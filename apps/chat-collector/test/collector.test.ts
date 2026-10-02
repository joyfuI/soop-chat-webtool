import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import {
  BroadcastOfflineError,
  type ChannelResolver,
  type ConnectionState,
  type NodeSoopChatOptions,
  ProtocolError,
  RestrictedRoomError,
  SoopChat,
  type SoopChatEventMap,
  type SoopChatEventType,
  type SoopChatListener,
  type SoopEvent,
} from 'soop-chat';

import { buildApp } from '../src/app.ts';
import type { AsyncStore } from '../src/async-store.ts';
import type { BroadcastLookup } from '../src/collector.ts';
import { downloadBroadcast } from '../src/download.ts';
import { csvDownload, sqliteDownload } from '../src/download-source.ts';
import { runQuery } from '../src/query.ts';
import {
  DAY_MS,
  initializeSettings,
  MAX_RETENTION_DAYS,
  Store,
} from '../src/storage.ts';

const headers = { authorization: 'Bearer test-api-key' };
const key = Buffer.alloc(32, 7);
const stores = new Set<AsyncStore>();
const channel = (broadcastNo = '1001') => ({
  broadcastNo,
  chatNo: '1',
  chatDomain: 'localhost',
  chatPort: 8000,
});
const event = (type = 'chatMessage', receivedAt = Date.now()): SoopEvent =>
  ({
    type,
    opcode: type === 'unknown' ? '9999' : '0005',
    receivedAt,
    data: { message: '한글,"인용"\n다음 줄', fields: ['hello'] },
    raw: {
      opcode: '0005',
      flags: '00',
      payload: Uint8Array.from([0, 12, 255, 65]),
      text: '',
      fields: [],
    },
  }) as unknown as SoopEvent;

class FakeChat extends SoopChat {
  readonly options: NodeSoopChatOptions;
  readonly listeners = new Map<string, Set<(event: never) => unknown>>();
  controller = new AbortController();
  currentState: ConnectionState = 'idle';
  connections = 0;
  disconnections = 0;

  constructor(options: NodeSoopChatOptions) {
    super(options);
    this.options = options;
  }
  override get state() {
    return this.currentState;
  }
  override on<K extends SoopChatEventType>(
    type: K,
    listener: SoopChatListener<K>,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, listeners);
    listeners.add(listener as (event: never) => unknown);
    return () => {
      listeners.delete(listener as (event: never) => unknown);
    };
  }
  emit<K extends SoopChatEventType>(type: K, value: SoopChatEventMap[K]) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(value as never);
  }
  transition(current: ConnectionState) {
    const previous = this.currentState;
    this.currentState = current;
    this.emit('stateChange', { previous, current });
  }
  override async connect() {
    this.connections++;
    this.controller = new AbortController();
    this.transition('resolving');
    try {
      assert.ok(this.options.resolveChannel);
      await this.options.resolveChannel(this.streamerId, {
        signal: this.controller.signal,
        ...(this.options.roomPassword
          ? { roomPassword: this.options.roomPassword }
          : {}),
      });
      this.controller.signal.throwIfAborted();
      this.transition('connecting');
      this.emit('event', event('login'));
      this.transition('connected');
    } catch (error) {
      this.transition('closed');
      throw error;
    }
  }
  override async disconnect() {
    this.disconnections++;
    this.controller.abort();
    this.transition('closed');
  }
  end() {
    this.emit('event', event('closeBroad'));
    this.transition('closed');
    this.emit('ended', { reason: 'offline' });
  }
}

async function fixture(
  t: TestContext,
  resolver: ChannelResolver | null = async () => channel(),
  corsOrigins: string[] = [],
  lookupBroadcast: BroadcastLookup | null = async () => '1001',
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  const chats: FakeChat[] = [];
  const options = {
    apiKey: 'test-api-key',
    secretKey: key,
    dataDir,
    corsOrigins,
    ...(resolver ? { resolveChannel: resolver } : {}),
    ...(lookupBroadcast ? { lookupBroadcast } : {}),
    createChat: (opts: NodeSoopChatOptions) => {
      const chat = new FakeChat(opts);
      chats.push(chat);
      return chat;
    },
  };
  const contexts: Awaited<ReturnType<typeof buildApp>>[] = [];
  const open = async () => {
    const context = await buildApp(options);
    contexts.push(context);
    const settings = new DatabaseSync(join(dataDir, '_settings.db'));
    initializeSettings(settings);
    const inspector = new Store(settings, dataDir, key);
    stores.add(context.store);
    context.app.addHook('onClose', async () => {
      inspector.close();
      settings.close();
      stores.delete(context.store);
    });
    return { ...context, backend: context.store, store: inspector };
  };
  const context = await open();
  t.after(async () => {
    for (const current of contexts.reverse()) await current.app.close();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    rmSync(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });
  return {
    ...context,
    dataDir,
    chats,
    open,
    call: (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      context.app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      }),
  };
}

async function flush(turns = 6) {
  for (let turn = 0; turn < turns; turn++) {
    await setImmediate();
    await Promise.all([...stores].map((store) => store.flush()));
    await setImmediate();
  }
}

test('blocked SQLite writes keep control APIs responsive and stop drains ordered event snapshots', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/streamers', { streamerId: 'other123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  assert.ok(chat);
  const previous = f.store.findBroadcast('1001').event_count;
  const db = f.store.getDatabase('user123');
  db.exec('BEGIN IMMEDIATE');
  let stopped = false;
  let stopping: ReturnType<typeof f.call> | undefined;
  const started = Date.now();
  try {
    for (let index = 0; index < 200; index++) {
      const incoming = event();
      incoming.raw.payload[0] = index;
      chat.emit('event', incoming);
      incoming.raw.payload[0] = 255;
    }
    const responses = await Promise.all([
      f.call('GET', '/api/streamers'),
      f.call('GET', '/api/settings'),
      f.call('GET', '/api/broadcasts/other123'),
      f.call('POST', '/api/collection/start/user123'),
      f.call('POST', '/api/collection/stop/other123'),
    ]);
    for (const response of responses) assert.equal(response.statusCode, 200);
    assert.ok(
      Date.now() - started < 1500,
      'control APIs must finish while the DB write lock is held',
    );
    assert.equal(f.chats.length, 1);
    stopping = f.call('POST', '/api/collection/stop/user123');
    void stopping.then(() => {
      stopped = true;
    });
    await setTimeout(100);
    assert.equal(stopped, false);
    assert.equal(f.store.findBroadcast('1001').event_count, previous);
  } finally {
    db.exec('ROLLBACK');
  }
  assert.equal((await stopping)?.statusCode, 200);
  assert.equal(f.store.findBroadcast('1001').event_count, previous + 200);
  const rows = db
    .prepare('SELECT raw_payload FROM events ORDER BY id')
    .all()
    .slice(previous);
  assert.deepEqual(
    rows.map((row) => (row.raw_payload as Uint8Array)[0]),
    Array.from({ length: 200 }, (_, index) => index),
  );
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const beforeShutdown = f.store.findBroadcast('1001').event_count;
  for (let index = 0; index < 100; index++)
    f.chats.at(-1)?.emit('event', event());
  const path = f.store.databasePath('user123');
  await f.app.close();
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      reader.prepare('SELECT event_count FROM broadcasts').get()?.event_count,
      beforeShutdown + 100,
    );
  } finally {
    reader.close();
  }
});

