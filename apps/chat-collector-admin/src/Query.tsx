import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
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
import type { FormEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type Broadcast,
  request,
  type Streamer,
  streamerIdPattern,
} from './api';
import {
  Feedback,
  messageOf,
  paginationLabels,
  SectionHeading,
  useResource,
} from './common';
import { downloadTimestamp, saveFile, toCsv } from './downloads';
import {
  readSavedQueries,
  type SavedQuery,
  writeSavedQueries,
} from './savedQueries';

function loadSaved() {
  try {
    return { queries: readSavedQueries(window.localStorage), error: '' };
  } catch (error) {
    return {
      queries: [] as SavedQuery[],
      error: `저장 쿼리를 읽지 못했습니다. ${messageOf(error)}`,
    };
  }
}

export default function Query({
  active,
  revision,
}: {
  active: boolean;
  revision: number;
}) {
  const resource = useResource<Streamer[]>('/streamers', active, revision);
  const broadcasts = useResource<Broadcast[]>('/broadcasts', active, revision);
  const [streamerId, setStreamerId] = useState('');
  const streamerIds = [
    ...new Set([
      ...(resource.data ?? []).map((streamer) => streamer.streamerId),
      ...(broadcasts.data ?? []).map((broadcast) => broadcast.streamer_id),
    ]),
  ].sort();
  const selectedStreamer = streamerIds.includes(streamerId) ? streamerId : '';
  const missingTarget = Boolean(
    streamerId &&
      !selectedStreamer &&
      resource.data &&
      broadcasts.data &&
      !resource.loading &&
      !broadcasts.loading &&
      !resource.error &&
      !broadcasts.error,
  );
  const [sql, setSql] = useState(
    `SELECT *
FROM events
ORDER BY id DESC
LIMIT 100;`,
  );
  const [saved, setSaved] = useState(loadSaved);
  const [queryName, setQueryName] = useState('');
  const [selected, setSelected] = useState('');
  const [storageSuccess, setStorageSuccess] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const controller = useRef<AbortController | null>(null);
  const visit = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    visit.current++;
    if (active) {
      setSaved(loadSaved());
    } else {
      setError('');
      setNotice('');
      setStorageSuccess('');
      setSaved((value) => ({ ...value, error: '' }));
    }
  }, [active]);

  const cancel = useCallback(() => {
    if (!controller.current) return;
    controller.current.abort();
    controller.current = null;
    setPending(false);
    setNotice('조회가 취소되었습니다.');
  }, []);
  const targetChanged = useCallback(
    (value: string) => {
      if (value === streamerId) return;
      cancel();
      setStreamerId(value);
      setRows(null);
      setError('');
      setNotice('');
      setPage(0);
    },
    [cancel, streamerId],
  );
  useEffect(() => {
    if (missingTarget) targetChanged('');
  }, [missingTarget, targetChanged]);
  const execute = async (event: FormEvent) => {
    event.preventDefault();
    if (controller.current) return;
    setError('');
    setNotice('');
    if (!streamerIdPattern.test(selectedStreamer) || !sql.trim()) {
      setError('스트리머를 선택하고 SQL을 입력해 주세요.');
      return;
    }
    const current = new AbortController();
    const currentVisit = visit.current;
    controller.current = current;
    setPending(true);
    setRows(null);
    setPage(0);
    try {
      const result = await request<Record<string, unknown>[]>(
        `/query/${encodeURIComponent(selectedStreamer)}`,
        { method: 'POST', body: { sql }, signal: current.signal },
      );
      if (!current.signal.aborted) setRows(result);
    } catch (cause) {
      if (!current.signal.aborted && visit.current === currentVisit)
        setError(messageOf(cause));
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setPending(false);
      }
    }
  };
  const persist = (queries: SavedQuery[], message: string) => {
    setStorageSuccess('');
    try {
      writeSavedQueries(window.localStorage, queries);
      setSaved({ queries, error: '' });
      setStorageSuccess(message);
      return true;
    } catch (cause) {
      setSaved((value) => ({
        ...value,
        error: `저장 쿼리를 변경하지 못했습니다. ${messageOf(cause)}`,
      }));
      return false;
    }
  };
  const save = () => {
    const name = queryName.trim();
    if (!name || !sql.trim()) return;
    const exists = saved.queries.some((query) => query.name === name);
    if (exists && !window.confirm(`저장 쿼리 '${name}'을 덮어쓸까요?`)) return;
    const query = { name, sql };
    const queries = exists
      ? saved.queries.map((item) => (item.name === name ? query : item))
      : [...saved.queries, query];
    if (persist(queries, '이 브라우저에 쿼리를 저장했습니다.')) {
      setSelected(name);
      setQueryName(name);
    }
  };
  const remove = () => {
    if (!selected || !window.confirm(`저장 쿼리 '${selected}'을 삭제할까요?`))
      return;
    if (
      persist(
        saved.queries.filter((query) => query.name !== selected),
        '저장 쿼리를 삭제했습니다.',
      )
    )
      setSelected('');
  };
  const columns = rows?.length ? Object.keys(rows[0] ?? {}) : [];
  const count = rows?.length ?? 0;
  const exportResult = () => {
    if (!rows?.length) return;
    setError('');
    try {
      saveFile(
        new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }),
        `${downloadTimestamp(Date.now())}-${streamerId}-query.csv`,
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(count / rowsPerPage) - 1),
  );

  return (
    <Stack spacing={3}>
      <SectionHeading
        description="스트리머 DB에 읽기 전용 SELECT를 실행합니다. 방송 기록이 남아 있는 등록 해제된 스트리머도 선택할 수 있습니다."
        title="SQL 조회"
      />
      <Feedback error={error || resource.error || broadcasts.error} />
      {notice ? <Alert severity="info">{notice}</Alert> : null}
      <Stack
        component="form"
        noValidate
        onSubmit={(event) => void execute(event)}
        spacing={2}
      >
        <TextField
          label="스트리머 선택"
          onChange={(event) => targetChanged(event.target.value)}
          select
          slotProps={{ inputLabel: { shrink: true }, select: { native: true } }}
          sx={{ width: { sm: 320 } }}
          value={selectedStreamer}
        >
          <option value="">선택해 주세요</option>
          {streamerIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </TextField>
        <TextField
          disabled={pending}
          fullWidth
          label="SQL"
          minRows={6}
          multiline
          onChange={(event) => setSql(event.target.value)}
          required
          slotProps={{
            htmlInput: { spellCheck: false },
            input: {
              sx: { fontFamily: 'monospace', fontSize: 14, lineHeight: 1.7 },
            },
          }}
          value={sql}
        />
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Typography color="text.secondary" variant="body2">
            events · broadcasts 테이블 / 행 제한은 WHERE·LIMIT으로 지정 / 서버
            실행 제한 30초
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              disabled={pending || !selectedStreamer || !sql.trim()}
              type="submit"
              variant="contained"
            >
              {pending ? '조회 중…' : '쿼리 실행'}
            </Button>
            {pending ? (
              <Button onClick={cancel} variant="outlined">
                조회 취소
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Stack>
      <Box
        sx={{ borderTop: 1, borderBottom: 1, borderColor: 'divider', py: 3 }}
      >
        <Typography component="h3" sx={{ mb: 2, fontWeight: 600 }}>
          저장 쿼리
        </Typography>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ alignItems: { xs: 'stretch', md: 'flex-start' } }}
        >
          <TextField
            disabled={pending}
            label="저장 쿼리 선택"
            onChange={(event) => {
              const name = event.target.value;
              setSelected(name);
              const query = saved.queries.find((item) => item.name === name);
              if (query) {
                setSql(query.sql);
                setQueryName(query.name);
              }
              setStorageSuccess('');
            }}
            select
            size="small"
            sx={{ minWidth: { md: 280 } }}
            value={selected}
          >
            <MenuItem value="">쿼리 선택</MenuItem>
            {saved.queries.map((query) => (
              <MenuItem key={query.name} value={query.name}>
                {query.name}
              </MenuItem>
            ))}
          </TextField>
          <Button
            color="error"
            disabled={pending || !selected}
            onClick={remove}
            sx={{ minHeight: 40 }}
          >
            저장 쿼리 삭제
          </Button>
          <TextField
            disabled={pending}
            label="저장할 이름"
            onChange={(event) => setQueryName(event.target.value)}
            size="small"
            sx={{ flex: 1 }}
            value={queryName}
          />
          <Button
            disabled={pending || !queryName.trim() || !sql.trim()}
            onClick={save}
            sx={{ minHeight: 40 }}
            variant="outlined"
          >
            쿼리 저장
          </Button>
        </Stack>
        <Box sx={{ mt: saved.error || storageSuccess ? 2 : 0 }}>
          <Feedback error={saved.error} success={storageSuccess} />
        </Box>
      </Box>
      {pending ? <LinearProgress aria-label="SQL 실행 중" /> : null}
      {rows !== null ? (
        <Box>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{
              mb: 2,
              alignItems: { xs: 'stretch', sm: 'center' },
              justifyContent: 'space-between',
            }}
          >
            <Typography component="h3" sx={{ fontWeight: 600 }}>
              마지막 조회 결과 · {count.toLocaleString('ko-KR')}행
            </Typography>
            <Button
              disabled={!count || pending}
              onClick={exportResult}
              variant="outlined"
            >
              CSV 다운로드
            </Button>
          </Stack>
          {count ? (
            <>
              <TableContainer
                sx={{
                  borderTop: 1,
                  borderBottom: 1,
                  borderColor: 'divider',
                  maxHeight: 560,
                }}
              >
                <Table aria-label="SQL 조회 결과" size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {columns.map((column) => (
                        <TableCell key={column} sx={{ whiteSpace: 'nowrap' }}>
                          {column}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows
                      .slice(
                        safePage * rowsPerPage,
                        (safePage + 1) * rowsPerPage,
                      )
                      .map((row, index) => (
                        <TableRow hover key={safePage * rowsPerPage + index}>
                          {columns.map((column) => (
                            <TableCell
                              key={column}
                              sx={{
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                                minWidth: 120,
                                maxWidth: 440,
                                verticalAlign: 'top',
                                fontFamily: 'monospace',
                                fontSize: 13,
                              }}
                            >
                              {row[column] === null
                                ? 'NULL'
                                : typeof row[column] === 'object'
                                  ? JSON.stringify(row[column])
                                  : String(row[column] ?? '')}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </TableContainer>
              <TablePagination
                component="div"
                count={count}
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
            </>
          ) : (
            <Alert severity="info">조회 결과가 없습니다.</Alert>
          )}
        </Box>
      ) : null}
    </Stack>
  );
}
