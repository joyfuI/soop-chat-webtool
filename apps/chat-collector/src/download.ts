import { createReadStream, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';

import {
  ApiError,
  type Broadcast,
  broadcastSchema,
  type Store,
} from './storage.ts';

const columns = [
  'id',
  'broadcast_no',
  'type',
  'opcode',
  'received_at',
  'data',
  'raw_flags',
  'raw_payload',
] as const;

export function sqliteDownload(store: Store, broadcast: Broadcast): Readable {
  const directory = mkdtempSync(join(tmpdir(), 'soop-chat-collector-'));
  const path = join(directory, 'broadcast.sqlite');
  const cleanup = () => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    rmdirSync(directory);
  };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec(
      'PRAGMA auto_vacuum = FULL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;',
    );
    db.exec(broadcastSchema);
    db.prepare('ATTACH DATABASE ? AS source').run(
      store.databasePath(broadcast.streamer_id),
    );
    // ponytail: synchronous archive copy; use a worker if large exports delay collection.
    db.exec('BEGIN');
    const result = db
      .prepare(
        'INSERT INTO broadcasts SELECT * FROM source.broadcasts WHERE broadcast_no = ?',
      )
      .run(broadcast.broadcast_no);
    if (!result.changes) throw new ApiError(404, '방송을 찾을 수 없습니다.');
    db.prepare(
      'INSERT INTO events SELECT * FROM source.events WHERE broadcast_no = ? ORDER BY id',
    ).run(broadcast.broadcast_no);
    db.exec('COMMIT; DETACH DATABASE source;');
    db.close();
    db = undefined;
    const stream = createReadStream(path);
    stream.once('close', cleanup);
    return stream;
  } catch (error) {
    db?.close();
    cleanup();
    throw error;
  }
}

export function csvDownload(store: Store, broadcast: Broadcast): Readable {
  const db = new DatabaseSync(store.databasePath(broadcast.streamer_id), {
    readOnly: true,
  });
  let closed = false;
  const cleanup = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };
  try {
    db.exec('BEGIN');
    if (
      !db
        .prepare('SELECT 1 FROM broadcasts WHERE broadcast_no = ?')
        .get(broadcast.broadcast_no)
    )
      throw new ApiError(404, '방송을 찾을 수 없습니다.');
    const statement = db.prepare(
      'SELECT * FROM events WHERE broadcast_no = ? ORDER BY id',
    );
    const stream = Readable.from(
      (async function* () {
        try {
          yield `\uFEFF${columns.join(',')}\r\n`;
          let count = 0;
          for (const row of statement.iterate(broadcast.broadcast_no)) {
            yield `${columns
              .map((column) => {
                const value =
                  column === 'raw_payload'
                    ? Buffer.from(row[column] as Uint8Array).toString('base64')
                    : String(row[column] ?? '');
                return `"${value.replaceAll('"', '""')}"`;
              })
              .join(',')}\r\n`;
            if (++count % 256 === 0) await setImmediate();
          }
        } finally {
          cleanup();
        }
      })(),
      { objectMode: false },
    );
    stream.once('close', cleanup);
    return stream;
  } catch (error) {
    cleanup();
    throw error;
  }
}