test('streamer workers isolate locked writes and crashes, reuse case aliases, and recover on retry', {
  timeout: 10_000,
}, async (t) => {
  const broadcastNo = (id: string) => (id === 'alpha123' ? '1001' : '1002');
  const f = await fixture(
    t,
    async (id) => channel(broadcastNo(id)),
    [],
    async (id) => broadcastNo(id),
  );
  for (const streamerId of ['alpha123', 'beta123'])
    assert.equal(
      (await f.call('POST', '/api/streamers', { streamerId })).statusCode,
      201,
    );
  await f.call('POST', '/api/collection/start');
  await flush();
  const alpha = f.chats.find((chat) => chat.streamerId === 'alpha123');
  const beta = f.chats.find((chat) => chat.streamerId === 'beta123');
  assert.ok(alpha && beta);
  const workers = Reflect.get(f.backend, 'streamers') as Map<
    string,
    Promise<{ worker: Worker; call(method: string): Promise<unknown> }>
  >;
  const alphaWorker = await workers.get('alpha123');
  const betaWorker = await workers.get('beta123');
  assert.ok(alphaWorker && betaWorker);
  assert.notEqual(alphaWorker.worker.threadId, betaWorker.worker.threadId);
  assert.equal(
    (await f.call('GET', '/api/broadcasts/ALPHA123')).statusCode,
    200,
  );
  assert.equal(workers.size, 2);
  await assert.rejects(
    alphaWorker.call('getCredentials'),
    (error: unknown) => (error as { statusCode: number }).statusCode === 400,
  );
  const db = f.store.getDatabase('alpha123');
  const alphaCount = f.store.findBroadcast('1001').event_count;
  const betaCount = f.store.findBroadcast('1002').event_count;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 20; index++) {
      alpha.emit('event', event());
      beta.emit('event', event());
    }
    await f.backend.waitForWrites('beta123');
    assert.equal(f.store.findBroadcast('1001').event_count, alphaCount);
    assert.equal(f.store.findBroadcast('1002').event_count, betaCount + 20);
    const response = await f.call('GET', '/api/broadcasts/beta123');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].event_count, betaCount + 20);
    assert.equal((await f.call('GET', '/api/streamers')).statusCode, 200);
  } finally {
    db.exec('ROLLBACK');
  }
  await f.backend.waitForWrites('alpha123');
  assert.equal(f.store.findBroadcast('1001').event_count, alphaCount + 20);

  const exited = new Promise<void>((resolve) =>
    alphaWorker.worker.once('exit', () => resolve()),
  );
  // An invalid message causes a real worker failure before the queued event.
  alphaWorker.worker.postMessage(null);
  alpha.emit('event', event());
  beta.emit('event', event());
  await Promise.all([
    f.backend.waitForWrites('alpha123'),
    f.backend.waitForWrites('beta123'),
    exited,
  ]);
  const states = (await f.call('GET', '/api/streamers')).json();
  assert.equal(states[0].lastError.code, 'STORAGE_ERROR');
  assert.equal(states[1].state, 'collecting');
  assert.equal((await f.call('GET', '/api/settings')).statusCode, 200);
  assert.equal(f.store.findBroadcast('1002').event_count, betaCount + 21);
  assert.equal(workers.has('alpha123'), false);
  assert.equal(
    (await f.call('POST', '/api/collection/start/alpha123')).statusCode,
    200,
  );
  await flush();
  const recovered = await workers.get('alpha123');
  assert.ok(recovered);
  assert.notEqual(recovered.worker, alphaWorker.worker);
  assert.equal(await workers.get('beta123'), betaWorker);
  assert.equal(f.store.findBroadcast('1001').event_count, alphaCount + 21);
  assert.equal(
    (await f.call('GET', '/api/streamers')).json()[0].state,
    'collecting',
  );
});

test('deletion waits outside the main thread, serializes writes, and exports cancel without temporary files', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.backend.saveEvent('user123', 'old', event());
  const broadcast = await f.backend.findBroadcast('old');
  const path = await f.backend.databasePath('user123');
  const db = f.store.getDatabase('user123');
  db.exec('BEGIN IMMEDIATE');
  const controller = new AbortController();
  const deleting = f.backend.deleteBroadcast(broadcast, controller.signal);
  const cancellation = assert.rejects(
    deleting,
    (error: unknown) => (error as { statusCode: number }).statusCode === 499,
  );
  const writing = f.backend.saveEvent('user123', 'new', event());
  let written = false;
  void writing.then(() => {
    written = true;
  });
  try {
    await setTimeout(250);
    assert.equal((await f.call('GET', '/api/streamers')).statusCode, 200);
    assert.equal(written, false);
    controller.abort();
    await cancellation;
  } finally {
    db.exec('ROLLBACK');
  }
  await writing;
  assert.equal(f.store.findBroadcast('old').event_count, 1);
  assert.equal(f.store.findBroadcast('new').event_count, 1);
  await f.backend.deleteBroadcast(broadcast);
  assert.throws(() => f.store.findBroadcast('old'), /방송을 찾을 수 없습니다/);
  const before = readdirSync(tmpdir()).filter((name) =>
    name.startsWith('soop-chat-collector-'),
  );
  const cancelled = new AbortController();
  const preparing = downloadBroadcast(
    path,
    f.store.findBroadcast('new'),
    'db',
    cancelled.signal,
  );
  const rejection = assert.rejects(preparing);
  cancelled.abort();
  await rejection;
  const download = await downloadBroadcast(
    path,
    f.store.findBroadcast('new'),
    'db',
    new AbortController().signal,
  );
  download.stream.destroy();
  await download.finished;
  const csv = await downloadBroadcast(
    path,
    f.store.findBroadcast('new'),
    'csv',
    new AbortController().signal,
  );
  csv.stream.destroy();
  await csv.finished;
  // Keep native export queries running so cancellation must stop the process.
  db.exec(`
    ALTER TABLE events RENAME TO saved_events;
    CREATE VIEW events AS
    WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id + 1 FROM n)
    SELECT n.id, e.broadcast_no, e.type, e.opcode, e.received_at, e.data, e.raw_flags, e.raw_payload
    FROM n CROSS JOIN saved_events e;
  `);
  const nativeCancellation = new AbortController();
  const exporting = downloadBroadcast(
    path,
    f.store.findBroadcast('new'),
    'db',
    nativeCancellation.signal,
  );
  const nativeRejection = assert.rejects(
    exporting,
    (error: unknown) => (error as { statusCode: number }).statusCode === 499,
  );
  await setTimeout(400);
  assert.equal((await f.call('GET', '/api/streamers')).statusCode, 200);
  nativeCancellation.abort();
  await nativeRejection;
  const streaming = new AbortController();
  const liveCsv = await downloadBroadcast(
    path,
    f.store.findBroadcast('new'),
    'csv',
    streaming.signal,
  );
  await once(liveCsv.stream, 'data');
  const csvError = assert.rejects(
    once(liveCsv.stream, 'end'),
    (error: unknown) => (error as { statusCode: number }).statusCode === 499,
  );
  streaming.abort();
  await csvError;
  await liveCsv.finished;
  assert.deepEqual(
    readdirSync(tmpdir()).filter(
      (name) =>
        name.startsWith('soop-chat-collector-') && !before.includes(name),
    ),
    [],
  );
});

