import { Worker } from 'node:worker_threads';

import { runDatabaseJob } from './query.ts';
import type { Store } from './storage.ts';
import {
  ApiError,
  type Broadcast,
  compareBroadcasts,
  type StoredEvent,
  type Streamer,
} from './types.ts';

class StoreWorker {
  readonly worker: Worker;
  readonly ready: Promise<void>;
  private sequence = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    options:
      | { dataDir: string; secretKey: Buffer }
      | { dataDir: string; streamerId: string },
    onExit?: () => void,
  ) {
    this.worker = new Worker(new URL('./store-worker.ts', import.meta.url), {
      workerData: options,
      execArgv: [],
    });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if (message.ready) {
          resolve();
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.ok) request.resolve(message.value);
        else request.reject(new ApiError(message.statusCode, message.message));
      });
      const fail = () => {
        this.failure = new ApiError(500, 'DB 워커가 종료되었습니다.');
        reject(this.failure);
        for (const request of this.pending.values())
          request.reject(this.failure);
        this.pending.clear();
      };
      this.worker.on('error', fail);
      this.worker.on('exit', () => {
        fail();
        onExit?.();
      });
    });
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch {
        this.pending.delete(id);
        reject(new ApiError(500, 'DB 요청을 전달할 수 없습니다.'));
      }
    });
  }

  async close() {
    if (this.failure) {
      await this.worker.terminate();
      return;
    }
    const exited = new Promise<void>((resolve) =>
      this.worker.once('exit', () => resolve()),
    );
    await this.call('close');
    await exited;
  }
}

export class AsyncStore {
  readonly dataDir: string;
  private metadata!: StoreWorker;
  private readonly streamers = new Map<string, Promise<StoreWorker>>();
  private closing = false;
  private readonly pendingEvents = new Map<string, number>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  static async open(dataDir: string, secretKey: Buffer) {
    const store = new AsyncStore(dataDir);
    try {
      store.metadata = new StoreWorker({ dataDir, secretKey });
      await store.metadata.ready;
      return store;
    } catch (error) {
      await Promise.allSettled([store.metadata?.close()]);
      throw error;
    }
  }

  private streamerWorker(
    id: string,
    canonicalKnown = false,
  ): Promise<StoreWorker> {
    if (this.closing)
      return Promise.reject(new ApiError(503, 'DB를 종료하고 있습니다.'));
    const key = id.toLowerCase();
    const current = this.streamers.get(key);
    if (current) return current;
    // ponytail: retain one worker per used streamer; use a bounded pool if memory becomes limiting.
    const pending = (async () => {
      const canonical = canonicalKnown
        ? id
        : (await this.getStreamer(id, false)).streamer_id;
      const worker = new StoreWorker(
        { dataDir: this.dataDir, streamerId: canonical },
        () => {
          if (this.streamers.get(key) === pending) this.streamers.delete(key);
        },
      );
      try {
        await worker.ready;
        return worker;
      } catch (error) {
        await worker.close();
        throw error;
      }
    })();
    this.streamers.set(key, pending);
    void pending.catch(() => {
      if (this.streamers.get(key) === pending) this.streamers.delete(key);
    });
    return pending;
  }

  private streamerRequest<T>(
    id: string,
    method: string,
    ...args: unknown[]
  ): Promise<T> {
    return this.track(
      this.streamerWorker(id).then((worker) => worker.call<T>(method, args)),
    );
  }

