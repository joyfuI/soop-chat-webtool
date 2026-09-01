import type { DonationData, StoreType } from '../types';

const REGEXP = /^(.+?)(?:\*(\d+))?$/;

const donationCalc = (
  data: DonationData,
  priceList: StoreType['setup.priceList'],
  skipPriceCheck: boolean = false,
) => {
  const match = data.message.match(REGEXP);
  if (!match) {
    return null;
  }
  const name = match[1]?.trim();
  if (!name) {
    return null;
  }
  const amount = parseInt(match[2] || '1', 10);
  const price = !skipPriceCheck
    ? priceList.find((item) => item === data.amount / amount)
    : data.amount / amount;
  return typeof price === 'number' ? { name, amount, price } : null;
};

export default donationCalc;