test('CORS preflight, allowed origins and API authentication', async (t) => {
  const origin = 'http://localhost:5173';
  const f = await fixture(t, undefined, [origin, 'http://localhost:4173']);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const response = await f.app.inject({
      method: 'OPTIONS',
      url: '/api/streamers',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.ok(
      String(response.headers['access-control-allow-methods']).includes(method),
    );
    assert.match(
      String(response.headers['access-control-allow-headers']),
      /Authorization/i,
    );
    assert.match(
      String(response.headers['access-control-allow-headers']),
      /Content-Type/i,
    );
  }
  const unauthorized = await f.app.inject({
    url: '/api/settings',
    headers: { origin },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers['access-control-allow-origin'], origin);
  const authorized = await f.app.inject({
    url: '/api/settings',
    headers: { ...headers, origin },
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.headers['access-control-allow-origin'], origin);
  const deniedOrigin = 'http://untrusted.example';
  for (const method of ['GET', 'OPTIONS'] as const) {
    const response = await f.app.inject({
      method,
      url: '/api/settings',
      headers: {
        ...headers,
        origin: deniedOrigin,
        'access-control-request-method': 'GET',
      },
    });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const disabled = await fixture(t);
  const withoutCors = await disabled.app.inject({
    url: '/api/settings',
    headers: { ...headers, origin },
  });
  assert.equal(withoutCors.statusCode, 200);
  assert.equal(withoutCors.headers['access-control-allow-origin'], undefined);
  assert.equal(
    (
      await disabled.app.inject({
        method: 'OPTIONS',
        url: '/api/settings',
        headers: { origin, 'access-control-request-method': 'GET' },
      })
    ).statusCode,
    401,
  );
  for (const invalid of [
    '*',
    'http://localhost:5173/',
    'http://localhost:5173/path',
    'file:///tmp',
  ]) {
    await assert.rejects(
      buildApp({
        apiKey: 'test-api-key',
        secretKey: key,
        dataDir: f.dataDir,
        corsOrigins: [invalid],
      }),
    );
  }
});

test('API authentication, ID boundaries, registration, password encryption, SQLite settings', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject('/api/settings')).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        url: '/api/settings',
        headers: { authorization: 'Bearer wrong' },
      })
    ).statusCode,
    401,
  );
  assert.deepEqual((await f.call('GET', '/api/settings')).json(), {
    username: null,
    passwordConfigured: false,
  });
  for (const id of [
    'abc12',
    'abc1234567890',
    'abc_12',
    'abc-12',
    '한글1234',
    ' abc123',
    '../abc123',
  ]) {
    assert.equal(
      (await f.call('POST', '/api/streamers', { streamerId: id })).statusCode,
      400,
      id,
    );
  }
  for (const id of ['Abc123', 'abcdefghijkl'])
    assert.equal(
      (await f.call('POST', '/api/streamers', { streamerId: id })).statusCode,
      201,
    );
  assert.equal(
    (await f.call('POST', '/api/streamers', { streamerId: 'abc123' }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await f.call('POST', '/api/streamers', {
        streamerId: 'new123',
        roomPassword: 'a\n',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call('PATCH', '/api/streamers/Abc123', {
        roomPassword: 'room-secret',
      })
    ).statusCode,
    200,
  );
  assert.equal(f.store.getStreamer('abc123').room_password, 'room-secret');
  assert.equal(f.store.getDatabase('abc123'), f.store.getDatabase('Abc123'));
  assert.equal(
    (await f.call('GET', '/api/streamers'))
      .json()
      .find(
        (streamer: { streamerId: string }) => streamer.streamerId === 'Abc123',
      ).roomPassword,
    'room-secret',
  );
  const unauthenticated = await f.app.inject('/api/streamers');
  assert.equal(unauthenticated.statusCode, 401);
  assert.ok(!unauthenticated.body.includes('room-secret'));
  assert.equal(
    (await f.call('PATCH', '/api/streamers/Abc123', { roomPassword: null }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await f.call('PATCH', '/api/settings', {
        username: 'user123',
        password: null,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call('PATCH', '/api/settings', {
        username: '  ',
        password: 'secret',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call('PATCH', '/api/settings', {
        username: ' user123 ',
        password: 'login-secret',
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(f.store.getCredentials(), {
    username: 'user123',
    password: 'login-secret',
  });
  const first = f.store.settings.prepare('SELECT * FROM settings').get();
  assert.ok(first);
  assert.notEqual(
    Buffer.from(first.soop_password_ciphertext as Uint8Array).toString(),
    'login-secret',
  );
  assert.ok(
    !(await f.call('GET', '/api/settings')).body.includes('login-secret'),
  );
  await f.call('PATCH', '/api/settings', {
    username: 'user123',
    password: 'login-secret',
  });
  const second = f.store.settings.prepare('SELECT * FROM settings').get();
  assert.notDeepEqual(first.soop_password_iv, second?.soop_password_iv);
  for (const db of [f.store.settings, f.store.getDatabase('Abc123')]) {
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA busy_timeout').get()?.timeout, 5000);
    assert.equal(
      db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
      1000,
    );
  }
  assert.throws(() =>
    f.store.settings.exec(
      'INSERT INTO settings (id, updated_at) VALUES (2, 0)',
    ),
  );
  assert.throws(() =>
    f.store.settings.exec("UPDATE settings SET soop_password_iv = x'00'"),
  );
  assert.throws(() =>
    f.store.settings.exec('UPDATE streamers SET registered = 0, enabled = 1'),
  );
  assert.throws(() =>
    f.store.settings.exec("UPDATE streamers SET streamer_id = '../bad'"),
  );
  const eventsDb = f.store.getDatabase('Abc123');
  f.store.saveEvent('Abc123', 'constraint1', event());
  assert.throws(() => eventsDb.exec("UPDATE events SET data = 'invalid JSON'"));
  assert.throws(() =>
    eventsDb.exec("UPDATE events SET raw_payload = 'not a blob'"),
  );
  assert.throws(() =>
    eventsDb.exec("UPDATE events SET broadcast_no = 'missing'"),
  );
  assert.throws(() => eventsDb.exec('UPDATE broadcasts SET event_count = -1'));
  const committedReader = new DatabaseSync(f.store.databasePath('Abc123'), {
    readOnly: true,
  });
  try {
    assert.equal(
      committedReader.prepare('SELECT count(*) AS count FROM events').get()
        ?.count,
      1,
    );
  } finally {
    committedReader.close();
  }
  await f.app.close();
  const reopened = await f.open();
  assert.deepEqual(reopened.store.getCredentials(), {
    username: 'user123',
    password: 'login-secret',
  });
  const iv = reopened.store.settings
    .prepare('SELECT soop_password_tag FROM settings')
    .get()?.soop_password_tag as Uint8Array;
  const damaged = Buffer.from(iv);
  damaged[0] ^= 1;
  reopened.store.settings
    .prepare('UPDATE settings SET soop_password_tag = ?')
    .run(damaged);
  assert.throws(() => reopened.store.getCredentials());
  reopened.store.updateCredentials(null, null);
  assert.equal(reopened.store.getCredentials(), undefined);
});

test('retention API validates days, preserves partial updates and registration settings without reconnecting', async (t) => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/streamers', {
    streamerId: 'user123',
    roomPassword: 'room-secret',
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().roomPassword, 'room-secret');
  assert.equal(created.json().retentionDays, 0);
  assert.equal(f.store.getStreamer('user123').retention_days, 0);
  for (const retentionDays of [
    null,
    -1,
    0.5,
    '30',
    true,
    [30],
    MAX_RETENTION_DAYS + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(
      (
        await f.call('POST', '/api/streamers', {
          streamerId: 'other123',
          retentionDays,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.call('PATCH', '/api/streamers/user123', { retentionDays }))
        .statusCode,
      400,
    );
  }
  for (const payload of [{}, { other: 30 }])
    assert.equal(
      (await f.call('PATCH', '/api/streamers/user123', payload)).statusCode,
      400,
    );
  for (const value of ['-1', 'NULL', '1.5', "'invalid'"])
    assert.throws(() =>
      f.store.settings.exec(`UPDATE streamers SET retention_days = ${value}`),
    );
  assert.throws(() =>
    f.store.updateStreamer('user123', {
      retentionDays: MAX_RETENTION_DAYS + 1,
    }),
  );
  assert.equal(
    (await f.call('PATCH', '/api/streamers/missing123', { retentionDays: 1 }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.call('POST', '/api/streamers', {
        streamerId: 'other123',
        retentionDays: MAX_RETENTION_DAYS,
      })
    ).json().retentionDays,
    MAX_RETENTION_DAYS,
  );
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  const before = f.chats.length;
  f.store.saveEvent(
    'user123',
    'expired',
    event('unknown', Date.now() - 100 * DAY_MS),
  );
  const changed = await f.call('PATCH', '/api/streamers/user123', {
    retentionDays: 30,
  });
  assert.equal(changed.json().retentionDays, 30);
  assert.equal(f.store.getStreamer('user123').room_password, 'room-secret');
  assert.equal(f.chats.length, before);
  assert.equal(chat?.disconnections, 0);
  assert.equal(f.store.findBroadcast('expired').broadcast_no, 'expired');
  await f.call('PATCH', '/api/streamers/user123', { roomPassword: null });
  await flush();
  assert.equal(f.store.getStreamer('user123').retention_days, 30);
  assert.equal(f.store.getStreamer('user123').room_password, null);
  assert.equal(f.chats.length, before);
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'changed',
    retentionDays: 7,
  });
  await flush();
  assert.equal(f.store.getStreamer('user123').retention_days, 7);
  assert.equal(f.chats.length, before);
  assert.equal(chat?.disconnections, 0);
  assert.equal(chat?.options.roomPassword, 'room-secret');
  assert.equal(
    (await f.call('POST', '/api/collection/stop/user123')).json().retentionDays,
    7,
  );
  assert.equal(
    (await f.call('POST', '/api/collection/stop')).json()[0].retentionDays,
    MAX_RETENTION_DAYS,
  );
  assert.equal(
    (await f.call('GET', '/api/streamers')).json()[1].retentionDays,
    7,
  );
  await f.call('DELETE', '/api/streamers/user123');
  assert.equal(f.store.getStreamer('user123', false).retention_days, 7);
  const registered = await f.call('POST', '/api/streamers', {
    streamerId: 'USER123',
  });
  assert.equal(registered.json().retentionDays, 7);
  assert.equal(registered.json().enabled, false);
  await f.call('DELETE', '/api/streamers/user123');
  assert.equal(
    (
      await f.call('POST', '/api/streamers', {
        streamerId: 'user123',
        retentionDays: 0,
      })
    ).json().retentionDays,
    0,
  );
});

test('retention runs at startup and daily, uses first collection time and deletes whole broadcasts at the boundary', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const f = await fixture(t);
  f.store.addStreamer('alpha123', null, 1);
  f.store.addStreamer('beta123', null, 2);
  f.store.addStreamer('forever1', null);
  f.store.addStreamer('archive1', null, 1);
  f.store.removeStreamer('archive1');
  f.store.saveEvent('alpha123', 'shared', event('chatMessage', now - DAY_MS));
  f.store.saveEvent('alpha123', 'old', event('chatMessage', now - 3 * DAY_MS));
  f.store.saveEvent('alpha123', 'old', event('chatMessage', now));
  f.store.saveEvent(
    'alpha123',
    'young',
    event('chatMessage', now - DAY_MS + 1),
  );
  f.store.saveEvent('beta123', 'shared', event('chatMessage', now - DAY_MS));
  f.store.saveEvent(
    'beta123',
    'beta-old',
    event('chatMessage', now - 2 * DAY_MS),
  );
  f.store.saveEvent(
    'forever1',
    'forever',
    event('chatMessage', now - 100 * DAY_MS),
  );
  f.store.saveEvent(
    'archive1',
    'archived',
    event('chatMessage', now - 100 * DAY_MS),
  );
  await f.app.ready();
  await flush(12);
  assert.deepEqual(
    f.store.listBroadcasts('alpha123').map((b) => b.broadcast_no),
    ['young'],
  );
  assert.deepEqual(
    f.store.listBroadcasts('beta123').map((b) => b.broadcast_no),
    ['shared'],
  );
  assert.equal(
    f.store
      .getDatabase('alpha123')
      .prepare('SELECT count(*) AS count FROM events')
      .get()?.count,
    1,
  );
  assert.equal(f.store.findBroadcast('forever').event_count, 1);
  assert.equal(f.store.findBroadcast('archived').event_count, 1);
  t.mock.timers.tick(DAY_MS - 1);
  await flush();
  assert.equal(f.store.findBroadcast('young').event_count, 1);
  t.mock.timers.tick(1);
  await flush(12);
  assert.deepEqual(f.store.listBroadcasts('alpha123'), []);
  assert.deepEqual(f.store.listBroadcasts('beta123'), []);
  assert.equal(
    f.store
      .getDatabase('alpha123')
      .prepare('SELECT count(*) AS count FROM events')
      .get()?.count,
    0,
  );
  await f.call('PATCH', '/api/streamers/forever1', { retentionDays: 1 });
  f.store.addStreamer('archive1', null);
  assert.equal(f.store.getStreamer('archive1').retention_days, 1);
  assert.equal(f.store.findBroadcast('forever').event_count, 1);
  assert.equal(f.store.findBroadcast('archived').event_count, 1);
  t.mock.timers.tick(DAY_MS - 1);
  await flush();
  assert.equal(f.store.findBroadcast('forever').event_count, 1);
  t.mock.timers.tick(1);
  await flush(12);
  assert.deepEqual(f.store.listBroadcasts(), []);
  f.store.saveEvent(
    'alpha123',
    'disabled-policy',
    event('chatMessage', Date.now() - 2 * DAY_MS),
  );
  await f.call('PATCH', '/api/streamers/alpha123', { retentionDays: 0 });
  t.mock.timers.tick(DAY_MS);
  await flush();
  assert.equal(f.store.findBroadcast('disabled-policy').event_count, 1);
});

test('retention protects resolving, collecting, retrying and asynchronous restart transitions until collection stops', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let resolveFirst: ((value: ReturnType<typeof channel>) => void) | undefined;
  let first = true;
  const f = await fixture(t, async () => {
    if (!first) return channel();
    first = false;
    return new Promise((resolve) => {
      resolveFirst = resolve;
    });
  });
  f.store.addStreamer('user123', null, 1);
  f.store.setEnabled('user123', true);
  f.store.saveEvent('user123', '1001', event('chatMessage', now - 2 * DAY_MS));
  f.store.saveEvent('user123', 'older', event('chatMessage', now - 2 * DAY_MS));
  await f.app.ready();
  await flush();
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'connecting',
  );
  assert.equal(f.store.listBroadcasts().length, 2);
  assert.ok(resolveFirst);
  resolveFirst(channel());
  await flush();
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'collecting',
  );
  t.mock.timers.tick(DAY_MS);
  await flush(12);
  assert.deepEqual(
    f.store.listBroadcasts().map((b) => b.broadcast_no),
    ['1001'],
  );
  const chat = f.chats[0];
  assert.ok(chat);
  chat.transition('closed');
  assert.equal(f.collector.canDeleteBroadcast('user123', '1001'), false);
  t.mock.timers.tick(DAY_MS);
  await flush();
  assert.equal(f.store.findBroadcast('1001').event_count, 3);
  let releaseDisconnect: (() => void) | undefined;
  const disconnect = chat.disconnect.bind(chat);
  t.mock.method(
    chat,
    'disconnect',
    () =>
      new Promise<void>((resolve) => {
        releaseDisconnect = () => {
          void disconnect().then(resolve);
        };
      }),
  );
  const changed = await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'changed',
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(chat.disconnections, 0);
  chat.transition('closed');
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.collector.runners.has('user123'), false);
  assert.equal(f.collector.canDeleteBroadcast('user123', '1001'), false);
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/1001')).statusCode,
    409,
  );
  t.mock.timers.tick(DAY_MS);
  await flush();
  assert.equal(f.store.findBroadcast('1001').event_count, 3);
  assert.ok(releaseDisconnect);
  releaseDisconnect();
  await flush();
  assert.equal(f.collector.canDeleteBroadcast('user123', '1001'), false);
  await f.call('POST', '/api/collection/stop/user123');
  assert.equal(f.collector.canDeleteBroadcast('user123', '1001'), true);
  t.mock.timers.tick(DAY_MS);
  await flush();
  assert.deepEqual(f.store.listBroadcasts(), []);
});

test('retention protection survives overlapping restarts and shutdown prevents a delayed restart', async (t) => {
  const f = await fixture(t);
  await f.call('POST', '/api/streamers', {
    streamerId: 'user123',
    retentionDays: 1,
  });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  assert.ok(chat);
  let releaseDisconnect: (() => void) | undefined;
  const disconnect = chat.disconnect.bind(chat);
  t.mock.method(
    chat,
    'disconnect',
    () =>
      new Promise<void>((resolve) => {
        releaseDisconnect = () => {
          void disconnect().then(resolve);
        };
      }),
  );
  const delayed = f.collector.restart('user123');
  await f.collector.restart('USER123');
  await flush();
  assert.equal(f.chats.length, 2);
  assert.equal(
    f.collector.canDeleteBroadcast('user123', 'another-broadcast'),
    false,
  );
  const databasePath = f.store.databasePath('user123');
  await f.app.close();
  assert.ok(releaseDisconnect);
  releaseDisconnect();
  await delayed;
  assert.equal(f.collector.runners.size, 0);
  assert.equal(f.chats.length, 2);
  assert.equal(
    f.collector.canDeleteBroadcast('user123', 'another-broadcast'),
    true,
  );
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      reader.prepare('SELECT count(*) AS count FROM broadcasts').get()?.count,
      1,
    );
  } finally {
    reader.close();
  }
});

test('retention failure leaves collection state unchanged and retries next day while other streamers are cleaned', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const f = await fixture(t);
  f.store.addStreamer('failed1', null, 1);
  f.store.addStreamer('other123', null, 1);
  f.store.saveEvent('failed1', 'failed', event('chatMessage', now - DAY_MS));
  f.store.saveEvent('other123', 'other', event('chatMessage', now - DAY_MS));
  const blocked = f.store.getDatabase('failed1');
  blocked.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON broadcasts BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  const logged = t.mock.method(f.app.log, 'error', () => {});
  await f.app.ready();
  await flush();
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0]?.arguments[0], {
    streamerId: 'failed1',
  });
  assert.equal(
    f.collector.status(f.store.getStreamer('failed1')).state,
    'stopped',
  );
  assert.equal(f.store.findBroadcast('failed').event_count, 1);
  assert.deepEqual(f.store.listBroadcasts('other123'), []);
  blocked.exec('DROP TRIGGER fail_delete');
  t.mock.timers.tick(DAY_MS);
  await flush();
  assert.deepEqual(f.store.listBroadcasts(), []);
  assert.equal(logged.mock.callCount(), 1);
});

