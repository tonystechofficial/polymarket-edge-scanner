import { z } from 'zod';

/**
 * Zod schemas for every external payload that crosses a trust boundary:
 * Polymarket responses, Workers AI output, admin input. Unknown keys are tolerated
 * on Polymarket objects (the API adds fields often) and rejected on admin input.
 */

const numericString = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
});

export const gammaFeeScheduleSchema = z
  .object({
    rate: z.number().min(0).max(1),
    exponent: z.number().min(0).max(4).default(1),
    takerOnly: z.boolean().default(true),
    rebateRate: z.number().optional(),
  })
  .loose();

export const gammaTagSchema = z.object({ slug: z.string().optional(), label: z.string().optional() }).loose();

/** A market as returned by Gamma `/markets` (also nested in `/events`). */
export const gammaMarketSchema = z
  .object({
    id: z.string(),
    conditionId: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    question: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    outcomes: z.unknown().optional(),
    outcomePrices: z.unknown().optional(),
    clobTokenIds: z.unknown().optional(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    archived: z.boolean().optional(),
    enableOrderBook: z.boolean().optional(),
    acceptingOrders: z.boolean().optional(),
    liquidityNum: z.number().optional().nullable(),
    liquidity: numericString.optional().nullable(),
    volume24hr: z.number().optional().nullable(),
    orderMinSize: z.number().optional().nullable(),
    orderPriceMinTickSize: z.number().optional().nullable(),
    negRisk: z.boolean().optional().nullable(),
    feeSchedule: gammaFeeScheduleSchema.optional().nullable(),
    feesEnabled: z.boolean().optional().nullable(),
    umaResolutionStatus: z.string().optional().nullable(),
    tags: z.array(gammaTagSchema).optional().nullable(),
    events: z
      .array(z.object({ id: z.string().optional(), tags: z.array(gammaTagSchema).optional().nullable(), negRisk: z.boolean().optional().nullable() }).loose())
      .optional()
      .nullable(),
  })
  .loose();
export type GammaMarket = z.infer<typeof gammaMarketSchema>;

export const gammaEventSchema = z
  .object({
    id: z.string(),
    title: z.string().optional().nullable(),
    slug: z.string().optional().nullable(),
    endDate: z.string().optional().nullable(),
    negRisk: z.boolean().optional().nullable(),
    tags: z.array(gammaTagSchema).optional().nullable(),
    markets: z.array(gammaMarketSchema).default([]),
  })
  .loose();
export type GammaEvent = z.infer<typeof gammaEventSchema>;

export const clobLevelSchema = z.object({ price: numericString, size: numericString }).loose();

/** One book as returned by CLOB `GET /book` and `POST /books`. */
export const clobBookSchema = z
  .object({
    market: z.string().optional(),
    asset_id: z.string(),
    timestamp: numericString.optional(),
    hash: z.string().optional(),
    bids: z.array(clobLevelSchema).default([]),
    asks: z.array(clobLevelSchema).default([]),
    tick_size: numericString.optional(),
    min_order_size: numericString.optional(),
    neg_risk: z.boolean().optional(),
  })
  .loose();
export type ClobBook = z.infer<typeof clobBookSchema>;

export const clobBooksResponseSchema = z.array(clobBookSchema);

export const geoblockResponseSchema = z
  .object({
    blocked: z.boolean(),
    country: z.string().optional().nullable(),
    region: z.string().optional().nullable(),
    ip: z.string().optional().nullable(),
  })
  .loose();

/** The structured output the AI must produce. Validated with zod, never trusted raw. */
export const aiAnalysisSchema = z.object({
  summary: z.string().min(1).max(1200),
  probability_estimate: z.number().min(0).max(1).nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  supporting_evidence: z.array(z.string().max(400)).max(10).default([]),
  contradicting_evidence: z.array(z.string().max(400)).max(10).default([]),
  sources: z.array(z.string().max(300)).max(10).default([]),
  data_freshness: z.enum(['unknown', 'stale', 'recent']).default('unknown'),
  recommendation: z.enum(['INSUFFICIENT_EVIDENCE', 'REVIEW', 'AVOID']),
  resolution_risks: z.array(z.string().max(400)).max(10).default([]),
});
export type AiAnalysisParsed = z.infer<typeof aiAnalysisSchema>;

/** JSON Schema handed to Workers AI `response_format`. Kept in sync with `aiAnalysisSchema`. */
export const aiAnalysisJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    probability_estimate: { type: ['number', 'null'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    supporting_evidence: { type: 'array', items: { type: 'string' } },
    contradicting_evidence: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
    data_freshness: { type: 'string', enum: ['unknown', 'stale', 'recent'] },
    recommendation: { type: 'string', enum: ['INSUFFICIENT_EVIDENCE', 'REVIEW', 'AVOID'] },
    resolution_risks: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'summary',
    'probability_estimate',
    'confidence',
    'supporting_evidence',
    'contradicting_evidence',
    'sources',
    'data_freshness',
    'recommendation',
    'resolution_risks',
  ],
} as const;

/** Admin input for a strategy parameter update: strict, one key at a time. */
export const paramUpdateSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
    value: z.number().finite(),
  })
  .strict();
export type ParamUpdate = z.infer<typeof paramUpdateSchema>;
