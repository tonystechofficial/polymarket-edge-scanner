/** Outcome side of a binary market. Multi-outcome events are handled as sets of binary markets. */
export type Side = 'YES' | 'NO';

export type MarketStatus = 'tracked' | 'closed' | 'resolved' | 'ignored';

export interface FeeSchedule {
  /** Taker fee rate, e.g. 0.07 for crypto markets. 0 means fee-free. */
  rate: number;
  /** Exponent applied to p(1-p). Gamma publishes 1 today. */
  exponent: number;
  takerOnly: boolean;
  /** Where the rate came from: Gamma `feeSchedule`, or a conservative assumption. */
  source: 'gamma_fee_schedule' | 'assumed_max';
}

export interface TrackedMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  category: string;
  tags: string[];
  endDate: string;
  yesTokenId: string;
  noTokenId: string;
  outcomes: [string, string];
  fee: FeeSchedule;
  negRisk: boolean;
  eventId: string | null;
  liquidity: number;
  volume24h: number;
  minOrderSize: number;
  tickSize: number;
  status: MarketStatus;
  ignoreReason?: string;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  /** Sorted best first: bids descending, asks ascending. */
  bids: BookLevel[];
  asks: BookLevel[];
  timestampMs: number;
  hash: string;
  tickSize: number;
  minOrderSize: number;
}

export interface PriceObservation {
  marketId: string;
  tokenId: string;
  side: Side;
  observedAt: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  bidDepthUsdc: number;
  askDepthUsdc: number;
  bookTimestampMs: number;
  bookHash: string;
  ageSeconds: number;
}

export type EstimateSource = 'empirical_calibration' | 'structural_arbitrage';

export interface ProbabilityEstimate {
  p: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  source: EstimateSource;
  explanation: string;
}

export type SignalType = 'VALUE' | 'ARBITRAGE';
export type SignalStatus = 'ACCEPTED' | 'REJECTED';

export interface SignalDecision {
  idemKey: string;
  marketId: string;
  type: SignalType;
  side: Side;
  outcome: string;
  status: SignalStatus;
  reasons: string[];
  estimate: ProbabilityEstimate | null;
  execPrice: number | null;
  feeRate: number;
  feeCostPerShare: number | null;
  spread: number | null;
  slippagePerShare: number | null;
  grossEdgePerShare: number | null;
  netEdgePerShare: number | null;
  safetyMargin: number;
  suggestedShares: number;
  suggestedNotionalUsdc: number;
  evidence: Record<string, unknown>;
  strategyVersion: string;
}

export interface SimulatedFill {
  requestedShares: number;
  filledShares: number;
  vwapPrice: number | null;
  worstPrice: number | null;
  notionalUsdc: number;
  feePaidUsdc: number;
  slippageUsdc: number;
  partial: boolean;
  assumptions: string[];
}

export interface MarketResult {
  marketId: string;
  winningOutcome: string;
  winningSide: Side;
  finalPrices: [number, number];
  resolvedAt: string;
  source: string;
}

export interface CalibrationSample {
  marketId: string;
  price: number;
  daysToEnd: number;
  outcome: 0 | 1;
}

export type AiConfidence = 'low' | 'medium' | 'high';
export type AiRecommendation = 'INSUFFICIENT_EVIDENCE' | 'REVIEW' | 'AVOID';
export type AiDataFreshness = 'unknown' | 'stale' | 'recent';

export interface AiAnalysis {
  summary: string;
  probability_estimate: number | null;
  confidence: AiConfidence;
  supporting_evidence: string[];
  contradicting_evidence: string[];
  sources: string[];
  data_freshness: AiDataFreshness;
  recommendation: AiRecommendation;
  /** Flags about resolution-rule hazards (ambiguous wording, 50-50 clauses, external data dependency). */
  resolution_risks: string[];
}

export interface GeoblockStatus {
  blocked: boolean;
  country: string | null;
  region: string | null;
  checkedAt: string;
  /** `unknown` when the official endpoint could not be reached. */
  eligibility: 'blocked' | 'allowed' | 'unknown';
}

export interface StrategyParamSpec {
  key: string;
  value: number;
  min: number;
  max: number;
  description: string;
}