test('retention yields between broadcasts, rechecks registration, does not overlap and cancels on shutdown', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const f = await fixture(t);
  f.store.addStreamer('archive1', null, 1);
  f.store.addStreamer('user123', null, 1);
  for (let index = 0; index < 20; index++) {
    f.store.saveEvent(
      'archive1',
      `archive-${index}`,
      event('chatMessage', now - DAY_MS),
    );
    f.store.saveEvent(
      'user123',
      `user-${index}`,
      event('chatMessage', now - DAY_MS),
    );
  }
  const original = f.backend.deleteBroadcast.bind(f.backend);
  let firstDeleted!: () => void;
  const firstDeletion = new Promise<void>((resolve) => {
    firstDeleted = resolve;
  });
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deletions = t.mock.method(
    f.backend,
    'deleteBroadcast',
    async (broadcast, signal) => {
      assert.equal(f.store.settings.isOpen, true);
      await original(broadcast, signal);
      if (broadcast.streamer_id === 'archive1') {
        await f.backend.removeStreamer('archive1');
        firstDeleted();
        await paused;
      }
    },
  );
  await f.app.ready();
  await firstDeletion;
  const initial = deletions.mock.callCount();
  assert.equal(initial, 1);
  t.mock.timers.tick(2 * DAY_MS);
  assert.equal(deletions.mock.callCount(), initial);
  await f.call('GET', '/api/streamers');
  assert.equal(f.store.listBroadcasts('archive1').length, 19);
  const databasePath = f.store.databasePath('user123');
  const closed = f.app.close();
  await setImmediate();
  release();
  await closed;
  const completed = deletions.mock.callCount();
  assert.ok(completed < 21);
  assert.equal(f.store.settings.isOpen, false);
  t.mock.timers.tick(3 * DAY_MS);
  await flush();
  assert.equal(deletions.mock.callCount(), completed);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.ok(
      Number(
        reader.prepare('SELECT count(*) AS count FROM broadcasts').get()?.count,
      ) > 0,
    );
  } finally {
    reader.close();
  }
});

