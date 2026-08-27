import type { AppType } from 'api';
import { hc } from 'hono/client';

export type ApiClient = ReturnType<typeof hc<AppType>>;

export const createApiClient = (...args: Parameters<typeof hc>): ApiClient =>
  hc<AppType>(...args);
