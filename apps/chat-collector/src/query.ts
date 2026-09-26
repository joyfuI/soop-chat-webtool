import { fork } from 'node:child_process';

import { ApiError } from './storage.ts';

export function runQuery(
  path: string,
  sql: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // SQLite native calls cannot be interrupted with Worker.terminate().
    const worker = fork(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './query-process.ts'
          : './query-process.js',
        import.meta.url,
      ),
      {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    let settled = false;
    const finish = (
      error: Error | null,
      rows: Record<string, unknown>[] = [],
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      const complete = () => {
        if (error) reject(error);
        else resolve(rows);
      };
      if (!worker.pid || worker.exitCode !== null || worker.signalCode !== null)
        complete();
      else {
        worker.once('exit', complete);
        worker.kill('SIGKILL');
      }
    };
    const abort = () => finish(new ApiError(499, '조회가 취소되었습니다.'));
    const timer = setTimeout(
      () =>
        finish(new ApiError(504, 'SELECT 실행 시간이 10초를 초과했습니다.')),
      10_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    worker.on(
      'message',
      (result: {
        ok: boolean;
        rows?: Record<string, unknown>[];
        message?: string;
      }) => {
        finish(
          result.ok
            ? null
            : new ApiError(
                400,
                result.message ?? 'SELECT 실행에 실패했습니다.',
              ),
          result.rows,
        );
      },
    );
    worker.on('error', () =>
      finish(new ApiError(500, '조회 워커를 실행할 수 없습니다.')),
    );
    worker.on('exit', () => {
      if (!settled)
        finish(new ApiError(500, '조회 워커가 응답 없이 종료되었습니다.'));
    });
    worker.send({ path, sql });
  });
}