test('offline retry at 10 seconds, event routing, broadcast rollover, storage error', async (t) => {
  let calls = 0;
  const f = await fixture(t, async (id) => {
    if (++calls === 1) throw new BroadcastOfflineError(id);
    return channel(calls === 2 ? '1001' : '1002');
  });
  await f.app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const streamer = f.store.addStreamer('user123', null);
  f.store.setEnabled('user123', true);
  f.collector.start(streamer);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.collector.status(streamer).state, 'waiting');
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  const chat = f.chats[0];
  assert.ok(chat);
  assert.equal(f.collector.status(streamer).state, 'collecting');
  chat.emit('event', event());
  const unknown = event('unknown');
  chat.emit('unknown', unknown as SoopChatEventMap['unknown']);
  chat.emit('event', unknown);
  chat.emit('protocolError', {
    error: new ProtocolError('bad packet'),
    raw: unknown.raw,
  });
  await flush();
  const db = f.store.getDatabase('user123');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count,
    4,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM events WHERE type='unknown'")
      .get()?.count,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE type='protocolError'",
      )
      .get()?.count,
    1,
  );
  assert.deepEqual(
    Array.from(
      db.prepare('SELECT raw_payload FROM events LIMIT 1').get()
        ?.raw_payload as Uint8Array,
    ),
    [0, 12, 255, 65],
  );
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 2);
  chat.end();
  await flush();
  assert.ok(f.store.findBroadcast('1001').ended_at);
  assert.ok(f.collector.canDeleteBroadcast('user123', '1001'));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 3);
  chat.emit('event', event());
  await flush();
  assert.equal(f.store.findBroadcast('1002').event_count, 2);
  chat.transition('closed');
  assert.equal(f.store.findBroadcast('1002').ended_at, null);
  assert.equal(f.collector.canDeleteBroadcast('user123', '1002'), false);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 4);
  assert.equal(f.store.findBroadcast('1002').event_count, 3);
  db.exec(
    "CREATE TRIGGER fail_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'blocked'); END",
  );
  const previousCount = f.store.findBroadcast('1002').event_count;
  chat.emit('event', event());
  await flush();
  assert.equal(f.collector.status(streamer).state, 'error');
  assert.equal(f.collector.status(streamer).lastError?.code, 'STORAGE_ERROR');
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls, 4);
  db.exec('DROP TRIGGER fail_insert');
  assert.equal(f.store.findBroadcast('1002').event_count, previousCount);
  f.collector.start(f.store.getStreamer('user123'));
  await flush();
  assert.equal(calls, 5);
  await f.collector.stop('user123');
  const count = f.store.findBroadcast('1002').event_count;
  f.chats.at(-1)?.emit('event', event());
  assert.equal(f.store.findBroadcast('1002').event_count, count);
  t.mock.timers.reset();
});

test('restricted authentication refreshes once and collects without a manual retry', async (t) => {
  let broadcastNo = '1001';
  let logins = 0;
  let invalidCookie = 'AuthTicket=ticket-1';
  let reason: 'adult' | 'subscriptionPlus' | 'loginRequired' = 'loginRequired';
  const cookies: (string | null)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      if (input.startsWith('https://login.sooplive.com/')) {
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get('szUid'), 'test-account');
        assert.equal(body.get('szPassword'), 'test-secret');
        return Response.json(
          { RESULT: 1 },
          {
            headers: { 'set-cookie': `AuthTicket=ticket-${++logins}; Path=/` },
          },
        );
      }
      assert.ok(input.startsWith('https://live.sooplive.com/'));
      const cookie = new Headers(init.headers).get('cookie');
      cookies.push(cookie);
      if (cookie === invalidCookie)
        return Response.json({
          CHANNEL: {
            RESULT:
              reason === 'adult'
                ? -6
                : reason === 'subscriptionPlus'
                  ? -14
                  : -1,
            REASON: reason === 'loginRequired' ? 'login required' : '',
          },
        });
      return Response.json({
        CHANNEL: {
          RESULT: 1,
          BNO: broadcastNo,
          CHATNO: '1',
          CHDOMAIN: 'localhost',
          CHPT: 8000,
          TK: 'chat-ticket',
          FTK: 'fan-ticket',
        },
      });
    },
  );
  const f = await fixture(t, null, [], async () => broadcastNo);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.call('PATCH', '/api/settings', {
    username: 'test-account',
    password: 'test-secret',
  });
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  assert.ok(chat);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'collecting',
  );
  assert.equal(logins, 2);
  assert.deepEqual(cookies, ['AuthTicket=ticket-1', 'AuthTicket=ticket-2']);
  for (const restriction of [
    'adult',
    'subscriptionPlus',
    'loginRequired',
  ] as const) {
    reason = restriction;
    invalidCookie = `AuthTicket=ticket-${logins}`;
    const previousLogins = logins;
    broadcastNo = String(Number(broadcastNo) + 1);
    chat.transition('closed');
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(logins, previousLogins + 1);
    assert.deepEqual(cookies.slice(-2), [
      invalidCookie,
      `AuthTicket=ticket-${logins}`,
    ]);
    assert.equal(
      f.collector.status(f.store.getStreamer('user123')).state,
      'collecting',
    );
    assert.equal(
      f.collector.status(f.store.getStreamer('user123')).lastError,
      null,
    );
    assert.equal(
      f.collector.status(f.store.getStreamer('user123')).broadcastNo,
      broadcastNo,
    );
    assert.equal(f.store.findBroadcast(broadcastNo).event_count, 1);
  }
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(cookies.length, 8);
  assert.equal(f.chats.length, 1);
});

test('restricted broadcasts wait for a new number; settings preserve the block and start retries the same broadcast', async (t) => {
  for (const reason of [
    'password',
    'subscriptionPlus',
    'adult',
    'loginRequired',
  ] as const) {
    await t.test(reason, async (t) => {
      const requestsPerConnection = reason === 'password' ? 1 : 2;
      const expectedLogins = Array<string>(requestsPerConnection).fill(
        'first-account',
      );
      let broadcastNo: string | null = '1001';
      let denied = true;
      let metadataFailure: 'http' | 'json' | 'number' | null = null;
      let polls = 0;
      let liveRequests = 0;
      let passwordChecks = 0;
      const logins: (string | null)[] = [];
      const passwords: (string | null)[] = [];
      t.mock.method(
        globalThis,
        'fetch',
        async (input: string, init: RequestInit) => {
          if (input.startsWith('https://api-channel.sooplive.com/')) {
            polls++;
            assert.equal(new Headers(init.headers).get('cookie'), null);
            assert.equal(init.body, undefined);
            if (metadataFailure === 'http')
              return new Response('', { status: 503 });
            if (metadataFailure === 'json') return new Response('{');
            if (metadataFailure === 'number')
              return Response.json({ broadNo: -1 });
            return broadcastNo === null
              ? new Response('')
              : Response.json({ broadNo: Number(broadcastNo) });
          }
          const body = new URLSearchParams(String(init.body));
          if (input.startsWith('https://login.sooplive.com/')) {
            logins.push(body.get('szUid'));
            return Response.json(
              { RESULT: 1 },
              { headers: { 'set-cookie': 'AuthTicket=ticket; Path=/' } },
            );
          }
          assert.ok(input.startsWith('https://live.sooplive.com/'));
          passwords.push(body.get('pwd'));
          if (body.get('type') === 'aid') {
            passwordChecks++;
            return Response.json({ CHANNEL: { RESULT: denied ? 0 : 1 } });
          }
          liveRequests++;
          if (denied && reason !== 'password')
            return Response.json({
              CHANNEL: {
                RESULT:
                  reason === 'adult'
                    ? -6
                    : reason === 'subscriptionPlus'
                      ? -14
                      : -1,
                REASON: reason === 'loginRequired' ? 'login required' : '',
              },
            });
          return Response.json({
            CHANNEL: {
              RESULT: 1,
              BNO: broadcastNo,
              CHATNO: '1',
              CHDOMAIN: 'localhost',
              CHPT: 8000,
              BPWD: reason === 'password' ? 'Y' : 'N',
              TK: 'ticket',
              FTK: 'fan-ticket',
            },
          });
        },
      );
      const f = await fixture(t, null, [], null);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      await f.call('PATCH', '/api/settings', {
        username: 'first-account',
        password: 'first-secret',
      });
      await f.call('POST', '/api/streamers', {
        streamerId: 'user123',
        roomPassword: 'wrong',
      });
      await f.call('POST', '/api/collection/start/user123');
      await flush();
      assert.equal(liveRequests, requestsPerConnection);
      assert.equal(polls, 1);
      assert.equal(passwordChecks, reason === 'password' ? 1 : 0);
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).state,
        'error',
      );
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).lastError?.code,
        'RESTRICTED_ROOM',
      );
      assert.equal(f.store.listBroadcasts().length, 0);
      t.mock.timers.tick(9999);
      await flush();
      assert.equal(polls, 1);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(polls, 2);
      await f.call('PATCH', '/api/streamers/user123', {
        roomPassword: 'updated',
      });
      await f.call('PATCH', '/api/settings', {
        username: 'second-account',
        password: 'second-secret',
      });
      // Neither going offline, returning with the same number nor invalid metadata unblocks access.
      for (const next of [null, '1001']) {
        broadcastNo = next;
        t.mock.timers.tick(10_000);
        await flush();
      }
      for (const failure of ['http', 'json', 'number'] as const) {
        metadataFailure = failure;
        t.mock.timers.tick(10_000);
        await flush();
      }
      metadataFailure = null;
      assert.equal(liveRequests, requestsPerConnection);
      assert.equal(passwordChecks, reason === 'password' ? 1 : 0);
      assert.deepEqual(logins, expectedLogins);
      assert.equal(
        f.chats.reduce((n, chat) => n + chat.connections, 0),
        1,
      );
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).lastError?.code,
        'RESTRICTED_ROOM',
      );
      await f.call('POST', '/api/collection/start/user123');
      await flush();
      assert.equal(liveRequests, requestsPerConnection * 2);
      assert.equal(passwordChecks, reason === 'password' ? 2 : 0);
      expectedLogins.push(
        ...Array<string>(requestsPerConnection).fill('second-account'),
      );
      assert.deepEqual(logins, expectedLogins);
      assert.equal(passwords.at(-1), 'updated');
      assert.equal(
        f.chats.reduce((n, chat) => n + chat.connections, 0),
        2,
      );
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).lastError?.code,
        'RESTRICTED_ROOM',
      );
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(liveRequests, requestsPerConnection * 2);
      broadcastNo = '1002';
      denied = false;
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(liveRequests, requestsPerConnection * 2 + 1);
      if (reason !== 'password') expectedLogins.push('second-account');
      assert.deepEqual(logins, expectedLogins);
      assert.equal(passwords.at(-1), 'updated');
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).state,
        'collecting',
      );
      assert.equal(
        f.collector.status(f.store.getStreamer('user123')).lastError,
        null,
      );
      assert.equal(f.store.findBroadcast('1002').event_count, 1);
      const collectingPolls = polls;
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(polls, collectingPolls);
      // A later denied broadcast receives its own block, independent of the old number.
      broadcastNo = '1003';
      denied = true;
      f.chats.at(-1)?.transition('closed');
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(liveRequests, requestsPerConnection * 3 + 1);
      assert.ok(f.store.findBroadcast('1002').ended_at);
      t.mock.timers.tick(10_000);
      await flush();
      assert.equal(liveRequests, requestsPerConnection * 3 + 1);
    });
  }
});

