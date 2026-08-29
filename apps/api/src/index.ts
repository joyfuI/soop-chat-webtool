/// <reference types="node" />

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  BroadcastOfflineError,
  ChannelResolutionError,
  RestrictedRoomError,
  resolveNodeChannel,
} from 'soop-chat';
import * as z from 'zod';

const app = new Hono();

app.use(
  '*',
  cors({
    origin:
      process.env.NODE_ENV === 'development'
        ? '*'
        : ['https://soop-gamepinball-helper.netlify.app'],
    allowMethods: ['GET', 'OPTIONS'],
  }),
);

const route = app.get(
  '/channel',
  zValidator(
    'query',
    z.object({ streamerId: z.string().trim().min(1) }),
    (result, c) => {
      if (!result.success) {
        return c.json(
          {
            code: 'INVALID_REQUEST',
            message: 'Invalid query parameters.',
            issues: result.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
          400,
        );
      }
      return;
    },
  ),
  async (c) => {
    const { streamerId } = c.req.valid('query');
    c.header('Cache-Control', 'no-store');
    try {
      const channel = await resolveNodeChannel(streamerId, {
        signal: c.req.raw.signal,
      });
      return c.json(channel, 200);
    } catch (e) {
      if (e instanceof BroadcastOfflineError) {
        return c.json({ code: e.code, message: e.message }, 404);
      }

      if (e instanceof RestrictedRoomError) {
        return c.json(
          { code: e.code, message: e.message, reason: e.reason },
          403,
        );
      }

      if (e instanceof ChannelResolutionError) {
        return c.json({ code: e.code, message: e.message }, 502);
      }

      console.error(e);
      return c.json(
        { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        500,
      );
    }
  },
);

export type AppType = typeof route;

export default app;
