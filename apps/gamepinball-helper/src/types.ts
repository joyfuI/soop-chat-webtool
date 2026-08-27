import type { SoopChatEventMap } from 'soop-chat';

export type DonationData = {
  receivedAt: string;
  type:
    | (
        | SoopChatEventMap['sendBalloon']
        | SoopChatEventMap['adconEffect']
      )['type']
    | 'manual';
  amount: number;
  username: string;
  userId: string;
  message: string;
};

export type StoreType = {
  tab: number; // 0
  'setup.id': string; // ''
  'setup.rule': string; // ''
  'setup.priceList': number[]; // [50, 200]
  'progress.fontSize': number; // 40
  'progress.donationList': DonationData[]; // []
  review: Record<string, Record<string, number>>; // {}
  'pinball.rerollPrice': number; // 1000
  'pinball.timer.minute': number; // 1
  'pinball.timer.second': number; // 0
};
