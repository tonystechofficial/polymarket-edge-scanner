import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { selectBatch, shouldDiscover, type GammaMarket } from '@pes/shared';
import { ClobClient, GammaClient, HttpError, SubrequestBudget, checkGeoblock, fetchJson, normalizeBook, normalizeMarket, validateBookPair } from '@pes/polymarket';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handlers: Handler[]) {
  let i = 0;
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const h = handlers[Math.min(i, handlers.length - 1)]!;
    i += 1;
    return h(url, init);
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

describe('HTTP layer: retries, backoff, budget', () => {
  it('retries 5xx and 429 with backoff, then succeeds', async () => {
    const waits: number[] = [];
    const f = fakeFetch([() => json({}, 500), () => json({}, 429, { 'retry-after': '1' }), () => json({ ok: 1 })]);
    const r = await fetchJson('https://x.test/a', z.object({ ok: z.number() }), { fetch: f.fetch, sleep: async (ms) => { waits.push(ms); }, retries: 2, backoffMs: 100 });
    expect(r.ok).toBe(1);
    expect(f.calls).toHaveLength(3);
    expect(waits[0]).toBe(100);
    expect(waits[1]).toBeGreaterThanOrEqual(1000);
  });
  it('does not retry a 404 and surfaces the status', async () => {
    const f = fakeFetch([() => json({ error: 'nope' }, 404)]);
    await expect(fetchJson('https://x.test/a', z.any(), { fetch: f.fetch, sleep: noSleep })).rejects.toMatchObject({ status: 404, retryable: false });
    expect(f.calls).toHaveLength(1);
  });
  it('gives up after the bounded number of retries', async () => {
    const f = fakeFetch([() => json({}, 503)]);
    await expect(fetchJson('https://x.test/a', z.any(), { fetch: f.fetch, sleep: noSleep, retries: 2 })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(3);
  });
  it('rejects invalid JSON and schema mismatches without retrying', async () => {
    const bad = fakeFetch([() => new Response('<html>', { status: 200 })]);
    await expect(fetchJson('https://x.test/a', z.any(), { fetch: bad.fetch, sleep: noSleep })).rejects.toMatchObject({ kind: 'invalid_json' });
    expect(bad.calls).toHaveLength(1);
    const mismatch = fakeFetch([() => json({ nope: true })]);
    await expect(fetchJson('https://x.test/a', z.object({ ok: z.number() }), { fetch: mismatch.fetch, sleep: noSleep })).rejects.toMatchObject({ kind: 'schema' });
  });
  it('treats a timeout as retryable', async () => {
    const f = fakeFetch([
      (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      () => json({ ok: 1 }),
    ]);
    const r = await fetchJson('https://x.test/a', z.object({ ok: z.number() }), { fetch: f.fetch, sleep: noSleep, timeoutMs: 10, retries: 1 });
    expect(r.ok).toBe(1);
  });
  it('stops at the subrequest budget', async () => {
    const budget = new SubrequestBudget(1);
    const f = fakeFetch([() => json({ ok: 1 })]);
    await fetchJson('https://x.test/a', z.any(), { fetch: f.fetch, budget });
    await expect(fetchJson('https://x.test/b', z.any(), { fetch: f.fetch, budget })).rejects.toMatchObject({ kind: 'budget' });
    expect(budget.remaining).toBe(0);
  });
});

const rawMarket: GammaMarket = {
  id: '42',
  conditionId: '0x' + 'a'.repeat(64),
  slug: 'will-x',
  question: 'Will X happen before 2027?',
  description: 'This market resolves YES if X is confirmed by an official source before 2027-01-01, otherwise NO.',
  endDate: '2026-12-31T00:00:00Z',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.4", "0.6"]',
  clobTokenIds: '["1234567890123", "9876543210987"]',
  active: true,
  closed: false,
  enableOrderBook: true,
  acceptingOrders: true,
  liquidityNum: 12_000,
  volume24hr: 3_000,
  feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true, rebateRate: 0.25 },
  tags: [{ slug: 'politics' }],
};

describe('market normalisation and data validation', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  it('tracks a well-formed market with its documented fee and category', () => {
    const r = normalizeMarket(rawMarket, { now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.market.category).toBe('politics');
      expect(r.market.fee).toMatchObject({ rate: 0.04, source: 'gamma_fee_schedule' });
      expect(r.market.yesTokenId).toBe('1234567890123');
    }
  });
  it('ignores closed, non-binary, undocumented, past or malformed markets with a reason', () => {
    expect(normalizeMarket({ ...rawMarket, closed: true }, { now })).toMatchObject({ ok: false, reason: 'closed_or_archived' });
    expect(normalizeMarket({ ...rawMarket, outcomes: '["A","B","C"]' }, { now })).toMatchObject({ ok: false, reason: 'not_binary' });
    expect(normalizeMarket({ ...rawMarket, description: 'short' }, { now })).toMatchObject({ ok: false, reason: 'undocumented_resolution' });
    expect(normalizeMarket({ ...rawMarket, endDate: '2020-01-01T00:00:00Z' }, { now })).toMatchObject({ ok: false, reason: 'past_end_date' });
    expect(normalizeMarket({ ...rawMarket, clobTokenIds: 'garbage' }, { now })).toMatchObject({ ok: false, reason: 'missing_token_ids' });
    expect(normalizeMarket({ ...rawMarket, acceptingOrders: false }, { now })).toMatchObject({ ok: false, reason: 'not_accepting_orders' });
  });
  it('assumes the maximum documented fee when Gamma publishes no schedule', () => {
    const r = normalizeMarket({ ...rawMarket, feeSchedule: null }, { now });
    expect(r.ok && r.market.fee).toMatchObject({ rate: 0.07, source: 'assumed_max' });
  });
  it('sorts book levels best-first and drops malformed levels', () => {
    const b = normalizeBook({ asset_id: 't', bids: [{ price: '0.1', size: '5' }, { price: '0.4', size: '7' }, { price: 'x', size: '1' }], asks: [{ price: '0.9', size: '1' }, { price: '0.45', size: '2' }, { price: '0.5', size: '0' }], timestamp: '1792545433176', hash: 'h' });
    expect(b.bids.map((l) => l.price)).toEqual([0.4, 0.1]);
    expect(b.asks.map((l) => l.price)).toEqual([0.45, 0.9]);
    expect(b.timestampMs).toBe(1792545433176);
  });
  it('flags stale, crossed and incoherent book pairs', () => {
    const t = now.getTime();
    const yes = { tokenId: 'y', bids: [{ price: 0.4, size: 1 }], asks: [{ price: 0.41, size: 1 }], timestampMs: t - 1000, hash: '', tickSize: 0.01, minOrderSize: 5 };
    const no = { tokenId: 'n', bids: [{ price: 0.59, size: 1 }], asks: [{ price: 0.6, size: 1 }], timestampMs: t - 1000, hash: '', tickSize: 0.01, minOrderSize: 5 };
    expect(validateBookPair(yes, no, { now }).ok).toBe(true);
    expect(validateBookPair({ ...yes, timestampMs: t - 3_600_000 }, no, { now }).problems).toContain('yes_stale_book');
    expect(validateBookPair({ ...yes, bids: [{ price: 0.5, size: 1 }] }, no, { now }).problems).toContain('yes_crossed_book');
    expect(validateBookPair(yes, { ...no, asks: [{ price: 0.7, size: 1 }] }, { now }).problems).toContain('incoherent_pair');
  });
});

describe('Polymarket clients', () => {
  it('Gamma: validates each market individually and counts rejected ones', async () => {
    const f = fakeFetch([() => json([rawMarket, { id: 7 }])]);
    const client = new GammaClient('https://gamma.test', { fetch: f.fetch, sleep: noSleep });
    const r = await client.listMarkets({ limit: 500, liquidityMin: 1000 });
    expect(r.markets).toHaveLength(1);
    expect(r.rejected).toBe(1);
    expect(f.calls[0]).toContain('limit=50');
    expect(f.calls[0]).toContain('liquidity_num_min=1000');
    expect(f.calls[0]).toContain('closed=false');
  });
  it('CLOB: prices a batch of tokens in one request and reports missing books', async () => {
    const f = fakeFetch([(_u, init) => {
      const body = JSON.parse(String(init?.body)) as Array<{ token_id: string }>;
      expect(body).toHaveLength(2);
      return json([{ asset_id: 'a', bids: [], asks: [{ price: '0.5', size: '10' }], timestamp: '1', hash: 'h' }]);
    }]);
    const client = new ClobClient('https://clob.test', { fetch: f.fetch, sleep: noSleep });
    const r = await client.getBooks(['a', 'b', 'a']);
    expect(f.calls).toHaveLength(1);
    expect(r.books.get('a')?.asks[0]?.price).toBe(0.5);
    expect(r.missing).toEqual(['b']);
  });
  it('geoblock: reports blocked / allowed / unknown and never throws', async () => {
    const blocked = fakeFetch([() => json({ blocked: true, ip: '1.2.3.4', country: 'FR', region: 'NAQ' })]);
    expect(await checkGeoblock('https://g.test', { fetch: blocked.fetch, sleep: noSleep })).toMatchObject({ blocked: true, country: 'FR', eligibility: 'blocked' });
    const allowed = fakeFetch([() => json({ blocked: false, country: 'XX', region: '' })]);
    expect((await checkGeoblock('https://g.test', { fetch: allowed.fetch, sleep: noSleep })).eligibility).toBe('allowed');
    const down = fakeFetch([() => json({}, 500)]);
    const r = await checkGeoblock('https://g.test', { fetch: down.fetch, sleep: noSleep });
    expect(r.eligibility).toBe('unknown');
    expect(r.blocked).toBe(true);
  });
});

describe('batch planning and quota guards', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}` }));
  it('selects the next slice from the cursor and wraps around', () => {
    const a = selectBatch(items, 0, 3, 20);
    expect(a.batch.map((x) => x.id)).toEqual(['m0', 'm1', 'm2']);
    expect(a.nextCursor).toBe(3);
    const c = selectBatch(items, 6, 3, 20);
    expect(c.batch.map((x) => x.id)).toEqual(['m6']);
    expect(c.nextCursor).toBe(0);
    expect(c.wrapped).toBe(true);
  });
  it('never exceeds the hard cap even when parameters ask for more', () => {
    expect(selectBatch(items, 0, 100, 2).batch).toHaveLength(2);
  });
  it('runs discovery on the configured cadence and when nothing is tracked', () => {
    expect(shouldDiscover(0, 6, 0)).toBe(true);
    expect(shouldDiscover(1, 6, 10)).toBe(false);
    expect(shouldDiscover(6, 6, 10)).toBe(true);
    expect(shouldDiscover(3, 6, 0)).toBe(true);
  });
});
