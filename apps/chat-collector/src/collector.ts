import {
  AuthenticationError,
  authenticateNode,
  BroadcastOfflineError,
  type ChannelResolver,
  type NodeSoopChatOptions,
  RestrictedRoomError,
  resolveNodeChannel,
  type SoopAuthentication,
  SoopChat,
  SoopChatError,
} from 'soop-chat';

import type { Store, Streamer } from './storage.ts';

export type ChatFactory = (
  options: NodeSoopChatOptions,
) => Pick<SoopChat, 'connect' | 'disconnect' | 'on' | 'state'>;
type State = 'stopped' | 'waiting' | 'connecting' | 'collecting' | 'error';
type Runner = {
  streamer: Streamer;
  chat: ReturnType<ChatFactory>;
  state: State;
  broadcastNo: string | null;
  lastBroadcastNo: string | null;
  lastError: { code: string; message: string } | null;
  active: boolean;
  fatal: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  attempt: Promise<void> | undefined;
  unsubscribe: (() => void)[];
};

export class Collector {
  readonly store: Store;
  readonly runners = new Map<string, Runner>();
  readonly createChat: ChatFactory;
  readonly resolverOverride: ChannelResolver | undefined;
  private readonly restarting = new Map<string, number>();
  private closing = false;
  private authentication: Promise<SoopAuthentication> | undefined;
  private authController = new AbortController();
  private credentials: ReturnType<Store['getCredentials']>;

  constructor(
    store: Store,
    createChat: ChatFactory = (options) => new SoopChat(options),
    resolver?: ChannelResolver,
  ) {
    this.store = store;
    this.createChat = createChat;
    this.resolverOverride = resolver;
    this.credentials = store.getCredentials();
  }

