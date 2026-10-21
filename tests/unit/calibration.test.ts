import { describe, expect, it } from 'vitest';
import type { CalibrationSample } from '@pes/shared';
import {
  DEFAULT_CALIBRATION_PARAMS,
  brierScore,
  compareWithBaselines,
  estimateFromCalibration,
  horizonBucket,
  logLoss,
  reliabilityTable,
  wilsonInterval,
} from '@pes/strategy';

function samples(n: number, price: number, hitRate: number, daysToEnd = 3): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ marketId: `m${i}`, price, daysToEnd, outcome: i < Math.round(n * hitRate) ? 1 : 0 });
  }
  return out;
}

describe('empirical calibration estimator', () => {
  it('returns INSUFFICIENT_EVIDENCE when the price/horizon bin has too few resolved samples', () => {
    const r = estimateFromCalibration(samples(5, 0.3, 0.6), 0.3, 3, DEFAULT_CALIBRATION_PARAMS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('INSUFFICIENT_EVIDENCE');
      expect(r.n).toBe(5);
    }
  });
  it('estimates the resolution frequency of similar markets with a Wilson interval', () => {
    const r = estimateFromCalibration(samples(60, 0.3, 0.5), 0.31, 3, DEFAULT_CALIBRATION_PARAMS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.estimate.p).toBeCloseTo(0.5, 9);
      expect(r.estimate.n).toBe(60);
      expect(r.estimate.ciLow).toBeLessThan(0.5);
      expect(r.estimate.ciHigh).toBeGreaterThan(0.5);
      expect(r.estimate.source).toBe('empirical_calibration');
      expect(r.estimate.explanation).toMatch(/60 resolved markets/);
    }
  });
  it('never returns the market price itself as the estimate', () => {
    const r = estimateFromCalibration(samples(60, 0.3, 0.9), 0.3, 3, DEFAULT_CALIBRATION_PARAMS);
    expect(r.ok && r.estimate.p).toBeCloseTo(0.9, 9);
  });
  it('ignores samples from another horizon bucket', () => {
    const far = samples(60, 0.3, 0.5, 60);
    const r = estimateFromCalibration(far, 0.3, 2, DEFAULT_CALIBRATION_PARAMS);
    expect(r.ok).toBe(false);
  });
  it('buckets horizons on the configured day edges', () => {
    const edges = [1, 7, 30];
    expect(horizonBucket(0.5, edges)).toBe(0);
    expect(horizonBucket(3, edges)).toBe(1);
    expect(horizonBucket(10, edges)).toBe(2);
    expect(horizonBucket(400, edges)).toBe(3);
  });
});

describe('Wilson interval', () => {
  it('is tighter with more samples and contains the point estimate', () => {
    const small = wilsonInterval(5, 10, 1.96);
    const large = wilsonInterval(50, 100, 1.96);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(small.low).toBeLessThan(0.5);
    expect(small.high).toBeGreaterThan(0.5);
  });
  it('handles n = 0 without NaN', () => {
    const r = wilsonInterval(0, 0, 1.96);
    expect(r.low).toBe(0);
    expect(r.high).toBe(1);
  });
});

describe('calibration metrics', () => {
  it('Brier score is 0 for perfect forecasts and 0.25 for constant 0.5', () => {
    expect(brierScore([1, 0, 1], [1, 0, 1])).toBe(0);
    expect(brierScore([0.5, 0.5], [1, 0])).toBeCloseTo(0.25, 9);
  });
  it('log loss penalises confident mistakes and never returns Infinity', () => {
    expect(logLoss([0.9], [0])).toBeGreaterThan(logLoss([0.6], [0]));
    expect(Number.isFinite(logLoss([1], [0]))).toBe(true);
  });
  it('reliability table groups predictions in bins with observed rates', () => {
    const table = reliabilityTable([0.1, 0.12, 0.9, 0.95], [0, 1, 1, 1], 0.2);
    const low = table.find((b) => b.binLow === 0);
    const high = table.find((b) => b.binLow === 0.8);
    expect(low?.n).toBe(2);
    expect(low?.observedRate).toBeCloseTo(0.5, 9);
    expect(high?.n).toBe(2);
    expect(high?.observedRate).toBe(1);
  });
  it('compares the model against the market-implied and uniform baselines on the same samples', () => {
    const s = samples(10, 0.8, 0.8);
    const preds = s.map(() => 0.8);
    const c = compareWithBaselines(s, preds);
    expect(c.model.n).toBe(10);
    expect(c.marketImplied.brier).toBeCloseTo(c.model.brier, 9);
    expect(c.uniform.brier).toBeCloseTo(0.25, 9);
    expect(c.model.brier).toBeLessThan(c.uniform.brier);
  });
  it('skips samples where the model abstained instead of inventing a forecast', () => {
    const s = samples(4, 0.5, 0.5);
    const c = compareWithBaselines(s, [0.5, null, 0.5, null]);
    expect(c.model.n).toBe(2);
    expect(c.marketImplied.n).toBe(4);
  });
});
