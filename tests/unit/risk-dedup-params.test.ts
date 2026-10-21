import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  applyParamUpdate,
  checkRiskLimits,
  kellyFraction,
  paramsFromRecords,
  positionSize,
  priceBucket,
  signalIdemKey,
  type RiskState,
} from '@pes/strategy';

const params = paramsFromRecords([]);
const calm: RiskState = { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 };

describe('risk limits', () => {
  it('Kelly fraction for a binary payoff is (p - price) / (1 - price) and 0 without edge', () => {
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 9);
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.4, 0.5)).toBe(0);
  });
  it('sizes with fractional Kelly and caps at the per-position maximum', () => {
    const r = positionSize({ p: 0.9, price: 0.5, params: { ...params, bankroll_usdc: 10_000, kelly_fraction: 0.25, max_position_usdc: 50 }, state: calm });
    expect(r.notionalUsdc).toBe(50);
    expect(r.shares).toBe(100);
    expect(r.reasons).toContain('capped_max_position');
  });
  it('returns zero size when the edge is absent', () => {
    const r = positionSize({ p: 0.5, price: 0.5, params, state: calm });
    expect(r.shares).toBe(0);
    expect(r.reasons).toContain('no_edge');
  });
  it('blocks new positions beyond exposure, count and daily limits', () => {
    const p = { ...params, max_open_positions: 2, max_daily_new_positions: 3, bankroll_usdc: 1000, max_exposure_pct: 0.1 };
    expect(checkRiskLimits(p, { openExposureUsdc: 95, openPositions: 0, newPositionsToday: 0 }, 10).ok).toBe(false);
    expect(checkRiskLimits(p, { openExposureUsdc: 0, openPositions: 2, newPositionsToday: 0 }, 10).reasons).toContain('max_open_positions');
    expect(checkRiskLimits(p, { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 3 }, 10).reasons).toContain('max_daily_new_positions');
    expect(checkRiskLimits(p, calm, 10).ok).toBe(true);
  });
});

describe('signal deduplication', () => {
  it('buckets prices so that tick noise does not create a new signal', () => {
    expect(priceBucket(0.431, 0.02)).toBe(priceBucket(0.439, 0.02));
    expect(priceBucket(0.43, 0.02)).not.toBe(priceBucket(0.47, 0.02));
  });
  it('produces a deterministic idempotency key that changes with market, side, bucket or day', () => {
    const base = { marketId: 'm1', type: 'VALUE' as const, side: 'YES' as const, priceBucket: '0.42', day: '2026-10-21' };
    expect(signalIdemKey(base)).toBe(signalIdemKey({ ...base }));
    expect(signalIdemKey(base)).not.toBe(signalIdemKey({ ...base, side: 'NO' }));
    expect(signalIdemKey(base)).not.toBe(signalIdemKey({ ...base, day: '2026-10-22' }));
    expect(signalIdemKey(base)).not.toBe(signalIdemKey({ ...base, priceBucket: '0.44' }));
    expect(signalIdemKey(base)).toMatch(/^[a-z0-9:_.-]+$/i);
  });
});

describe('strategy parameters with bounds', () => {
  it('starts from documented defaults', () => {
    expect(params.safety_margin).toBe(DEFAULT_PARAMS.safety_margin.value);
    expect(params.min_net_edge).toBeGreaterThan(0);
  });
  it('accepts an update inside the allowed range', () => {
    const r = applyParamUpdate(params, { key: 'safety_margin', value: 0.05 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.safety_margin).toBe(0.05);
  });
  it('rejects values outside the range and unknown keys', () => {
    expect(applyParamUpdate(params, { key: 'safety_margin', value: 0.9 }).ok).toBe(false);
    expect(applyParamUpdate(params, { key: 'kelly_fraction', value: -1 }).ok).toBe(false);
    expect(applyParamUpdate(params, { key: 'live_trading', value: 1 }).ok).toBe(false);
  });
  it('reads stored rows and ignores corrupt values', () => {
    const p = paramsFromRecords([
      { key: 'safety_margin', value: '0.03' },
      { key: 'min_net_edge', value: 'not-a-number' },
    ]);
    expect(p.safety_margin).toBe(0.03);
    expect(p.min_net_edge).toBe(DEFAULT_PARAMS.min_net_edge.value);
  });
});
