import { AiBudget, analyzeMarket, type AiBinding } from '@pes/ai';
import { ClobClient, GammaClient, SubrequestBudget, checkGeoblock, normalizeMarket, observationFromBook, validateBookPair, type FetchLike } from '@pes/polymarket';
import {
  DEFAULT_CALIBRATION_PARAMS,
  assertSimulationOnly,
  canOpenRealPosition,
  checkRiskLimits,
  estimateFromCalibration,
  evaluateValue,
  findBinaryDutchBook,
  findMultiOutcomeDutchBook,
  paramsFromRecords,
  priceBucket,
  signalIdemKey,
  simulateBuy,
  type ArbitrageOpportunity,
  type RiskState,
  type StrategyParams,
} from '@pes/strategy';
import { HARD_CAPS, STRATEGY_VERSION, dayKey, daysBetween, fnv1a, parseStringArray, round, safeJsonParse, selectBatch, shouldDiscover, type GeoblockStatus, type OrderBook, type PriceObservation, type SignalDecision, type TrackedMarket } from '@pes/shared';
import { Repo } from '../db/repo.ts';
import { parseConfig, type ScannerConfig, type WorkerEnv } from '../env.ts';

export type Trigger = 'cron' | 'manual' | 'test';

export interface ScanDeps {
  fetch?: FetchLike;
  ai?: AiBinding | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  lockTtlMs?: number;
}

export interface RunSummary {
  runId: string;
  status: 'ok' | 'error' | 'skipped';
  phase: string;
  marketsScanned: number;
  signalsCreated: number;
  signalsAccepted: number;
  aiCalls: number;
  subrequests: number;
  d1Statements: number;
  durationMs: number;
  error?: string;
  details: Record<string, unknown>;
}

const GEOBLOCK_TTL_MS = 6 * 3600_000;
const CLEANUP_INTERVAL_MS = 6 * 3600_000;
const MAX_DISCOVERY_PER_RUN = 24;
const MAX_RESOLUTIONS_PER_RUN = 3;
const AI_REANALYSIS_DAYS = 7;

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString();
}

/** Wrap the Workers AI binding into the narrow interface the ai package expects. */
export function aiBindingFrom(env: WorkerEnv): AiBinding {
  return { run: (model, inputs) => (env.AI as unknown as { run: (m: string, i: Record<string, unknown>) => Promise<unknown> }).run(model, inputs) };
}

/**
 * One scheduled run: short, resumable, budgeted. Phases: discover OR price, then resolve,
 * then an optional AI analysis, then bounded maintenance. Never a loop, never a retry storm.
 */
