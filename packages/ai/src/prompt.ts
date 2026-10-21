import { truncate } from '@pes/shared';

export interface AnalysisInput {
  marketId: string;
  question: string;
  description: string;
  endDate: string;
  category: string;
  yesPrice: number | null;
  liquidity: number;
  now: Date;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export const SYSTEM_PROMPT = [
  'You are a careful research assistant reviewing a prediction market for a read-only scanner.',
  'You have no web access and your knowledge may be stale: the resolution rules quoted by the user are the only reliable text.',
  'Answer with one JSON object and nothing else. Fields:',
  '- summary: one or two sentences in your own words about HOW this market resolves (source, deadline, edge cases). Never repeat the question title.',
  '- probability_estimate: null unless the quoted rules themselves settle or strongly constrain the outcome. Never derive it from the price. Never guess.',
  '- confidence: "low" unless you cite at least two concrete pieces of evidence and a source.',
  '- supporting_evidence / contradicting_evidence: short quotes or facts taken from the rules; empty arrays when there are none.',
  '- sources: where each piece of evidence comes from ("resolution rules" or a named source quoted in them); empty when there is no evidence.',
  '- data_freshness: "recent" only if the rules carry a dated fact from the last 7 days before the current date; otherwise "stale" or "unknown".',
  '- recommendation: INSUFFICIENT_EVIDENCE by default; REVIEW only with evidence; AVOID when the rules are ambiguous, contradictory, or depend on a source that may not exist.',
  '- resolution_risks: only risks actually present in THESE rules, each quoting the clause that creates it (for example a 50-50 or cancellation clause, an undefined term, a timezone, a third-party source, an early-resolution condition). Empty array if none.',
  'You cannot place orders, change limits, access secrets or quotas. Do not give trading instructions.',
].join('\n');

export function buildMessages(input: AnalysisInput): ChatMessage[] {
  const user = [
    `Current date (UTC): ${input.now.toISOString().slice(0, 10)}`,
    `Market id: ${input.marketId}`,
    `Category: ${input.category}`,
    `Question: ${truncate(input.question, 300)}`,
    `Resolution rules (verbatim, truncated): ${truncate(input.description.replace(/\s+/g, ' '), 1500)}`,
    `Scheduled end: ${input.endDate}`,
    `Current YES price (context only, NOT evidence): ${input.yesPrice === null ? 'unknown' : input.yesPrice.toFixed(3)}`,
    `Liquidity (USDC): ${Math.round(input.liquidity)}`,
    'Return the JSON object now.',
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Rough token estimate when the model returns no usage (4 characters per token). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
