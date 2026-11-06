import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deserialize, serialize } from 'node:v8';

import { configureDatabase } from './storage.ts';
import type { StoredEvent } from './types.ts';

export type QueuedWrite = { broadcastNo: string } & (
  | { event: Omit<StoredEvent, 'data'> & { data: string } }
  | { endedAt: number }
);

export type QueuedEntry = { id: number; write: QueuedWrite };

export class ChatQueue {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, '_chat-queue.db'));
    try {
      configureDatabase(this.db);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS queue_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          uuid TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS queued_writes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          streamer_id TEXT NOT NULL,
          broadcast_no TEXT NOT NULL,
          value BLOB NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS queued_writes_by_streamer
          ON queued_writes(streamer_id, id);
      `);
      this.db
        .prepare('INSERT OR IGNORE INTO queue_identity VALUES (1, ?)')
        .run(randomUUID());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  queueState() {
    return {
      source: this.db.prepare('SELECT uuid FROM queue_identity').get()
        ?.uuid as string,
      streamers: this.db
        .prepare('SELECT DISTINCT streamer_id FROM queued_writes')
        .all()
        .map((row) => row.streamer_id as string),
    };
  }

  appendWrites(streamerId: string, writes: QueuedWrite[]) {
    const insert = this.db.prepare(
      'INSERT INTO queued_writes (streamer_id, broadcast_no, value) VALUES (?, ?, ?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const write of writes)
        insert.run(streamerId, write.broadcastNo, serialize(write));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  nextWrites(streamerId: string): QueuedEntry[] {
    return this.db
      .prepare(`
      SELECT id, value FROM queued_writes WHERE streamer_id = ? ORDER BY id LIMIT 256
    `)
      .all(streamerId)
      .map((row) => ({
        id: row.id as number,
        write: deserialize(row.value as Uint8Array) as QueuedWrite,
      }));
  }

  discardWrites(streamerId: string, through: number) {
    this.db
      .prepare('DELETE FROM queued_writes WHERE streamer_id = ? AND id <= ?')
      .run(streamerId, through);
  }

  hasQueuedBroadcast(streamerId: string, broadcastNo: string) {
    return !!this.db
      .prepare(`
      SELECT 1 FROM queued_writes WHERE streamer_id = ? AND broadcast_no = ? LIMIT 1
    `)
      .get(streamerId, broadcastNo);
  }

  close() {
    this.db.close();
  }
}
