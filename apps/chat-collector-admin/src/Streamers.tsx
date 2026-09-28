import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { FormEvent } from 'react';
import { useRef, useState } from 'react';

import {
  maxRetentionDays,
  request,
  type Streamer,
  streamerIdPattern,
} from './api';
import { Feedback, SectionHeading, useAction, useResource } from './common';

const stateLabels = {
  stopped: '중지',
  waiting: '방송 대기',
  connecting: '연결 중',
  collecting: '수집 중',
  error: '오류',
};

export default function Streamers({
  active,
  revision,
  onChanged,
}: {
  active: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const resource = useResource<Streamer[]>(
    '/streamers',
    active,
    revision,
    10_000,
  );
  const action = useAction(onChanged, active);
  const streamers = resource.data ?? [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Streamer | null>(null);
  const [streamerId, setStreamerId] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [retention, setRetention] = useState('');
  const [formError, setFormError] = useState('');
  const idInput = useRef<HTMLInputElement>(null);

  const edit = (streamer: Streamer | null) => {
    setEditing(streamer);
    setStreamerId(streamer?.streamerId ?? '');
    setRoomPassword(streamer?.roomPassword ?? '');
    setRetention(streamer ? String(streamer.retentionDays) : '');
    setFormError('');
    action.reset();
    setOpen(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const id = streamerId.trim();
    if (!streamerIdPattern.test(id)) {
      setFormError('스트리머 ID는 영문·숫자 6~12자여야 합니다.');
      return;
    }
    const days = retention.trim() ? Number(retention) : undefined;
    if (
      (editing && days === undefined) ||
      (days !== undefined &&
        (!Number.isSafeInteger(days) || days < 0 || days > maxRetentionDays))
    ) {
      setFormError(
        `보존 기간은 0~${maxRetentionDays.toLocaleString('ko-KR')} 사이의 정수여야 합니다.`,
      );
      return;
    }
    if (
      Array.from(roomPassword).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      setFormError('방 비밀번호에는 제어 문자를 사용할 수 없습니다.');
      return;
    }
    const body: {
      streamerId?: string;
      roomPassword?: string | null;
      retentionDays?: number;
    } = {};
    if (!editing) body.streamerId = id;
    if (days !== undefined) body.retentionDays = days;
    if (!editing && roomPassword) body.roomPassword = roomPassword;
    if (editing && roomPassword !== (editing.roomPassword ?? ''))
      body.roomPassword = roomPassword || null;
    const saved = await action.run(
      () =>
        request<Streamer>(
          editing ? `/streamers/${encodeURIComponent(id)}` : '/streamers',
          { method: editing ? 'PATCH' : 'POST', body },
        ),
      editing
        ? '스트리머 설정을 저장했습니다.'
        : '스트리머를 추가했습니다. 수집을 시작할 수 있습니다.',
    );
    if (saved) {
      setRoomPassword('');
      setOpen(false);
    }
  };
  const collection = (operation: 'start' | 'stop', streamer?: Streamer) => {
    if (
      operation === 'stop' &&
      !streamer &&
      !window.confirm('등록된 모든 스트리머의 수집을 중지할까요?')
    )
      return;
    void action.run(
      () =>
        request(
          `/collection/${operation}${streamer ? `/${encodeURIComponent(streamer.streamerId)}` : ''}`,
          { method: 'POST' },
        ),
      `${streamer?.streamerId ?? '전체 스트리머'} 수집을 ${operation === 'start' ? '시작' : '중지'}했습니다.`,
    );
  };
  const remove = (streamer: Streamer) => {
    if (
      !window.confirm(
        `${streamer.streamerId} 등록을 해제할까요? 수집은 중지되며 방송·채팅 기록은 보존됩니다.`,
      )
    )
      return;
    void action.run(
      () =>
        request<void>(`/streamers/${encodeURIComponent(streamer.streamerId)}`, {
          method: 'DELETE',
        }),
      '스트리머 등록을 해제했습니다.',
    );
  };

  return (
    <Stack spacing={3}>
      <SectionHeading description="10초마다 갱신합니다." title="스트리머">
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button
            disabled={resource.loading || action.busy}
            onClick={() => void resource.refresh()}
          >
            새로고침
          </Button>
          <Button
            disabled={!streamers.length || action.busy}
            onClick={() => collection('start')}
            variant="outlined"
          >
            전체 시작
          </Button>
          <Button
            disabled={!streamers.length || action.busy}
            onClick={() => collection('stop')}
            variant="outlined"
          >
            전체 중지
          </Button>
          <Button
            disabled={action.busy}
            onClick={() => edit(null)}
            variant="contained"
          >
            스트리머 추가
          </Button>
        </Stack>
      </SectionHeading>
      <Feedback
        error={action.error || resource.error}
        success={action.success}
      />
      <Box>
        <Typography color="text.secondary" sx={{ mb: 1.5 }} variant="body2">
          등록 {streamers.length}명 · 수집 중{' '}
          {
            streamers.filter((streamer) => streamer.state === 'collecting')
              .length
          }
          명
        </Typography>
        {resource.loading ? (
          <LinearProgress aria-label="스트리머 갱신 중" />
        ) : null}
        <TableContainer
          sx={{ borderTop: 1, borderBottom: 1, borderColor: 'divider' }}
        >
          <Table aria-label="스트리머 목록" size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell>스트리머 ID</TableCell>
                <TableCell>상태</TableCell>
                <TableCell>방송 번호</TableCell>
                <TableCell>보존 기간</TableCell>
                <TableCell>방 비밀번호</TableCell>
                <TableCell>최근 오류</TableCell>
                <TableCell align="right">관리</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {streamers.map((streamer) => (
                <TableRow hover key={streamer.streamerId}>
                  <TableCell
                    component="th"
                    scope="row"
                    sx={{ fontWeight: 600 }}
                  >
                    {streamer.streamerId}
                  </TableCell>
                  <TableCell>
                    <Chip
                      color={
                        streamer.state === 'error'
                          ? 'error'
                          : streamer.state === 'collecting'
                            ? 'success'
                            : 'default'
                      }
                      label={stateLabels[streamer.state]}
                      size="small"
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>{streamer.broadcastNo ?? '—'}</TableCell>
                  <TableCell>
                    {streamer.retentionDays === 0
                      ? '무제한'
                      : `${streamer.retentionDays}일`}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 220, overflowWrap: 'anywhere' }}>
                    {streamer.roomPassword ?? '없음'}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 260, overflowWrap: 'anywhere' }}>
                    {streamer.lastError
                      ? `${streamer.lastError.code}: ${streamer.lastError.message}`
                      : '—'}
                  </TableCell>
                  <TableCell align="right">
                    <Stack
                      direction="row"
                      spacing={0.5}
                      sx={{ justifyContent: 'flex-end' }}
                    >
                      {!streamer.enabled || streamer.state === 'error' ? (
                        <Button
                          disabled={action.busy}
                          onClick={() => collection('start', streamer)}
                          size="small"
                        >
                          {streamer.state === 'error' ? '재시도' : '시작'}
                        </Button>
                      ) : null}
                      {streamer.enabled ? (
                        <Button
                          disabled={action.busy}
                          onClick={() => collection('stop', streamer)}
                          size="small"
                        >
                          중지
                        </Button>
                      ) : null}
                      <Button
                        disabled={action.busy}
                        onClick={() => edit(streamer)}
                        size="small"
                      >
                        수정
                      </Button>
                      <Button
                        color="error"
                        disabled={action.busy}
                        onClick={() => remove(streamer)}
                        size="small"
                      >
                        삭제
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {!streamers.length ? (
                <TableRow>
                  <TableCell align="center" colSpan={7} sx={{ py: 7 }}>
                    {resource.loading
                      ? '불러오는 중입니다.'
                      : resource.error
                        ? '목록을 불러오지 못했습니다.'
                        : '등록된 스트리머가 없습니다. 스트리머를 추가해 주세요.'}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
      <Dialog
        aria-labelledby="streamer-dialog-title"
        fullWidth
        maxWidth="sm"
        onClose={() => {
          if (!action.busy) setOpen(false);
        }}
        open={open}
        slotProps={{
          transition: { onEntered: () => idInput.current?.focus() },
        }}
      >
        <Box component="form" noValidate onSubmit={(event) => void save(event)}>
          <DialogTitle id="streamer-dialog-title">
            스트리머 {editing ? '수정' : '추가'}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={3} sx={{ pt: 1 }}>
              <Feedback error={formError || action.error} />
              <TextField
                autoComplete="off"
                autoFocus
                disabled={action.busy}
                fullWidth
                helperText={
                  editing ? 'ID는 변경할 수 없습니다.' : '영문·숫자 6~12자'
                }
                inputRef={idInput}
                label="스트리머 ID"
                onChange={(event) => setStreamerId(event.target.value)}
                required
                slotProps={{ input: { readOnly: Boolean(editing) } }}
                value={streamerId}
              />
              <TextField
                autoComplete="off"
                disabled={action.busy}
                fullWidth
                helperText={
                  editing
                    ? '빈칸으로 저장하면 해제됩니다. 변경·해제는 다음 연결부터 반영됩니다.'
                    : '비밀번호 방송이면 입력해 주세요.'
                }
                label="방 비밀번호"
                onChange={(event) => setRoomPassword(event.target.value)}
                type="text"
                value={roomPassword}
              />
              <TextField
                disabled={action.busy}
                fullWidth
                helperText="0은 무제한입니다. 추가 시 비워두면 서버 기본값 또는 이전 보존 설정을 사용합니다."
                label="채팅 보존 기간 (일)"
                onChange={(event) => setRetention(event.target.value)}
                required={Boolean(editing)}
                slotProps={{
                  htmlInput: { min: 0, max: maxRetentionDays, step: 1 },
                }}
                type="number"
                value={retention}
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ p: 3 }}>
            <Button disabled={action.busy} onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button disabled={action.busy} type="submit" variant="contained">
              {action.busy ? '저장 중…' : '저장'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Stack>
  );
}
