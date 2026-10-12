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

import { decryptAuthTicket, encryptAuthTicket } from './auth-cookie.ts';
import { zValidator } from './validator-wrapper.ts';

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
        : [
            'https://soop-gamepinball-helper.netlify.app',
            'https://bluejump-fan.vercel.app',
            'http://localhost:3000',
          ],
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
        console.info({ event: 'channel_lookup_success', streamerId });
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
        console.info({ event: 'channel_lookup_success', streamerId });
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
        console.info({
          event: 'login_success',
          username: credentials.username,
        });
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
  })
  .get('/turn', async (c) => {
    c.header('Cache-Control', 'no-store');
    const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = c.env;
    if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) {
      return c.json(
        {
          code: 'TURN_NOT_CONFIGURED',
          message: 'TURN credentials are not configured.',
        },
        503,
      );
    }

    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 86400 }),
          signal: c.req.raw.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Cloudflare TURN returned HTTP ${response.status}.`);
      }

      const credentials = z
        .object({
          iceServers: z
            .array(
              z.object({
                urls: z.array(z.string().min(1)).min(1),
                username: z.string().min(1).optional(),
                credential: z.string().min(1).optional(),
              }),
            )
            .min(1),
        })
        .parse(await response.json());
      return c.json(credentials, 200);
    } catch (e) {
      console.error({ event: 'turn_credentials_error', error: e });
      return c.json(
        {
          code: 'TURN_UNAVAILABLE',
          message: 'Failed to issue TURN credentials.',
        },
        503,
      );
    }
  });

export type AppType = typeof route;

export default app;
