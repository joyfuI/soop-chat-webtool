import { createApiClient } from '@joyfui/api-client';

if (!import.meta.env.VITE_API_URL) {
  throw new Error('VITE_API_URL 환경변수가 설정되지 않았습니다.');
}

const api = createApiClient(import.meta.env.VITE_API_URL);

export default api;
