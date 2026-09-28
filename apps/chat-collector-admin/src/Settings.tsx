import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';

import { type Settings as AccountSettings, request } from './api';
import { Feedback, SectionHeading, useAction, useResource } from './common';

export default function Settings({
  active,
  revision,
  onChanged,
}: {
  active: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const resource = useResource<AccountSettings>('/settings', active, revision);
  const action = useAction(onChanged, active);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const incomplete = Boolean(username.trim()) !== Boolean(password);
  useEffect(() => {
    if (resource.data) setUsername(resource.data.username ?? '');
  }, [resource.data?.username]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!resource.data || incomplete) return;
    const id = username.trim();
    if (
      await action.run(
        () =>
          request<AccountSettings>('/settings', {
            method: 'PATCH',
            body: { username: id || null, password: id ? password : null },
          }),
        id ? 'SOOP 계정을 저장했습니다.' : 'SOOP 계정을 해제했습니다.',
      )
    ) {
      setUsername(id);
      setPassword('');
    }
  };

  return (
    <Stack spacing={3}>
      <SectionHeading
        description="인증 정보가 필요한 방송 수집에 사용할 SOOP 계정을 설정합니다."
        title="SOOP 계정"
      >
        <Button
          disabled={resource.loading || action.busy}
          onClick={() => void resource.refresh()}
          variant="outlined"
        >
          새로고침
        </Button>
      </SectionHeading>
      <Feedback
        error={action.error || resource.error}
        success={action.success}
      />
      {resource.loading ? (
        <LinearProgress aria-label="계정 설정 조회 중" />
      ) : null}
      <Stack spacing={3} sx={{ maxWidth: 600 }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: 'space-between' }}
        >
          <Typography color="text.secondary">현재 계정</Typography>
          <Typography sx={{ overflowWrap: 'anywhere' }}>
            {resource.data ? (resource.data.username ?? '설정 없음') : '—'}
          </Typography>
        </Stack>
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: 'space-between' }}
        >
          <Typography color="text.secondary">비밀번호</Typography>
          <Typography>
            {resource.data
              ? resource.data.passwordConfigured
                ? '설정됨'
                : '설정 없음'
              : '—'}
          </Typography>
        </Stack>
        <Divider />
        <Alert severity="info">계정 변경은 다음 연결부터 반영됩니다.</Alert>
        <Stack
          component="form"
          onSubmit={(event) => void save(event)}
          spacing={3}
        >
          <TextField
            autoComplete="username"
            disabled={action.busy}
            label="SOOP 아이디"
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
          <TextField
            autoComplete="new-password"
            disabled={action.busy}
            helperText="아이디와 비밀번호를 함께 입력해 주세요. 둘 다 비우고 저장하면 계정이 해제됩니다."
            label="SOOP 비밀번호"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <Button
            disabled={action.busy || !resource.data || incomplete}
            sx={{ alignSelf: 'flex-start' }}
            type="submit"
            variant="contained"
          >
            {action.busy ? '처리 중…' : '저장'}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}
