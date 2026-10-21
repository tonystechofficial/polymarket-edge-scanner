import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.ts';

const TOKEN = 'test-admin-token-0123456789abcdef';

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://scanner.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('public API', () => {
  it('answers health and status on a fresh database', async () => {
    const health = await call('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const status = await call('/api/status');
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.simulationOnly).toBe(true);
    expect(body.tradingAllowed).toBe(false);
    expect((body.safety as { reasons: string[] }).reasons).toContain('SIMULATION_ONLY_BUILD');
    expect(typeof body.nextRunAt).toBe('string');
  });

  it('lists markets, signals, simulations, params, quotas and calibration', async () => {
    for (const path of ['/api/markets', '/api/signals', '/api/simulations', '/api/params', '/api/quotas', '/api/calibration', '/api/analyses', '/api/runs', '/api/errors']) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
    const params = (await (await call('/api/params')).json()) as { params: Array<{ key: string }> };
    expect(params.params.map((p) => p.key)).toContain('safety_margin');
    expect(params.params.map((p) => p.key)).not.toContain('live_trading');
  });

  it('returns 404 JSON for unknown API routes and 400 for missing query params', async () => {
    expect((await call('/api/nope')).status).toBe(404);
    expect((await call('/api/observations')).status).toBe(400);
    expect((await call('/api/signals/abc')).status).toBe(400);
    expect((await call('/api/signals/999999')).status).toBe(404);
  });
});

describe('admin API', () => {
  it('rejects missing and wrong tokens without leaking details', async () => {
    const missing = await call('/api/admin/whoami');
    expect(missing.status).toBe(401);
    const wrong = await call('/api/admin/whoami', { headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    const query = await call(`/api/admin/whoami?token=${TOKEN}`);
    expect(query.status, 'a token in the URL must never work').toBe(401);
  });

  it('accepts the bearer token and updates parameters only within bounds', async () => {
    const ok = await call('/api/admin/whoami', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);

    const good = await call('/api/admin/params', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'safety_margin', value: 0.04 }) });
    expect(good.status).toBe(200);
    const after = (await (await call('/api/params')).json()) as { params: Array<{ key: string; value: number }> };
    expect(after.params.find((p) => p.key === 'safety_margin')?.value).toBe(0.04);

    const bad = await call('/api/admin/params', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'safety_margin', value: 5 }) });
    expect(bad.status).toBe(422);
    const unknown = await call('/api/admin/params', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'live_trading', value: 1 }) });
    expect(unknown.status).toBe(422);
    const malformed = await call('/api/admin/params', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{"key":"safety_margin","value":"0.1","extra":1}' });
    expect(malformed.status).toBe(400);
  });
});
