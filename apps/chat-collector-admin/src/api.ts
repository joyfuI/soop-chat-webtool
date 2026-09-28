export type Streamer = {
  streamerId: string;
  enabled: boolean;
  state: 'stopped' | 'waiting' | 'connecting' | 'collecting' | 'error';
  broadcastNo: string | null;
  lastError: { code: string; message: string } | null;
  roomPassword: string | null;
  retentionDays: number;
};

export type Broadcast = {
  broadcast_no: string;
  streamer_id: string;
  first_collected_at: number;
  last_collected_at: number;
  ended_at: number | null;
  event_count: number;
  collecting: boolean;
};

export type Settings = { username: string | null; passwordConfigured: boolean };

export const streamerIdPattern = /^[A-Za-z0-9]{6,12}$/;
export const maxRetentionDays = Math.floor(
  Number.MAX_SAFE_INTEGER / 86_400_000,
);
export const apiBaseUrl = (import.meta.env.VITE_COLLECTOR_API_URL ?? '')
  .trim()
  .replace(/\/+$/, '');
const apiKey = import.meta.env.VITE_COLLECTOR_API_KEY ?? '';

export const configurationError = (() => {
  if (!apiBaseUrl || !apiKey.trim())
    return 'VITE_COLLECTOR_API_URL과 VITE_COLLECTOR_API_KEY를 설정한 뒤 개발 서버를 재시작하거나 다시 빌드해 주세요.';
  try {
    const url = new URL(apiBaseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return 'API 서버 주소는 사용자 정보·쿼리·해시 없는 HTTP(S) URL이어야 합니다.';
  } catch {
    return 'VITE_COLLECTOR_API_URL에 올바른 HTTP(S) 서버 주소를 설정해 주세요.';
  }
  return '';
})();

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

async function requestResponse(
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  if (configurationError) throw new Error(configurationError);
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'omit',
    cache: 'no-store',
  };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/api${path}`, init);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      'API 서버에 연결할 수 없습니다. 서버 주소와 CORS 설정을 확인해 주세요.',
    );
  }
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? 'API 인증에 실패했습니다. API 키를 확인해 주세요.'
        : `요청에 실패했습니다. (HTTP ${response.status})`;
    const body: unknown = await response.json().catch(() => null);
    throw new Error(
      body &&
        typeof body === 'object' &&
        'message' in body &&
        typeof body.message === 'string'
        ? body.message
        : fallback,
    );
  }
  return response;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await requestResponse(path, options);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function requestFile(path: string): Promise<Blob> {
  const response = await requestResponse(path);
  try {
    return await response.blob();
  } catch {
    throw new Error('파일을 내려받지 못했습니다. 다시 시도해 주세요.');
  }
}
