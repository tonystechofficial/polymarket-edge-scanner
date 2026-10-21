import { describe, expect, it } from 'vitest';
import type { FeeSchedule } from '@pes/shared';
import { findBinaryDutchBook, findMultiOutcomeDutchBook } from '@pes/strategy';

const free: FeeSchedule = { rate: 0, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' };
const politics: FeeSchedule = { rate: 0.04, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' };

describe('binary Dutch book (YES ask + NO ask < 1 after fees)', () => {
  it('finds a structural opportunity priced on executable depth', () => {
    const r = findBinaryDutchBook({
      marketId: 'm1',
      yesAsks: [{ price: 0.45, size: 200 }],
      noAsks: [{ price: 0.5, size: 200 }],
      fee: free,
      minSets: 10,
      maxSets: 100,
      safetyMargin: 0.01,
    });
    expect(r).not.toBeNull();
    expect(r?.kind).toBe('binary_dutch_book');
    expect(r?.sets).toBe(100);
    expect(r?.costPerSet).toBeCloseTo(0.95, 9);
    expect(r?.netProfitPerSet).toBeCloseTo(0.05 - 0.01, 9);
    expect(r?.legs).toHaveLength(2);
  });
  it('returns null when fees erase the gap', () => {
    const r = findBinaryDutchBook({
      marketId: 'm1',
      yesAsks: [{ price: 0.49, size: 200 }],
      noAsks: [{ price: 0.5, size: 200 }],
      fee: politics,
      minSets: 10,
      maxSets: 100,
      safetyMargin: 0.005,
    });
    expect(r).toBeNull();
  });
  it('returns null when depth cannot fill the minimum number of sets', () => {
    const r = findBinaryDutchBook({
      marketId: 'm1',
      yesAsks: [{ price: 0.4, size: 3 }],
      noAsks: [{ price: 0.5, size: 300 }],
      fee: free,
      minSets: 10,
      maxSets: 100,
      safetyMargin: 0,
    });
    expect(r).toBeNull();
  });
  it('returns null on a normally priced market', () => {
    const r = findBinaryDutchBook({
      marketId: 'm1',
      yesAsks: [{ price: 0.68, size: 1000 }],
      noAsks: [{ price: 0.33, size: 1000 }],
      fee: free,
      minSets: 10,
      maxSets: 100,
      safetyMargin: 0.01,
    });
    expect(r).toBeNull();
  });
});

describe('multi-outcome Dutch book (sum of YES asks across all outcomes of an event < 1)', () => {
  const legs = (prices: number[]) =>
    prices.map((p, i) => ({ marketId: `m${i}`, tokenId: `t${i}`, outcome: `O${i}`, asks: [{ price: p, size: 500 }], fee: free }));

  it('finds the opportunity when the whole outcome set is present', () => {
    const r = findMultiOutcomeDutchBook({ eventId: 'e1', legs: legs([0.3, 0.3, 0.3]), expectedOutcomes: 3, minSets: 10, maxSets: 50, safetyMargin: 0.01 });
    expect(r?.kind).toBe('multi_outcome_dutch_book');
    expect(r?.costPerSet).toBeCloseTo(0.9, 9);
    expect(r?.netProfitPerSet).toBeCloseTo(0.09, 9);
    expect(r?.legs).toHaveLength(3);
  });
  it('refuses when some outcomes of the event are missing (the set would not be complete)', () => {
    const r = findMultiOutcomeDutchBook({ eventId: 'e1', legs: legs([0.3, 0.3]), expectedOutcomes: 3, minSets: 10, maxSets: 50, safetyMargin: 0.01 });
    expect(r).toBeNull();
  });
  it('returns null when the sum is at or above 1', () => {
    const r = findMultiOutcomeDutchBook({ eventId: 'e1', legs: legs([0.4, 0.4, 0.3]), expectedOutcomes: 3, minSets: 10, maxSets: 50, safetyMargin: 0.01 });
    expect(r).toBeNull();
  });
});
