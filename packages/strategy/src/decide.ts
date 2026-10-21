import { STRATEGY_VERSION, dayKey, daysBetween, round, type OrderBook, type ProbabilityEstimate, type Side, type SignalDecision, type TrackedMarket } from '@pes/shared';
import { walkBook } from './book.ts';
import { priceBucket, signalIdemKey } from './dedup.ts';
import { computeEdge } from './edge.ts';
import { takerFeePerShare } from './fees.ts';
import type { StrategyParams } from './params.ts';
import { checkRiskLimits, positionSize, type RiskState } from './risk.ts';

export interface EvaluateInput {
  market: TrackedMarket;
  yesBook: OrderBook;
  noBook: OrderBook;
  /** Independent estimate, or null when none can be justified. */
  estimate: ProbabilityEstimate | null;
  estimateDetail?: string;
  params: StrategyParams;
  risk: RiskState;
  now: Date;
  validation: { ok: boolean; problems: string[] };
}

/**
 * The value decision. Every check appends a reason; the signal is ACCEPTED only when no
 * rejection reason remains. The market price is never used as the estimate: without an
 * independent estimate the answer is INSUFFICIENT_EVIDENCE.
 */
export function evaluateValue(input: EvaluateInput): SignalDecision {
  const { market, params, estimate, now } = input;
  const rejections: string[] = [];
  const notes: string[] = [];

  if (!input.validation.ok) rejections.push(...input.validation.problems);

  const yesAsk = input.yesBook.asks[0]?.price ?? null;
  const yesBid = input.yesBook.bids[0]?.price ?? null;
  const mid = yesAsk !== null && yesBid !== null ? (yesAsk + yesBid) / 2 : (yesAsk ?? yesBid);

  // Side: buy the outcome whose estimated probability exceeds its price.
  let side: Side = 'YES';
  if (estimate && mid !== null && estimate.p < mid) side = 'NO';
  const book = side === 'YES' ? input.yesBook : input.noBook;
  const bestAsk = book.asks[0]?.price ?? null;
  const bestBid = book.bids[0]?.price ?? null;
  const spread = bestAsk !== null && bestBid !== null ? round(bestAsk - bestBid, 4) : null;

  const daysToEnd = daysBetween(now, market.endDate);
  if (daysToEnd < params.min_days_to_end) rejections.push(`ends_too_soon:${round(daysToEnd, 3)}d`);
  if (daysToEnd > params.max_days_to_end) rejections.push(`ends_too_late:${round(daysToEnd, 1)}d`);
  if (market.liquidity < params.min_liquidity_usdc) rejections.push(`liquidity_below_min:${round(market.liquidity, 0)}`);
  if (bestAsk === null) rejections.push('no_ask_liquidity');
  if (spread !== null && spread > params.max_spread) rejections.push(`spread_too_wide:${spread.toFixed(3)}`);

  let execPrice: number | null = bestAsk;
  let feeCost: number | null = null;
  let slippage: number | null = null;
  let gross: number | null = null;
  let net: number | null = null;
  let shares = 0;
  let notional = 0;

  if (!estimate) {
    rejections.push('INSUFFICIENT_EVIDENCE');
    if (input.estimateDetail) notes.push(`estimate:${input.estimateDetail}`);
  } else {
    if (estimate.n < params.min_calibration_samples) rejections.push(`insufficient_samples:${estimate.n}<${params.min_calibration_samples}`);
    // Conservative probability of the chosen side: the lower bound of the interval.
    const pSideLow = side === 'YES' ? estimate.ciLow : 1 - estimate.ciHigh;
    const pSidePoint = side === 'YES' ? estimate.p : 1 - estimate.p;
    if (bestAsk !== null) {
      const size = positionSize({ p: pSideLow, price: bestAsk, params, state: input.risk, minOrderSize: market.minOrderSize });
      notes.push(...size.reasons.map((r) => `sizing:${r}`));
      shares = size.shares;
      const fill = walkBook(book.asks, Math.max(shares, market.minOrderSize));
      if (fill.partial || fill.vwap === null) {
        rejections.push('insufficient_depth');
        execPrice = bestAsk;
      } else {
        execPrice = fill.vwap;
      }
      feeCost = takerFeePerShare(execPrice, market.fee);
      const edge = computeEdge({ pSide: pSideLow, execPrice, bestPrice: bestAsk, feePerShare: feeCost, safetyMargin: params.safety_margin });
      gross = edge.grossEdgePerShare;
      net = edge.netEdgePerShare;
      slippage = edge.slippagePerShare;
      notional = shares * execPrice;
      if (shares <= 0) rejections.push('size_zero');
      if (net < params.min_net_edge) rejections.push(`edge_below_threshold:net=${net.toFixed(4)}<${params.min_net_edge}`);
      else notes.push(`edge_ok:ci_low=${pSideLow.toFixed(3)} point=${pSidePoint.toFixed(3)} exec=${execPrice.toFixed(3)} fee=${feeCost.toFixed(4)} net=${net.toFixed(4)}`);
      const limits = checkRiskLimits(params, input.risk, notional);
      rejections.push(...limits.reasons);
    }
  }

  const status = rejections.length === 0 ? 'ACCEPTED' : 'REJECTED';
  const priceForKey = execPrice ?? mid ?? 0;
  return {
    idemKey: signalIdemKey({ marketId: market.id, type: 'VALUE', side, priceBucket: priceBucket(priceForKey), day: dayKey(now) }),
    marketId: market.id,
    type: 'VALUE',
    side,
    outcome: side === 'YES' ? market.outcomes[0] : market.outcomes[1],
    status,
    reasons: [...rejections, ...notes],
    estimate,
    execPrice,
    feeRate: market.fee.rate,
    feeCostPerShare: feeCost,
    spread,
    slippagePerShare: slippage,
    grossEdgePerShare: gross,
    netEdgePerShare: net,
    safetyMargin: params.safety_margin,
    suggestedShares: status === 'ACCEPTED' ? shares : 0,
    suggestedNotionalUsdc: status === 'ACCEPTED' ? round(notional, 4) : 0,
    evidence: {
      yesBestBid: yesBid,
      yesBestAsk: yesAsk,
      noBestBid: input.noBook.bids[0]?.price ?? null,
      noBestAsk: input.noBook.asks[0]?.price ?? null,
      bookAgeSeconds: round(Math.max(0, (now.getTime() - book.timestampMs) / 1000), 1),
      daysToEnd: round(daysToEnd, 3),
      feeSource: market.fee.source,
      estimateSource: estimate?.source ?? null,
      estimateExplanation: estimate?.explanation ?? input.estimateDetail ?? null,
    },
    strategyVersion: STRATEGY_VERSION,
  };
}
