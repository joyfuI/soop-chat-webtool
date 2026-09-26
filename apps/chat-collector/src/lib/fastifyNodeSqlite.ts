import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export type SqliteValue =
  | null
  | number
  | bigint
  | string
  | Buffer
  | ArrayBufferView;

export type SqliteNamedParameters = Record<string, SqliteValue>;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

export interface FastifySqlite {
  /**
   * node:sqlite 원본 DatabaseSync 인스턴스.
   * 단, db.prepare()를 직접 쓰면 플러그인의 statement 옵션이 자동 적용되지 않는다.
   * bare named parameter 옵션까지 적용하려면 app.sqlite.prepare()를 쓰는 것을 권장한다.
   */
  db: DatabaseSync;

  exec(sql: string): void;

  prepare(sql: string): SqliteStatement;

  run(sql: string, ...anonymousParameters: SqliteValue[]): SqliteRunResult;
  run(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): SqliteRunResult;

  get<T = Record<string, unknown>>(
    sql: string,
    ...anonymousParameters: SqliteValue[]
  ): T | undefined;
  get<T = Record<string, unknown>>(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): T | undefined;

  all<T = Record<string, unknown>>(
    sql: string,
    ...anonymousParameters: SqliteValue[]
  ): T[];
  all<T = Record<string, unknown>>(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): T[];
}

export interface FastifyNodeSqliteOptions {
  /**
   * 예: './app.db', ':memory:'
   */
  path: string | Buffer | URL;

  /**
   * 기본값 true.
   * 파일 DB에서 WAL 모드를 활성화한다.
   */
  wal?: boolean;

  /**
   * 기본값 true.
   */
  foreignKeys?: boolean;

  /**
   * SQLite lock 대기 시간.
   * 예: 5000
   */
  busyTimeoutMs?: number;

  /**
   * true면 SQL은 :name처럼 쓰고,
   * JS 객체는 { name: value }처럼 prefix 없이 넘길 수 있다.
   *
   * 예:
   * app.sqlite.run(
   *   'INSERT INTO users (name) VALUES (:name)',
   *   { name: 'kim' },
   * );
   */
  allowBareNamedParameters?: boolean;

  /**
   * true면 전달한 named parameter 객체에 SQL에서 쓰지 않는 키가 있어도 무시한다.
   * 기본적으로는 node:sqlite가 알 수 없는 named parameter에 대해 예외를 던진다.
   */
  allowUnknownNamedParameters?: boolean;

  /**
   * WAL/PRAGMA 적용 후 실행할 초기화 코드.
   * 테이블 생성이나 간단한 마이그레이션에 사용하면 된다.
   */
  setup?: (db: DatabaseSync) => void | Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    sqlite: FastifySqlite;
  }
}

const sqlitePlugin: FastifyPluginAsync<FastifyNodeSqliteOptions> = async (
  fastify,
  options,
) => {
  const db = new DatabaseSync(options.path);
  let closed = false;

  const close = () => {
    if (!closed) {
      db.close();
      closed = true;
    }
  };

  const applyStatementOptions = (statement: SqliteStatement) => {
    if (typeof options.allowBareNamedParameters === 'boolean') {
      statement.setAllowBareNamedParameters(options.allowBareNamedParameters);
    }

    if (typeof options.allowUnknownNamedParameters === 'boolean') {
      statement.setAllowUnknownNamedParameters(
        options.allowUnknownNamedParameters,
      );
    }

    return statement;
  };

  const prepare = (sql: string) => {
    return applyStatementOptions(db.prepare(sql));
  };

  const callStatement = <T>(
    sql: string,
    method: 'run' | 'get' | 'all',
    parameters: unknown[],
  ): T => {
    const statement = prepare(sql);
    const executor = statement[method] as (
      this: SqliteStatement,
      ...args: unknown[]
    ) => unknown;

    return executor.apply(statement, parameters) as T;
  };

  function run(
    sql: string,
    ...anonymousParameters: SqliteValue[]
  ): SqliteRunResult;
  function run(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): SqliteRunResult;
  function run(sql: string, ...parameters: unknown[]): SqliteRunResult {
    return callStatement<SqliteRunResult>(sql, 'run', parameters);
  }

  function get<T = Record<string, unknown>>(
    sql: string,
    ...anonymousParameters: SqliteValue[]
  ): T | undefined;
  function get<T = Record<string, unknown>>(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): T | undefined;
  function get<T = Record<string, unknown>>(
    sql: string,
    ...parameters: unknown[]
  ): T | undefined {
    return callStatement<T | undefined>(sql, 'get', parameters);
  }

  function all<T = Record<string, unknown>>(
    sql: string,
    ...anonymousParameters: SqliteValue[]
  ): T[];
  function all<T = Record<string, unknown>>(
    sql: string,
    namedParameters: SqliteNamedParameters,
    ...anonymousParameters: SqliteValue[]
  ): T[];
  function all<T = Record<string, unknown>>(
    sql: string,
    ...parameters: unknown[]
  ): T[] {
    return callStatement<T[]>(sql, 'all', parameters);
  }

  try {
    if (options.busyTimeoutMs != null) {
      const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs));
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    }

    if (options.foreignKeys !== false) {
      db.exec('PRAGMA foreign_keys = ON');
    }

    if (options.wal !== false) {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as
        | { journal_mode?: string }
        | undefined;

      fastify.log.debug(
        { journalMode: row?.journal_mode },
        'SQLite journal mode configured',
      );
    }

    await options.setup?.(db);

    const sqlite: FastifySqlite = {
      db,

      exec(sql) {
        db.exec(sql);
      },

      prepare,
      run,
      get,
      all,
    };

    fastify.decorate('sqlite', sqlite);

    fastify.addHook('onClose', async () => {
      close();
    });
  } catch (error) {
    close();
    throw error;
  }
};

export default fp(sqlitePlugin, {
  name: 'fastify-node-sqlite',
  fastify: '4.x || 5.x',
});
