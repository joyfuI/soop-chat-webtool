import { pipeline } from 'node:stream/promises';

import { csvDownload, sqliteDownload } from './download-source.ts';
import { ApiError, type Broadcast } from './storage.ts';

process.once('message', async (request) => {
  const { path, broadcast, format, directory } = request as {
    path: string;
    broadcast: Broadcast;
    format: 'db' | 'csv';
    directory?: string;
  };
  try {
    const stream =
      format === 'db'
        ? sqliteDownload(path, broadcast, directory)
        : csvDownload(path, broadcast);
    process.send?.({ ready: true });
    await pipeline(stream, process.stdout, { end: false });
    process.stdout.end();
    process.disconnect?.();
  } catch (error) {
    process.send?.(
      {
        statusCode: error instanceof ApiError ? error.statusCode : 500,
        message:
          error instanceof ApiError
            ? error.message
            : '다운로드에 실패했습니다.',
      },
      () => process.disconnect?.(),
    );
    process.exitCode = 1;
  }
});
