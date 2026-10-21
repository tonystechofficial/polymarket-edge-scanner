import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('D1 migrations', () => {
  it('creates every table of the schema', async () => {
    const rows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const t of ['markets', 'price_observations', 'ai_analyses', 'signals', 'simulated_orders', 'market_results', 'calibration_samples', 'run_logs', 'quota_usage', 'strategy_params', 'system_state']) {
      expect(names).toContain(t);
    }
  });

  it('refuses a simulated order that claims not to be a simulation', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO markets (id, condition_id, slug, question, description, end_date, yes_token_id, no_token_id, outcomes_json, first_seen_at, last_seen_at) VALUES ('m-chk', '0x1', 'm-chk', 'q', 'd', ?, 'y', 'n', '["Yes","No"]', ?, ?)`).bind(now, now, now).run();
    const sig = await env.DB.prepare(`INSERT INTO signals (idem_key, market_id, created_at, type, side, outcome, status, strategy_version) VALUES ('k-chk', 'm-chk', ?, 'VALUE', 'YES', 'Yes', 'REJECTED', 'test') RETURNING id`).bind(now).first<{ id: number }>();
    await expect(
      env.DB.prepare(`INSERT INTO simulated_orders (signal_id, market_id, created_at, side, outcome, token_id, requested_shares, filled_shares, notional_usdc, fee_paid_usdc, slippage_usdc, is_simulation) VALUES (?, 'm-chk', ?, 'YES', 'Yes', 'y', 1, 1, 0.5, 0, 0, 0)`).bind(sig!.id, now).run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('enforces signal idempotency keys', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO markets (id, condition_id, slug, question, description, end_date, yes_token_id, no_token_id, outcomes_json, first_seen_at, last_seen_at) VALUES ('m-dup', '0x1', 'm-dup', 'q', 'd', ?, 'y', 'n', '["Yes","No"]', ?, ?)`).bind(now, now, now).run();
    const insert = () => env.DB.prepare(`INSERT OR IGNORE INTO signals (idem_key, market_id, created_at, type, side, outcome, status, strategy_version) VALUES ('k-dup', 'm-dup', ?, 'VALUE', 'YES', 'Yes', 'REJECTED', 'test')`).bind(now).run();
    const first = await insert();
    const second = await insert();
    expect(first.meta.changes).toBe(1);
    expect(second.meta.changes).toBe(0);
  });
});
