#!/usr/bin/env node
// Production smoke test against the deployed Worker. Read-only unless ADMIN_TOKEN is provided
// (then one manual scan is triggered). Usage: BASE_URL=https://... [ADMIN_TOKEN=...] node scripts/smoke-prod.mjs
const base = (process.env.BASE_URL || process.argv[2] || '').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN || '';
if (!base) {
  console.error('BASE_URL is required (e.g. https://polymarket-edge-scanner.<subdomain>.workers.dev)');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
async function get(path, init) {
  const started = Date.now();
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body, ms: Date.now() - started };
}

const health = await get('/api/health');
check('GET /api/health', health.res.status === 200 && health.body?.ok === true, `${health.res.status} in ${health.ms} ms`);

const status = await get('/api/status');
check('GET /api/status', status.res.status === 200, `${status.res.status} in ${status.ms} ms`);
check('status.simulationOnly === true', status.body?.simulationOnly === true);
check('status.tradingAllowed === false', status.body?.tradingAllowed === false);
check('status.safety lists SIMULATION_ONLY_BUILD', Array.isArray(status.body?.safety?.reasons) && status.body.safety.reasons.includes('SIMULATION_ONLY_BUILD'));
check('status.nextRunAt is a date', typeof status.body?.nextRunAt === 'string' && !Number.isNaN(Date.parse(status.body.nextRunAt)), status.body?.nextRunAt);
if (status.body?.geoblock) check('geoblock recorded', typeof status.body.geoblock.eligibility === 'string', `${status.body.geoblock.eligibility} ${status.body.geoblock.country ?? ''}`);

for (const path of ['/api/markets?limit=5', '/api/signals?limit=5', '/api/simulations?limit=5', '/api/calibration', '/api/quotas', '/api/params', '/api/runs?limit=5', '/api/errors', '/api/analyses?limit=5']) {
  const r = await get(path);
  check(`GET ${path}`, r.res.status === 200 && typeof r.body === 'object', `${r.res.status} in ${r.ms} ms`);
}

const dash = await get('/');
check('GET / (dashboard asset)', dash.res.status === 200 && String(dash.body).includes('Polymarket Edge Scanner'), `${dash.res.status} in ${dash.ms} ms`);

const noAuth = await get('/api/admin/whoami');
check('admin without token is refused', noAuth.res.status === 401 || noAuth.res.status === 503, `${noAuth.res.status}`);
const urlToken = await get(`/api/admin/whoami?token=${encodeURIComponent(token || 'x')}`);
check('token in URL never works', urlToken.res.status === 401 || urlToken.res.status === 503, `${urlToken.res.status}`);

if (token) {
  const who = await get('/api/admin/whoami', { headers: { authorization: `Bearer ${token}` } });
  check('admin bearer accepted', who.res.status === 200, `${who.res.status}`);
  const run = await get('/api/admin/run', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const s = run.body?.summary;
  check('POST /api/admin/run completes', run.res.status === 200 && s && s.status !== 'error', s ? `${s.status} phase=${s.phase} markets=${s.marketsScanned} signals=${s.signalsCreated} ai=${s.aiCalls} subrequests=${s.subrequests} d1=${s.d1Statements} ${s.durationMs} ms${s.error ? ` error=${s.error}` : ''}` : `${run.res.status} ${JSON.stringify(run.body).slice(0, 200)}`);
  if (s?.details) console.log('     details:', JSON.stringify(s.details).slice(0, 600));
  const quotas = await get('/api/quotas');
  check('quota accounting updated', quotas.res.status === 200 && (quotas.body?.usage?.worker_invocations ?? 0) >= 1, JSON.stringify(quotas.body?.usage));
} else {
  console.log('INFO ADMIN_TOKEN not set: skipping the manual scan trigger.');
}

console.log(failures === 0 ? '\nAll production checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