  private track<T>(request: Promise<T>): Promise<T> {
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request)).catch(() => {});
    return request;
  }

  private read<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closing)
      return Promise.reject(new ApiError(503, 'DB를 종료하고 있습니다.'));
    return this.track(this.metadata.call<T>(method, args));
  }

  private write<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new ApiError(503, 'DB를 종료하고 있습니다.'));
    const key = id.toLowerCase();
    const previous = this.writes.get(key);
    const request = previous ? previous.catch(() => {}).then(action) : action();
    this.writes.set(key, request);
    void request
      .finally(() => {
        if (this.writes.get(key) === request) this.writes.delete(key);
      })
      .catch(() => {});
    return this.track(request);
  }

  listStreamers(registeredOnly = true) {
    return this.read<Streamer[]>('listStreamers', registeredOnly);
  }
  getStreamer(id: string, registeredOnly = true) {
    return this.read<Streamer>('getStreamer', id, registeredOnly);
  }
  async addStreamer(id: string, password: string | null, days?: number) {
    const prepared = await this.read<ReturnType<Store['prepareStreamer']>>(
      'prepareStreamer',
      id,
      days,
    );
    await this.track(this.streamerWorker(prepared.streamerId, true));
    return this.read<Streamer>('addStreamer', id, password, days);
  }
  updateStreamer(id: string, changes: Parameters<Store['updateStreamer']>[1]) {
    return this.read<void>('updateStreamer', id, changes);
  }
  setEnabled(id: string, enabled: boolean) {
    return this.read<void>('setEnabled', id, enabled);
  }
  removeStreamer(id: string) {
    return this.read<void>('removeStreamer', id);
  }
  getSettings() {
    return this.read<ReturnType<Store['getSettings']>>('getSettings');
  }
  getCredentials() {
    return this.read<ReturnType<Store['getCredentials']>>('getCredentials');
  }
  updateCredentials(username: string | null, password: string | null) {
    return this.read<void>('updateCredentials', username, password);
  }
  databasePath(id: string) {
    return this.read<string>('databasePath', id);
  }
  listBroadcasts(id?: string) {
    return this.track(
      (async () => {
        const targets = id
          ? [await this.getStreamer(id, false)]
          : await this.listStreamers(false);
        const broadcasts = await Promise.all(
          targets.map((s) =>
            this.streamerRequest<Broadcast[]>(s.streamer_id, 'listBroadcasts'),
          ),
        );
        return broadcasts.flat().sort(compareBroadcasts);
      })(),
    );
  }
  findBroadcast(no: string) {
    return this.track(
      (async () => {
        const targets = await this.listStreamers(false);
        const broadcasts = await Promise.all(
          targets.map((s) =>
            this.streamerRequest<Broadcast | undefined>(
              s.streamer_id,
              'findBroadcast',
              no,
            ),
          ),
        );
        const matches = broadcasts.filter((b) => b !== undefined);
        if (!matches.length)
          throw new ApiError(404, '방송을 찾을 수 없습니다.');
        if (matches.length > 1)
          throw new ApiError(
            409,
            '여러 스트리머 DB에 같은 방송 번호가 있습니다.',
          );
        return matches[0] as Broadcast;
      })(),
    );
  }
  listExpiredBroadcasts(id: string, cutoff: number) {
    return this.streamerRequest<Broadcast[]>(
      id,
      'listExpiredBroadcasts',
      cutoff,
    );
  }
  saveEvent(id: string, no: string, event: StoredEvent) {
    // Bound the backlog when disk commits cannot keep up with incoming chat.
    const key = id.toLowerCase();
    if ((this.pendingEvents.get(key) ?? 0) >= 10_000)
      return Promise.reject(
        new ApiError(503, '채팅 저장 대기열이 가득 찼습니다.'),
      );
    let snapshot: StoredEvent;
    try {
      snapshot = structuredClone({
        type: event.type,
        opcode: event.opcode,
        receivedAt: event.receivedAt,
        data: event.data,
        raw: { flags: event.raw.flags, payload: event.raw.payload },
      });
    } catch {
      return Promise.reject(
        new ApiError(500, '채팅 저장 요청을 만들 수 없습니다.'),
      );
    }
    this.pendingEvents.set(key, (this.pendingEvents.get(key) ?? 0) + 1);
    const request = this.write(id, () =>
      this.streamerRequest<void>(id, 'saveEvent', no, snapshot),
    );
    void request
      .finally(() => {
        const remaining = (this.pendingEvents.get(key) ?? 1) - 1;
        if (remaining) this.pendingEvents.set(key, remaining);
        else this.pendingEvents.delete(key);
      })
      .catch(() => {});
    return request;
  }
  markEnded(id: string, no: string) {
    return this.write(id, () =>
      this.streamerRequest<void>(id, 'markEnded', no),
    );
  }
  deleteBroadcast(broadcast: Broadcast, signal?: AbortSignal) {
    return this.write(broadcast.streamer_id, async () => {
      const path = await this.databasePath(broadcast.streamer_id);
      await runDatabaseJob(
        { operation: 'delete', path, broadcastNo: broadcast.broadcast_no },
        signal
          ? AbortSignal.any([signal, this.shutdown.signal])
          : this.shutdown.signal,
      );
    });
  }
  async waitForWrites(id: string) {
    const key = id.toLowerCase();
    while (this.writes.has(key)) await this.writes.get(key)?.catch(() => {});
  }
  async flush() {
    while (this.requests.size) await Promise.allSettled([...this.requests]);
  }
  async close() {
    this.shutdown.abort();
    await this.flush();
    this.closing = true;
    await Promise.all([
      ...[...this.streamers.values()].map(async (worker) =>
        (await worker).close(),
      ),
      this.metadata.close(),
    ]);
  }
}
