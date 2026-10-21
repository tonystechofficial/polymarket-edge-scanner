import type { Side, SignalType } from '@pes/shared';

/** Price bucket label, so a one-tick move does not produce a "new" signal. */
export function priceBucket(price: number, width = 0.02): string {
  const b = Math.floor(price / width + 1e-9) * width;
  return b.toFixed(2);
}

/**
 * Idempotency key of a signal. The same market, type, side, price bucket and UTC day always
 * produce the same key; the database enforces uniqueness on it.
 */
export function signalIdemKey(parts: { marketId: string; type: SignalType; side: Side; priceBucket: string; day: string }): string {
  return [parts.marketId, parts.type, parts.side, parts.priceBucket, parts.day].join(':').toLowerCase();
}
