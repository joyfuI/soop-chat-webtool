import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyReply } from 'fastify';
import type { ChannelResolver } from 'soop-chat';

import { AsyncStore } from './async-store.ts';
import {
  type BroadcastLookup,
  type ChatFactory,
  Collector,
} from './collector.ts';
import { downloadBroadcast } from './download.ts';
import { runQuery } from './query.ts';
import { ApiError, DAY_MS, MAX_RETENTION_DAYS } from './types.ts';

type StreamerParams = { streamerId: string };
type BroadcastParams = { broadcastNo: string };
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9]{6,12}$' };
const streamerParams = {
  type: 'object',
  required: ['streamerId'],
  properties: { streamerId: idSchema },
};
const broadcastParams = {
  type: 'object',
  required: ['broadcastNo'],
  properties: { broadcastNo: { type: 'string', minLength: 1 } },
};
const passwordSchema = {
  type: 'string',
  minLength: 1,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
};
const retentionSchema = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_RETENTION_DAYS,
};

export async function buildApp(options: {
  apiKey: string;
  secretKey: Buffer;
  dataDir: string;
  logger?: boolean;
  corsOrigins?: string[];
  createChat?: ChatFactory;
  resolveChannel?: ChannelResolver;
  lookupBroadcast?: BroadcastLookup;
}) {
  if (!options.apiKey.trim())
    throw new Error('COLLECTOR_API_KEY를 설정해야 합니다.');
  if (options.secretKey.length !== 32)
    throw new Error(
      'COLLECTOR_SECRET_KEY는 Base64로 인코딩한 32바이트 키여야 합니다.',
    );
  mkdirSync(options.dataDir, { recursive: true });
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.body.password'] }
      : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  try {
    if (options.corsOrigins?.length) {
      for (const origin of options.corsOrigins) {
        const url = new URL(origin);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin
        )
          throw new Error('CORS 출처는 경로 없는 HTTP(S) 출처여야 합니다.');
      }
      await app.register(cors, {
        origin: options.corsOrigins,
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type'],
      });
    }
    const store = await AsyncStore.open(options.dataDir, options.secretKey);
    app.addHook('onClose', async () => store.close());
    const collector = new Collector(
      store,
      options.createChat,
      options.resolveChannel,
      options.lookupBroadcast,
    );
    await collector.reloadCredentials();
    const shutdown = new AbortController();
    const jobs = new Set<Promise<unknown>>();
    const requestJob = async <T>(
      reply: FastifyReply,
      execute: (signal: AbortSignal) => Promise<T>,
    ) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once('close', cancel);
      const job = execute(
        AbortSignal.any([shutdown.signal, controller.signal]),
      );
      jobs.add(job);
      try {
        return await job;
      } finally {
        jobs.delete(job);
        reply.raw.removeListener('close', cancel);
      }
    };
    let retentionTimer: ReturnType<typeof setTimeout> | undefined;
    let retentionRun: Promise<void> | undefined;
    const cleanExpiredBroadcasts = async () => {
      const now = Date.now();
      for (const streamer of await store.listStreamers()) {
        if (shutdown.signal.aborted) return;
        if (streamer.retention_days === 0) continue;
        try {
          const expired = await store.listExpiredBroadcasts(
            streamer.streamer_id,
            now - streamer.retention_days * DAY_MS,
          );
          for (const broadcast of expired) {
            if (shutdown.signal.aborted) return;
            if (
              !(await store.getStreamer(streamer.streamer_id, false)).registered
            )
              break;
            if (
              !collector.canDeleteBroadcast(
                streamer.streamer_id,
                broadcast.broadcast_no,
              )
            )
              continue;
            await store.deleteBroadcast(broadcast, shutdown.signal);
            await setImmediate();
          }
        } catch {
          app.log.error(
            { streamerId: streamer.streamer_id },
            '보존 기간이 지난 방송 삭제에 실패했습니다.',
          );
        }
      }
    };
    const startRetentionCleanup = () => {
      if (shutdown.signal.aborted) return;
      retentionRun = cleanExpiredBroadcasts()
        .catch(() => {
          app.log.error('채팅 보존 기간 정리에 실패했습니다.');
        })
        .finally(() => {
          retentionRun = undefined;
          if (shutdown.signal.aborted) return;
          retentionTimer = setTimeout(startRetentionCleanup, DAY_MS);
          retentionTimer.unref();
        });
    };
    const streams = new Set<Readable>();
    const expectedKey = createHash('sha256')
      .update(`Bearer ${options.apiKey}`)
      .digest();
    app.addHook('onRequest', async (request) => {
      const suppliedKey = createHash('sha256')
        .update(request.headers.authorization ?? '')
        .digest();
      if (!timingSafeEqual(suppliedKey, expectedKey))
        throw new ApiError(401, 'API 인증에 실패했습니다.');
    });
    app.setErrorHandler<FastifyError>((error, _request, reply) => {
      const status =
        error instanceof ApiError
          ? error.statusCode
          : (error.statusCode ?? 500);
      return reply
        .code(status)
        .send({
          message:
            error instanceof ApiError
              ? error.message
              : status < 500
                ? '요청 형식이 올바르지 않습니다.'
                : '서버 오류가 발생했습니다.',
        });
    });
    app.addHook('preClose', async () => {
      shutdown.abort();
      if (retentionTimer) clearTimeout(retentionTimer);
      await Promise.all([collector.shutdown(), retentionRun]);
      for (const stream of streams) stream.destroy();
      await Promise.allSettled([...jobs]);
    });

    app.get('/api/streamers', async () =>
      (await store.listStreamers()).map((s) => collector.status(s)),
    );
    app.post<{
      Body: {
        streamerId: string;
        roomPassword?: string;
        retentionDays?: number;
      };
    }>(
      '/api/streamers',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['streamerId'],
            properties: {
              streamerId: idSchema,
              roomPassword: passwordSchema,
              retentionDays: retentionSchema,
            },
          },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            collector.status(
              await store.addStreamer(
                request.body.streamerId,
                request.body.roomPassword ?? null,
                request.body.retentionDays,
              ),
            ),
          ),
    );
    app.patch<{
      Params: StreamerParams;
      Body: { roomPassword?: string | null; retentionDays?: number };
    }>(
      '/api/streamers/:streamerId',
      {
        schema: {
          params: streamerParams,
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              roomPassword: { anyOf: [passwordSchema, { type: 'null' }] },
              retentionDays: retentionSchema,
            },
          },
        },
      },
      async (request) => {
        const streamer = await store.getStreamer(request.params.streamerId);
        await store.updateStreamer(streamer.streamer_id, request.body);
        return collector.status(await store.getStreamer(streamer.streamer_id));
      },
    );
    app.delete<{ Params: StreamerParams }>(
      '/api/streamers/:streamerId',
      { schema: { params: streamerParams } },
      async (request, reply) => {
        const streamer = await store.getStreamer(request.params.streamerId);
        await store.removeStreamer(streamer.streamer_id);
        await collector.stop(streamer.streamer_id);
        return reply.code(204).send();
      },
    );

    for (const action of ['start', 'stop'] as const) {
      const change = async (id: string) => {
        const streamer = await store.getStreamer(id);
        await store.setEnabled(streamer.streamer_id, action === 'start');
        if (action === 'start') {
          const current = await store.getStreamer(streamer.streamer_id, false);
          if (current.registered && current.enabled) collector.start(current);
        } else await collector.stop(streamer.streamer_id);
        return collector.status(await store.getStreamer(streamer.streamer_id));
      };
      app.post<{ Params: StreamerParams }>(
        `/api/collection/${action}/:streamerId`,
        { schema: { params: streamerParams } },
        async (request) => change(request.params.streamerId),
      );
      app.post(`/api/collection/${action}`, async () =>
        Promise.all(
          (await store.listStreamers()).map((s) => change(s.streamer_id)),
        ),
      );
    }

    app.get('/api/settings', async () => store.getSettings());
    app.patch<{ Body: { username: string | null; password: string | null } }>(
      '/api/settings',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['username', 'password'],
            properties: { username: {}, password: {} },
            oneOf: [
              {
                properties: {
                  username: { type: 'string', minLength: 1, pattern: '\\S' },
                  password: { type: 'string', minLength: 1 },
                },
              },
              {
                properties: {
                  username: { type: 'null' },
                  password: { type: 'null' },
                },
              },
            ],
          },
        },
      },
      async (request) => {
        await store.updateCredentials(
          request.body.username?.trim() ?? null,
          request.body.password,
        );
        await collector.reloadCredentials();
        return store.getSettings();
      },
    );

    const broadcasts = async (id?: string) =>
      (await store.listBroadcasts(id)).map((b) => ({
        ...b,
        collecting: collector.isActive(b.streamer_id, b.broadcast_no),
      }));
    app.get('/api/broadcasts', async () => broadcasts());
    app.get<{ Params: StreamerParams }>(
      '/api/broadcasts/:streamerId',
      { schema: { params: streamerParams } },
      async (request) => broadcasts(request.params.streamerId),
    );
    app.delete<{ Params: BroadcastParams }>(
      '/api/broadcasts/:broadcastNo',
      { schema: { params: broadcastParams } },
      async (request, reply) => {
        const broadcast = await store.findBroadcast(request.params.broadcastNo);
        if (
          !collector.canDeleteBroadcast(
            broadcast.streamer_id,
            broadcast.broadcast_no,
          )
        )
          throw new ApiError(
            409,
            '먼저 해당 스트리머의 수집을 중지해야 합니다.',
          );
        await requestJob(reply, (signal) =>
          store.deleteBroadcast(broadcast, signal),
        );
        return reply.code(204).send();
      },
    );
    app.get<{ Params: BroadcastParams; Querystring: { format: 'db' | 'csv' } }>(
      '/api/broadcasts/:broadcastNo/download',
      {
        schema: {
          params: broadcastParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['format'],
            properties: { format: { type: 'string', enum: ['db', 'csv'] } },
          },
        },
      },
      async (request, reply) => {
        const broadcast = await store.findBroadcast(request.params.broadcastNo);
        const format = request.query.format;
        const path = await store.databasePath(broadcast.streamer_id);
        const preparing = requestJob(reply, (signal) =>
          downloadBroadcast(path, broadcast, format, signal),
        );
        const completion = preparing.then((download) => download.finished);
        jobs.add(completion);
        void completion.finally(() => jobs.delete(completion)).catch(() => {});
        const { stream } = await preparing;
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        return reply
          .header(
            'Content-Disposition',
            `attachment; filename="${broadcast.streamer_id}-${encodeURIComponent(broadcast.broadcast_no)}.${format}"`,
          )
          .header('Cache-Control', 'no-store')
          .type(
            format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/vnd.sqlite3',
          )
          .send(stream);
      },
    );
    app.post<{ Params: StreamerParams; Body: { sql: string } }>(
      '/api/query/:streamerId',
      {
        schema: {
          params: streamerParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['sql'],
            properties: { sql: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (request, reply) => {
        const path = await store.databasePath(request.params.streamerId);
        reply.header('Cache-Control', 'no-store');
        return requestJob(reply, (signal) =>
          runQuery(path, request.body.sql, signal),
        );
      },
    );

    app.addHook('onReady', async () => {
      for (const streamer of await store.listStreamers())
        if (streamer.enabled) collector.start(streamer);
      startRetentionCleanup();
    });
    return { app, store, collector };
  } catch (error) {
    await app.close();
    throw error;
  }
}
