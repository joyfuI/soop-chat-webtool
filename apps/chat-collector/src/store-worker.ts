import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import {
  ApiError,
  initializeSettings,
  Store,
  StreamerStore,
} from './storage.ts';

const { dataDir, secretKey, streamerId } = workerData;
let settings: DatabaseSync | undefined;
let store: Store | StreamerStore;
const methods = new Set(
  streamerId
    ? [
        'saveEvent',
        'markEnded',
        'listBroadcasts',
        'findBroadcast',
        'listExpiredBroadcasts',
      ]
    : [
        'prepareStreamer',
        'addStreamer',
        'getStreamer',
        'listStreamers',
        'updateStreamer',
        'setEnabled',
        'removeStreamer',
        'getSettings',
        'getCredentials',
        'updateCredentials',
        'databasePath',
      ],
);
if (streamerId) store = new StreamerStore(dataDir, streamerId);
else {
  settings = new DatabaseSync(join(dataDir, '_settings.db'));
  initializeSettings(settings);
  store = new Store(settings, dataDir, Buffer.from(secretKey));
}
parentPort?.on('message', ({ id, method, args }) => {
  try {
    if (method === 'close') {
      store.close();
      settings?.close();
      parentPort?.postMessage({ id, ok: true });
      parentPort?.close();
      return;
    }
    const execute = (
      store as unknown as Record<string, (...args: unknown[]) => unknown>
    )[method];
    if (!methods.has(method) || typeof execute !== 'function')
      throw new ApiError(400, '허용되지 않은 DB 작업입니다.');
    const value = Reflect.apply(execute, store, args);
    parentPort?.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort?.postMessage({
      id,
      ok: false,
      statusCode: error instanceof ApiError ? error.statusCode : 500,
      message:
        error instanceof ApiError ? error.message : 'DB 작업에 실패했습니다.',
    });
  }
});
parentPort?.postMessage({ ready: true });
