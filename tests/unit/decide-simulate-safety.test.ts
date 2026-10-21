import { describe, expect, it } from 'vitest';
import type { OrderBook, ProbabilityEstimate, TrackedMarket } from '@pes/shared';
import { assertSimulationOnly, canOpenRealPosition, evaluateValue, paramsFromRecords, settleFill, simulateBuy } from '@pes/strategy';

const now = new Date('2026-10-21T12:00:00Z');
const params = paramsFromRecords([]);

const market: TrackedMarket = {
  id: 'm1',
  conditionId: '0xabc',
  slug: 'm1',
  question: 'Will it rain in Bordeaux on 2026-10-25?',
  description: 'Resolves YES if Météo-France reports more than 0.2 mm of rain at Bordeaux-Mérignac on 2026-10-25.',
  category: 'weather',
  tags: ['weather'],
  endDate: '2026-10-26T00:00:00Z',
  yesTokenId: '1'.repeat(12),
  noTokenId: '2'.repeat(12),
  outcomes: ['Yes', 'No'],
  fee: { rate: 0.05, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' },
  negRisk: false,
  eventId: 'e1',
  liquidity: 50_000,
  volume24h: 20_000,
  minOrderSize: 5,
  tickSize: 0.01,
  status: 'tracked',
};

function book(tokenId: string, bid: number, ask: number, size = 5_000): OrderBook {
  return { tokenId, bids: [{ price: bid, size }], asks: [{ price: ask, size }], timestampMs: now.getTime() - 5_000, hash: 'h', tickSize: 0.01, minOrderSize: 5 };
}
const yes = book(market.yesTokenId, 0.4, 0.41);
const no = book(market.noTokenId, 0.59, 0.6);
const strong: ProbabilityEstimate = { p: 0.7, ciLow: 0.62, ciHigh: 0.78, n: 120, source: 'empirical_calibration', explanation: 'test' };

describe('value signal decision', () => {
  it('returns INSUFFICIENT_EVIDENCE rejection when no independent estimate exists', () => {
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: null, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d.status).toBe('REJECTED');
    expect(d.reasons).toContain('INSUFFICIENT_EVIDENCE');
    expect(d.estimate).toBeNull();
    expect(d.execPrice).toBeCloseTo(0.41, 9);
  });
  it('accepts when the lower confidence bound beats the executable price plus costs and margin', () => {
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: strong, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d.status).toBe('ACCEPTED');
    expect(d.side).toBe('YES');
    expect(d.type).toBe('VALUE');
    expect(d.netEdgePerShare).toBeGreaterThan(0);
    expect(d.suggestedShares).toBeGreaterThan(0);
    expect(d.reasons.join(' ')).toMatch(/ci_low/);
    expect(d.idemKey.length).toBeGreaterThan(8);
  });
  it('takes the NO side when the estimate is below the price', () => {
    const low: ProbabilityEstimate = { ...strong, p: 0.15, ciLow: 0.08, ciHigh: 0.22 };
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: low, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d.side).toBe('NO');
    expect(d.status).toBe('ACCEPTED');
  });
  it('rejects stale or incoherent books even with a strong estimate', () => {
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: strong, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: false, problems: ['yes_stale_book'] } });
    expect(d.status).toBe('REJECTED');
    expect(d.reasons).toContain('yes_stale_book');
  });
  it('rejects when the edge is below the threshold once the safety margin is applied', () => {
    const marginal: ProbabilityEstimate = { ...strong, p: 0.46, ciLow: 0.43, ciHigh: 0.49 };
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: marginal, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d.status).toBe('REJECTED');
    expect(d.reasons.some((r) => r.startsWith('edge_below_threshold'))).toBe(true);
  });
  it('rejects when the spread is too wide or the estimate has too few samples', () => {
    const wide = book(market.yesTokenId, 0.3, 0.5);
    const d1 = evaluateValue({ market, yesBook: wide, noBook: no, estimate: strong, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d1.reasons.some((r) => r.startsWith('spread_too_wide'))).toBe(true);
    const thin = { ...strong, n: 3 };
    const d2 = evaluateValue({ market, yesBook: yes, noBook: no, estimate: thin, params, risk: { openExposureUsdc: 0, openPositions: 0, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d2.status).toBe('REJECTED');
  });
  it('rejects when risk limits are saturated and says so', () => {
    const d = evaluateValue({ market, yesBook: yes, noBook: no, estimate: strong, params, risk: { openExposureUsdc: 0, openPositions: 999, newPositionsToday: 0 }, now, validation: { ok: true, problems: [] } });
    expect(d.status).toBe('REJECTED');
    expect(d.reasons).toContain('max_open_positions');
  });
});

describe('simulator', () => {
  const fee = { rate: 0.05, exponent: 1, takerOnly: true, source: 'gamma_fee_schedule' as const };
  it('fills at executable prices across levels, charges taker fees and records assumptions', () => {
    const asks = [
      { price: 0.4, size: 50 },
      { price: 0.45, size: 100 },
    ];
    const fill = simulateBuy({ asks, shares: 100, fee, bookAgeSeconds: 5 });
    expect(fill.filledShares).toBe(100);
    expect(fill.vwapPrice).toBeCloseTo((50 * 0.4 + 50 * 0.45) / 100, 9);
    expect(fill.notionalUsdc).toBeCloseTo(50 * 0.4 + 50 * 0.45, 9);
    expect(fill.feePaidUsdc).toBeCloseTo(50 * 0.05 * 0.4 * 0.6 + 50 * 0.05 * 0.45 * 0.55, 9);
    expect(fill.slippageUsdc).toBeCloseTo(50 * 0.05, 9);
    expect(fill.partial).toBe(false);
    expect(fill.assumptions.join(' ')).toMatch(/snapshot/i);
  });
  it('marks partial fills and never fills more than the book shows', () => {
    const fill = simulateBuy({ asks: [{ price: 0.4, size: 10 }], shares: 100, fee, bookAgeSeconds: 5 });
    expect(fill.partial).toBe(true);
    expect(fill.filledShares).toBe(10);
  });
  it('settles a win at 1 USDC per share and a loss at 0, net of fees', () => {
    const fill = simulateBuy({ asks: [{ price: 0.4, size: 100 }], shares: 100, fee, bookAgeSeconds: 5 });
    const win = settleFill(fill, true);
    const loss = settleFill(fill, false);
    expect(win.payoutUsdc).toBe(100);
    expect(win.pnlUsdc).toBeCloseTo(100 - 40 - fill.feePaidUsdc, 9);
    expect(loss.payoutUsdc).toBe(0);
    expect(loss.pnlUsdc).toBeCloseTo(-40 - fill.feePaidUsdc, 9);
  });
});

describe('simulation-only guarantees', () => {
  it('never allows a real position, whatever the geoblock says', () => {
    const allowedGeo = { blocked: false, country: 'XX', region: null, checkedAt: now.toISOString(), eligibility: 'allowed' as const };
    const r1 = canOpenRealPosition({ simulationOnly: true, geoblock: allowedGeo });
    expect(r1.allowed).toBe(false);
    expect(r1.reasons).toContain('SIMULATION_ONLY_BUILD');
    const r2 = canOpenRealPosition({ simulationOnly: true, geoblock: { ...allowedGeo, blocked: true, eligibility: 'blocked', country: 'FR' } });
    expect(r2.reasons).toContain('GEOBLOCKED:FR');
    const r3 = canOpenRealPosition({ simulationOnly: true, geoblock: null });
    expect(r3.reasons).toContain('GEOBLOCK_UNKNOWN');
  });
  it('refuses to start when the configuration tries to disable simulation mode', () => {
    expect(() => assertSimulationOnly({ SIMULATION_ONLY: 'false' })).toThrow(/simulation/i);
    expect(() => assertSimulationOnly({})).toThrow();
    expect(() => assertSimulationOnly({ SIMULATION_ONLY: 'true' })).not.toThrow();
  });
});