test('start APIs cancel a blocked poll, preserve broadcast history and keep connecting or collecting runners', async (t) => {
  let denied = true;
  let calls = 0;
  let broadcastNo = '1001';
  let pollSignal: AbortSignal | undefined;
  let resolveConnection:
    | ((value: ReturnType<typeof channel>) => void)
    | undefined;
  let polls = 0;
  const f = await fixture(
    t,
    async (id) => {
      if (id === 'other123') return channel('1002');
      if (++calls === 1) return channel();
      if (denied) throw new RestrictedRoomError('adult');
      return new Promise((resolve) => {
        resolveConnection = resolve;
      });
    },
    [],
    (id, signal) => {
      if (id === 'other123') return Promise.resolve('1002');
      if (++polls !== 3) return Promise.resolve(broadcastNo);
      pollSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const id of ['user123', 'other123'])
    await f.call('POST', '/api/streamers', { streamerId: id });
  await f.call('POST', '/api/collection/start');
  await flush();
  const blocked = f.chats.find((chat) => chat.streamerId === 'user123');
  const healthy = f.chats.find((chat) => chat.streamerId === 'other123');
  assert.ok(blocked && healthy);
  const firstCollectedAt = f.store.findBroadcast('1001').first_collected_at;
  blocked.transition('closed');
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).lastError?.code,
    'RESTRICTED_ROOM',
  );
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(pollSignal?.aborted, false);
  denied = false;
  broadcastNo = '1003';
  const started = await f.call('POST', '/api/collection/start');
  assert.equal(started.statusCode, 200);
  await flush();
  assert.equal(pollSignal?.aborted, true);
  assert.equal(blocked.disconnections, 1);
  assert.equal(healthy.disconnections, 0);
  assert.equal(healthy.connections, 1);
  assert.equal(f.chats.length, 3);
  assert.equal(f.store.getStreamer('user123').enabled, 1);
  const retry = f.chats[2];
  assert.ok(retry);
  assert.equal(retry.connections, 1);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'connecting',
  );
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).lastError,
    null,
  );
  assert.equal(f.collector.canDeleteBroadcast('user123', '1001'), false);
  await Promise.all([
    f.call('POST', '/api/collection/start/USER123'),
    f.call('POST', '/api/collection/start'),
  ]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.chats.length, 3);
  assert.equal(polls, 4);
  assert.ok(resolveConnection);
  resolveConnection(channel('1003'));
  await flush();
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'collecting',
  );
  assert.equal(f.store.findBroadcast('1001').event_count, 1);
  assert.ok(f.store.findBroadcast('1001').ended_at);
  assert.equal(f.store.findBroadcast('1003').event_count, 1);
  assert.equal(
    f.store.findBroadcast('1001').first_collected_at,
    firstCollectedAt,
  );
  await f.call('POST', '/api/collection/start');
  await flush();
  assert.equal(f.chats.length, 3);
  assert.equal(retry.connections, 1);
  assert.equal(retry.disconnections, 0);
});

test('ordinary connection failures retry at 10 seconds; one restricted streamer does not block another', async (t) => {
  const calls = new Map<string, number>();
  const f = await fixture(t, async (id) => {
    const count = (calls.get(id) ?? 0) + 1;
    calls.set(id, count);
    if (id === 'denied1') throw new RestrictedRoomError('unknown');
    if (count === 1) throw new Error('network error');
    return channel();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const id of ['denied1', 'user123']) {
    await f.call('POST', '/api/streamers', { streamerId: id });
    await f.call('POST', `/api/collection/start/${id}`);
  }
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.get('denied1'), 1);
  assert.equal(calls.get('user123'), 2);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'collecting',
  );
});

test('stop and shutdown abort pending broadcast-number polls and release retry timers', async (t) => {
  let polls = 0;
  let signal: AbortSignal | undefined;
  const f = await fixture(
    t,
    async () => {
      throw new RestrictedRoomError('password');
    },
    [],
    (_id, currentSignal) => {
      if (++polls === 1) return Promise.resolve('1001');
      signal = currentSignal;
      return new Promise((_resolve, reject) => {
        currentSignal.addEventListener(
          'abort',
          () => reject(currentSignal.reason),
          { once: true },
        );
      });
    },
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(signal?.aborted, false);
  await f.call('POST', '/api/collection/stop/user123');
  assert.equal(signal?.aborted, true);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(polls, 2);
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  assert.equal(signal?.aborted, false);
  await f.app.close();
  assert.equal(signal?.aborted, true);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(polls, 3);
  assert.equal(
    f.chats.reduce((n, chat) => n + chat.connections, 0),
    1,
  );
});

test('room password changes and clearing preserve collection and apply on automatic retry or a later start', async (t) => {
  const passwords: (string | undefined)[] = [];
  const f = await fixture(t, async (_id, context) => {
    passwords.push(context.roomPassword);
    return channel();
  });
  await f.app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.call('POST', '/api/streamers', {
    streamerId: 'user123',
    roomPassword: 'original',
  });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  for (const roomPassword of ['changed', null, 'restored']) {
    const chat = f.chats.at(-1);
    assert.ok(chat);
    const count = f.store.findBroadcast('1001').event_count;
    const response = await f.call('PATCH', '/api/streamers/user123', {
      roomPassword,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, 'collecting');
    assert.ok(!Object.hasOwn(response.json(), 'roomPasswordConfigured'));
    assert.equal(response.json().roomPassword, roomPassword);
    assert.equal(f.chats.at(-1), chat);
    assert.equal(chat.currentState, 'connected');
    assert.equal(chat.disconnections, 0);
    assert.equal(chat.connections, 1);
    chat.emit('event', event());
    await flush();
    assert.equal(f.store.findBroadcast('1001').event_count, count + 1);
    assert.equal(f.store.findBroadcast('1001').ended_at, null);
    chat.transition('closed');
    t.mock.timers.tick(9999);
    await flush();
    assert.equal(f.chats.at(-1), chat);
    t.mock.timers.tick(1);
    await flush();
    const reconnected = f.chats.at(-1);
    assert.ok(reconnected);
    assert.notEqual(reconnected, chat);
    assert.equal(reconnected.options.roomPassword, roomPassword ?? undefined);
    assert.equal(reconnected.currentState, 'connected');
    assert.equal(f.store.findBroadcast('1001').event_count, count + 2);
    assert.equal(f.store.findBroadcast('1001').ended_at, null);
  }
  const waiting = f.chats.at(-1);
  assert.ok(waiting);
  waiting.transition('closed');
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'intermediate',
  });
  await f.call('PATCH', '/api/streamers/user123', { roomPassword: 'latest' });
  assert.equal(f.chats.at(-1), waiting);
  assert.equal(waiting.disconnections, 0);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'latest');
  await f.call('POST', '/api/collection/stop/user123');
  const before = f.chats.length;
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'next-start',
  });
  assert.equal(f.chats.length, before);
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'next-start');
  assert.deepEqual(passwords, [
    'original',
    'changed',
    undefined,
    'restored',
    'latest',
    'next-start',
  ]);
});

