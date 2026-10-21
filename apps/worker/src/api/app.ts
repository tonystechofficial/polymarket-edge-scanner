import { Hono, type Context } from 'hono';
import { checkGeoblock } from '@pes/polymarket';
import { applyParamUpdate, brierScore, canOpenRealPosition, compareWithBaselines, describeParams, logLoss, paramsFromRecords, reliabilityTable } from '@pes/strategy';
import { CLOUDFLARE_FREE_LIMITS, HARD_CAPS, STRATEGY_VERSION, dayKey, paramUpdateSchema, safeJsonParse, type CalibrationSample, type GeoblockStatus } from '@pes/shared';
import { Repo } from '../db/repo.ts';
import { nextCronRun, parseConfig, type WorkerEnv } from '../env.ts';
import { aiBindingFrom, runScan } from '../scan/run.ts';

type AppEnv = { Bindings: WorkerEnv };

export const app = new Hono<AppEnv>();

const PUBLIC_CACHE = 'public, max-age=30';

function intParam(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

function json(c: Context<AppEnv>, body: unknown, status = 200, cache = PUBLIC_CACHE): Response {
  c.header('cache-control', cache);
  c.header('x-content-type-options', 'nosniff');
  c.header('access-control-allow-origin', '*');
  return c.json(body as never, status as never);
}

app.get('/api/health', (c) => json(c, { ok: true, service: 'polymarket-edge-scanner', strategyVersion: STRATEGY_VERSION, time: new Date().toISOString() }, 200, 'no-store'));

app.get('/api/status', async (c) => {
  const repo = new Repo(c.env.DB);
  const cfg = parseConfig(c.env);
  const now = new Date();
  const [states, counts, lastRuns] = await Promise.all([repo.getStates(['last_run_at', 'last_run_phase', 'last_run_status', 'geoblock_json', 'run_counter', 'price_cursor', 'scan_lock']), repo.apiCounts(), repo.apiRuns(1)]);
  const geoblock = safeJsonParse<GeoblockStatus>(states.geoblock_json) ?? null;
  const lockUntil = Number(states.scan_lock ?? 0);
  return json(c, {
    simulationOnly: true,
    tradingAllowed: false,
    safety: canOpenRealPosition({ simulationOnly: cfg.simulationOnly, geoblock }),
    geoblock,
    lastRun: lastRuns[0] ?? null,
    lastRunAt: states.last_run_at ?? null,
    lastRunPhase: states.last_run_phase ?? null,
    lastRunStatus: states.last_run_status ?? null,
    runCounter: Number(states.run_counter ?? 0),
    priceCursor: Number(states.price_cursor ?? 0),
    scanLocked: lockUntil > now.getTime(),
    nextRunAt: nextCronRun(cfg.cronSchedule, now)?.toISOString() ?? null,
    cronSchedule: cfg.cronSchedule,
    counts,
    config: {
      aiEnabled: cfg.aiEnabled,
      aiModel: cfg.aiModel,
      aiMaxCallsPerRun: cfg.aiMaxCallsPerRun,
      aiMaxCallsPerDay: cfg.aiMaxCallsPerDay,
      aiMaxNeuronsPerDay: cfg.aiMaxNeuronsPerDay,
      maxMarketsPerRun: cfg.maxMarketsPerRun,
      maxTrackedMarkets: cfg.maxTrackedMarkets,
      discoveryEveryNRuns: cfg.discoveryEveryNRuns,
      retentionDays: cfg.retentionDays,
      strategyVersion: STRATEGY_VERSION,
    },
    time: now.toISOString(),
  }, 200, 'no-store');
});

app.get('/api/markets', async (c) => {
  const repo = new Repo(c.env.DB);
  const rows = await repo.apiMarkets({ status: c.req.query('status') ?? undefined, category: c.req.query('category') ?? undefined, limit: intParam(c.req.query('limit'), 50, 200), offset: intParam(c.req.query('offset'), 0, 10_000) });
  return json(c, { markets: rows });
});

app.get('/api/markets/:id', async (c) => {
  const repo = new Repo(c.env.DB);
  const id = c.req.param('id');
  const market = await repo.apiMarket(id);
  if (!market) return json(c, { error: 'not found' }, 404, 'no-store');
  const [observations, signals, analyses] = await Promise.all([repo.apiObservations(id, 60), repo.apiSignals({ marketId: id, limit: 20, offset: 0 }), repo.apiAnalyses(id, 3)]);
  return json(c, { market, observations, signals, analyses });
});

app.get('/api/observations', async (c) => {
  const marketId = c.req.query('market_id');
  if (!marketId) return json(c, { error: 'market_id required' }, 400, 'no-store');
  const repo = new Repo(c.env.DB);
  return json(c, { observations: await repo.apiObservations(marketId, intParam(c.req.query('limit'), 100, 500)) });
});

app.get('/api/signals', async (c) => {
  const repo = new Repo(c.env.DB);
  const rows = await repo.apiSignals({ status: c.req.query('status') ?? undefined, marketId: c.req.query('market_id') ?? undefined, limit: intParam(c.req.query('limit'), 50, 200), offset: intParam(c.req.query('offset'), 0, 10_000) });
  return json(c, { signals: rows });
});

app.get('/api/signals/:id', async (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) return json(c, { error: 'invalid id' }, 400, 'no-store');
  const repo = new Repo(c.env.DB);
  const signal = await repo.apiSignal(id);
  return signal ? json(c, { signal }) : json(c, { error: 'not found' }, 404, 'no-store');
});

