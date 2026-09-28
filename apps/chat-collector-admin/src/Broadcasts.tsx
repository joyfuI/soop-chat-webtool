import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';

import { type Broadcast, request, requestFile } from './api';
import { overlapsDate } from './broadcastFilters';
import {
  Feedback,
  formatTime,
  paginationLabels,
  SectionHeading,
  useAction,
  useResource,
} from './common';
import { downloadTimestamp, saveFile } from './downloads';

export default function Broadcasts({
  active,
  revision,
  onChanged,
}: {
  active: boolean;
  revision: number;
  onChanged: () => void;
}) {
  const resource = useResource<Broadcast[]>('/broadcasts', active, revision);
  const action = useAction(onChanged, active);
  const download = useAction(() => {}, active);
  const busy = action.busy || download.busy;
  const [streamerId, setStreamerId] = useState('');
  const [date, setDate] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const broadcasts = resource.data ?? [];
  const streamerIds = [
    ...new Set(broadcasts.map((item) => item.streamer_id)),
  ].sort();
  const selectedStreamer = streamerIds.includes(streamerId) ? streamerId : '';
  useEffect(() => {
    if (streamerId !== selectedStreamer) {
      setStreamerId(selectedStreamer);
      setPage(0);
    }
  }, [streamerId, selectedStreamer]);
  const rows = broadcasts.filter(
    (broadcast) =>
      (!selectedStreamer || broadcast.streamer_id === selectedStreamer) &&
      overlapsDate(broadcast, date),
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / rowsPerPage) - 1),
  );
  const remove = (broadcast: Broadcast) => {
    if (
      !window.confirm(
        `${broadcast.streamer_id}의 방송 ${broadcast.broadcast_no}와 관련 채팅 이벤트를 영구 삭제할까요?`,
      )
    )
      return;
    download.reset();
    void action.run(
      () =>
        request<void>(
          `/broadcasts/${encodeURIComponent(broadcast.broadcast_no)}`,
          { method: 'DELETE' },
        ),
      '방송과 관련 이벤트를 삭제했습니다.',
    );
  };
  const exportBroadcast = (broadcast: Broadcast, format: 'db' | 'csv') => {
    action.reset();
    void download.run(async () => {
      const number = encodeURIComponent(broadcast.broadcast_no);
      const blob = await requestFile(
        `/broadcasts/${number}/download?format=${format}`,
      );
      saveFile(
        blob,
        `${downloadTimestamp(broadcast.first_collected_at)}-${broadcast.streamer_id}-${number}.${format}`,
      );
    }, '다운로드를 시작했습니다.');
  };

  return (
    <Stack spacing={3}>
      <SectionHeading
        description="등록 해제된 스트리머의 기록도 포함합니다."
        title="방송"
      >
        <Button
          disabled={resource.loading || busy}
          onClick={() => void resource.refresh()}
          variant="outlined"
        >
          새로고침
        </Button>
      </SectionHeading>
      <Feedback
        error={action.error || download.error || resource.error}
        success={action.success || download.success}
      />
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{
          alignItems: { xs: 'stretch', md: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            label="스트리머"
            onChange={(event) => {
              setStreamerId(event.target.value);
              setPage(0);
            }}
            select
            size="small"
            slotProps={{
              inputLabel: { shrink: true },
              select: { native: true },
            }}
            sx={{ width: { sm: 240 } }}
            value={selectedStreamer}
          >
            <option value="">전체 스트리머</option>
            {streamerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </TextField>
          <TextField
            helperText="최초·최근 수집 기간이 해당 날짜와 겹치는 방송을 표시합니다."
            label="수집 날짜"
            onChange={(event) => {
              setDate(event.target.value);
              setPage(0);
            }}
            size="small"
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: { sm: 240 } }}
            type="date"
            value={date}
          />
          <Button
            disabled={!selectedStreamer && !date}
            onClick={() => {
              setStreamerId('');
              setDate('');
              setPage(0);
            }}
            sx={{ alignSelf: 'flex-start', minHeight: 40 }}
            variant="outlined"
          >
            필터 초기화
          </Button>
        </Stack>
        <Typography color="text.secondary" variant="body2">
          {rows.length.toLocaleString('ko-KR')}개
        </Typography>
      </Stack>
      <Box>
        {download.busy ? (
          <LinearProgress aria-label="방송 파일 다운로드 중" />
        ) : null}
        {resource.loading ? (
          <LinearProgress aria-label="방송 목록 갱신 중" />
        ) : null}
        <TableContainer
          sx={{ borderTop: 1, borderBottom: 1, borderColor: 'divider' }}
        >
          <Table aria-label="방송 목록" size="small" sx={{ minWidth: 1180 }}>
            <TableHead>
              <TableRow>
                <TableCell>방송 번호</TableCell>
                <TableCell>스트리머</TableCell>
                <TableCell>최초 수집</TableCell>
                <TableCell>최근 수집</TableCell>
                <TableCell>종료 확인</TableCell>
                <TableCell align="right">이벤트 수</TableCell>
                <TableCell>수집</TableCell>
                <TableCell align="right">다운로드</TableCell>
                <TableCell align="right">관리</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows
                .slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage)
                .map((broadcast) => (
                  <TableRow
                    hover
                    key={`${broadcast.streamer_id}:${broadcast.broadcast_no}`}
                  >
                    <TableCell
                      component="th"
                      scope="row"
                      sx={{ fontFamily: 'monospace', fontWeight: 600 }}
                    >
                      {broadcast.broadcast_no}
                    </TableCell>
                    <TableCell>{broadcast.streamer_id}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatTime(broadcast.first_collected_at)}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatTime(broadcast.last_collected_at)}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatTime(broadcast.ended_at)}
                    </TableCell>
                    <TableCell align="right">
                      {broadcast.event_count.toLocaleString('ko-KR')}
                    </TableCell>
                    <TableCell>
                      {broadcast.collecting ? (
                        <Chip
                          color="success"
                          label="수집 중"
                          size="small"
                          variant="outlined"
                        />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ justifyContent: 'flex-end' }}
                      >
                        <Button
                          aria-label={`방송 ${broadcast.broadcast_no} DB 다운로드`}
                          disabled={busy}
                          onClick={() => exportBroadcast(broadcast, 'db')}
                          size="small"
                          variant="outlined"
                        >
                          DB
                        </Button>
                        <Button
                          aria-label={`방송 ${broadcast.broadcast_no} CSV 다운로드`}
                          disabled={busy}
                          onClick={() => exportBroadcast(broadcast, 'csv')}
                          size="small"
                          variant="outlined"
                        >
                          CSV
                        </Button>
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        color="error"
                        disabled={broadcast.collecting || busy}
                        onClick={() => remove(broadcast)}
                        size="small"
                        title={
                          broadcast.collecting
                            ? '스트리머 수집을 먼저 중지해 주세요.'
                            : '방송과 이벤트 삭제'
                        }
                      >
                        삭제
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              {!rows.length ? (
                <TableRow>
                  <TableCell align="center" colSpan={9} sx={{ py: 7 }}>
                    {resource.loading
                      ? '불러오는 중입니다.'
                      : resource.error
                        ? '목록을 불러오지 못했습니다.'
                        : '표시할 방송이 없습니다.'}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={rows.length}
          onPageChange={(_event, value) => setPage(value)}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value));
            setPage(0);
          }}
          page={safePage}
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={[25, 50, 100]}
          {...paginationLabels}
        />
      </Box>
    </Stack>
  );
}