test('room password updates do not cancel an in-flight connection and are used after it disconnects', async (t) => {
  const passwords: (string | undefined)[] = [];
  let finish: ((value: ReturnType<typeof channel>) => void) | undefined;
  const f = await fixture(t, async (_id, context) => {
    passwords.push(context.roomPassword);
    if (passwords.length > 1) return channel();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await f.app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  assert.ok(chat);
  const changed = await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'new-password',
  });
  assert.equal(changed.json().state, 'connecting');
  assert.equal(chat.controller.signal.aborted, false);
  assert.equal(chat.disconnections, 0);
  assert.equal(f.chats.length, 1);
  assert.ok(finish);
  finish(channel());
  await flush();
  assert.equal(chat.currentState, 'connected');
  chat.transition('closed');
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(passwords, [undefined, 'new-password']);
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'new-password');
});

test('account changes and clearing preserve collection and apply credentials on the next connection', async (t) => {
  const logins: { username: string | null; password: string | null }[] = [];
  const cookies: (string | null)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init: RequestInit) => {
      if (input.startsWith('https://login.sooplive.com/')) {
        const body = new URLSearchParams(String(init.body));
        const username = body.get('szUid');
        logins.push({ username, password: body.get('szPassword') });
        return Response.json(
          { RESULT: 1 },
          { headers: { 'set-cookie': `AuthTicket=${username}; Path=/` } },
        );
      }
      assert.ok(input.startsWith('https://live.sooplive.com/'));
      cookies.push(new Headers(init.headers).get('cookie'));
      return Response.json({
        CHANNEL: {
          RESULT: 1,
          BNO: '1001',
          CHATNO: '1',
          CHDOMAIN: 'localhost',
          CHPT: 8000,
          TK: 'ticket',
          FTK: 'fan-ticket',
        },
      });
    },
  );
  const f = await fixture(t, null);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.call('PATCH', '/api/settings', {
    username: 'first-account',
    password: 'first-secret',
  });
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const chat = f.chats[0];
  assert.ok(chat);
  for (const credentials of [
    { username: 'second-account', password: 'second-secret' },
    { username: null, password: null },
  ]) {
    const connections = chat.connections;
    const response = await f.call('PATCH', '/api/settings', credentials);
    assert.equal(response.statusCode, 200);
    await flush();
    assert.equal(f.chats.length, 1);
    assert.equal(chat.connections, connections);
    assert.equal(chat.disconnections, 0);
    assert.equal(chat.currentState, 'connected');
    assert.equal(
      f.collector.status(f.store.getStreamer('user123')).state,
      'collecting',
    );
    const count = f.store.findBroadcast('1001').event_count;
    chat.emit('event', event());
    await flush();
    assert.equal(f.store.findBroadcast('1001').event_count, count + 1);
    chat.transition('closed');
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(chat.connections, connections + 1);
    assert.equal(chat.currentState, 'connected');
  }
  assert.deepEqual(logins, [
    { username: 'first-account', password: 'first-secret' },
    { username: 'second-account', password: 'second-secret' },
  ]);
  assert.deepEqual(cookies, [
    'AuthTicket=first-account',
    'AuthTicket=second-account',
    null,
  ]);
});

test('start/stop idempotence, active deletion, reconnect configuration and automatic resume', async (t) => {
  let broadcastNo = '1001';
  const f = await fixture(t, async () => channel(broadcastNo));
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/streamers', { streamerId: 'other123' });
  assert.equal(
    (await f.call('POST', '/api/collection/start/user123')).statusCode,
    200,
  );
  await flush();
  await f.call('POST', '/api/collection/start/USER123');
  assert.equal(f.chats.length, 1);
  assert.equal(f.chats[0]?.options.reconnect, false);
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/1001')).statusCode,
    409,
  );
  const firstChat = f.chats[0];
  assert.ok(firstChat);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  broadcastNo = '1002';
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'new-room-password',
  });
  await flush();
  assert.equal(firstChat?.controller.signal.aborted, false);
  assert.equal(firstChat?.disconnections, 0);
  assert.equal(f.store.findBroadcast('1001').ended_at, null);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).broadcastNo,
    '1001',
  );
  const before = f.chats.length;
  await f.call('PATCH', '/api/settings', {
    username: 'user123',
    password: 'secret',
  });
  await flush();
  assert.equal(f.chats.length, before);
  firstChat.transition('closed');
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.chats.length, before + 1);
  assert.ok(firstChat.controller.signal.aborted);
  assert.ok(f.store.findBroadcast('1001').ended_at);
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'new-room-password');
  await f.app.close();
  assert.equal(f.store.settings.isOpen, false);
  const resumed = await f.open();
  await resumed.app.ready();
  await flush();
  assert.equal(
    resumed.collector.status(resumed.store.getStreamer('user123')).state,
    'collecting',
  );
  assert.equal(
    resumed.collector.status(resumed.store.getStreamer('other123')).state,
    'stopped',
  );
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'new-room-password');
  assert.ok(resumed.store.findBroadcast('1001').ended_at);
  assert.equal(
    resumed.collector.status(resumed.store.getStreamer('user123')).broadcastNo,
    '1002',
  );
  assert.equal(resumed.store.getStreamer('user123').enabled, 1);
  await resumed.app.inject({
    method: 'POST',
    url: '/api/collection/stop',
    headers,
  });
  await resumed.app.inject({
    method: 'POST',
    url: '/api/collection/stop',
    headers,
  });
  assert.ok(resumed.store.listStreamers().every((s) => s.enabled === 0));
  await resumed.app.inject({
    method: 'POST',
    url: '/api/collection/start',
    headers,
  });
  await flush();
  assert.ok(resumed.store.listStreamers().every((s) => s.enabled === 1));
  await resumed.app.inject({
    method: 'POST',
    url: '/api/streamers',
    headers,
    payload: { streamerId: 'new123' },
  });
  assert.equal(resumed.store.getStreamer('new123').enabled, 0);
});

test('stop cancels an in-flight resolver without late events or reactivation', async (t) => {
  let signal: AbortSignal | undefined;
  const f = await fixture(
    t,
    (_id, context) =>
      new Promise((resolve, reject) => {
        signal = context.signal;
        context.signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
        void resolve;
      }),
  );
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  f.store.saveEvent('user123', '1001', event());
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/1001')).statusCode,
    409,
  );
  assert.equal(
    (await f.call('POST', '/api/collection/stop/user123')).statusCode,
    200,
  );
  assert.equal(signal?.aborted, true);
  await flush();
  assert.equal(f.store.findBroadcast('1001').event_count, 1);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).state,
    'stopped',
  );
});

test('unpaginated lists, archive retention, duplicate broadcast conflicts and cascade deletion', async (t) => {
  const f = await fixture(t);
  for (const id of ['User123', 'other123']) f.store.addStreamer(id, null);
  for (let i = 0; i < 205; i++)
    f.store.saveEvent('User123', `${2000 + i}`, event('chatMessage', i + 1));
  assert.equal(
    (await f.call('GET', '/api/broadcasts/User123')).json().length,
    205,
  );
  assert.equal(
    (await f.call('GET', '/api/broadcasts')).json()[0].broadcast_no,
    '2204',
  );
  f.store.saveEvent('other123', '2000', event());
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/2000')).statusCode,
    409,
  );
  assert.equal(
    (await f.call('GET', '/api/broadcasts/2000/download?format=csv'))
      .statusCode,
    409,
  );
  assert.equal(
    (await f.call('DELETE', '/api/streamers/User123')).statusCode,
    204,
  );
  assert.equal((await f.call('GET', '/api/streamers')).json().length, 1);
  assert.equal(
    (await f.call('GET', '/api/broadcasts/user123')).json().length,
    205,
  );
  assert.equal(
    (await f.call('GET', '/api/broadcasts/2001/download?format=csv'))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await f.call('POST', '/api/query/user123', {
        sql: 'SELECT count(*) AS count FROM events',
      })
    ).json()[0].count,
    205,
  );
  assert.equal(
    (await f.call('POST', '/api/streamers', { streamerId: 'user123' }))
      .statusCode,
    201,
  );
  assert.equal(f.store.getStreamer('user123').streamer_id, 'User123');
  assert.ok(readdirSync(f.dataDir).includes('User123.db'));
  assert.ok(!readdirSync(f.dataDir).includes('user123.db'));
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/2001')).statusCode,
    204,
  );
  assert.equal(
    f.store
      .getDatabase('User123')
      .prepare("SELECT count(*) AS count FROM events WHERE broadcast_no='2001'")
      .get()?.count,
    0,
  );
  assert.equal(
    (await f.call('DELETE', '/api/broadcasts/missing')).statusCode,
    404,
  );
});

