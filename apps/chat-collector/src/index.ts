import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.ts';

const apiKey = process.env.COLLECTOR_API_KEY ?? '';
const encodedKey = process.env.COLLECTOR_SECRET_KEY ?? '';
const secretKey = Buffer.from(encodedKey, 'base64');
if (secretKey.length !== 32 || secretKey.toString('base64') !== encodedKey) {
  throw new Error(
    'COLLECTOR_SECRET_KEY는 Base64로 인코딩한 32바이트 키여야 합니다.',
  );
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT는 1~65535 정수여야 합니다.');
const root = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url),
);
const { app } = await buildApp({
  apiKey,
  secretKey,
  dataDir: join(root, 'data'),
  logger: true,
  corsOrigins: (process.env.COLLECTOR_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
try {
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
} catch (error) {
  await app.close();
  throw error;
}
