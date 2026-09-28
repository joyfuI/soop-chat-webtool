import { constants, DatabaseSync } from 'node:sqlite';

import type { DatabaseJob } from './query.ts';
import {
  ApiError,
  configureDatabase,
  deleteStoredBroadcast,
} from './storage.ts';

process.once('message', (request) => {
  const job = request as DatabaseJob;
  let db: DatabaseSync | undefined;
  let result: {
    ok: boolean;
    rows?: Record<string, unknown>[];
    message?: string;
    statusCode?: number;
  };
  try {
    if (job.operation === 'delete') {
      db = new DatabaseSync(job.path);
      configureDatabase(db);
      deleteStoredBroadcast(db, job.broadcastNo);
      result = { ok: true };
    } else {
      const { path, sql } = job;
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      const allowed = new Set([
        constants.SQLITE_SELECT,
        constants.SQLITE_READ,
        constants.SQLITE_FUNCTION,
        constants.SQLITE_RECURSIVE,
      ]);
      let select = false;
      db.setAuthorizer((action, _arg1, arg2) => {
        if (action === constants.SQLITE_SELECT) select = true;
        if (
          action === constants.SQLITE_FUNCTION &&
          arg2?.toLowerCase() === 'load_extension'
        )
          return constants.SQLITE_DENY;
        return allowed.has(action)
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
      });
      const statement = db.prepare(sql);
      const tail = sql.slice(statement.sourceSQL.length);
      if (
        !select ||
        !/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*$/.test(tail)
      ) {
        throw new Error('단일 SELECT 문장만 사용할 수 있습니다.');
      }
      const columns = statement.columns().map((column) => column.name);
      if (new Set(columns).size !== columns.length)
        throw new Error('중복 컬럼명에는 SQL 별칭이 필요합니다.');
      statement.setReadBigInts(true);
      const rows = statement
        .all()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === 'bigint'
                ? value >= BigInt(Number.MIN_SAFE_INTEGER) &&
                  value <= BigInt(Number.MAX_SAFE_INTEGER)
                  ? Number(value)
                  : value.toString()
                : value instanceof Uint8Array
                  ? Buffer.from(value).toString('base64')
                  : value,
            ]),
          ),
        );
      result = { ok: true, rows };
    }
  } catch (error) {
    result = {
      ok: false,
      statusCode:
        error instanceof ApiError
          ? error.statusCode
          : job.operation === 'query'
            ? 400
            : 500,
      message:
        job.operation === 'query' || error instanceof ApiError
          ? error instanceof Error
            ? error.message
            : 'SELECT 실행에 실패했습니다.'
          : '방송 삭제에 실패했습니다.',
    };
  } finally {
    db?.close();
  }
  process.send?.(result, () => process.disconnect?.());
});