test('SQLite and CSV exports preserve the snapshot, DB column names, JSON and raw bytes', async (t) => {
  const f = await fixture(t);
  f.store.addStreamer('user123', null);
  f.store.saveEvent('user123', '1001', event());
  f.store.saveEvent('user123', '1002', event('unknown'));
  const csv = await f.call('GET', '/api/broadcasts/1001/download?format=csv');
  assert.equal(csv.statusCode, 200);
  assert.equal(
    csv.headers['content-disposition'],
    'attachment; filename="user123-1001.csv"',
  );
  assert.ok(
    csv.body.startsWith(
      '\uFEFFid,broadcast_no,type,opcode,received_at,data,raw_flags,raw_payload\r\n',
    ),
  );
  assert.ok(csv.body.includes('AAz/QQ=='));
  assert.ok(csv.body.includes('한글'));
  assert.ok(csv.body.includes('""message""'));
  const result = await f.call('GET', '/api/broadcasts/1001/download?format=db');
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.headers['content-disposition'],
    'attachment; filename="user123-1001.db"',
  );
  const download = join(f.dataDir, 'download.db');
  writeFileSync(download, result.rawPayload);
  const db = new DatabaseSync(download, { readOnly: true });
  try {
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM broadcasts').get()?.count,
      1,
    );
    assert.equal(
      db.prepare('SELECT broadcast_no FROM broadcasts').get()?.broadcast_no,
      '1001',
    );
    assert.deepEqual(
      Array.from(
        db.prepare('SELECT raw_payload FROM events').get()
          ?.raw_payload as Uint8Array,
      ),
      [0, 12, 255, 65],
    );
    assert.equal(
      db.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
    assert.equal(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum, 1);
    assert.equal(
      db.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'delete',
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('settings','streamers')",
        )
        .get()?.count,
      0,
    );
  } finally {
    db.close();
  }
  const reader = csvDownload(
    f.store.databasePath('user123'),
    f.store.findBroadcast('1001'),
  );
  const chunks: Buffer[] = [];
  const iterator = reader[Symbol.asyncIterator]();
  const header = await iterator.next();
  chunks.push(Buffer.from(header.value));
  f.store.saveEvent('user123', '1001', event('unknown'));
  f.store.deleteBroadcast(f.store.findBroadcast('1002'));
  assert.equal(
    f.store.getDatabase('user123').prepare('PRAGMA busy_timeout').get()
      ?.timeout,
    5000,
  );
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
  }
  assert.equal(Buffer.concat(chunks).toString().split('\r\n').length - 2, 1);
  await flush();
  const before = readdirSync(tmpdir()).filter((name) =>
    name.startsWith('soop-chat-collector-'),
  );
  const aborted = sqliteDownload(
    f.store.databasePath('user123'),
    f.store.findBroadcast('1001'),
  );
  const close = once(aborted, 'close');
  aborted.destroy();
  await close;
  assert.deepEqual(
    readdirSync(tmpdir()).filter(
      (name) =>
        name.startsWith('soop-chat-collector-') && !before.includes(name),
    ),
    [],
  );
  const cancelledCsv = csvDownload(
    f.store.databasePath('user123'),
    f.store.findBroadcast('1001'),
  );
  const csvClose = once(cancelledCsv, 'close');
  cancelledCsv.destroy();
  await csvClose;
  for (const format of ['json', 'sqlite'])
    assert.equal(
      (await f.call('GET', `/api/broadcasts/1001/download?format=${format}`))
        .statusCode,
      400,
    );
});

test('SELECT API supports CTE/JOIN/aggregates and rejects mutations, multiple statements and duplicate names', async (t) => {
  const f = await fixture(t);
  f.store.addStreamer('user123', null);
  f.store.saveEvent('user123', '1001', event());
  const query = (sql: string) => f.call('POST', '/api/query/user123', { sql });
  assert.deepEqual(
    (
      await query(
        'WITH e AS (SELECT * FROM events) SELECT b.broadcast_no AS broadcast, count(e.id) AS count FROM broadcasts b JOIN e ON e.broadcast_no=b.broadcast_no GROUP BY b.broadcast_no',
      )
    ).json(),
    [{ broadcast: '1001', count: 1 }],
  );
  assert.deepEqual((await query('SELECT * FROM events WHERE 0')).json(), []);
  assert.deepEqual(
    (
      await query(
        'SELECT 9223372036854775807 AS large, -9223372036854775808 AS negative, 42 AS small, NULL AS empty, raw_payload FROM events',
      )
    ).json(),
    [
      {
        large: '9223372036854775807',
        negative: '-9223372036854775808',
        small: 42,
        empty: null,
        raw_payload: 'AAz/QQ==',
      },
    ],
  );
  assert.equal(
    (await query('SELECT 1 AS a; /* trailing comment */')).statusCode,
    200,
  );
  for (const sql of [
    'DELETE FROM events RETURNING *',
    "UPDATE events SET type='changed' RETURNING *",
    'WITH e AS (SELECT 1) DELETE FROM events RETURNING *',
    'CREATE TABLE hacked(id INTEGER)',
    'DROP TABLE events',
    'PRAGMA table_info(events)',
    "SELECT * FROM pragma_table_info('events')",
    "ATTACH DATABASE ':memory:' AS other",
    'DETACH DATABASE main',
    "SELECT load_extension('anything')",
    'BEGIN',
    'VACUUM',
    'SELECT 1; DELETE FROM events',
    'SELECT 1; SELECT 2',
    'SELECT e.broadcast_no, b.broadcast_no FROM events e JOIN broadcasts b USING(broadcast_no)',
    'SELECT * FROM nonexistent',
    'SELECT * FROM settings',
  ])
    assert.equal((await query(sql)).statusCode, 400, sql);
  assert.equal(f.store.findBroadcast('1001').event_count, 1);
  assert.equal(
    (await f.call('POST', '/api/query/absent123', { sql: 'SELECT 1' }))
      .statusCode,
    404,
  );
});

test('long SELECT times out at 10 seconds while collection continues; cancellation and shutdown release processes', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t);
  await f.call('POST', '/api/streamers', { streamerId: 'user123' });
  await f.call('POST', '/api/collection/start/user123');
  await flush();
  const sql =
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n';
  const started = Date.now();
  const pending = f.call('POST', '/api/query/user123', { sql });
  await setTimeout(200);
  const previous = f.store.findBroadcast('1001').event_count;
  f.chats[0]?.emit('event', event());
  await flush();
  assert.equal(f.store.findBroadcast('1001').event_count, previous + 1);
  assert.equal((await f.call('GET', '/api/broadcasts')).statusCode, 200);
  const response = await pending;
  assert.equal(response.statusCode, 504);
  assert.ok(Date.now() - started >= 9900 && Date.now() - started < 13_000);
  const controller = new AbortController();
  const cancelled = runQuery(
    f.store.databasePath('user123'),
    sql,
    controller.signal,
  );
  const rejection = assert.rejects(
    cancelled,
    (error: unknown) => (error as { statusCode: number }).statusCode === 499,
  );
  await setTimeout(200);
  controller.abort();
  await rejection;
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const disconnected = new AbortController();
  const httpQuery = fetch(`${address}/api/query/user123`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal: disconnected.signal,
  });
  const httpRejection = assert.rejects(
    httpQuery,
    (error: unknown) => (error as Error).name === 'AbortError',
  );
  await setTimeout(200);
  disconnected.abort();
  await httpRejection;
  assert.equal(
    (
      await f.call('POST', '/api/query/user123', {
        sql: 'SELECT count(*) AS count FROM events',
      })
    ).statusCode,
    200,
  );
  await flush();
  assert.ok(!process.getActiveResourcesInfo().includes('ProcessWrap'));
  const shutdown = f.call('POST', '/api/query/user123', { sql });
  await setTimeout(200);
  await f.app.close();
  assert.equal((await shutdown).statusCode, 499);
  await flush();
  assert.ok(!process.getActiveResourcesInfo().includes('ProcessWrap'));
});
