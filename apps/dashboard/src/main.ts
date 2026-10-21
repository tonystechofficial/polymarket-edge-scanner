/* Dashboard: plain TypeScript, no framework. Reads the Worker's JSON API, same origin. */

type Json = Record<string, unknown>;

const TOKEN_KEY = 'pes_admin_token';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function num(value: unknown, digits = 3): string {
  if (value === null || value === undefined || value === '') return '–';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : esc(value);
}

function when(iso: unknown): string {
  if (!iso) return '–';
  const d = new Date(String(iso));
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function ago(iso: unknown): string {
  if (!iso) return '–';
  const ms = Date.now() - new Date(String(iso)).getTime();
  if (!Number.isFinite(ms)) return '–';
  const m = Math.round(ms / 60_000);
  if (Math.abs(m) < 1) return 'just now';
  if (Math.abs(m) < 90) return `${m > 0 ? m + ' min ago' : 'in ' + -m + ' min'}`;
  const h = Math.round(m / 60);
  return h > 0 ? `${h} h ago` : `in ${-h} h`;
}

async function api<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function stat(label: string, value: string, cls = ''): string {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v ${cls}">${value}</div></div>`;
}

function table(headers: Array<[string, string?]>, rows: string[][], rowAttrs: string[] = []): string {
  if (rows.length === 0) return '<p class="muted small">Nothing yet.</p>';
  const head = headers.map(([h, cls]) => `<th class="${cls ?? ''}">${esc(h)}</th>`).join('');
  const body = rows.map((r, i) => `<tr ${rowAttrs[i] ?? ''}>${r.map((cell, j) => `<td class="${headers[j]?.[1] ?? ''}">${cell}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function badge(text: string, cls: string): string {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

// ---- sections ---------------------------------------------------------------

async function renderStatus(): Promise<void> {
  const s = await api('/api/status');
  const geo = (s.geoblock ?? null) as { blocked: boolean; country: string | null; eligibility: string; checkedAt: string } | null;
  const counts = (s.counts ?? {}) as Record<string, number>;
  const lastRun = (s.lastRun ?? null) as Json | null;
  const safety = (s.safety ?? { reasons: [] }) as { reasons: string[] };
  const cfg = (s.config ?? {}) as Json;
  $('status').innerHTML = [
    stat('Mode', badge('simulation only', 'sim')),
    stat('Live trading', `${badge('blocked', 'bad')}<div class="small muted">${esc(safety.reasons.join(', '))}</div>`),
    stat('Geoblock (Worker egress)', geo ? `${badge(geo.eligibility, geo.blocked ? 'warn' : 'ok')} <span class="mono">${esc(geo.country ?? '??')}</span><div class="small muted">${ago(geo.checkedAt)}</div>` : '<span class="muted">not checked yet</span>'),
    stat('Last run', lastRun ? `${badge(String(lastRun.status), lastRun.status === 'ok' ? 'ok' : lastRun.status === 'error' ? 'bad' : 'warn')} ${esc(lastRun.phase)}<div class="small muted">${ago(lastRun.started_at)} · ${esc(lastRun.duration_ms)} ms</div>` : '<span class="muted">never</span>'),
    stat('Next scheduled run', `${when(s.nextRunAt)}<div class="small muted">${esc(s.cronSchedule)} · ${ago(s.nextRunAt)}</div>`),
    stat('Tracked markets', `${counts.tracked ?? 0}<div class="small muted">${counts.resolved ?? 0} resolved · ${counts.ignored ?? 0} ignored</div>`),
    stat('Signals', `${counts.accepted_signals ?? 0} accepted<div class="small muted">${counts.signals ?? 0} total</div>`),
    stat('Open simulations', String(counts.open_simulations ?? 0)),
    stat('Calibration samples', String(counts.calibration_samples ?? 0)),
    stat('AI model', `<span class="mono small">${esc(cfg.aiModel)}</span><div class="small muted">${cfg.aiEnabled ? 'enabled' : 'disabled'} · ≤${esc(cfg.aiMaxCallsPerDay)} calls/day</div>`),
    stat('Run counter', `${esc(s.runCounter)}<div class="small muted">cursor ${esc(s.priceCursor)} · ${s.scanLocked ? 'locked' : 'idle'}</div>`),
    stat('Strategy', `<span class="mono small">${esc(cfg.strategyVersion)}</span>`),
  ].join('');
  $('footer-version').textContent = ` · ${String(cfg.strategyVersion ?? '')}`;
}

async function renderMarkets(): Promise<void> {
  const category = ($('market-category') as HTMLSelectElement).value;
  const r = await api<{ markets: Json[] }>(`/api/markets?limit=100${category ? `&category=${encodeURIComponent(category)}` : ''}`);
  const categories = Array.from(new Set(r.markets.map((m) => String(m.category)))).sort();
  const select = $('market-category') as HTMLSelectElement;
  if (select.options.length <= 1) categories.forEach((c) => select.add(new Option(c, c)));
  $('markets-table').innerHTML = table(
    [['Question', 'wrap'], ['Category'], ['Status'], ['YES mid'], ['Spread'], ['Liquidity'], ['Fee'], ['Ends'], ['Priced'], ['Accepted']],
    r.markets.map((m) => [
      `<a href="https://polymarket.com/market/${esc(m.slug)}" target="_blank" rel="noopener">${esc(m.question)}</a>`,
      esc(m.category),
      badge(String(m.status), m.status === 'tracked' ? 'ok' : m.status === 'resolved' ? '' : 'warn'),
      num(m.yes_mid),
      num(m.yes_spread),
      num(m.liquidity, 0),
      `${num(m.fee_rate, 2)}${m.fee_source === 'assumed_max' ? '*' : ''}`,
      when(m.end_date),
      ago(m.last_priced_at),
      String(m.accepted_signals ?? 0),
    ]),
  );
}

async function renderSignals(): Promise<void> {
  const status = ($('signal-status') as HTMLSelectElement).value;
  const r = await api<{ signals: Json[] }>(`/api/signals?limit=100${status ? `&status=${status}` : ''}`);
  $('signals-table').innerHTML = table(
    [['When'], ['Market', 'wrap'], ['Type'], ['Side'], ['Status'], ['Estimate'], ['Exec'], ['Net edge'], ['Shares'], ['Reasons', 'wrap']],
    r.signals.map((s) => {
      const reasons = (JSON.parse(String(s.reasons_json ?? '[]')) as string[]).slice(0, 4);
      return [
        when(s.created_at),
        esc(s.question),
        esc(s.type),
        esc(s.side),
        badge(String(s.status), s.status === 'ACCEPTED' ? 'ok' : ''),
        s.estimate_p === null || s.estimate_p === undefined ? '<span class="muted">none</span>' : `${num(s.estimate_p)} <span class="muted small">[${num(s.estimate_ci_low, 2)}, ${num(s.estimate_ci_high, 2)}] n=${esc(s.estimate_n)}</span>`,
        num(s.exec_price),
        num(s.net_edge, 4),
        num(s.suggested_shares, 0),
        `<span class="small">${esc(reasons.join(' · '))}</span>`,
      ];
    }),
    r.signals.map((s) => `class="clickable" data-signal="${esc(s.id)}"`),
  );
  $('signals-table').querySelectorAll<HTMLTableRowElement>('tr[data-signal]').forEach((row) => {
    row.addEventListener('click', () => void renderSignalDetail(Number(row.dataset.signal)));
  });
}

async function renderSignalDetail(id: number): Promise<void> {
  const r = await api<{ signal: Json }>(`/api/signals/${id}`);
  const s = r.signal;
  const reasons = JSON.parse(String(s.reasons_json ?? '[]')) as string[];
  const evidence = JSON.parse(String(s.evidence_json ?? '{}')) as Json;
  const orders = (s.simulated_orders ?? []) as Json[];
  const detail = $('signal-detail');
  detail.hidden = false;
  detail.innerHTML = `
    <div class="row between"><strong>Signal #${esc(s.id)} · ${esc(s.type)} ${esc(s.side)} · ${badge(String(s.status), s.status === 'ACCEPTED' ? 'ok' : '')}</strong><a href="#signals" id="close-detail">close</a></div>
    <p>${esc(s.question)} <span class="muted small">(${esc(s.category)}, fee ${num(s.fee_rate, 2)}, strategy ${esc(s.strategy_version)})</span></p>
    <div class="grid">
      ${stat('Estimate', s.estimate_p === null ? 'none (INSUFFICIENT_EVIDENCE)' : `${num(s.estimate_p)} [${num(s.estimate_ci_low)}, ${num(s.estimate_ci_high)}] n=${esc(s.estimate_n)}<div class="small muted">${esc(s.estimate_source)}</div>`)}
      ${stat('Executable price', num(s.exec_price))}
      ${stat('Fee / share', num(s.fee_cost_per_share, 4))}
      ${stat('Spread', num(s.spread))}
      ${stat('Slippage / share', num(s.slippage_per_share, 4))}
      ${stat('Gross edge', num(s.gross_edge, 4))}
      ${stat('Safety margin', num(s.safety_margin, 3))}
      ${stat('Net edge / share', num(s.net_edge, 4))}
      ${stat('Suggested size', `${num(s.suggested_shares, 0)} sh · ${num(s.suggested_notional, 2)} USDC`)}
    </div>
    <h3 class="small">Reasons</h3><ul>${reasons.map((x) => `<li class="mono small">${esc(x)}</li>`).join('')}</ul>
    <h3 class="small">Evidence and sources</h3><pre class="output small">${esc(JSON.stringify(evidence, null, 2))}</pre>
    ${orders.length ? `<h3 class="small">Simulated orders</h3>${table([['Side'], ['Filled'], ['VWAP'], ['Notional'], ['Fee'], ['Slippage'], ['Status'], ['PnL']], orders.map((o) => [esc(o.side), num(o.filled_shares, 0), num(o.vwap_price), num(o.notional_usdc, 2), num(o.fee_paid_usdc, 4), num(o.slippage_usdc, 4), esc(o.status), num(o.pnl_usdc, 2)]))}` : ''}
  `;
  $('close-detail').addEventListener('click', () => {
    detail.hidden = true;
  });
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderSimulations(): Promise<void> {
  const r = await api<{ orders: Json[]; summary: Json }>('/api/simulations?limit=100');
  const s = r.summary ?? {};
  $('sim-summary').innerHTML = [
    stat('Simulated orders', String(s.total ?? 0)),
    stat('Open', String(s.open ?? 0)),
    stat('Settled', String(s.settled ?? 0)),
    stat('Realised PnL (sim)', `${num(s.realized_pnl_usdc, 2)} USDC`, Number(s.realized_pnl_usdc) >= 0 ? '' : 'bad'),
    stat('Open exposure (sim)', `${num(s.open_exposure_usdc, 2)} USDC`),
    stat('Fees paid (sim)', `${num(s.fees_usdc, 4)} USDC`),
  ].join('');
  $('sim-table').innerHTML = table(
    [['When'], ['Market', 'wrap'], ['Side'], ['Requested'], ['Filled'], ['VWAP'], ['Notional'], ['Fee'], ['Slippage'], ['Status'], ['PnL'], ['Assumptions', 'wrap']],
    r.orders.map((o) => [when(o.created_at), esc(o.question), esc(o.side), num(o.requested_shares, 0), num(o.filled_shares, 0), num(o.vwap_price), num(o.notional_usdc, 2), num(o.fee_paid_usdc, 4), num(o.slippage_usdc, 4), badge(String(o.status), o.status === 'OPEN' ? 'warn' : 'ok'), num(o.pnl_usdc, 2), `<span class="small muted">${esc((JSON.parse(String(o.assumptions_json ?? '[]')) as string[])[0] ?? '')}</span>`]),
  );
}

async function renderCalibration(): Promise<void> {
  const r = await api('/api/calibration');
  const mpc = (r.marketPriceCalibration ?? {}) as { reliability?: Json[]; brier?: number | null; logLoss?: number | null };
  const cmp = (r.modelVsBaselines ?? null) as Record<string, { n: number; brier: number; logLoss: number }> | null;
  const rows = (mpc.reliability ?? []).filter((b) => Number(b.n) > 0);
  $('calibration-body').innerHTML = `
    <div class="grid">
      ${stat('Resolved samples', String(r.samples ?? 0))}
      ${stat('Market price Brier', mpc.brier === null || mpc.brier === undefined ? '–' : num(mpc.brier, 4))}
      ${stat('Market price log loss', mpc.logLoss === null || mpc.logLoss === undefined ? '–' : num(mpc.logLoss, 4))}
    </div>
    <h3 class="small">Reliability of market prices (resolved markets tracked by this scanner)</h3>
    ${table([['Price bin'], ['n'], ['Mean price'], ['Observed YES rate']], rows.map((b) => [`${num(b.binLow, 1)}–${num(b.binHigh, 1)}`, String(b.n), num(b.meanPrediction, 3), num(b.observedRate, 3)]))}
    <h3 class="small">Experimental estimator vs. reference strategies</h3>
    ${cmp ? table([['Strategy'], ['n'], ['Brier'], ['Log loss']], Object.entries(cmp).map(([k, v]) => [esc(k), String(v.n), num(v.brier, 4), num(v.logLoss, 4)])) : '<p class="muted small">No resolved market with a model estimate yet. The estimator abstains until enough resolved markets fill a price/horizon bin.</p>'}
    <p class="muted small">${esc(r.note)}</p>`;
}

async function renderAi(): Promise<void> {
  const r = await api<{ analyses: Json[] }>('/api/analyses?limit=40');
  $('ai-table').innerHTML = table(
    [['When'], ['Market', 'wrap'], ['Status'], ['Recommendation'], ['Prob.'], ['Confidence'], ['Summary', 'wrap'], ['Risks', 'wrap'], ['Adjustments', 'wrap'], ['Tokens'], ['Neurons']],
    r.analyses.map((a) => [
      when(a.created_at),
      esc(a.question),
      badge(String(a.status), a.status === 'ok' ? 'ok' : a.status === 'skipped_quota' ? 'warn' : 'bad'),
      esc(a.recommendation),
      a.probability_estimate === null ? '<span class="muted">null</span>' : num(a.probability_estimate),
      esc(a.confidence),
      `<span class="small">${esc(a.summary)}</span>`,
      `<span class="small">${esc((JSON.parse(String(a.resolution_risks_json ?? '[]')) as string[]).join(' · '))}</span>`,
      `<span class="small muted">${esc((JSON.parse(String(a.adjustments_json ?? '[]')) as string[]).join(' · '))}</span>`,
      `${esc(a.input_tokens)}/${esc(a.output_tokens)}`,
      num(a.neurons_est, 1),
    ]),
  );
}

async function renderRunsAndErrors(): Promise<void> {
  const [runs, errors] = await Promise.all([api<{ runs: Json[] }>('/api/runs?limit=20'), api<{ runErrors: Json[]; aiErrors: Json[] }>('/api/errors')]);
  $('runs-table').innerHTML = table(
    [['Started'], ['Trigger'], ['Phase'], ['Status'], ['Markets'], ['Signals'], ['Accepted'], ['AI'], ['Subreq.'], ['D1 stmts'], ['ms'], ['Error', 'wrap']],
    runs.runs.map((r) => [when(r.started_at), esc(r.trigger), esc(r.phase), badge(String(r.status), r.status === 'ok' ? 'ok' : r.status === 'error' ? 'bad' : 'warn'), String(r.markets_scanned), String(r.signals_created), String(r.signals_accepted), String(r.ai_calls), String(r.subrequests), String(r.d1_statements), String(r.duration_ms ?? ''), `<span class="small">${esc(r.error ?? '')}</span>`]),
  );
  const aiErr = errors.aiErrors.map((e) => [when(e.created_at), 'ai', esc(e.market_id), badge(String(e.status), 'bad'), `<span class="small">${esc(e.error ?? '')}</span>`]);
  const runErr = errors.runErrors.map((e) => [when(e.started_at), 'run', esc(e.phase), badge(String(e.status), 'bad'), `<span class="small">${esc(e.error ?? 'run did not finish (killed or still running)')}</span>`]);
  $('errors-table').innerHTML = `<h3 class="small">Errors</h3>${table([['When'], ['Kind'], ['Where'], ['Status'], ['Message', 'wrap']], [...runErr, ...aiErr])}`;
}

async function renderQuotas(): Promise<void> {
  const r = await api('/api/quotas');
  const usage = (r.usage ?? {}) as Record<string, number>;
  const limits = r.limits as { workers: Record<string, number>; d1: Record<string, number>; workersAi: Record<string, number> };
  const caps = (r.projectCaps ?? {}) as Record<string, number>;
  const bar = (label: string, used: number, limit: number, unit = '') => {
    const pct = Math.min(100, Math.round((used / limit) * 1000) / 10);
    return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${used.toLocaleString()}${unit} <span class="muted small">/ ${limit.toLocaleString()}${unit} (${pct}%)</span></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
  };
  $('quotas-body').innerHTML = `
    <div class="grid">
      ${bar('Worker runs today', usage.worker_invocations ?? 0, limits.workers.requestsPerDay ?? 100000)}
      ${bar('D1 rows written today', usage.d1_rows_written ?? 0, limits.d1.rowsWrittenPerDay ?? 100000)}
      ${bar('AI neurons today (estimate)', Math.round(usage.ai_neurons_est ?? 0), limits.workersAi.neuronsPerDay ?? 10000)}
      ${bar('AI calls today', usage.ai_calls ?? 0, caps.aiMaxCallsPerDay ?? 60)}
      ${stat('Subrequests today', String(usage.subrequests ?? 0))}
      ${stat('D1 statements today', String(usage.d1_statements ?? 0))}
      ${stat('AI tokens today', `${usage.ai_input_tokens ?? 0} in / ${usage.ai_output_tokens ?? 0} out`)}
    </div>
    <p class="muted small">${esc(r.note)} Per-run caps: ≤${esc(caps.maxSubrequestsPerRun)} subrequests, ≤${esc(caps.maxD1StatementsPerRun)} D1 statements, ≤${esc(caps.maxMarketsPerRun)} markets, ≤${esc(caps.maxAiCallsPerRun)} AI calls.</p>`;
}

async function renderParams(): Promise<void> {
  const r = await api<{ params: Array<{ key: string; value: number; min: number; max: number; description: string }> }>('/api/params');
  $('params-table').innerHTML = table([['Key'], ['Value'], ['Allowed range'], ['Description', 'wrap']], r.params.map((p) => [`<span class="mono">${esc(p.key)}</span>`, String(p.value), `${p.min} – ${p.max}`, `<span class="small">${esc(p.description)}</span>`]));
  const select = $('admin-param-key') as HTMLSelectElement;
  if (select.options.length === 0) r.params.forEach((p) => select.add(new Option(`${p.key} (${p.value})`, p.key)));
}

// ---- admin ------------------------------------------------------------------

function adminHeaders(): HeadersInit {
  const token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function out(value: unknown): void {
  $('admin-output').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function adminCall(path: string, body?: unknown, button?: HTMLButtonElement): Promise<void> {
  if (button) button.disabled = true;
  try {
    const res = await fetch(path, { method: 'POST', headers: adminHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    out({ http: res.status, ...(data as Json) });
    await refreshAll();
  } catch (err) {
    out(`request failed: ${(err as Error).message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function wireAdmin(): void {
  const tokenInput = $('admin-token') as HTMLInputElement;
  tokenInput.value = sessionStorage.getItem(TOKEN_KEY) ?? '';
  $('admin-save').addEventListener('click', async () => {
    sessionStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
    try {
      const res = await fetch('/api/admin/whoami', { headers: adminHeaders() });
      out({ http: res.status, ...((await res.json().catch(() => ({}))) as Json) });
    } catch (err) {
      out(`request failed: ${(err as Error).message}`);
    }
  });
  $('admin-run').addEventListener('click', (e) => void adminCall('/api/admin/run', undefined, e.currentTarget as HTMLButtonElement));
  $('admin-geo').addEventListener('click', (e) => void adminCall('/api/admin/geoblock-check', undefined, e.currentTarget as HTMLButtonElement));
  $('admin-param-save').addEventListener('click', (e) => {
    const key = ($('admin-param-key') as HTMLSelectElement).value;
    const value = Number(($('admin-param-value') as HTMLInputElement).value);
    void adminCall('/api/admin/params', { key, value }, e.currentTarget as HTMLButtonElement);
  });
}

// ---- boot -------------------------------------------------------------------

async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(name, err);
    const el = document.querySelector<HTMLElement>(`#${name}`);
    if (el) el.insertAdjacentHTML('beforeend', `<p class="small" style="color:var(--bad)">Failed to load: ${esc((err as Error).message)}</p>`);
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([
    safely('overview', renderStatus),
    safely('markets', renderMarkets),
    safely('signals', renderSignals),
    safely('simulations', renderSimulations),
    safely('calibration', renderCalibration),
    safely('ai', renderAi),
    safely('errors', renderRunsAndErrors),
    safely('quotas', renderQuotas),
    safely('params', renderParams),
  ]);
}

$('market-category').addEventListener('change', () => void safely('markets', renderMarkets));
$('signal-status').addEventListener('change', () => void safely('signals', renderSignals));
wireAdmin();
void refreshAll();
setInterval(() => void safely('overview', renderStatus), 60_000);
