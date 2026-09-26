import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyError } from 'fastify';
import type { ChannelResolver } from 'soop-chat';

import { type ChatFactory, Collector } from './collector.ts';
import { csvDownload, sqliteDownload } from './download.ts';
import sqlitePlugin from './lib/fastifyNodeSqlite.ts';
import { runQuery } from './query.ts';
import { ApiError, initializeSettings, Store } from './storage.ts';

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

export async function buildApp(options: {
  apiKey: string;
  secretKey: Buffer;
  dataDir: string;
  logger?: boolean;
  createChat?: ChatFactory;
  resolveChannel?: ChannelResolver;
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
      ? {
          redact: [
            'req.headers.authorization',
            'req.body.password',
            'req.body.roomPassword',
          ],
        }
      : false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  try {
    await app.register(sqlitePlugin, {
      path: join(options.dataDir, '_settings.db'),
      wal: false,
      setup: initializeSettings,
    });
    const store = new Store(app.sqlite.db, options.dataDir, options.secretKey);
    const collector = new Collector(
      store,
      options.createChat,
      options.resolveChannel,
    );
    const shutdown = new AbortController();
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
      await collector.shutdown();
      for (const stream of streams) stream.destroy();
    });
    app.addHook('onClose', async () => store.close());

    app.get('/api/streamers', async () =>
      store.listStreamers().map((s) => collector.status(s)),
    );
    app.post<{ Body: { streamerId: string; roomPassword?: string } }>(
      '/api/streamers',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['streamerId'],
            properties: { streamerId: idSchema, roomPassword: passwordSchema },
          },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            collector.status(
              store.addStreamer(
                request.body.streamerId,
                request.body.roomPassword ?? null,
              ),
            ),
          ),
    );
    app.patch<{
      Params: StreamerParams;
      Body: { roomPassword: string | null };
    }>(
      '/api/streamers/:streamerId',
      {
        schema: {
          params: streamerParams,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['roomPassword'],
            properties: {
              roomPassword: { anyOf: [passwordSchema, { type: 'null' }] },
            },
          },
        },
      },
      async (request) => {
        const streamer = store.getStreamer(request.params.streamerId);
        store.updatePassword(streamer.streamer_id, request.body.roomPassword);
        await collector.restart(streamer.streamer_id);
        return collector.status(store.getStreamer(streamer.streamer_id));
      },
    );
    app.delete<{ Params: StreamerParams }>(
      '/api/streamers/:streamerId',
      { schema: { params: streamerParams } },
      async (request, reply) => {
        const streamer = store.getStreamer(request.params.streamerId);
        store.removeStreamer(streamer.streamer_id);
        await collector.stop(streamer.streamer_id);
        return reply.code(204).send();
      },
    );

    for (const action of ['start', 'stop'] as const) {
      const change = async (id: string) => {
        const streamer = store.getStreamer(id);
        store.setEnabled(streamer.streamer_id, action === 'start');
        if (action === 'start')
          collector.start(store.getStreamer(streamer.streamer_id));
        else await collector.stop(streamer.streamer_id);
        return collector.status(store.getStreamer(streamer.streamer_id));
      };
      app.post<{ Params: StreamerParams }>(
        `/api/collection/${action}/:streamerId`,
        { schema: { params: streamerParams } },
        async (request) => change(request.params.streamerId),
      );
      app.post(`/api/collection/${action}`, async () =>
        Promise.all(store.listStreamers().map((s) => change(s.streamer_id))),
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
        store.updateCredentials(
          request.body.username?.trim() ?? null,
          request.body.password,
        );
        await collector.reloadCredentials();
        return store.getSettings();
      },
    );

    const broadcasts = (id?: string) =>
      store
        .listBroadcasts(id)
        .map((b) => ({
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
        const broadcast = store.findBroadcast(request.params.broadcastNo);
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
        store.deleteBroadcast(broadcast);
        return reply.code(204).send();
      },
    );
    app.get<{
      Params: BroadcastParams;
      Querystring: { format: 'sqlite' | 'csv' };
    }>(
      '/api/broadcasts/:broadcastNo/download',
      {
        schema: {
          params: broadcastParams,
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['format'],
            properties: { format: { type: 'string', enum: ['sqlite', 'csv'] } },
          },
        },
      },
      async (request, reply) => {
        const broadcast = store.findBroadcast(request.params.broadcastNo);
        const format = request.query.format;
        const stream =
          format === 'sqlite'
            ? sqliteDownload(store, broadcast)
            : csvDownload(store, broadcast);
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
        const controller = new AbortController();
        const cancel = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        reply.raw.once('close', cancel);
        try {
          reply.header('Cache-Control', 'no-store');
          return await runQuery(
            store.databasePath(request.params.streamerId),
            request.body.sql,
            AbortSignal.any([shutdown.signal, controller.signal]),
          );
        } finally {
          reply.raw.removeListener('close', cancel);
        }
      },
    );

    app.addHook('onReady', async () => {
      for (const streamer of store.listStreamers())
        if (streamer.enabled) collector.start(streamer);
    });
    return { app, store, collector };
  } catch (error) {
    await app.close();
    throw error;
  }
}