export async function runScan(env: WorkerEnv, trigger: Trigger, deps: ScanDeps = {}): Promise<RunSummary> {
  assertSimulationOnly(env);
  const cfg = parseConfig(env);
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const day = dayKey(now);
  const started = Date.now();
  const repo = new Repo(env.DB);
  const runId = `${nowIso.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;

  const summary: RunSummary = { runId, status: 'ok', phase: 'init', marketsScanned: 0, signalsCreated: 0, signalsAccepted: 0, aiCalls: 0, subrequests: 0, d1Statements: 0, durationMs: 0, details: {} };

  const locked = await repo.acquireLock(now.getTime(), deps.lockTtlMs ?? 120_000);
  if (!locked) {
    await repo.startRun(runId, trigger, 'locked', nowIso);
    await repo.finishRun(runId, { status: 'skipped', phase: 'locked', marketsScanned: 0, signalsCreated: 0, signalsAccepted: 0, aiCalls: 0, subrequests: 0, durationMs: Date.now() - started, error: 'another run holds the lock', details: {} }, nowIso);
    return { ...summary, status: 'skipped', phase: 'locked', error: 'another run holds the lock', d1Statements: repo.statements, durationMs: Date.now() - started };
  }

  const subBudget = new SubrequestBudget(HARD_CAPS.maxSubrequestsPerRun);
  const http = { fetch: deps.fetch, sleep: deps.sleep, budget: subBudget, timeoutMs: 8_000, retries: 1 };
  const gamma = new GammaClient(cfg.gammaBaseUrl, http);
  const clob = new ClobClient(cfg.clobBaseUrl, http);
  const stateUpdates: Record<string, string> = {};
  const details: Record<string, unknown> = {};
  const quota: Record<string, number> = { worker_invocations: 1 };
  let aiNeurons = 0;

  await repo.startRun(runId, trigger, 'init', nowIso);
  try {
    const states = await repo.getStates(['run_counter', 'price_cursor', 'geoblock_json', 'last_cleanup_at', 'ai_model_error']);
    const runCounter = Number(states.run_counter ?? 0) || 0;
    let cursor = Number(states.price_cursor ?? 0) || 0;
    const params = paramsFromRecords(await repo.loadParamRows());
    const trackedCount = await repo.countTracked();

    // Official geoblock check, refreshed every 6 hours. It describes the Worker's egress.
    let geoblock = safeJsonParse<GeoblockStatus>(states.geoblock_json) ?? null;
    if (!geoblock || !Number.isFinite(Date.parse(geoblock.checkedAt)) || now.getTime() - Date.parse(geoblock.checkedAt) > GEOBLOCK_TTL_MS) {
      geoblock = await checkGeoblock(cfg.geoblockUrl, http, now);
      stateUpdates.geoblock_json = JSON.stringify(geoblock);
    }
    const safety = canOpenRealPosition({ simulationOnly: cfg.simulationOnly, geoblock });
    details.safety = safety;

    let touched: TrackedMarket[] = [];
    const accepted = new Set<string>();

    if (shouldDiscover(runCounter, cfg.discoveryEveryNRuns, trackedCount)) {
      summary.phase = 'discover';
      touched = await discover(gamma, repo, cfg, params, now, trackedCount, details);
      summary.marketsScanned = touched.length;
    } else {
      summary.phase = 'price';
      const result = await price(clob, repo, cfg, params, now, cursor, details);
      cursor = result.nextCursor;
      touched = result.batch;
      summary.marketsScanned = result.batch.length;
      summary.signalsCreated = result.signalsCreated;
      summary.signalsAccepted = result.signalsAccepted;
      result.acceptedMarketIds.forEach((id) => accepted.add(id));
      stateUpdates.price_cursor = String(cursor);
    }

    if (subBudget.remaining > 0 && repo.statements < HARD_CAPS.maxD1StatementsPerRun - 12) {
      await resolve(gamma, repo, now, details);
    }

    if (cfg.aiEnabled && deps.ai && summary.phase === 'price' && subBudget.remaining > 0 && repo.statements < HARD_CAPS.maxD1StatementsPerRun - 4) {
      const usage = await repo.quotaToday(day);
      const budget = new AiBudget({ maxCallsPerRun: cfg.aiMaxCallsPerRun, maxCallsPerDay: cfg.aiMaxCallsPerDay, maxNeuronsPerDay: cfg.aiMaxNeuronsPerDay }, { calls: usage.ai_calls ?? 0, neurons: usage.ai_neurons_est ?? 0 });
      const ai = await analyze(deps.ai, repo, cfg, touched, accepted, budget, now, details, states.ai_model_error ?? null);
      if (ai.modelError) stateUpdates.ai_model_error = ai.modelError;
      summary.aiCalls = ai.calls;
      aiNeurons = ai.neurons;
      quota.ai_calls = ai.calls;
      quota.ai_neurons_est = ai.neurons;
      quota.ai_input_tokens = ai.inputTokens;
      quota.ai_output_tokens = ai.outputTokens;
    }

    const lastCleanup = Date.parse(states.last_cleanup_at ?? '') || 0;
    if (now.getTime() - lastCleanup > CLEANUP_INTERVAL_MS && repo.statements < HARD_CAPS.maxD1StatementsPerRun - 6) {
      await repo.cleanup(addDays(now, -cfg.retentionDays), addDays(now, -14));
      stateUpdates.last_cleanup_at = nowIso;
      details.cleanup = 'done';
    }

    stateUpdates.run_counter = String(runCounter + 1);
    stateUpdates.last_run_at = nowIso;
    stateUpdates.last_run_phase = summary.phase;
    stateUpdates.last_run_status = 'ok';
  } catch (err) {
    summary.status = 'error';
    summary.error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500);
    stateUpdates.last_run_at = nowIso;
    stateUpdates.last_run_status = 'error';
  } finally {
    summary.subrequests = subBudget.consumed;
    quota.subrequests = subBudget.consumed;
    quota.d1_statements = repo.statements + 4;
    quota.d1_rows_written = repo.rowsWritten;
    summary.details = details;
    summary.durationMs = Date.now() - started;
    try {
      await repo.setStates(stateUpdates, nowIso);
      await repo.addQuota(day, quota, nowIso);
      await repo.finishRun(runId, { status: summary.status === 'skipped' ? 'skipped' : summary.status, phase: summary.phase, marketsScanned: summary.marketsScanned, signalsCreated: summary.signalsCreated, signalsAccepted: summary.signalsAccepted, aiCalls: summary.aiCalls, subrequests: summary.subrequests, durationMs: summary.durationMs, error: summary.error ?? null, details: { ...details, aiNeurons: round(aiNeurons, 2) } }, nowIso);
    } finally {
      await repo.releaseLock(nowIso);
    }
    summary.d1Statements = repo.statements;
  }
  return summary;
}

// ---------------------------------------------------------------------------

async function discover(gamma: GammaClient, repo: Repo, cfg: ScannerConfig, params: StrategyParams, now: Date, trackedCount: number, details: Record<string, unknown>): Promise<TrackedMarket[]> {
  const room = Math.min(MAX_DISCOVERY_PER_RUN, cfg.maxTrackedMarkets - trackedCount + MAX_DISCOVERY_PER_RUN);
  const { events, rejected } = await gamma.listEvents({
    limit: 20,
    liquidityMin: params.discovery_liquidity_min,
    volumeMin: params.discovery_volume_min,
    endDateMin: addDays(now, params.min_days_to_end),
    endDateMax: addDays(now, params.max_days_to_end),
  });
  const ignored: Record<string, number> = {};
  const eventCounts = new Map<string, number>();
  const picked: TrackedMarket[] = [];
  for (const event of events) {
    eventCounts.set(event.id, event.markets.length);
    const eventTags = (event.tags ?? []).map((t) => t.slug ?? t.label ?? '').filter(Boolean);
    const ok: TrackedMarket[] = [];
    for (const raw of event.markets) {
      const n = normalizeMarket(raw, { now, eventTags, eventId: event.id, eventNegRisk: event.negRisk ?? null });
      if (n.ok) ok.push(n.market);
      else ignored[n.reason] = (ignored[n.reason] ?? 0) + 1;
    }
    ok.sort((a, b) => b.liquidity - a.liquidity);
    for (const m of ok.slice(0, HARD_CAPS.maxMarketsPerEvent)) {
      if (picked.length >= room) break;
      if (m.liquidity < params.min_liquidity_usdc) {
        ignored.liquidity_below_min = (ignored.liquidity_below_min ?? 0) + 1;
        continue;
      }
      picked.push(m);
    }
  }
  if (picked.length > 0) await repo.upsertMarkets(picked, eventCounts, now.toISOString());
  details.discovery = { events: events.length, rejectedPayloads: rejected, upserted: picked.length, ignored, trackedBefore: trackedCount };
  return picked;
}

// ---------------------------------------------------------------------------

interface PriceResult {
  batch: TrackedMarket[];
  nextCursor: number;
  signalsCreated: number;
  signalsAccepted: number;
  acceptedMarketIds: string[];
}

async function price(clob: ClobClient, repo: Repo, cfg: ScannerConfig, params: StrategyParams, now: Date, cursor: number, details: Record<string, unknown>): Promise<PriceResult> {
  const nowIso = now.toISOString();
  const tracked = await repo.listTracked(cfg.maxTrackedMarkets);
  const sel = selectBatch(tracked, cursor, cfg.maxMarketsPerRun, HARD_CAPS.maxMarketsPerRun);
  const out: PriceResult = { batch: sel.batch, nextCursor: sel.nextCursor, signalsCreated: 0, signalsAccepted: 0, acceptedMarketIds: [] };
  if (sel.batch.length === 0) {
    details.pricing = { tracked: tracked.length, batch: 0 };
    return out;
  }

  const tokenIds = sel.batch.flatMap((m) => [m.yesTokenId, m.noTokenId]);
  const { books, missing } = await clob.getBooks(tokenIds);
  const samples = await repo.loadCalibrationSamples(3000);
  const dayStart = `${dayKey(now)}T00:00:00.000Z`;
  let risk: RiskState = await repo.riskState(dayStart);
  const calibrationParams = { ...DEFAULT_CALIBRATION_PARAMS, minSamples: params.min_calibration_samples };

  const observations: PriceObservation[] = [];
  const topLevels = new Map<string, unknown>();
  const candidates: Array<{ market: TrackedMarket; decision: SignalDecision; legs: Array<{ marketId: string; fee: TrackedMarket['fee']; tokenId: string; side: string; outcome: string; asks: OrderBook['asks']; shares: number; ageSeconds: number }> }> = [];
  const paramsRecord = params as unknown as Record<string, number>;
  const problems: Record<string, number> = {};
  const byEvent = new Map<string, Array<{ market: TrackedMarket; yes: OrderBook }>>();

  for (const market of sel.batch) {
    const yes = books.get(market.yesTokenId);
    const no = books.get(market.noTokenId);
    if (!yes || !no) {
      problems.missing_book = (problems.missing_book ?? 0) + 1;
      continue;
    }
    const validation = validateBookPair(yes, no, { now, maxAgeSeconds: params.max_book_age_seconds });
    for (const p of validation.problems) problems[p] = (problems[p] ?? 0) + 1;
    observations.push(observationFromBook(market.id, 'YES', yes, now), observationFromBook(market.id, 'NO', no, now));
    topLevels.set(market.yesTokenId, { bids: yes.bids.slice(0, 5), asks: yes.asks.slice(0, 5) });
    topLevels.set(market.noTokenId, { bids: no.bids.slice(0, 5), asks: no.asks.slice(0, 5) });

    const yesBid = yes.bids[0]?.price ?? null;
    const yesAsk = yes.asks[0]?.price ?? null;
    const yesMid = yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 : (yesAsk ?? yesBid);
    const daysToEnd = daysBetween(now, market.endDate);
    const est = yesMid === null ? null : estimateFromCalibration(samples, yesMid, daysToEnd, calibrationParams);
    const decision = evaluateValue({
      market,
      yesBook: yes,
      noBook: no,
      estimate: est?.ok ? est.estimate : null,
      estimateDetail: est && !est.ok ? est.detail : undefined,
      params,
      risk,
      now,
      validation,
    });
    const book = decision.side === 'YES' ? yes : no;
    candidates.push({ market, decision, legs: [{ marketId: market.id, fee: market.fee, tokenId: book.tokenId, side: decision.side, outcome: decision.outcome, asks: book.asks, shares: decision.suggestedShares, ageSeconds: (now.getTime() - book.timestampMs) / 1000 }] });

    if (validation.ok) {
      const arb = findBinaryDutchBook({ marketId: market.id, yesAsks: yes.asks, noAsks: no.asks, fee: market.fee, minSets: params.arb_min_sets, maxSets: params.arb_max_sets, safetyMargin: params.safety_margin, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId });
      if (arb) candidates.push(arbitrageCandidate(market, arb, params, risk, now, [yes, no], new Map([[market.id, market]])));
      if (market.negRisk && market.eventId) {
        const list = byEvent.get(market.eventId) ?? [];
        list.push({ market, yes });
        byEvent.set(market.eventId, list);
      }
    }
  }

  // Multi-outcome Dutch books, only when the whole outcome set of a negRisk event is in this batch.
  for (const [eventId, legs] of byEvent) {
    const expected = (legs[0]?.market as TrackedMarket & { eventMarketCount?: number | null }).eventMarketCount ?? null;
    if (!expected || legs.length !== expected) continue;
    const arb = findMultiOutcomeDutchBook({ eventId, legs: legs.map((l) => ({ marketId: l.market.id, tokenId: l.market.yesTokenId, outcome: l.market.outcomes[0], asks: l.yes.asks, fee: l.market.fee })), expectedOutcomes: expected, minSets: params.arb_min_sets, maxSets: params.arb_max_sets, safetyMargin: params.safety_margin });
    if (arb) candidates.push(arbitrageCandidate(legs[0]!.market, arb, params, risk, now, legs.map((l) => l.yes), new Map(legs.map((l) => [l.market.id, l.market]))));
  }

  if (observations.length > 0) await repo.insertObservations(observations, topLevels);

  const marketIds = sel.batch.map((m) => m.id);
  let inserted = 0;
  for (const c of candidates) {
    if (repo.statements >= HARD_CAPS.maxD1StatementsPerRun - 10) {
      details.signals_truncated = true;
      break;
    }
    const id = await repo.insertSignal(c.decision, nowIso, paramsRecord);
    if (id === null) continue; // same signal already recorded today at this price bucket
    inserted += 1;
    if (c.decision.status !== 'ACCEPTED') continue;
    out.signalsAccepted += 1;
    out.acceptedMarketIds.push(c.market.id);
    let notional = 0;
    for (const leg of c.legs) {
      const fill = simulateBuy({ asks: leg.asks, shares: leg.shares, fee: leg.fee, bookAgeSeconds: leg.ageSeconds });
      await repo.insertSimulatedOrder({ signalId: id, marketId: leg.marketId, side: leg.side, outcome: leg.outcome, tokenId: leg.tokenId, fill, now: nowIso });
      notional += fill.notionalUsdc;
    }
    risk = { openExposureUsdc: risk.openExposureUsdc + notional, openPositions: risk.openPositions + 1, newPositionsToday: risk.newPositionsToday + 1 };
  }
  out.signalsCreated = inserted;
  await repo.markPriced(marketIds, nowIso);
  details.pricing = { tracked: tracked.length, batch: sel.batch.length, missingBooks: missing.length, problems, candidates: candidates.length, inserted, risk };
  return out;
}

function arbitrageCandidate(market: TrackedMarket, arb: ArbitrageOpportunity, params: StrategyParams, risk: RiskState, now: Date, books: OrderBook[], marketsById: Map<string, TrackedMarket>) {
  // The per-position cap applies to baskets too: never more notional than max_position_usdc.
  const sets = Math.min(arb.sets, Math.floor(params.max_position_usdc / arb.costPerSet));
  const notional = sets * arb.costPerSet;
  const limits = checkRiskLimits(params, risk, notional);
  const reasons = [...limits.reasons, `structural:${arb.kind}`, `sets=${sets}/${arb.sets} cost=${arb.costPerSet.toFixed(4)} fee=${arb.feePerSet.toFixed(4)} net=${arb.netProfitPerSet.toFixed(4)}`];
  if (sets < params.arb_min_sets) reasons.unshift(`below_min_sets_after_cap:${sets}<${params.arb_min_sets}`);
  const ok = limits.ok && sets >= params.arb_min_sets;
  const decision: SignalDecision = {
    idemKey: signalIdemKey({ marketId: market.id, type: 'ARBITRAGE', side: 'YES', priceBucket: priceBucket(arb.costPerSet), day: dayKey(now) }),
    marketId: market.id,
    type: 'ARBITRAGE',
    side: 'YES',
    outcome: 'ALL_OUTCOMES',
    status: ok ? 'ACCEPTED' : 'REJECTED',
    reasons,
    estimate: { p: 1, ciLow: 1, ciHigh: 1, n: 0, source: 'structural_arbitrage', explanation: arb.explanation },
    execPrice: arb.costPerSet,
    feeRate: market.fee.rate,
    feeCostPerShare: arb.feePerSet,
    spread: null,
    slippagePerShare: null,
    grossEdgePerShare: 1 - arb.costPerSet,
    netEdgePerShare: arb.netProfitPerSet,
    safetyMargin: arb.safetyMargin,
    suggestedShares: ok ? sets : 0,
    suggestedNotionalUsdc: ok ? round(notional, 4) : 0,
    evidence: { kind: arb.kind, legs: arb.legs, explanation: arb.explanation },
    strategyVersion: STRATEGY_VERSION,
  };
  const legs = arb.legs.map((leg) => {
    const book = books.find((b) => b.tokenId === leg.tokenId);
    const legMarket = marketsById.get(leg.marketId) ?? market;
    return { marketId: legMarket.id, fee: legMarket.fee, tokenId: leg.tokenId, side: leg.side, outcome: leg.outcome, asks: book?.asks ?? [], shares: sets, ageSeconds: book ? (now.getTime() - book.timestampMs) / 1000 : Number.POSITIVE_INFINITY };
  });
  return { market, decision, legs };
}

// ---------------------------------------------------------------------------

async function resolve(gamma: GammaClient, repo: Repo, now: Date, details: Record<string, unknown>): Promise<void> {
  const nowIso = now.toISOString();
  const candidates = await repo.marketsPastEnd(new Date(now.getTime() - 3600_000).toISOString(), 40);
  if (candidates.length === 0) return;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const raws = await gamma.getMarketsByIds(candidates.map((c) => c.id));
  let resolved = 0;
  let closedOnly = 0;
  let abandoned = 0;
  for (const raw of raws) {
    if (resolved >= MAX_RESOLUTIONS_PER_RUN) break;
    const c = byId.get(String(raw.id));
    if (!c) continue;
    const prices = parseStringArray(raw.outcomePrices)?.map(Number) ?? [];
    const p0 = prices[0];
    const p1 = prices[1];
    const settled = raw.umaResolutionStatus === 'resolved' || (raw.closed === true && p0 !== undefined && p1 !== undefined && Math.max(p0, p1) >= 0.99);
    if (!settled) {
      if (daysBetween(c.endDate, now) > 60) {
        await repo.setMarketStatus(c.id, 'ignored', 'unresolved_60_days_after_end');
        abandoned += 1;
      } else if (raw.closed === true) {
        await repo.setMarketStatus(c.id, 'closed', null);
        closedOnly += 1;
      }
      continue;
    }
    if (p0 === undefined || p1 === undefined || Math.max(p0, p1) < 0.99) {
      await repo.setMarketStatus(c.id, 'closed', 'resolved_without_clear_winner');
      closedOnly += 1;
      continue;
    }
    const winningIndex = p0 > p1 ? 0 : 1;
    const winningSide = winningIndex === 0 ? 'YES' : 'NO';
    await repo.recordResult({ marketId: c.id, winningOutcome: c.outcomes[winningIndex] ?? winningSide, winningSide, finalPrices: [p0, p1], resolvedAt: nowIso, source: 'gamma' }, raw.umaResolutionStatus ?? null, nowIso);
    const daily = await repo.dailyYesPrices(c.id, 45);
    const samplesToInsert = daily
      .map((d) => ({ marketId: c.id, day: d.day, price: d.mid, daysToEnd: daysBetween(d.observedAt, c.endDate), outcome: (winningSide === 'YES' ? 1 : 0) as 0 | 1, category: c.category }))
      .filter((s) => s.daysToEnd >= 0 && s.price > 0 && s.price < 1);
    if (samplesToInsert.length > 0) await repo.insertCalibrationSamples(samplesToInsert, nowIso);
    resolved += 1;
  }
  details.resolution = { candidates: candidates.length, returned: raws.length, resolved, closedOnly, abandoned };
}

// ---------------------------------------------------------------------------

async function analyze(ai: AiBinding, repo: Repo, cfg: ScannerConfig, touched: TrackedMarket[], accepted: Set<string>, budget: AiBudget, now: Date, details: Record<string, unknown>, modelErrorState: string | null): Promise<{ calls: number; neurons: number; inputTokens: number; outputTokens: number; modelError?: string }> {
  const result: { calls: number; neurons: number; inputTokens: number; outputTokens: number; modelError?: string } = { calls: 0, neurons: 0, inputTokens: 0, outputTokens: 0 };
  // A model known to be unusable (deprecated, unknown) is not retried until AI_MODEL changes.
  if (modelErrorState && modelErrorState.startsWith(`${cfg.aiModel}|`)) {
    details.ai = { calls: 0, skipped: ['model_unavailable'], model: cfg.aiModel, error: modelErrorState.slice(cfg.aiModel.length + 1, cfg.aiModel.length + 201) };
    return result;
  }
  const recent = now.getTime() - AI_REANALYSIS_DAYS * 86_400_000;
  const ordered = [...touched].sort((a, b) => Number(accepted.has(b.id)) - Number(accepted.has(a.id)));
  const skipped: string[] = [];
  for (const market of ordered) {
    const lastAi = (market as TrackedMarket & { lastAiAt?: string | null }).lastAiAt;
    if (lastAi && Date.parse(lastAi) > recent && !accepted.has(market.id)) continue;
    const verdict = budget.canCall();
    if (!verdict.ok) {
      skipped.push(verdict.reason);
      break;
    }
    const promptHash = fnv1a(`${market.question}|${market.description}|${market.endDate}`);
    const outcome = await analyzeMarket(ai, cfg.aiModel, { marketId: market.id, question: market.question, description: market.description, endDate: market.endDate, category: market.category, yesPrice: null, liquidity: market.liquidity, now }, budget);
    await repo.insertAnalysis(market.id, promptHash, outcome, now.toISOString());
    if (outcome.status !== 'skipped_quota') {
      result.calls += 1;
      result.neurons += outcome.neuronsEstimated;
      result.inputTokens += outcome.usage.inputTokens;
      result.outputTokens += outcome.usage.outputTokens;
    }
    if (outcome.status === 'error' && outcome.unavailable) {
      result.modelError = `${cfg.aiModel}|${outcome.error ?? 'unavailable'}`;
      skipped.push('model_unavailable');
      break;
    }
    if (outcome.status === 'error' && /limit|quota|3040|429/i.test(outcome.error ?? '')) {
      skipped.push('model_quota_error');
      break;
    }
  }
  details.ai = { calls: result.calls, neurons: round(result.neurons, 2), skipped, model: cfg.aiModel };
  return result;
}
