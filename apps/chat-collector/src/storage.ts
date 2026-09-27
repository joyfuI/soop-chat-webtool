import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RawPacket } from 'soop-chat';

export const DAY_MS = 86_400_000;
export const MAX_RETENTION_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS);

function validateRetentionDays(days: number) {
  if (!Number.isSafeInteger(days) || days < 0 || days > MAX_RETENTION_DAYS)
    throw new ApiError(400, '채팅 보존 일수가 올바르지 않습니다.');
}

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type Streamer = {
  streamer_id: string;
  room_password: string | null;
  retention_days: number;
  registered: number;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type Broadcast = {
  broadcast_no: string;
  streamer_id: string;
  first_collected_at: number;
  last_collected_at: number;
  ended_at: number | null;
  event_count: number;
};

export type StoredEvent = {
  type: string;
  opcode: string;
  receivedAt: number;
  data: unknown;
  raw: Pick<RawPacket, 'flags' | 'payload'>;
};

export const broadcastSchema = `
  CREATE TABLE IF NOT EXISTS broadcasts (
    broadcast_no TEXT PRIMARY KEY NOT NULL,
    streamer_id TEXT NOT NULL,
    first_collected_at INTEGER NOT NULL,
    last_collected_at INTEGER NOT NULL,
    ended_at INTEGER,
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    CHECK (length(broadcast_no) > 0),
    CHECK (length(streamer_id) BETWEEN 6 AND 12
      AND streamer_id NOT GLOB '*[^A-Za-z0-9]*')
  ) STRICT;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    broadcast_no TEXT NOT NULL REFERENCES broadcasts(broadcast_no) ON DELETE CASCADE,
    type TEXT NOT NULL,
    opcode TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    raw_flags TEXT NOT NULL,
    raw_payload BLOB NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS broadcasts_by_collected_at
    ON broadcasts(first_collected_at DESC, broadcast_no ASC);
  CREATE INDEX IF NOT EXISTS events_by_broadcast ON events(broadcast_no, id);
`;

export function configureDatabase(db: DatabaseSync) {
  const previous = db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum;
  db.exec('PRAGMA auto_vacuum = FULL');
  if (
    previous === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1").get()
  ) {
    db.exec('VACUUM');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
  `);
}

export function initializeSettings(db: DatabaseSync) {
  configureDatabase(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      soop_username TEXT,
      soop_password_ciphertext BLOB,
      soop_password_iv BLOB,
      soop_password_tag BLOB,
      updated_at INTEGER NOT NULL,
      CHECK (
        (soop_username IS NULL AND soop_password_ciphertext IS NULL
          AND soop_password_iv IS NULL AND soop_password_tag IS NULL)
        OR
        (soop_username IS NOT NULL AND length(trim(soop_username)) > 0
          AND soop_password_ciphertext IS NOT NULL AND length(soop_password_ciphertext) > 0
          AND soop_password_iv IS NOT NULL AND length(soop_password_iv) = 12
          AND soop_password_tag IS NOT NULL AND length(soop_password_tag) = 16)
      )
    ) STRICT;
    CREATE TABLE IF NOT EXISTS streamers (
      streamer_id TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
      room_password TEXT,
      retention_days INTEGER NOT NULL DEFAULT 0 CHECK (retention_days >= 0),
      registered INTEGER NOT NULL DEFAULT 1 CHECK (registered IN (0, 1)),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (length(streamer_id) BETWEEN 6 AND 12
        AND streamer_id NOT GLOB '*[^A-Za-z0-9]*'),
      CHECK (room_password IS NULL OR length(room_password) > 0),
      CHECK (registered = 1 OR enabled = 0)
    ) STRICT;
  `);
  db.prepare(
    'INSERT OR IGNORE INTO settings (id, updated_at) VALUES (1, ?)',
  ).run(Date.now());
}

export class Store {
  readonly dataDir: string;
  readonly settings: DatabaseSync;
  readonly secretKey: Buffer;
  readonly databases = new Map<
    string,
    {
      streamerId: string;
      db: DatabaseSync;
      broadcast: ReturnType<DatabaseSync['prepare']>;
      event: ReturnType<DatabaseSync['prepare']>;
    }
  >();

  constructor(settings: DatabaseSync, dataDir: string, secretKey: Buffer) {
    this.settings = settings;
    this.dataDir = dataDir;
    this.secretKey = secretKey;
  }

  listStreamers(registeredOnly = true): Streamer[] {
    return this.settings
      .prepare(
        `SELECT * FROM streamers ${registeredOnly ? 'WHERE registered = 1' : ''} ORDER BY streamer_id COLLATE NOCASE`,
      )
      .all() as Streamer[];
  }

  getStreamer(id: string, registeredOnly = true): Streamer {
    const row = this.settings
      .prepare('SELECT * FROM streamers WHERE streamer_id = ?')
      .get(id) as Streamer | undefined;
    if (!row || (registeredOnly && !row.registered))
      throw new ApiError(404, '스트리머를 찾을 수 없습니다.');
    return row;
  }

  addStreamer(
    id: string,
    password: string | null,
    retentionDays?: number,
  ): Streamer {
    if (!/^[A-Za-z0-9]{6,12}$/.test(id))
      throw new ApiError(400, '스트리머 ID가 올바르지 않습니다.');
    const previous = this.settings
      .prepare('SELECT * FROM streamers WHERE streamer_id = ?')
      .get(id) as Streamer | undefined;
    if (previous?.registered)
      throw new ApiError(409, '이미 등록된 스트리머입니다.');
    const canonical = previous?.streamer_id ?? id;
    const days = retentionDays ?? previous?.retention_days ?? 0;
    validateRetentionDays(days);
    this.getDatabase(canonical);
    const now = Date.now();
    this.settings
      .prepare(`
      INSERT INTO streamers (streamer_id, room_password, retention_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(streamer_id) DO UPDATE SET room_password = excluded.room_password,
        retention_days = excluded.retention_days,
        registered = 1, enabled = 0, updated_at = excluded.updated_at
    `)
      .run(canonical, password, days, now, now);
    return this.getStreamer(canonical);
  }

  updateStreamer(
    id: string,
    changes: { roomPassword?: string | null; retentionDays?: number },
  ) {
    const streamer = this.getStreamer(id);
    const days = changes.retentionDays ?? streamer.retention_days;
    validateRetentionDays(days);
    this.settings
      .prepare(
        'UPDATE streamers SET room_password = ?, retention_days = ?, updated_at = ? WHERE streamer_id = ?',
      )
      .run(
        changes.roomPassword === undefined
          ? streamer.room_password
          : changes.roomPassword,
        days,
        Date.now(),
        streamer.streamer_id,
      );
  }

  setEnabled(id: string, enabled: boolean) {
    this.settings
      .prepare(
        'UPDATE streamers SET enabled = ?, updated_at = ? WHERE streamer_id = ?',
      )
      .run(Number(enabled), Date.now(), this.getStreamer(id).streamer_id);
  }

  removeStreamer(id: string) {
    this.settings
      .prepare(
        'UPDATE streamers SET registered = 0, enabled = 0, room_password = NULL, updated_at = ? WHERE streamer_id = ?',
      )
      .run(Date.now(), this.getStreamer(id).streamer_id);
  }

  getSettings() {
    const row = this.settings
      .prepare('SELECT soop_username FROM settings WHERE id = 1')
      .get();
    return {
      username: row?.soop_username ?? null,
      passwordConfigured: Boolean(row?.soop_username),
    };
  }

  getCredentials(): { username: string; password: string } | undefined {
    const row = this.settings
      .prepare('SELECT * FROM settings WHERE id = 1')
      .get();
    if (!row || row.soop_username === null) return undefined;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.secretKey,
      row.soop_password_iv as Uint8Array,
    );
    decipher.setAuthTag(row.soop_password_tag as Uint8Array);
    const password = Buffer.concat([
      decipher.update(row.soop_password_ciphertext as Uint8Array),
      decipher.final(),
    ]).toString('utf8');
    return { username: row.soop_username as string, password };
  }

  updateCredentials(username: string | null, password: string | null) {
    let encrypted: Buffer | null = null;
    let iv: Buffer | null = null;
    let tag: Buffer | null = null;
    if (username !== null && password !== null) {
      iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.secretKey, iv);
      encrypted = Buffer.concat([
        cipher.update(password, 'utf8'),
        cipher.final(),
      ]);
      tag = cipher.getAuthTag();
    }
    this.settings
      .prepare(
        'UPDATE settings SET soop_username = ?, soop_password_ciphertext = ?, soop_password_iv = ?, soop_password_tag = ?, updated_at = ? WHERE id = 1',
      )
      .run(username, encrypted, iv, tag, Date.now());
  }

  databasePath(id: string): string {
    return join(this.dataDir, `${this.getStreamer(id, false).streamer_id}.db`);
  }

  getDatabase(id: string): DatabaseSync {
    if (!/^[A-Za-z0-9]{6,12}$/.test(id))
      throw new ApiError(400, '스트리머 ID가 올바르지 않습니다.');
    const cacheKey = id.toLowerCase();
    let entry = this.databases.get(cacheKey);
    if (!entry) {
      const canonical = this.settings
        .prepare('SELECT streamer_id FROM streamers WHERE streamer_id = ?')
        .get(id)?.streamer_id as string | undefined;
      mkdirSync(this.dataDir, { recursive: true });
      const db = new DatabaseSync(join(this.dataDir, `${canonical ?? id}.db`));
      try {
        configureDatabase(db);
        db.exec(broadcastSchema);
        entry = {
          streamerId: canonical ?? id,
          db,
          broadcast: db.prepare(`
            INSERT INTO broadcasts VALUES (?, ?, ?, ?, NULL, 1)
            ON CONFLICT(broadcast_no) DO UPDATE SET
              first_collected_at = MIN(first_collected_at, excluded.first_collected_at),
              last_collected_at = MAX(last_collected_at, excluded.last_collected_at),
              ended_at = NULL, event_count = event_count + 1
          `),
          event: db.prepare(
            'INSERT INTO events (broadcast_no, type, opcode, received_at, data, raw_flags, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ),
        };
        this.databases.set(cacheKey, entry);
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return entry.db;
  }

  saveEvent(id: string, broadcastNo: string, event: StoredEvent) {
    const db = this.getDatabase(id);
    const entry = this.databases.get(id.toLowerCase());
    if (!entry) throw new Error('방송 DB가 열려 있지 않습니다.');
    const data = JSON.stringify(event.data);
    if (data === undefined) throw new Error('이벤트 데이터가 없습니다.');
    db.exec('BEGIN IMMEDIATE');
    try {
      entry.broadcast.run(
        broadcastNo,
        entry.streamerId,
        event.receivedAt,
        event.receivedAt,
      );
      entry.event.run(
        broadcastNo,
        event.type,
        event.opcode,
        event.receivedAt,
        data,
        event.raw.flags,
        event.raw.payload,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  markEnded(id: string, broadcastNo: string) {
    this.getDatabase(id)
      .prepare(
        'UPDATE broadcasts SET ended_at = ? WHERE broadcast_no = ? AND ended_at IS NULL',
      )
      .run(Date.now(), broadcastNo);
  }

  listBroadcasts(id?: string): Broadcast[] {
    const streamers = id
      ? [this.getStreamer(id, false)]
      : this.listStreamers(false);
    return streamers
      .flatMap(
        (streamer) =>
          this.getDatabase(streamer.streamer_id)
            .prepare('SELECT * FROM broadcasts')
            .all() as Broadcast[],
      )
      .sort(
        (a, b) =>
          b.first_collected_at - a.first_collected_at ||
          a.streamer_id.localeCompare(b.streamer_id) ||
          a.broadcast_no.localeCompare(b.broadcast_no),
      );
  }

  findBroadcast(broadcastNo: string): Broadcast {
    const matches: Broadcast[] = [];
    for (const streamer of this.listStreamers(false)) {
      const row = this.getDatabase(streamer.streamer_id)
        .prepare('SELECT * FROM broadcasts WHERE broadcast_no = ?')
        .get(broadcastNo) as Broadcast | undefined;
      if (row) matches.push(row);
    }
    if (!matches.length) throw new ApiError(404, '방송을 찾을 수 없습니다.');
    if (matches.length > 1)
      throw new ApiError(409, '여러 스트리머 DB에 같은 방송 번호가 있습니다.');
    return matches[0] as Broadcast;
  }

  listExpiredBroadcasts(id: string, cutoff: number): Broadcast[] {
    return this.getDatabase(id)
      .prepare(
        'SELECT * FROM broadcasts WHERE first_collected_at <= ? ORDER BY first_collected_at ASC, broadcast_no ASC',
      )
      .all(cutoff) as Broadcast[];
  }

  deleteBroadcast(broadcast: Broadcast) {
    const db = this.getDatabase(broadcast.streamer_id);
    db.prepare('DELETE FROM broadcasts WHERE broadcast_no = ?').run(
      broadcast.broadcast_no,
    );
    // Readers may defer truncation; deleted pages remain reusable in the meantime.
    db.exec('PRAGMA busy_timeout = 0');
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.exec('PRAGMA busy_timeout = 5000');
    }
  }

  close() {
    for (const { db } of this.databases.values()) db.close();
    this.databases.clear();
  }
}
