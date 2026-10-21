import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { runScan } from '../src/scan/run.ts';
import { Repo } from '../src/db/repo.ts';

// ---- synthetic Polymarket -----------------------------------------------------

const T0 = new Date('2026-10-21T10:00:00Z');
/** The scanner receives this clock; synthetic books are stamped a few seconds before it. */
const clock = { now: T0 };
const at = (d: Date) => {
  clock.now = d;
  return () => d;
};
const bookTs = () => clock.now.getTime() - 5_000;
const YES = '11111111111111';
const NO = '22222222222222';
const YES2 = '33333333333333';
const NO2 = '44444444444444';

function gammaMarket(id: string, yes: string, no: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conditionId: `0x${id.padStart(64, '0')}`,
    slug: `market-${id}`,
    question: `Will synthetic event ${id} happen before November?`,
    description: 'This market resolves YES if the synthetic event is confirmed by the synthetic source before 2026-11-01 00:00 UTC, otherwise NO. If the source is unavailable the market resolves 50-50.',
    endDate: '2026-11-01T00:00:00Z',
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.4", "0.6"]',
    clobTokenIds: JSON.stringify([yes, no]),
    active: true,
    closed: false,
    enableOrderBook: true,
    acceptingOrders: true,
    liquidityNum: 50_000,
    volume24hr: 20_000,
    feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
    ...overrides,
  };
}

const gammaEvents = [
  { id: 'e1', title: 'Synthetic event', negRisk: true, tags: [{ slug: 'politics' }], markets: [gammaMarket('101', YES, NO), gammaMarket('102', YES2, NO2)] },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Coherent YES/NO pair: on Polymarket the NO book mirrors the YES book (bid NO = 1 - ask YES). */
function pair(yes: string, no: string, yesBid: number, yesAsk: number, ts: number) {
  return [book(yes, yesBid, yesAsk, ts), book(no, round2(1 - yesAsk), round2(1 - yesBid), ts)];
}
/** YES asks of the two outcomes sum to 0.95: buying both pays 1 whichever outcome wins. */
const arbBooks = (ts: number) => [...pair(YES, NO, 0.4, 0.45, ts), ...pair(YES2, NO2, 0.45, 0.5, ts)];
const normalBooks = (ts: number) => [...pair(YES, NO, 0.4, 0.41, ts), ...pair(YES2, NO2, 0.58, 0.59, ts)];

function book(assetId: string, bid: number, ask: number, ts: number) {
  return { asset_id: assetId, timestamp: String(ts), hash: `h-${assetId}-${ts}`, bids: [{ price: String(bid - 0.02), size: '3000' }, { price: String(bid), size: '5000' }], asks: [{ price: String(ask + 0.02), size: '3000' }, { price: String(ask), size: '5000' }] };
}

type Route = (url: URL, init?: RequestInit) => unknown;
function fakePolymarket(routes: Partial<Record<'events' | 'markets' | 'books' | 'geoblock', Route>> = {}) {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push(url.host + url.pathname);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.host === 'geo.test') return json(routes.geoblock ? routes.geoblock(url, init) : { blocked: true, ip: '0.0.0.0', country: 'FR', region: 'NAQ' });
    if (url.host === 'gamma.test' && url.pathname === '/events') return json(routes.events ? routes.events(url, init) : gammaEvents);
    if (url.host === 'gamma.test' && url.pathname === '/markets') return json(routes.markets ? routes.markets(url, init) : []);
    if (url.host === 'clob.test' && url.pathname === '/books') return json(routes.books ? routes.books(url, init) : normalBooks(bookTs()));
    return json({ error: `unexpected ${url.href}` }, 500);
  };
  return { fetch, calls };
}

const stubAi = (response: unknown = null) => ({
  run: async () => ({
    response: response ?? {
      summary: 'Synthetic resolution rules depend on a synthetic source; nothing settles the question today.',
      probability_estimate: 0.9,
      confidence: 'high',
      supporting_evidence: [],
      contradicting_evidence: [],
      sources: [],
      data_freshness: 'unknown',
      recommendation: 'REVIEW',
      resolution_risks: ['50-50 clause if the source is unavailable'],
    },
    usage: { prompt_tokens: 600, completion_tokens: 90 },
  }),
});