app.get('/api/simulations', async (c) => {
  const repo = new Repo(c.env.DB);
  const data = await repo.apiSimulations({ status: c.req.query('status') ?? undefined, limit: intParam(c.req.query('limit'), 50, 200) });
  return json(c, { ...data, disclaimer: 'Simulated fills against book snapshots. No real order exists anywhere in this system.' });
});

app.get('/api/calibration', async (c) => {
  const repo = new Repo(c.env.DB);
  const samples = await repo.loadCalibrationSamples(3000);
  const marketPrices = samples.map((s) => s.price);
  const outcomes = samples.map((s) => s.outcome);
  const resolvedSignals = await repo.apiResolvedForCalibration(500);
  const modelSamples: CalibrationSample[] = [];
  const modelPreds: (number | null)[] = [];
  for (const r of resolvedSignals) {
    const evidence = safeJsonParse<{ yesBestBid?: number | null; yesBestAsk?: number | null }>(r.evidence_json) ?? {};
    const bid = evidence.yesBestBid ?? null;
    const ask = evidence.yesBestAsk ?? null;
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (ask ?? bid);
    if (mid === null) continue;
    modelSamples.push({ marketId: '', price: mid, daysToEnd: 0, outcome: r.winning_side === 'YES' ? 1 : 0 });
    modelPreds.push(r.estimate_p);
  }
  return json(c, {
    samples: samples.length,
    marketPriceCalibration: {
      reliability: reliabilityTable(marketPrices, outcomes, 0.1),
      brier: samples.length ? brierScore(marketPrices, outcomes) : null,
      logLoss: samples.length ? logLoss(marketPrices, outcomes) : null,
    },
    modelVsBaselines: modelSamples.length ? compareWithBaselines(modelSamples, modelPreds) : null,
    note: 'The estimator abstains (INSUFFICIENT_EVIDENCE) until a price/horizon bin holds enough resolved markets; the market-implied and uniform baselines are scored on the same samples.',
  });
});

app.get('/api/analyses', async (c) => {
  const repo = new Repo(c.env.DB);
  return json(c, { analyses: await repo.apiAnalyses(c.req.query('market_id') ?? null, intParam(c.req.query('limit'), 20, 100)) });
});

app.get('/api/runs', async (c) => {
  const repo = new Repo(c.env.DB);
  return json(c, { runs: await repo.apiRuns(intParam(c.req.query('limit'), 30, 200)) }, 200, 'no-store');
});

app.get('/api/errors', async (c) => {
  const repo = new Repo(c.env.DB);
  const [runs, ai] = await Promise.all([repo.apiRuns(intParam(c.req.query('limit'), 30, 100), true), repo.apiAiErrors(20)]);
  return json(c, { runErrors: runs, aiErrors: ai }, 200, 'no-store');
});

