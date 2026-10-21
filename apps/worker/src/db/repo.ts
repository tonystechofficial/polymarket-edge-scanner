import { safeJsonParse, type AiAnalysis, type MarketResult, type PriceObservation, type SignalDecision, type SimulatedFill, type TrackedMarket } from '@pes/shared';
import type { AnalysisOutcome } from '@pes/ai';

/**
 * Every D1 access of the project. Queries are bounded (LIMIT everywhere), writes are
 * idempotent (UNIQUE keys + ON CONFLICT), and the number of statements is counted so a
 * run can stop before the per-invocation limit (50 on the free plan).
 */
export class Repo {
  statements = 0;
  rowsWritten = 0;

  constructor(private readonly db: D1Database) {}

  private stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...params);
  }

  private async run(sql: string, ...params: unknown[]): Promise<D1Response> {
    this.statements += 1;
    const res = await this.stmt(sql, ...params).run();
    this.rowsWritten += res.meta?.changes ?? 0;
    return res;
  }

  private async all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.statements += 1;
    const res = await this.stmt(sql, ...params).all<T>();
    return res.results ?? [];
  }

  private async first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    this.statements += 1;
    return (await this.stmt(sql, ...params).first<T>()) ?? null;
  }

  private async batch(statements: D1PreparedStatement[]): Promise<void> {
    if (statements.length === 0) return;
    this.statements += statements.length;
    const results = await this.db.batch(statements);
    for (const r of results) this.rowsWritten += r.meta?.changes ?? 0;
  }

  // ---- system state & lock -------------------------------------------------

  async getState(key: string): Promise<string | null> {
    const row = await this.first<{ value: string }>('SELECT value FROM system_state WHERE key = ?', key);
    return row?.value ?? null;
  }

  async getStates(keys: string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const rows = await this.all<{ key: string; value: string }>(`SELECT key, value FROM system_state WHERE key IN (${keys.map(() => '?').join(',')}) LIMIT 50`, ...keys);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setStates(entries: Record<string, string>, now: string): Promise<void> {
    const stmts = Object.entries(entries).map(([key, value]) =>
      this.stmt('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, now),
    );
    await this.batch(stmts);
  }

  /** Atomic lock: succeeds only when no live lock exists. The value is the expiry in epoch ms. */
  async acquireLock(nowMs: number, ttlMs: number): Promise<boolean> {
    const res = await this.run(
      `INSERT INTO system_state (key, value, updated_at) VALUES ('scan_lock', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(system_state.value AS INTEGER) < ?`,
      String(nowMs + ttlMs),
      new Date(nowMs).toISOString(),
      nowMs,
    );
    return (res.meta?.changes ?? 0) > 0;
  }

  async releaseLock(now: string): Promise<void> {
    await this.run(`UPDATE system_state SET value = '0', updated_at = ? WHERE key = 'scan_lock'`, now);
  }

  // ---- params --------------------------------------------------------------

  async loadParamRows(): Promise<Array<{ key: string; value: string }>> {
    return this.all<{ key: string; value: string }>('SELECT key, value FROM strategy_params LIMIT 100');
  }

  async saveParam(key: string, value: number, updatedBy: string, now: string): Promise<void> {
    await this.run('INSERT INTO strategy_params (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by', key, String(value), now, updatedBy);
  }

  // ---- markets -------------------------------------------------------------

  async upsertMarkets(markets: TrackedMarket[], eventCounts: Map<string, number>, now: string): Promise<void> {
    const stmts = markets.map((m) =>
      this.stmt(
        `INSERT INTO markets (id, condition_id, slug, question, description, category, tags_json, end_date, yes_token_id, no_token_id, outcomes_json,
           fee_rate, fee_exponent, fee_source, neg_risk, event_id, event_market_count, liquidity, volume_24h, min_order_size, tick_size, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tracked', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description, category = excluded.category, tags_json = excluded.tags_json, end_date = excluded.end_date,
           fee_rate = excluded.fee_rate, fee_exponent = excluded.fee_exponent, fee_source = excluded.fee_source,
           event_market_count = excluded.event_market_count, liquidity = excluded.liquidity, volume_24h = excluded.volume_24h, last_seen_at = excluded.last_seen_at`,
        m.id,
        m.conditionId,
        m.slug,
        m.question,
        m.description.slice(0, 4000),
        m.category,
        JSON.stringify(m.tags.slice(0, 20)),
        m.endDate,
        m.yesTokenId,
        m.noTokenId,
        JSON.stringify(m.outcomes),
        m.fee.rate,
        m.fee.exponent,
        m.fee.source,
        m.negRisk ? 1 : 0,
        m.eventId,
        m.eventId ? (eventCounts.get(m.eventId) ?? null) : null,
        m.liquidity,
        m.volume24h,
        m.minOrderSize,
        m.tickSize,
        now,
        now,
      ),
    );
    await this.batch(stmts);
  }

  async countTracked(): Promise<number> {
    const row = await this.first<{ n: number }>(`SELECT COUNT(*) AS n FROM markets WHERE status = 'tracked'`);
    return row?.n ?? 0;
  }

  async listTracked(limit: number): Promise<TrackedMarket[]> {
    const rows = await this.all<MarketRow>(`SELECT * FROM markets WHERE status = 'tracked' ORDER BY id LIMIT ?`, limit);
    return rows.map(rowToMarket);
  }

  async markPriced(ids: string[], now: string): Promise<void> {
    if (ids.length === 0) return;
    await this.run(`UPDATE markets SET last_priced_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now, ...ids);
  }

  async setMarketStatus(id: string, status: TrackedMarket['status'], reason: string | null): Promise<void> {
    await this.run('UPDATE markets SET status = ?, ignore_reason = ? WHERE id = ?', status, reason, id);
  }

  /** Tracked markets whose end date passed: candidates for a resolution check. */
  async marketsPastEnd(nowIso: string, limit: number): Promise<Array<{ id: string; endDate: string; outcomes: [string, string]; category: string }>> {
    const rows = await this.all<{ id: string; end_date: string; outcomes_json: string; category: string }>(`SELECT id, end_date, outcomes_json, category FROM markets WHERE status = 'tracked' AND end_date < ? ORDER BY end_date LIMIT ?`, nowIso, limit);
    return rows.map((r) => ({ id: r.id, endDate: r.end_date, outcomes: (safeJsonParse<[string, string]>(r.outcomes_json) ?? ['Yes', 'No']) as [string, string], category: r.category }));
  }

  // ---- observations --------------------------------------------------------

  async insertObservations(observations: PriceObservation[], topLevels: Map<string, unknown>): Promise<void> {
    // 15 columns: 6 rows per statement stay under the 100 bound parameters limit.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < observations.length; i += 6) {
      const chunk = observations.slice(i, i + 6);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const params = chunk.flatMap((o) => [
        o.marketId,
        o.tokenId,
        o.side,
        o.observedAt,
        o.bestBid,
        o.bestAsk,
        o.mid,
        o.spread,
        o.bidDepthUsdc,
        o.askDepthUsdc,
        o.bookTimestampMs,
        o.bookHash,
        Number.isFinite(o.ageSeconds) ? o.ageSeconds : null,
        JSON.stringify(topLevels.get(o.tokenId) ?? null),
      ]);
      stmts.push(this.stmt(`INSERT OR IGNORE INTO price_observations (market_id, token_id, side, observed_at, best_bid, best_ask, mid, spread, bid_depth_usdc, ask_depth_usdc, book_ts, book_hash, age_seconds, top_levels_json) VALUES ${values}`, ...params));
    }
    await this.batch(stmts);
  }

  // ---- signals & simulations ----------------------------------------------

  /** Returns the new signal id, or null when the idempotency key already existed. */
  async insertSignal(d: SignalDecision, now: string, params: Record<string, number>): Promise<number | null> {
    const row = await this.first<{ id: number }>(
      `INSERT OR IGNORE INTO signals (idem_key, market_id, created_at, type, side, outcome, status, estimate_p, estimate_ci_low, estimate_ci_high, estimate_n, estimate_source,
         exec_price, fee_rate, fee_cost_per_share, spread, slippage_per_share, gross_edge, net_edge, safety_margin, suggested_shares, suggested_notional, reasons_json, evidence_json, strategy_version, params_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      d.idemKey,
      d.marketId,
      now,
      d.type,
      d.side,
      d.outcome,
      d.status,
      d.estimate?.p ?? null,
      d.estimate?.ciLow ?? null,
      d.estimate?.ciHigh ?? null,
      d.estimate?.n ?? null,
      d.estimate?.source ?? null,
      d.execPrice,
      d.feeRate,
      d.feeCostPerShare,
      d.spread,
      d.slippagePerShare,
      d.grossEdgePerShare,
      d.netEdgePerShare,
      d.safetyMargin,
      d.suggestedShares,
      d.suggestedNotionalUsdc,
      JSON.stringify(d.reasons.slice(0, 30)),
      JSON.stringify(d.evidence),
      d.strategyVersion,
      JSON.stringify(params),
    );
    if (row?.id) this.rowsWritten += 1;
    return row?.id ?? null;
  }

  async insertSimulatedOrder(input: { signalId: number; marketId: string; side: string; outcome: string; tokenId: string; fill: SimulatedFill; now: string }): Promise<void> {
    const f = input.fill;
    await this.run(
      `INSERT INTO simulated_orders (signal_id, market_id, created_at, side, outcome, token_id, requested_shares, filled_shares, vwap_price, worst_price, notional_usdc, fee_paid_usdc, slippage_usdc, partial, assumptions_json, status, is_simulation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1)`,
      input.signalId,
      input.marketId,
      input.now,
      input.side,
      input.outcome,
      input.tokenId,
      f.requestedShares,
      f.filledShares,
      f.vwapPrice,
      f.worstPrice,
      f.notionalUsdc,
      f.feePaidUsdc,
      f.slippageUsdc,
      f.partial ? 1 : 0,
      JSON.stringify(f.assumptions),
    );
  }

  async riskState(dayStartIso: string): Promise<{ openExposureUsdc: number; openPositions: number; newPositionsToday: number }> {
    const open = await this.first<{ exposure: number; n: number }>(`SELECT COALESCE(SUM(notional_usdc), 0) AS exposure, COUNT(*) AS n FROM simulated_orders WHERE status = 'OPEN'`);
    const today = await this.first<{ n: number }>(`SELECT COUNT(*) AS n FROM simulated_orders WHERE created_at >= ?`, dayStartIso);
    return { openExposureUsdc: open?.exposure ?? 0, openPositions: open?.n ?? 0, newPositionsToday: today?.n ?? 0 };
  }

  // ---- results, settlement, calibration -----------------------------------

  async recordResult(r: MarketResult, umaStatus: string | null, now: string): Promise<void> {
    await this.batch([
      this.stmt('INSERT OR IGNORE INTO market_results (market_id, resolved_at, winning_outcome, winning_side, final_prices_json, uma_status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.marketId, r.resolvedAt, r.winningOutcome, r.winningSide, JSON.stringify(r.finalPrices), umaStatus, r.source, now),
      this.stmt(
        `UPDATE simulated_orders SET status = 'SETTLED', settled_at = ?,
           payout_usdc = CASE WHEN side = ? THEN filled_shares ELSE 0 END,
           pnl_usdc = (CASE WHEN side = ? THEN filled_shares ELSE 0 END) - notional_usdc - fee_paid_usdc
         WHERE market_id = ? AND status = 'OPEN'`,
        now,
        r.winningSide,
        r.winningSide,
        r.marketId,
      ),
      this.stmt(`UPDATE markets SET status = 'resolved' WHERE id = ?`, r.marketId),
    ]);
  }

  /** Daily YES mid prices of a market, newest first, bounded. */
  async dailyYesPrices(marketId: string, limit = 45): Promise<Array<{ day: string; mid: number; observedAt: string }>> {
    const rows = await this.all<{ day: string; mid: number; observed_at: string }>(
      `SELECT substr(observed_at, 1, 10) AS day, mid, MAX(observed_at) AS observed_at FROM price_observations WHERE market_id = ? AND side = 'YES' AND mid IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT ?`,
      marketId,
      limit,
    );
    return rows.map((r) => ({ day: r.day, mid: r.mid, observedAt: r.observed_at }));
  }

  async insertCalibrationSamples(samples: Array<{ marketId: string; day: string; price: number; daysToEnd: number; outcome: 0 | 1; category: string }>, now: string): Promise<void> {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < samples.length; i += 12) {
      const chunk = samples.slice(i, i + 12);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
      stmts.push(this.stmt(`INSERT OR IGNORE INTO calibration_samples (market_id, obs_day, price, days_to_end, outcome, category, created_at) VALUES ${values}`, ...chunk.flatMap((s) => [s.marketId, s.day, s.price, s.daysToEnd, s.outcome, s.category, now])));
    }
    await this.batch(stmts);
  }

  async loadCalibrationSamples(limit = 3000): Promise<Array<{ marketId: string; price: number; daysToEnd: number; outcome: 0 | 1 }>> {
    const rows = await this.all<{ market_id: string; price: number; days_to_end: number; outcome: number }>('SELECT market_id, price, days_to_end, outcome FROM calibration_samples ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => ({ marketId: r.market_id, price: r.price, daysToEnd: r.days_to_end, outcome: r.outcome === 1 ? 1 : 0 }));
  }

  // ---- AI ------------------------------------------------------------------

  async insertAnalysis(marketId: string, promptHash: string, outcome: AnalysisOutcome, now: string): Promise<void> {
    const a: AiAnalysis = outcome.analysis;
    await this.batch([
      this.stmt(
        `INSERT OR IGNORE INTO ai_analyses (market_id, created_at, model, prompt_hash, status, summary, probability_estimate, confidence, supporting_json, contradicting_json, sources_json, resolution_risks_json, data_freshness, recommendation, adjustments_json, input_tokens, output_tokens, neurons_est, error, raw_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        marketId,
        now,
        outcome.model,
        promptHash,
        outcome.status,
        a.summary,
        a.probability_estimate,
        a.confidence,
        JSON.stringify(a.supporting_evidence),
        JSON.stringify(a.contradicting_evidence),
        JSON.stringify(a.sources),
        JSON.stringify(a.resolution_risks),
        a.data_freshness,
        a.recommendation,
        JSON.stringify(outcome.adjustments),
        outcome.usage.inputTokens,
        outcome.usage.outputTokens,
        outcome.neuronsEstimated,
        outcome.error ?? null,
        outcome.rawExcerpt ?? null,
      ),
      this.stmt('UPDATE markets SET last_ai_at = ? WHERE id = ?', now, marketId),
    ]);
  }

  // ---- runs & quotas -------------------------------------------------------

  async startRun(runId: string, trigger: string, phase: string, now: string): Promise<void> {
    await this.run(`INSERT INTO run_logs (run_id, started_at, trigger, phase, status) VALUES (?, ?, ?, ?, 'running')`, runId, now, trigger, phase);
  }

  async finishRun(runId: string, update: { status: 'ok' | 'error' | 'skipped'; phase: string; marketsScanned: number; signalsCreated: number; signalsAccepted: number; aiCalls: number; subrequests: number; durationMs: number; error: string | null; details: Record<string, unknown> }, now: string): Promise<void> {
    await this.run(
      `UPDATE run_logs SET finished_at = ?, status = ?, phase = ?, markets_scanned = ?, signals_created = ?, signals_accepted = ?, ai_calls = ?, subrequests = ?, d1_statements = ?, duration_ms = ?, error = ?, details_json = ? WHERE run_id = ?`,
      now,
      update.status,
      update.phase,
      update.marketsScanned,
      update.signalsCreated,
      update.signalsAccepted,
      update.aiCalls,
      update.subrequests,
      this.statements + 1,
      update.durationMs,
      update.error,
      JSON.stringify(update.details),
      runId,
    );
  }

  async addQuota(day: string, deltas: Record<string, number>, now: string): Promise<void> {
    const stmts = Object.entries(deltas)
      .filter(([, v]) => v !== 0)
      .map(([metric, delta]) => this.stmt('INSERT INTO quota_usage (day, metric, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET value = quota_usage.value + excluded.value, updated_at = excluded.updated_at', day, metric, delta, now));
    await this.batch(stmts);
  }

  async quotaToday(day: string): Promise<Record<string, number>> {
    const rows = await this.all<{ metric: string; value: number }>('SELECT metric, value FROM quota_usage WHERE day = ? LIMIT 50', day);
    return Object.fromEntries(rows.map((r) => [r.metric, r.value]));
  }

  /** Bounded retention: at most `limit` rows per table per call, oldest first. */
  async cleanup(cutoffIso: string, runLogCutoffIso: string, limit = 400): Promise<void> {
    await this.batch([
      this.stmt('DELETE FROM price_observations WHERE id IN (SELECT id FROM price_observations WHERE observed_at < ? ORDER BY observed_at LIMIT ?)', cutoffIso, limit),
      this.stmt('DELETE FROM run_logs WHERE id IN (SELECT id FROM run_logs WHERE started_at < ? ORDER BY started_at LIMIT ?)', runLogCutoffIso, limit),
      this.stmt(`DELETE FROM markets WHERE status = 'ignored' AND last_seen_at < ? AND id NOT IN (SELECT market_id FROM signals) AND id NOT IN (SELECT market_id FROM price_observations) AND id NOT IN (SELECT market_id FROM ai_analyses)`, cutoffIso),
    ]);
  }

  // ---- read API ------------------------------------------------------------

  async apiMarkets(filter: { status?: string; category?: string; limit: number; offset: number }): Promise<unknown[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('m.status = ?');
      params.push(filter.status);
    }
    if (filter.category) {
      where.push('m.category = ?');
      params.push(filter.category);
    }
    const sql = `SELECT m.id, m.slug, m.question, m.category, m.end_date, m.status, m.liquidity, m.volume_24h, m.fee_rate, m.fee_source, m.neg_risk, m.event_id, m.last_priced_at, m.last_ai_at,
        (SELECT mid FROM price_observations o WHERE o.market_id = m.id AND o.side = 'YES' ORDER BY o.observed_at DESC LIMIT 1) AS yes_mid,
        (SELECT spread FROM price_observations o WHERE o.market_id = m.id AND o.side = 'YES' ORDER BY o.observed_at DESC LIMIT 1) AS yes_spread,
        (SELECT COUNT(*) FROM signals s WHERE s.market_id = m.id AND s.status = 'ACCEPTED') AS accepted_signals
      FROM markets m ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.last_seen_at DESC, m.liquidity DESC LIMIT ? OFFSET ?`;
    return this.all(sql, ...params, filter.limit, filter.offset);
  }

  async apiMarket(id: string): Promise<unknown | null> {
    return this.first('SELECT * FROM markets WHERE id = ?', id);
  }

  async apiObservations(marketId: string, limit: number): Promise<unknown[]> {
    return this.all('SELECT id, side, observed_at, best_bid, best_ask, mid, spread, bid_depth_usdc, ask_depth_usdc, book_ts, age_seconds FROM price_observations WHERE market_id = ? ORDER BY observed_at DESC LIMIT ?', marketId, limit);
  }

  async apiSignals(filter: { status?: string; marketId?: string; limit: number; offset: number }): Promise<unknown[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('s.status = ?');
      params.push(filter.status);
    }
    if (filter.marketId) {
      where.push('s.market_id = ?');
      params.push(filter.marketId);
    }
    return this.all(
      `SELECT s.id, s.market_id, m.question, m.category, s.created_at, s.type, s.side, s.outcome, s.status, s.estimate_p, s.estimate_ci_low, s.estimate_ci_high, s.estimate_n, s.estimate_source, s.exec_price, s.fee_rate, s.fee_cost_per_share, s.spread, s.slippage_per_share, s.gross_edge, s.net_edge, s.safety_margin, s.suggested_shares, s.suggested_notional, s.reasons_json, s.strategy_version
       FROM signals s JOIN markets m ON m.id = s.market_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
      ...params,
      filter.limit,
      filter.offset,
    );
  }

  async apiSignal(id: number): Promise<unknown | null> {
    const signal = await this.first<Record<string, unknown>>('SELECT s.*, m.question, m.category, m.slug FROM signals s JOIN markets m ON m.id = s.market_id WHERE s.id = ?', id);
    if (!signal) return null;
    const orders = await this.all('SELECT * FROM simulated_orders WHERE signal_id = ? LIMIT 10', id);
    return { ...signal, simulated_orders: orders };
  }

  async apiSimulations(filter: { status?: string; limit: number }): Promise<{ orders: unknown[]; summary: unknown }> {
    const params: unknown[] = [];
    let where = '';
    if (filter.status) {
      where = 'WHERE o.status = ?';
      params.push(filter.status);
    }
    const orders = await this.all(`SELECT o.*, m.question FROM simulated_orders o JOIN markets m ON m.id = o.market_id ${where} ORDER BY o.created_at DESC LIMIT ?`, ...params, filter.limit);
    const summary = await this.first(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END) AS settled, COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN pnl_usdc ELSE 0 END), 0) AS realized_pnl_usdc, COALESCE(SUM(CASE WHEN status = 'OPEN' THEN notional_usdc ELSE 0 END), 0) AS open_exposure_usdc, COALESCE(SUM(fee_paid_usdc), 0) AS fees_usdc FROM simulated_orders`);
    return { orders, summary };
  }

  async apiResolvedForCalibration(limit = 500): Promise<Array<{ estimate_p: number | null; evidence_json: string; winning_side: string; type: string }>> {
    return this.all(`SELECT s.estimate_p, s.evidence_json, r.winning_side, s.type FROM signals s JOIN market_results r ON r.market_id = s.market_id WHERE s.type = 'VALUE' ORDER BY s.created_at DESC LIMIT ?`, limit);
  }

  async apiRuns(limit: number, onlyErrors = false): Promise<unknown[]> {
    return this.all(`SELECT run_id, started_at, finished_at, trigger, phase, status, markets_scanned, signals_created, signals_accepted, ai_calls, subrequests, d1_statements, duration_ms, error, details_json FROM run_logs ${onlyErrors ? `WHERE status IN ('error') OR (status = 'running' AND started_at < datetime('now', '-20 minutes'))` : ''} ORDER BY started_at DESC LIMIT ?`, limit);
  }

  async apiAiErrors(limit: number): Promise<unknown[]> {
    return this.all(`SELECT id, market_id, created_at, model, status, error FROM ai_analyses WHERE status IN ('error', 'invalid') ORDER BY created_at DESC LIMIT ?`, limit);
  }

  async apiAnalyses(marketId: string | null, limit: number): Promise<unknown[]> {
    if (marketId) return this.all('SELECT a.*, m.question FROM ai_analyses a JOIN markets m ON m.id = a.market_id WHERE a.market_id = ? ORDER BY a.created_at DESC LIMIT ?', marketId, limit);
    return this.all('SELECT a.*, m.question FROM ai_analyses a JOIN markets m ON m.id = a.market_id ORDER BY a.created_at DESC LIMIT ?', limit);
  }

  async apiCounts(): Promise<Record<string, number>> {
    const row = await this.first<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM markets WHERE status = 'tracked') AS tracked,
              (SELECT COUNT(*) FROM markets WHERE status = 'resolved') AS resolved,
              (SELECT COUNT(*) FROM markets WHERE status = 'ignored') AS ignored,
              (SELECT COUNT(*) FROM signals) AS signals,
              (SELECT COUNT(*) FROM signals WHERE status = 'ACCEPTED') AS accepted_signals,
              (SELECT COUNT(*) FROM simulated_orders WHERE status = 'OPEN') AS open_simulations,
              (SELECT COUNT(*) FROM calibration_samples) AS calibration_samples,
              (SELECT COUNT(*) FROM ai_analyses) AS ai_analyses,
              (SELECT COUNT(*) FROM price_observations) AS observations`,
    );
    return row ?? {};
  }
}

interface MarketRow {
  id: string;
  condition_id: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  tags_json: string;
  end_date: string;
  yes_token_id: string;
  no_token_id: string;
  outcomes_json: string;
  fee_rate: number;
  fee_exponent: number;
  fee_source: string;
  neg_risk: number;
  event_id: string | null;
  event_market_count: number | null;
  liquidity: number;
  volume_24h: number;
  min_order_size: number;
  tick_size: number;
  status: string;
  last_ai_at: string | null;
}

export function rowToMarket(r: MarketRow): TrackedMarket & { eventMarketCount: number | null; lastAiAt: string | null } {
  return {
    id: r.id,
    conditionId: r.condition_id,
    slug: r.slug,
    question: r.question,
    description: r.description,
    category: r.category,
    tags: safeJsonParse<string[]>(r.tags_json) ?? [],
    endDate: r.end_date,
    yesTokenId: r.yes_token_id,
    noTokenId: r.no_token_id,
    outcomes: (safeJsonParse<[string, string]>(r.outcomes_json) ?? ['Yes', 'No']) as [string, string],
    fee: { rate: r.fee_rate, exponent: r.fee_exponent, takerOnly: true, source: r.fee_source === 'gamma_fee_schedule' ? 'gamma_fee_schedule' : 'assumed_max' },
    negRisk: r.neg_risk === 1,
    eventId: r.event_id,
    liquidity: r.liquidity,
    volume24h: r.volume_24h,
    minOrderSize: r.min_order_size,
    tickSize: r.tick_size,
    status: r.status as TrackedMarket['status'],
    eventMarketCount: r.event_market_count,
    lastAiAt: r.last_ai_at ?? null,
  };
}
