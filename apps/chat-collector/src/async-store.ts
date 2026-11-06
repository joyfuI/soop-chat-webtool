import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import type { QueuedEntry, QueuedWrite } from './chat-queue.ts';
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
      | { dataDir: string; streamerId: string }
      | { dataDir: string; queue: true },
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

type Ingress = {
  entries: QueuedWrite[];
  sealed: boolean;
  saved: Promise<void>;
};

export class AsyncStore {
  readonly dataDir: string;
  private metadata!: StoreWorker;
  private queue!: StoreWorker;
  private queueSource!: string;
  private readonly streamers = new Map<string, Promise<StoreWorker>>();
  private closing = false;
  private readonly ingress = new Map<string, Ingress>();
  private readonly unpersisted = new Map<string, number>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drainErrors = new Set<string>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private readonly reportDrainError: (
    streamerId: string,
    error: unknown,
  ) => void;

  private constructor(
    dataDir: string,
    reportDrainError: (streamerId: string, error: unknown) => void,
  ) {
    this.dataDir = dataDir;
    this.reportDrainError = reportDrainError;
  }

  static async open(
    dataDir: string,
    secretKey: Buffer,
    reportDrainError: (streamerId: string, error: unknown) => void,
  ) {
    const store = new AsyncStore(dataDir, reportDrainError);
    try {
      store.metadata = new StoreWorker({ dataDir, secretKey });
      store.queue = new StoreWorker({ dataDir, queue: true });
      await Promise.all([store.metadata.ready, store.queue.ready]);
      const { source, streamers } = await store.queue.call<{
        source: string;
        streamers: string[];
      }>('queueState');
      store.queueSource = source;
      for (const id of streamers) store.scheduleDrain(id);
      return store;
    } catch (error) {
      await Promise.allSettled([store.metadata?.close(), store.queue?.close()]);
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
    try {
      const data = JSON.stringify(event.data);
      if (
        data === undefined ||
        !no ||
        !Number.isSafeInteger(event.receivedAt) ||
        typeof event.type !== 'string' ||
        typeof event.opcode !== 'string' ||
        typeof event.raw.flags !== 'string'
      )
        throw new Error('이벤트 데이터가 올바르지 않습니다.');
      return this.enqueue(id, {
        broadcastNo: no,
        event: {
          type: event.type,
          opcode: event.opcode,
          receivedAt: event.receivedAt,
          data,
          raw: {
            flags: event.raw.flags,
            payload: Uint8Array.from(event.raw.payload),
          },
        },
      });
    } catch {
      return Promise.reject(
        new ApiError(500, '채팅 저장 요청을 만들 수 없습니다.'),
      );
    }
  }

  markEnded(id: string, no: string) {
    return this.enqueue(id, { broadcastNo: no, endedAt: Date.now() });
  }

  private enqueue(id: string, entry: QueuedWrite) {
    if (this.closing)
      return Promise.reject(new ApiError(503, 'DB를 종료하고 있습니다.'));
    const key = id.toLowerCase();
    const count = this.unpersisted.get(key) ?? 0;
    if (count >= 10_000)
      return Promise.reject(
        new ApiError(503, '디스크 대기열 기록이 지연되고 있습니다.'),
      );
    this.unpersisted.set(key, count + 1);
    const current = this.ingress.get(key);
    if (current && !current.sealed) {
      current.entries.push(entry);
      return current.saved;
    }
    const batch: Ingress = {
      entries: [entry],
      sealed: false,
      saved: this.track(
        delay(20)
          .then(async () => {
            batch.sealed = true;
            await this.queue.call('appendWrites', [key, batch.entries]);
            this.scheduleDrain(key);
          })
          .finally(() => {
            const remaining =
              (this.unpersisted.get(key) ?? 0) - batch.entries.length;
            if (remaining) this.unpersisted.set(key, remaining);
            else this.unpersisted.delete(key);
            if (this.ingress.get(key) === batch) this.ingress.delete(key);
          }),
      ),
    };
    this.ingress.set(key, batch);
    return batch.saved;
  }

  private scheduleDrain(id: string) {
    this.dirty.add(id);
    if (this.drains.has(id) || this.retries.has(id)) return;
    this.drains.set(id, this.track(this.drain(id)));
  }

  private async drain(id: string) {
    try {
      // Allow several durable appends to share one destination transaction.
      await delay(100);
      do {
        this.dirty.delete(id);
        const applied = await this.write(id, async () => {
          const entries = await this.queue.call<QueuedEntry[]>('nextWrites', [
            id,
          ]);
          const last = entries.at(-1);
          if (!last) return false;
          await this.streamerRequest<void>(
            id,
            'applyQueuedWrites',
            this.queueSource,
            entries,
          );
          await this.queue.call('discardWrites', [id, last.id]);
          return true;
        });
        if (applied) this.dirty.add(id);
        this.drainErrors.delete(id);
      } while (this.dirty.has(id));
    } catch (error) {
      if (!this.drainErrors.has(id)) this.reportDrainError(id, error);
      this.drainErrors.add(id);
      if (!this.shutdown.signal.aborted) {
        const retry = setTimeout(() => {
          this.retries.delete(id);
          this.scheduleDrain(id);
        }, 1_000).unref();
        this.retries.set(id, retry);
      }
    } finally {
      this.drains.delete(id);
    }
  }

  deleteBroadcast(broadcast: Broadcast, signal?: AbortSignal) {
    const key = broadcast.streamer_id.toLowerCase();
    const pending = this.ingress.get(key)?.saved;
    return this.write(broadcast.streamer_id, async () => {
      await pending?.catch(() => {});
      if (
        await this.queue.call<boolean>('hasQueuedBroadcast', [
          key,
          broadcast.broadcast_no,
        ])
      )
        throw new ApiError(409, '이 방송의 채팅을 저장 중입니다.');
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
    for (;;) {
      const pending =
        this.ingress.get(key)?.saved ??
        this.drains.get(key) ??
        this.writes.get(key);
      if (!pending) return;
      await pending.catch(() => {});
    }
  }
  async flush() {
    while (this.requests.size) await Promise.allSettled([...this.requests]);
  }
  async close() {
    this.shutdown.abort();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await this.flush();
    this.closing = true;
    await Promise.all([
      ...[...this.streamers.values()].map(async (worker) =>
        (await worker).close(),
      ),
      this.metadata.close(),
      this.queue.close(),
    ]);
  }
}