  private resolve: ChannelResolver = async (id, context) => {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(10_000),
    ]);
    const request = { ...context, signal };
    if (this.resolverOverride) return this.resolverOverride(id, request);
    if (!this.credentials) return resolveNodeChannel(id, request);
    if (!this.authentication) {
      const pending = authenticateNode(this.credentials, {
        signal: AbortSignal.any([
          this.authController.signal,
          AbortSignal.timeout(10_000),
        ]),
      });
      this.authentication = pending;
      void pending.catch(() => {
        if (this.authentication === pending) this.authentication = undefined;
      });
    }
    const pending = this.authentication;
    try {
      const authentication = await pending;
      signal.throwIfAborted();
      return await resolveNodeChannel(id, { ...request, authentication });
    } catch (error) {
      if (
        this.authentication === pending &&
        (error instanceof AuthenticationError ||
          (error instanceof RestrictedRoomError && error.reason !== 'password'))
      )
        this.authentication = undefined;
      throw error;
    }
  };

  status(streamer: Streamer) {
    const runner = this.runners.get(streamer.streamer_id);
    return {
      streamerId: streamer.streamer_id,
      enabled: Boolean(streamer.enabled),
      state: runner?.state ?? 'stopped',
      broadcastNo: runner?.broadcastNo ?? null,
      lastError: runner?.lastError ?? null,
      roomPassword: streamer.room_password,
      retentionDays: streamer.retention_days,
    };
  }

  isActive(id: string, broadcastNo: string) {
    const runner = this.runners.get(id);
    return Boolean(
      runner?.active &&
        !runner.fatal &&
        (runner.broadcastNo === broadcastNo ||
          runner.lastBroadcastNo === broadcastNo),
    );
  }

  canDeleteBroadcast(id: string, broadcastNo: string) {
    const runner = this.runners.get(id);
    return (
      !this.restarting.has(id) &&
      !this.isActive(id, broadcastNo) &&
      !(runner?.active && runner.state === 'connecting' && !runner.broadcastNo)
    );
  }

  start(streamer: Streamer, lastBroadcastNo: string | null = null) {
    if (this.closing) return;
    const previous = this.runners.get(streamer.streamer_id);
    if (previous?.active && !previous.fatal) return;
    if (previous) this.dispose(previous);
    const runner: Runner = {
      streamer,
      chat: undefined as unknown as ReturnType<ChatFactory>,
      state: 'waiting',
      broadcastNo: null,
      lastBroadcastNo,
      lastError: null,
      active: true,
      fatal: false,
      timer: undefined,
      attempt: undefined,
      unsubscribe: [],
    };
    const current = () =>
      runner.active &&
      !runner.fatal &&
      this.runners.get(streamer.streamer_id) === runner;
    runner.chat = this.createChat({
      streamerId: streamer.streamer_id,
      ...(streamer.room_password === null
        ? {}
        : { roomPassword: streamer.room_password }),
      reconnect: false,
      resolveChannel: async (id, context) => {
        const channel = await this.resolve(id, context);
        context.signal.throwIfAborted();
        if (!current())
          throw new DOMException('Connection cancelled', 'AbortError');
        if (
          runner.lastBroadcastNo &&
          runner.lastBroadcastNo !== channel.broadcastNo
        ) {
          try {
            this.store.markEnded(id, runner.lastBroadcastNo);
          } catch {
            this.failStorage(runner);
            throw new Error('방송 종료 저장에 실패했습니다.');
          }
        }
        runner.broadcastNo = channel.broadcastNo;
        runner.lastBroadcastNo = channel.broadcastNo;
        return channel;
      },
    });
    this.runners.set(streamer.streamer_id, runner);
    runner.unsubscribe.push(
      runner.chat.on('event', (event) => {
        if (!current() || !runner.broadcastNo) return;
        try {
          this.store.saveEvent(streamer.streamer_id, runner.broadcastNo, event);
        } catch {
          this.failStorage(runner);
        }
      }),
      runner.chat.on('protocolError', ({ error, raw }) => {
        if (!current() || !runner.broadcastNo || !raw) return;
        try {
          this.store.saveEvent(streamer.streamer_id, runner.broadcastNo, {
            type: 'protocolError',
            opcode: raw.opcode,
            receivedAt: Date.now(),
            raw,
            data: {
              code: error.code,
              message: '프로토콜 이벤트를 해석할 수 없습니다.',
            },
          });
        } catch {
          this.failStorage(runner);
        }
      }),
      runner.chat.on('stateChange', ({ current: state }) => {
        if (!current()) return;
        if (state === 'connected') {
          runner.state = 'collecting';
          runner.lastError = null;
        } else if (state === 'closed') {
          runner.broadcastNo = null;
          runner.state = 'waiting';
          if (!runner.attempt) this.schedule(runner);
        }
      }),
      runner.chat.on('ended', ({ reason }) => {
        if (!current()) return;
        if (reason === 'offline' && runner.lastBroadcastNo) {
          try {
            this.store.markEnded(streamer.streamer_id, runner.lastBroadcastNo);
            runner.lastBroadcastNo = null;
          } catch {
            this.failStorage(runner);
            return;
          }
        }
        runner.broadcastNo = null;
        this.schedule(runner);
      }),
      runner.chat.on('error', () => {
        if (current())
          runner.lastError = {
            code: 'CONNECTION_ERROR',
            message: '채팅 연결에 오류가 발생했습니다.',
          };
      }),
    );
    this.attempt(runner);
  }

  private attempt(runner: Runner) {
    if (!runner.active || runner.fatal || runner.attempt) return;
    try {
      const streamer = this.store.getStreamer(runner.streamer.streamer_id);
      if (streamer.room_password !== runner.streamer.room_password) {
        void this.restart(streamer.streamer_id).catch(() =>
          this.failStorage(runner),
        );
        return;
      }
    } catch {
      this.failStorage(runner);
      return;
    }
    runner.state = 'connecting';
    runner.attempt = runner.chat
      .connect()
      .catch((error: unknown) => {
        if (!runner.active || runner.fatal) return;
        runner.broadcastNo = null;
        if (error instanceof BroadcastOfflineError) {
          runner.state = 'waiting';
          runner.lastError = null;
          if (runner.lastBroadcastNo) {
            try {
              this.store.markEnded(
                runner.streamer.streamer_id,
                runner.lastBroadcastNo,
              );
              runner.lastBroadcastNo = null;
            } catch {
              this.failStorage(runner);
            }
          }
        } else {
          runner.state = 'error';
          runner.lastError = {
            code:
              error instanceof SoopChatError ? error.code : 'CONNECTION_ERROR',
            message:
              error instanceof RestrictedRoomError
                ? `방송 접근이 제한되었습니다 (${error.reason}).`
                : '방송에 접속할 수 없습니다.',
          };
        }
      })
      .finally(() => {
        runner.attempt = undefined;
        if (runner.state !== 'collecting') this.schedule(runner);
      });
  }

  private schedule(runner: Runner) {
    if (!runner.active || runner.fatal || runner.timer || runner.attempt)
      return;
    runner.timer = setTimeout(() => {
      runner.timer = undefined;
      this.attempt(runner);
    }, 10_000);
  }

  private failStorage(runner: Runner) {
    runner.fatal = true;
    runner.state = 'error';
    runner.lastError = {
      code: 'STORAGE_ERROR',
      message:
        '채팅 저장에 실패했습니다. 수집 시작 API로 다시 시도할 수 있습니다.',
    };
    if (runner.timer) clearTimeout(runner.timer);
    runner.timer = undefined;
    runner.broadcastNo = null;
    void runner.chat.disconnect().catch(() => {});
  }

  private dispose(runner: Runner) {
    runner.active = false;
    if (runner.timer) clearTimeout(runner.timer);
    for (const off of runner.unsubscribe) off();
    return runner.chat.disconnect().catch(() => {});
  }

  async stop(id: string) {
    const runner = this.runners.get(id);
    if (!runner) return;
    this.runners.delete(id);
    await this.dispose(runner);
  }

  async restart(id: string) {
    const canonical = this.store.getStreamer(id, false).streamer_id;
    this.restarting.set(canonical, (this.restarting.get(canonical) ?? 0) + 1);
    try {
      const lastBroadcastNo =
        this.runners.get(canonical)?.lastBroadcastNo ?? null;
      await this.stop(canonical);
      if (this.closing) return;
      const streamer = this.store.getStreamer(canonical, false);
      if (streamer.registered && streamer.enabled)
        this.start(streamer, lastBroadcastNo);
    } finally {
      const remaining = (this.restarting.get(canonical) ?? 1) - 1;
      if (remaining) this.restarting.set(canonical, remaining);
      else this.restarting.delete(canonical);
    }
  }

  reloadCredentials() {
    const credentials = this.store.getCredentials();
    this.authController.abort();
    this.authController = new AbortController();
    this.authentication = undefined;
    this.credentials = credentials;
  }

  async shutdown() {
    this.closing = true;
    this.authController.abort();
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }
}
