/// <reference types="node" />
/// <reference types="../worker-configuration.d.ts" />
import type { Context } from 'hono';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import {
  AuthenticationError,
  authenticateNode,
  RestrictedRoomError,
  resolveNodeChannel,
  serializeChannelResolutionError,
} from 'soop-chat';
import * as z from 'zod';

import { decryptAuthTicket, encryptAuthTicket } from './auth-cookie';
import { zValidator } from './validator-wrapper';

const AUTH_COOKIE_NAME = '__Host-soop-auth';
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  partitioned: true,
  path: '/',
  sameSite: 'None',
  secure: true,
} as const;

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(
  '*',
  cors({
    origin:
      process.env.NODE_ENV === 'development'
        ? '*'
        : ['https://soop-gamepinball-helper.netlify.app'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: true,
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
        const encryptedAuthTicket = getCookie(c, AUTH_COOKIE_NAME);
        const authTicket = encryptedAuthTicket
          ? await decryptAuthTicket(encryptedAuthTicket, c.env.AUTH_COOKIE_KEY)
          : undefined;
        if (encryptedAuthTicket && !authTicket) {
          throw new AuthenticationError('SOOP login session is invalid.');
        }

        const channel = await resolveNodeChannel(streamerId, {
          signal: c.req.raw.signal,
          ...(roomPassword === undefined ? {} : { roomPassword }),
          ...(authTicket === undefined
            ? {}
            : { authentication: { authTicket } }),
        });
        return c.json(channel, 200);
      } catch (e) {
        return handleError(e, c);
      }
    },
  )
  .post(
    '/login',
    zValidator(
      'json',
      z.object({
        username: z.string().trim().min(1),
        password: z.string().min(1),
      }),
    ),
    async (c) => {
      const credentials = c.req.valid('json');
      c.header('Cache-Control', 'no-store');
      try {
        const { authTicket } = await authenticateNode(credentials, {
          signal: c.req.raw.signal,
        });
        setCookie(
          c,
          AUTH_COOKIE_NAME,
          await encryptAuthTicket(authTicket, c.env.AUTH_COOKIE_KEY),
          AUTH_COOKIE_OPTIONS,
        );
        return c.body(null, 200);
      } catch (e) {
        return handleError(e, c);
      }
    },
  )
  .delete('/login', (c) => {
    c.header('Cache-Control', 'no-store');
    deleteCookie(c, AUTH_COOKIE_NAME, AUTH_COOKIE_OPTIONS);
    return c.body(null, 204);
  });

export type AppType = typeof route;

export default app;
