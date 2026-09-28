import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { request } from './api';

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '요청에 실패했습니다.';
}

export function useResource<T>(
  path: string,
  active: boolean,
  revision: number,
  pollMs = 0,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    try {
      const result = await request<T>(path, { signal: current.signal });
      if (!current.signal.aborted) {
        setData(result);
        setError('');
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(messageOf(cause));
    } finally {
      if (controller.current === current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (!active) {
      setError('');
      return;
    }
    // revision invalidates the visible resource after a successful mutation.
    void revision;
    const whenVisible = () => {
      if (!document.hidden) void refresh();
    };
    whenVisible();
    const timer = pollMs ? window.setInterval(whenVisible, pollMs) : undefined;
    document.addEventListener('visibilitychange', whenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', whenVisible);
      controller.current?.abort();
    };
  }, [active, pollMs, refresh, revision]);

  return { data, error, loading, refresh };
}

export function useAction(onChanged: () => void, active: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const pending = useRef(false);
  const visit = useRef(0);
  useEffect(() => {
    visit.current++;
    if (!active) {
      setError('');
      setSuccess('');
    }
  }, [active]);
  const reset = () => {
    setError('');
    setSuccess('');
  };
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (pending.current) return false;
    const currentVisit = visit.current;
    pending.current = true;
    setBusy(true);
    reset();
    try {
      await action();
      if (active && visit.current === currentVisit) setSuccess(message);
      onChanged();
      return true;
    } catch (cause) {
      if (active && visit.current === currentVisit) setError(messageOf(cause));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { busy, error, success, run, reset };
}

export function Feedback({
  error,
  success = '',
}: {
  error: string;
  success?: string;
}) {
  return (
    <Stack aria-live="polite" spacing={1}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {success ? <Alert severity="success">{success}</Alert> : null}
    </Stack>
  );
}

export function SectionHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={2}
      sx={{
        alignItems: { xs: 'stretch', md: 'center' },
        justifyContent: 'space-between',
      }}
    >
      <Box>
        <Typography component="h1" variant="h5">
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 0.75 }} variant="body2">
          {description}
        </Typography>
      </Box>
      {children}
    </Stack>
  );
}

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'short',
  timeStyle: 'medium',
});
export const formatTime = (time: number | null) =>
  time === null ? '—' : dateFormatter.format(time);

export const paginationLabels = {
  labelRowsPerPage: '페이지당 행',
  labelDisplayedRows: ({
    from,
    to,
    count,
  }: {
    from: number;
    to: number;
    count: number;
  }) => `${from}–${to} / ${count.toLocaleString('ko-KR')}`,
  getItemAriaLabel: (type: 'first' | 'last' | 'next' | 'previous') =>
    ({
      first: '첫 페이지',
      last: '마지막 페이지',
      next: '다음 페이지',
      previous: '이전 페이지',
    })[type],
};
