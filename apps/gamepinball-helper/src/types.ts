import type { SoopChatEventMap } from 'soop-chat';
import { z } from 'zod';

export type DonationEvent =
  | SoopChatEventMap['sendBalloon']
  | SoopChatEventMap['adconEffect'];

export const storeSchema = {
  tab: z.number().default(0),
  'setup.streamerId': z.string().default(''),
  'setup.rule': z.string().default(''),
  'setup.priceList': z.array(z.number()).default([50, 200]),
  'progress.fontSize': z.number().default(40),
  'progress.donationList': z
    .array(
      z.object({
        receivedAt: z.iso.datetime(),
        type: z.literal(['sendBalloon', 'adconEffect', 'manual']),
        amount: z.number(),
        username: z.string(),
        userId: z.string(),
        message: z.string(),
      }),
    )
    .default([]),
  review: z
    .record(z.string(), z.record(z.string().trim(), z.number()))
    .default({}),
  'pinball.rerollPrice': z.number().default(1000),
  'pinball.timer.minute': z.number().default(1),
  'pinball.timer.second': z.number().default(0),
};

export type StoreKey = keyof typeof storeSchema;

export type StoreType = {
  [K in StoreKey]: z.output<(typeof storeSchema)[K]>;
};

export type DonationData = StoreType['progress.donationList'][number];
