import { zValidator as zv } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type * as z from 'zod';

export const zValidator = <
  T extends z.ZodType,
  Target extends keyof ValidationTargets,
>(
  target: Target,
  schema: T,
) =>
  zv(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          code: 'INVALID_REQUEST',
          message: 'Invalid request.',
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
      );
    }
    return;
  });
