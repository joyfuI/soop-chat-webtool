/// <reference types="node" />
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  AuthenticationError,
  RestrictedRoomError,
  resolveNodeChannel,
  serializeChannelResolutionError,
} from 'soop-chat';
import * as z from 'zod';

import { zValidator } from './validator-wrapper';

const app = new Hono();

app.use(
  '*',
  cors({
    origin:
      process.env.NODE_ENV === 'development'
        ? '*'
        : ['https://soop-gamepinball-helper.netlify.app'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

const handleError = (e: unknown, c: Context) => {
  console.error(e);

  if (e instanceof AuthenticationError) {
    return c.json({ code: e.code, message: e.message }, 401);
  }

  return c.json(
    serializeChannelResolutionError(e),
    e instanceof RestrictedRoomError ? 403 : 503,
  );
};

const route = app
  .get(
    '/channel',
    zValidator('query', z.object({ streamerId: z.string().trim().min(1) })),
    async (c) => {
      const { streamerId } = c.req.valid('query');
      c.header('Cache-Control', 'no-store');
      try {
        const channel = await resolveNodeChannel(streamerId, {
          signal: c.req.raw.signal,
        });
        return c.json(channel, 200);
      } catch (e) {
        return handleError(e, c);
      }
    },
  )
  .post(
    '/channel',
    zValidator(
      'json',
      z.object({
        streamerId: z.string().trim().min(1),
        roomPassword: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      const { streamerId, roomPassword } = c.req.valid('json');
      c.header('Cache-Control', 'no-store');
      try {
        const channel = await resolveNodeChannel(streamerId, {
          signal: c.req.raw.signal,
          ...(roomPassword === undefined ? {} : { roomPassword }),
        });
        return c.json(channel, 200);
      } catch (e) {
        return handleError(e, c);
      }
    },
  );

export type AppType = typeof route;

export default app;