app.get('/api/quotas', async (c) => {
  const repo = new Repo(c.env.DB);
  const cfg = parseConfig(c.env);
  const day = c.req.query('day') ?? dayKey();
  const usage = await repo.quotaToday(day);
  const pct = (value: number | undefined, limit: number) => (value === undefined ? 0 : Math.round((value / limit) * 1000) / 10);
  return json(c, {
    day,
    usage,
    limits: CLOUDFLARE_FREE_LIMITS,
    projectCaps: { ...HARD_CAPS, aiMaxCallsPerDay: cfg.aiMaxCallsPerDay, aiMaxNeuronsPerDay: cfg.aiMaxNeuronsPerDay },
    percentOfFreeTier: {
      workerRequests: pct(usage.worker_invocations, CLOUDFLARE_FREE_LIMITS.workers.requestsPerDay),
      d1RowsWritten: pct(usage.d1_rows_written, CLOUDFLARE_FREE_LIMITS.d1.rowsWrittenPerDay),
      aiNeurons: pct(usage.ai_neurons_est, CLOUDFLARE_FREE_LIMITS.workersAi.neuronsPerDay),
    },
    note: 'Usage counters are the scanner\'s own accounting (scheduled runs and admin runs only). Dashboard page views do not count: static assets are free and unlimited.',
  }, 200, 'no-store');
});

app.get('/api/params', async (c) => {
  const repo = new Repo(c.env.DB);
  const params = paramsFromRecords(await repo.loadParamRows());
  return json(c, { params: describeParams(params), strategyVersion: STRATEGY_VERSION }, 200, 'no-store');
});

// ---- admin ----------------------------------------------------------------

const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length === 0 || eb.length === 0) return false;
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i % ea.length] ?? 0) ^ (eb[i % eb.length] ?? 0);
  return diff === 0;
}

const admin = new Hono<AppEnv>();

admin.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  const token = c.env.ADMIN_TOKEN;
  if (!token || token.length < 24) return c.json({ error: 'admin disabled: set the ADMIN_TOKEN secret (at least 24 characters)' }, 503);
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) return c.json({ error: 'too many failed attempts' }, 429);
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!constantTimeEqual(presented, token)) {
    const fresh = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + FAILURE_WINDOW_MS } : entry;
    fresh.count += 1;
    failures.set(ip, fresh);
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

admin.get('/whoami', (c) => c.json({ ok: true, role: 'admin', simulationOnly: true }));

admin.post('/run', async (c) => {
  const summary = await runScan(c.env, 'manual', { ai: parseConfig(c.env).aiEnabled ? aiBindingFrom(c.env) : null });
  return c.json({ summary }, summary.status === 'error' ? 500 : 200);
});

admin.post('/params', async (c) => {
  const body = paramUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'expected { key, value }', issues: body.error.issues.map((i) => i.message) }, 400);
  const repo = new Repo(c.env.DB);
  const current = paramsFromRecords(await repo.loadParamRows());
  const result = applyParamUpdate(current, body.data);
  if (!result.ok) return c.json({ error: result.error }, 422);
  await repo.saveParam(body.data.key, body.data.value, 'admin', new Date().toISOString());
  return c.json({ ok: true, params: describeParams(result.params) });
});

admin.post('/geoblock-check', async (c) => {
  const cfg = parseConfig(c.env);
  const repo = new Repo(c.env.DB);
  const status = await checkGeoblock(cfg.geoblockUrl);
  await repo.setStates({ geoblock_json: JSON.stringify(status) }, new Date().toISOString());
  return c.json({ geoblock: status, safety: canOpenRealPosition({ simulationOnly: cfg.simulationOnly, geoblock: status }) });
});

app.route('/api/admin', admin);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return json(c, { error: 'not found' }, 404, 'no-store');
  // Dev and tests: static assets are normally served before the Worker runs.
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('dashboard not built', 404);
});

app.onError((err, c) => {
  console.error('api_error', c.req.path, err instanceof Error ? err.message : String(err));
  return json(c, { error: 'internal error' }, 500, 'no-store');
});
