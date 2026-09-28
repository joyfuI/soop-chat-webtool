import { fork } from 'node:child_process';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ApiError, type Broadcast } from './types.ts';

export async function downloadBroadcast(
  path: string,
  broadcast: Broadcast,
  format: 'db' | 'csv',
  signal: AbortSignal,
): Promise<{ stream: PassThrough; finished: Promise<void> }> {
  let directory: string | undefined;
  const cleanup = async () => {
    if (!directory) return;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await unlink(join(directory, `broadcast.sqlite${suffix}`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    }
    await rmdir(directory);
    directory = undefined;
  };
  try {
    signal.throwIfAborted();
    if (format === 'db')
      directory = await mkdtemp(join(tmpdir(), 'soop-chat-collector-'));
    signal.throwIfAborted();
  } catch (error) {
    await cleanup();
    throw error;
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(new URL('./download-process.ts', import.meta.url), {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
        windowsHide: true,
      });
      const stream = new PassThrough();
      let complete!: () => void;
      const finished = new Promise<void>((done) => {
        complete = done;
      });
      let ready = false;
      let failure: Error | undefined;
      stream.on('error', () => {});
      const abort = () => {
        failure ??= new ApiError(499, '다운로드가 취소되었습니다.');
        stream.destroy(failure);
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      });
      child.once('error', () => {
        failure = new ApiError(500, '다운로드 프로세스를 실행할 수 없습니다.');
        child.kill('SIGKILL');
      });
      child.on(
        'message',
        (result: {
          ready?: boolean;
          statusCode?: number;
          message?: string;
        }) => {
          if (result.ready) {
            if (signal.aborted) return;
            ready = true;
            child.stdout?.pipe(stream, { end: false });
            resolve({ stream, finished });
          } else {
            failure = new ApiError(
              result.statusCode ?? 500,
              result.message ?? '다운로드에 실패했습니다.',
            );
            child.kill('SIGKILL');
          }
        },
      );
      child.once('close', (code) => {
        signal.removeEventListener('abort', abort);
        void cleanup()
          .then(() => {
            if (code !== 0)
              failure ??= new ApiError(
                500,
                '다운로드 프로세스가 종료되었습니다.',
              );
            if (!ready)
              reject(
                failure ?? new ApiError(500, '다운로드를 준비하지 못했습니다.'),
              );
            if (failure) stream.destroy(failure);
            else stream.end();
          })
          .catch(() => {
            const error = new ApiError(
              500,
              '다운로드 임시 파일 정리에 실패했습니다.',
            );
            if (!ready) reject(error);
            stream.destroy(error);
          })
          .finally(complete);
      });
      child.send({ path, broadcast, format, directory });
      if (signal.aborted) abort();
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}
