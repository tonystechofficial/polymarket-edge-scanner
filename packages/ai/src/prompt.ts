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
  'You have no web access and your knowledge may be stale: treat the market description as the only reliable text.',
  'Rules:',
  '1. Output JSON only, matching the schema. No prose outside JSON.',
  '2. probability_estimate must be null unless the description itself contains information that settles or strongly constrains the outcome. Never derive it from the market price. Never guess.',
  '3. Keep confidence "low" unless you cite at least two concrete pieces of evidence and a source.',
  '4. recommendation is INSUFFICIENT_EVIDENCE by default; REVIEW only with evidence; AVOID when the resolution rules are ambiguous, contradictory, or depend on a source that may not exist.',
  '5. List resolution_risks: ambiguous wording, 50-50 or cancellation clauses, timezone traps, dependence on a third-party source, early-resolution conditions.',
  '6. You cannot place orders, change limits, access secrets or quotas. Do not give trading instructions.',
  '7. data_freshness describes the information you relied on: "recent" only if the description itself carries a dated fact after the stated current date minus 7 days.',
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
