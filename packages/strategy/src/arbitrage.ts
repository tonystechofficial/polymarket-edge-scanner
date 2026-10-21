import type { BookLevel, FeeSchedule, Side } from '@pes/shared';
import { takerFeeForFill } from './fees.ts';
import { totalDepthShares, walkBook } from './book.ts';

export interface ArbitrageLeg {
  marketId: string;
  tokenId: string;
  side: Side;
  outcome: string;
  /** VWAP of the leg for `sets` shares. */
  price: number;
  shares: number;
  feeUsdc: number;
}

export interface ArbitrageOpportunity {
  kind: 'binary_dutch_book' | 'multi_outcome_dutch_book';
  sets: number;
  costPerSet: number;
  feePerSet: number;
  payoutPerSet: 1;
  netProfitPerSet: number;
  safetyMargin: number;
  legs: ArbitrageLeg[];
  explanation: string;
}

interface LegInput {
  marketId: string;
  tokenId: string;
  side: Side;
  outcome: string;
  asks: BookLevel[];
  fee: FeeSchedule;
}

/** Candidate set sizes: the depth breakpoints of every leg, capped, largest first. */
function candidateSizes(legs: LegInput[], minSets: number, maxSets: number): number[] {
  const maxFillable = Math.min(maxSets, ...legs.map((l) => totalDepthShares(l.asks)));
  if (maxFillable < minSets) return [];
  const points = new Set<number>([maxFillable]);
  for (const leg of legs) {
    let cumulative = 0;
    for (const level of leg.asks) {
      cumulative += level.size;
      if (cumulative >= minSets && cumulative <= maxFillable) points.add(cumulative);
    }
  }
  return Array.from(points).sort((a, b) => b - a);
}

function evaluateSet(kind: ArbitrageOpportunity['kind'], legs: LegInput[], sets: number, safetyMargin: number): ArbitrageOpportunity | null {
  const built: ArbitrageLeg[] = [];
  let cost = 0;
  let fees = 0;
  for (const leg of legs) {
    const fill = walkBook(leg.asks, sets);
    if (fill.partial || fill.vwap === null) return null;
    const feeUsdc = takerFeeForFill(fill.fills, leg.fee);
    built.push({ marketId: leg.marketId, tokenId: leg.tokenId, side: leg.side, outcome: leg.outcome, price: fill.vwap, shares: sets, feeUsdc });
    cost += fill.vwap;
    fees += feeUsdc / sets;
  }
  const net = 1 - cost - fees - safetyMargin;
  if (net <= 0) return null;
  return {
    kind,
    sets,
    costPerSet: cost,
    feePerSet: fees,
    payoutPerSet: 1,
    netProfitPerSet: net,
    safetyMargin,
    legs: built,
    explanation: `Buying one share of every outcome costs ${cost.toFixed(4)} + ${fees.toFixed(4)} fees per set and pays exactly 1.0000 at resolution; net ${net.toFixed(4)} per set after a ${safetyMargin} margin, for ${sets} sets available on the books.`,
  };
}

function bestOpportunity(kind: ArbitrageOpportunity['kind'], legs: LegInput[], minSets: number, maxSets: number, safetyMargin: number): ArbitrageOpportunity | null {
  for (const sets of candidateSizes(legs, minSets, maxSets)) {
    const opp = evaluateSet(kind, legs, sets, safetyMargin);
    if (opp) return opp;
  }
  return null;
}

/**
 * Binary Dutch book: buying YES and NO of the same market costs less than the 1 USDC the pair
 * is redeemed for. This is a structural statement about prices, not an opinion about the event.
 */
export function findBinaryDutchBook(input: { marketId: string; yesAsks: BookLevel[]; noAsks: BookLevel[]; fee: FeeSchedule; minSets: number; maxSets: number; safetyMargin: number; yesTokenId?: string; noTokenId?: string }): ArbitrageOpportunity | null {
  const legs: LegInput[] = [
    { marketId: input.marketId, tokenId: input.yesTokenId ?? 'YES', side: 'YES', outcome: 'YES', asks: input.yesAsks, fee: input.fee },
    { marketId: input.marketId, tokenId: input.noTokenId ?? 'NO', side: 'NO', outcome: 'NO', asks: input.noAsks, fee: input.fee },
  ];
  return bestOpportunity('binary_dutch_book', legs, input.minSets, input.maxSets, input.safetyMargin);
}

/**
 * Multi-outcome Dutch book on a mutually exclusive, exhaustive event: the YES asks of all
 * outcomes sum below 1. Requires every outcome of the event, otherwise the set is incomplete
 * and the "guaranteed" payout is not guaranteed.
 */
export function findMultiOutcomeDutchBook(input: { eventId: string; legs: Array<{ marketId: string; tokenId: string; outcome: string; asks: BookLevel[]; fee: FeeSchedule }>; expectedOutcomes: number; minSets: number; maxSets: number; safetyMargin: number }): ArbitrageOpportunity | null {
  if (input.expectedOutcomes < 2 || input.legs.length !== input.expectedOutcomes) return null;
  if (new Set(input.legs.map((l) => l.marketId)).size !== input.legs.length) return null;
  const legs: LegInput[] = input.legs.map((l) => ({ ...l, side: 'YES' as const }));
  return bestOpportunity('multi_outcome_dutch_book', legs, input.minSets, input.maxSets, input.safetyMargin);
}
