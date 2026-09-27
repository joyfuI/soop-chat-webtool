import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import {
  BroadcastOfflineError,
  type ChannelResolver,
  type ConnectionState,
  type NodeSoopChatOptions,
  ProtocolError,
  SoopChat,
  type SoopChatEventMap,
  type SoopChatEventType,
  type SoopChatListener,
  type SoopEvent,
} from 'soop-chat';

import { buildApp } from '../src/app.ts';
import { csvDownload, sqliteDownload } from '../src/download.ts';
import { runQuery } from '../src/query.ts';
import { DAY_MS, MAX_RETENTION_DAYS } from '../src/storage.ts';

const headers = { authorization: 'Bearer test-api-key' };
const key = Buffer.alloc(32, 7);
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
  resolver: ChannelResolver = async () => channel(),
  corsOrigins: string[] = [],
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  const chats: FakeChat[] = [];
  const options = {
    apiKey: 'test-api-key',
    secretKey: key,
    dataDir,
    corsOrigins,
    resolveChannel: resolver,
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
    return context;
  };
  const context = await open();
  t.after(async () => {
    for (const current of contexts.reverse()) await current.app.close();
    for (const name of readdirSync(dataDir)) {
      try {
        unlinkSync(join(dataDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    rmdirSync(dataDir);
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

async function flush(turns = 2) {
  for (let turn = 0; turn < turns; turn++) await setImmediate();
}

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
  assert.ok(
    !(await f.call('GET', '/api/streamers')).body.includes('room-secret'),
  );
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
  assert.equal(f.chats.length, before + 1);
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'changed',
    retentionDays: 7,
  });
  await flush();
  assert.equal(f.store.getStreamer('user123').retention_days, 7);
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'changed');
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
  const pending = f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'changed',
  });
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
  assert.equal((await pending).statusCode, 200);
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
  blocked.exec('PRAGMA query_only = ON');
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
  blocked.exec('PRAGMA query_only = OFF');
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
  const original = f.store.deleteBroadcast.bind(f.store);
  const deletions = t.mock.method(f.store, 'deleteBroadcast', (broadcast) => {
    assert.equal(f.store.settings.isOpen, true);
    original(broadcast);
    if (broadcast.streamer_id === 'archive1')
      queueMicrotask(() => f.store.removeStreamer('archive1'));
  });
  await f.app.ready();
  const initial = deletions.mock.callCount();
  assert.equal(initial, 1);
  t.mock.timers.tick(2 * DAY_MS);
  assert.equal(deletions.mock.callCount(), initial);
  await flush();
  assert.equal(f.store.listBroadcasts('archive1').length, 19);
  assert.ok(deletions.mock.callCount() > initial);
  const databasePath = f.store.databasePath('user123');
  await f.app.close();
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
  assert.ok(f.store.findBroadcast('1001').ended_at);
  assert.ok(f.collector.canDeleteBroadcast('user123', '1001'));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 3);
  chat.emit('event', event());
  assert.equal(f.store.findBroadcast('1002').event_count, 2);
  chat.transition('closed');
  assert.equal(f.store.findBroadcast('1002').ended_at, null);
  assert.equal(f.collector.canDeleteBroadcast('user123', '1002'), false);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 4);
  assert.equal(f.store.findBroadcast('1002').event_count, 3);
  db.exec('PRAGMA query_only = ON');
  const previousCount = f.store.findBroadcast('1002').event_count;
  chat.emit('event', event());
  assert.equal(f.collector.status(streamer).state, 'error');
  assert.equal(f.collector.status(streamer).lastError?.code, 'STORAGE_ERROR');
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(calls, 4);
  db.exec('PRAGMA query_only = OFF');
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
  broadcastNo = '1002';
  await f.call('PATCH', '/api/streamers/user123', {
    roomPassword: 'new-room-password',
  });
  await flush();
  assert.ok(firstChat?.controller.signal.aborted);
  assert.ok(f.store.findBroadcast('1001').ended_at);
  assert.equal(
    f.collector.status(f.store.getStreamer('user123')).broadcastNo,
    '1002',
  );
  assert.equal(f.chats.at(-1)?.options.roomPassword, 'new-room-password');
  const before = f.chats.length;
  await f.call('PATCH', '/api/settings', {
    username: 'user123',
    password: 'secret',
  });
  await flush();
  assert.equal(f.chats.length, before + 1);
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
  assert.ok(
    csv.body.startsWith(
      '\uFEFFid,broadcast_no,type,opcode,received_at,data,raw_flags,raw_payload\r\n',
    ),
  );
  assert.ok(csv.body.includes('AAz/QQ=='));
  assert.ok(csv.body.includes('한글'));
  assert.ok(csv.body.includes('""message""'));
  const result = await f.call(
    'GET',
    '/api/broadcasts/1001/download?format=sqlite',
  );
  assert.equal(result.statusCode, 200);
  const download = join(f.dataDir, 'download.sqlite');
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
  const reader = csvDownload(f.store, f.store.findBroadcast('1001'));
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
  const aborted = sqliteDownload(f.store, f.store.findBroadcast('1001'));
  const close = once(aborted, 'close');
  aborted.destroy();
  await close;
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) =>
      name.startsWith('soop-chat-collector-'),
    ),
    before,
  );
  const cancelledCsv = csvDownload(f.store, f.store.findBroadcast('1001'));
  const csvClose = once(cancelledCsv, 'close');
  cancelledCsv.destroy();
  await csvClose;
  assert.equal(
    (await f.call('GET', '/api/broadcasts/1001/download?format=json'))
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
