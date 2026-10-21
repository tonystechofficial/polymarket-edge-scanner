import type { BookLevel, FeeSchedule } from '@pes/shared';

/**
 * Official taker fee per share: rate * (p * (1 - p)) ^ exponent
 * (https://docs.polymarket.com/polymarket-learn/trading/fees). Makers pay nothing; this
 * project only ever simulates taking liquidity, so the taker rate is the one that matters.
 */
export function takerFeePerShare(price: number, fee: FeeSchedule): number {
  if (fee.rate <= 0 || price <= 0 || price >= 1) return 0;
  return fee.rate * (price * (1 - price)) ** fee.exponent;
}

/** Fee of a fill that spans several levels: each level is charged at its own price. */
export function takerFeeForFill(levels: BookLevel[], fee: FeeSchedule): number {
  return levels.reduce((sum, l) => sum + l.size * takerFeePerShare(l.price, fee), 0);
}