async function count(table: string, where = '1=1'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

const TABLES = ['simulated_orders', 'calibration_samples', 'market_results', 'ai_analyses', 'signals', 'price_observations', 'markets', 'run_logs', 'quota_usage', 'strategy_params', 'system_state'];

// Every scenario starts from an empty database: the orchestrator keeps counters and cursors in D1.
beforeEach(async () => {
  clock.now = T0;
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scan orchestration', () => {
  it('first run discovers markets, second run prices them and records transparent rejections', async () => {
    const pm = fakePolymarket();
    const r1 = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(T0), sleep: async () => {} });
    expect(r1.status).toBe('ok');
    expect(r1.phase).toBe('discover');
    expect(r1.marketsScanned).toBe(2);
    expect(await count('markets', `status = 'tracked'`)).toBe(2);
    expect(pm.calls).toContain('geo.test/api/geoblock');
    expect(r1.subrequests).toBeLessThanOrEqual(3);

    const r2 = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    expect(r2.status).toBe('ok');
    expect(r2.phase).toBe('price');
    expect(r2.marketsScanned).toBe(2);
    expect(await count('price_observations')).toBe(4);
    expect(r2.signalsCreated).toBe(2);
    expect(r2.signalsAccepted).toBe(0);
    const signal = await env.DB.prepare(`SELECT status, reasons_json, estimate_p FROM signals LIMIT 1`).first<{ status: string; reasons_json: string; estimate_p: number | null }>();
    expect(signal?.status).toBe('REJECTED');
    expect(signal?.estimate_p).toBeNull();
    expect(JSON.parse(signal!.reasons_json)).toContain('INSUFFICIENT_EVIDENCE');
    expect(await count('simulated_orders')).toBe(0);

    const runs = await env.DB.prepare(`SELECT status, phase, subrequests, d1_statements FROM run_logs ORDER BY id`).all<{ status: string; phase: string; subrequests: number; d1_statements: number }>();
    expect(runs.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(Math.max(...runs.results.map((r) => r.d1_statements))).toBeLessThanOrEqual(40);
    const quota = await env.DB.prepare(`SELECT metric, value FROM quota_usage WHERE day = '2026-10-21'`).all<{ metric: string; value: number }>();
    expect(Object.fromEntries(quota.results.map((q) => [q.metric, q.value])).worker_invocations).toBe(2);
  });

  it('deduplicates signals across runs in the same price bucket and day', async () => {
    const pm = fakePolymarket();
    await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(T0), sleep: async () => {} });
    const a = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    const b = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(new Date(T0.getTime() + 30 * 60_000)), sleep: async () => {} });
    expect(a.signalsCreated).toBe(2);
    expect(b.signalsCreated).toBe(0);
    expect(await count('signals')).toBe(2);
  });

  it('refuses to run while another run holds the lock', async () => {
    const repo = new Repo(env.DB);
    expect(await repo.acquireLock(T0.getTime(), 120_000)).toBe(true);
    const pm = fakePolymarket();
    const r = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(T0) });
    expect(r.status).toBe('skipped');
    expect(pm.calls).toHaveLength(0);
    expect(await repo.acquireLock(T0.getTime() + 121_000, 120_000), 'an expired lock can be taken over').toBe(true);
  });

  it('detects a multi-outcome Dutch book and simulates it with executable prices, fees and assumptions', async () => {
    const pm = fakePolymarket({ books: () => arbBooks(bookTs()) });
    await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(T0), sleep: async () => {} });
    const r = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    expect(r.status).toBe('ok');
    const arb = await env.DB.prepare(`SELECT * FROM signals WHERE type = 'ARBITRAGE'`).first<Record<string, unknown>>();
    expect(arb).not.toBeNull();
    expect(arb?.status).toBe('ACCEPTED');
    expect(Number(arb?.exec_price)).toBeCloseTo(0.95, 6);
    expect(Number(arb?.net_edge)).toBeGreaterThan(0);
    expect(Number(arb?.suggested_notional)).toBeLessThanOrEqual(25);
    const orders = await env.DB.prepare(`SELECT market_id, side, filled_shares, notional_usdc, fee_paid_usdc, assumptions_json, is_simulation, status FROM simulated_orders`).all<Record<string, unknown>>();
    expect(orders.results).toHaveLength(2);
    expect(orders.results.map((o) => o.market_id).sort()).toEqual(['101', '102']);
    expect(orders.results.every((o) => o.side === 'YES' && o.is_simulation === 1 && o.status === 'OPEN')).toBe(true);
    expect(Number(orders.results[0]?.fee_paid_usdc)).toBeGreaterThan(0);
    expect(JSON.parse(String(orders.results[0]?.assumptions_json)).join(' ')).toMatch(/no order was created/i);
    // A binary YES/NO pair that is not a mirror is flagged as inconsistent data, never as free money.
    expect(await count('signals', `type = 'ARBITRAGE' AND evidence_json LIKE '%binary_dutch_book%'`)).toBe(0);
  });

  it('settles simulated orders and builds calibration samples when Gamma reports a resolution', async () => {
    const mode = { arb: true };
    const pm = fakePolymarket({
      books: () => (mode.arb ? arbBooks(bookTs()) : normalBooks(bookTs())),
      markets: () => [gammaMarket('101', YES, NO, { closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["1", "0"]' })],
    });
    await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(T0), sleep: async () => {} });
    await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    expect(await count('simulated_orders', `status = 'OPEN'`)).toBe(2);
    // Jump past the end date with normal prices: the resolve step asks Gamma and settles market 101.
    mode.arb = false;
    const later = new Date('2026-11-02T00:00:00Z');
    const r = await runScan(env, 'test', { fetch: pm.fetch, ai: null, now: at(later), sleep: async () => {} });
    expect(r.status).toBe('ok');
    expect(await count('market_results', `market_id = '101' AND winning_side = 'YES'`)).toBe(1);
    const settled = await env.DB.prepare(`SELECT side, pnl_usdc, payout_usdc, filled_shares, status FROM simulated_orders WHERE market_id = '101'`).all<{ side: string; pnl_usdc: number; payout_usdc: number; filled_shares: number; status: string }>();
    expect(settled.results).toHaveLength(1);
    expect(settled.results[0]?.status).toBe('SETTLED');
    expect(settled.results[0]?.payout_usdc).toBe(settled.results[0]?.filled_shares);
    expect(settled.results[0]!.pnl_usdc).toBeGreaterThan(0);
    expect(await count('simulated_orders', `market_id = '102' AND status = 'OPEN'`), 'the other outcome is still unresolved').toBe(1);
    expect(await count('calibration_samples', `market_id = '101' AND outcome = 1`)).toBeGreaterThan(0);
    expect((await env.DB.prepare(`SELECT status FROM markets WHERE id = '101'`).first<{ status: string }>())?.status).toBe('resolved');
  });

  it('stores a guarded AI analysis and respects the daily budget', async () => {
    const pm = fakePolymarket();
    const r = await runScan(env, 'test', { fetch: pm.fetch, ai: stubAi(), now: at(T0), sleep: async () => {} });
    expect(r.aiCalls).toBe(1);
    const a = await env.DB.prepare(`SELECT status, probability_estimate, confidence, recommendation, adjustments_json, neurons_est FROM ai_analyses`).first<Record<string, unknown>>();
    expect(a?.status).toBe('ok');
    expect(a?.probability_estimate, 'an unsupported probability is nulled by the guard').toBeNull();
    expect(a?.confidence).toBe('low');
    expect(a?.recommendation).toBe('INSUFFICIENT_EVIDENCE');
    expect(JSON.parse(String(a?.adjustments_json))).toContain('probability_removed:unsupported');
    expect(Number(a?.neurons_est)).toBeGreaterThan(0);

    // Exhaust the daily budget: the next run skips the model without calling it.
    await new Repo(env.DB).addQuota('2026-10-21', { ai_calls: 1000 }, T0.toISOString());
    let called = false;
    const spy = { run: async () => { called = true; return { response: {} }; } };
    const r2 = await runScan(env, 'test', { fetch: pm.fetch, ai: spy, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    expect(r2.aiCalls).toBe(0);
    expect(called).toBe(false);
  });

  it('survives a model failure and an upstream outage, logging the error instead of crashing', async () => {
    const failingAi = { run: async () => { throw new Error('3040: daily limit exceeded'); } };
    const pm = fakePolymarket();
    const r = await runScan(env, 'test', { fetch: pm.fetch, ai: failingAi, now: at(T0), sleep: async () => {} });
    expect(r.status).toBe('ok');
    expect((await env.DB.prepare(`SELECT status FROM ai_analyses`).first<{ status: string }>())?.status).toBe('error');

    const down = { fetch: async () => new Response('bad gateway', { status: 502 }) };
    const r2 = await runScan(env, 'test', { fetch: down.fetch, ai: null, now: at(new Date(T0.getTime() + 15 * 60_000)), sleep: async () => {} });
    expect(r2.status).toBe('error');
    expect(r2.error).toMatch(/HTTP 502/);
    const log = await env.DB.prepare(`SELECT status, error FROM run_logs ORDER BY id DESC LIMIT 1`).first<{ status: string; error: string }>();
    expect(log?.status).toBe('error');
    expect(await new Repo(env.DB).acquireLock(Date.now(), 1000), 'the lock is released after an error').toBe(true);
  });

  it('runs from the scheduled handler', async () => {
    const pm = fakePolymarket();
    vi.stubGlobal('fetch', pm.fetch);
    const ctrl = createScheduledController({ scheduledTime: T0, cron: '*/15 * * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, { ...env, AI_ENABLED: 'false' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count('run_logs', `trigger = 'cron' AND status = 'ok'`)).toBe(1);
    expect(await count('markets')).toBe(2);
  });

  it('refuses to start without the simulation flag', async () => {
    await expect(runScan({ ...env, SIMULATION_ONLY: 'false' }, 'test', { fetch: fakePolymarket().fetch, ai: null })).rejects.toThrow(/simulation/i);
  });
});
