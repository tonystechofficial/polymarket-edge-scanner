import { describe, expect, it } from 'vitest';
import type { FeeSchedule } from '@pes/shared';
import { computeEdge, executablePrice, takerFeeForFill, takerFeePerShare, walkBook } from '@pes/strategy';

const crypto: FeeSchedule = { rate: 0.07, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' };
const free: FeeSchedule = { rate: 0, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' };

describe('taker fees (official formula fee = shares * rate * (p(1-p))^exponent)', () => {
  it('matches the documented example: 100 crypto shares at 0.50 cost 1.75 USDC', () => {
    expect(takerFeePerShare(0.5, crypto) * 100).toBeCloseTo(1.75, 6);
  });
  it('is zero on fee-free markets and symmetric around 0.5', () => {
    expect(takerFeePerShare(0.3, free)).toBe(0);
    expect(takerFeePerShare(0.2, crypto)).toBeCloseTo(takerFeePerShare(0.8, crypto), 12);
  });
  it('sums fees level by level for a multi-level fill', () => {
    const fee = takerFeeForFill(
      [
        { price: 0.5, size: 100 },
        { price: 0.6, size: 50 },
      ],
      crypto,
    );
    expect(fee).toBeCloseTo(100 * 0.07 * 0.25 + 50 * 0.07 * 0.24, 6);
  });
});

describe('order book walking (executable price, not displayed price)', () => {
  const asks = [
    { price: 0.4, size: 100 },
    { price: 0.42, size: 100 },
    { price: 0.5, size: 1000 },
  ];
  it('fills inside the first level at the best price', () => {
    const fill = walkBook(asks, 50);
    expect(fill.filledShares).toBe(50);
    expect(fill.vwap).toBeCloseTo(0.4, 9);
    expect(fill.partial).toBe(false);
  });
  it('walks levels and reports the volume-weighted price and the worst level', () => {
    const fill = walkBook(asks, 150);
    expect(fill.filledShares).toBe(150);
    expect(fill.vwap).toBeCloseTo((100 * 0.4 + 50 * 0.42) / 150, 9);
    expect(fill.worstPrice).toBe(0.42);
    expect(fill.levelsUsed).toBe(2);
  });
  it('reports a partial fill when depth is insufficient and never invents liquidity', () => {
    const fill = walkBook(asks, 5000);
    expect(fill.partial).toBe(true);
    expect(fill.filledShares).toBe(1200);
    expect(executablePrice(asks, 5000)).toBeNull();
  });
  it('returns null executable price on an empty book', () => {
    expect(executablePrice([], 10)).toBeNull();
    expect(walkBook([], 10).filledShares).toBe(0);
  });
});

describe('net expected edge', () => {
  it('subtracts fee, slippage and the safety margin from the gross edge', () => {
    const r = computeEdge({ pSide: 0.6, execPrice: 0.5, bestPrice: 0.49, feePerShare: 0.0175, safetyMargin: 0.02 });
    expect(r.grossEdgePerShare).toBeCloseTo(0.1, 9);
    expect(r.slippagePerShare).toBeCloseTo(0.01, 9);
    expect(r.feePerShare).toBeCloseTo(0.0175, 9);
    expect(r.netEdgePerShare).toBeCloseTo(0.1 - 0.0175 - 0.02, 9);
    expect(r.breakEvenP).toBeCloseTo(0.5 + 0.0175 + 0.02, 9);
  });
  it('is negative when the estimate does not beat the executable price', () => {
    const r = computeEdge({ pSide: 0.5, execPrice: 0.52, bestPrice: 0.52, feePerShare: 0, safetyMargin: 0 });
    expect(r.netEdgePerShare).toBeLessThan(0);
  });
});
