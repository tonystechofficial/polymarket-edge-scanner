import {
  HARD_CAPS,
  parseStringArray,
  toNumber,
  type BookLevel,
  type ClobBook,
  type FeeSchedule,
  type GammaMarket,
  type OrderBook,
  type PriceObservation,
  type Side,
  type TrackedMarket,
} from '@pes/shared';

/** Conservative fee assumption when Gamma publishes no schedule: the highest documented category rate (crypto). */
export const ASSUMED_MAX_FEE_RATE = 0.07;

/** Tag slugs mapped to the fee/category families documented by Polymarket. Order matters: first match wins. */
const CATEGORY_BY_TAG: Array<[string, string[]]> = [
  ['geopolitics', ['geopolitics', 'world', 'military', 'ukraine', 'israel', 'iran', 'middle-east']],
  ['politics', ['politics', 'elections', 'us-politics', 'trump', 'congress', 'global-elections', 'main-election']],
  ['crypto', ['crypto', 'bitcoin', 'ethereum', 'crypto-prices', 'solana', 'memecoins']],
  ['sports', ['sports', 'nba', 'nfl', 'soccer', 'mlb', 'nhl', 'tennis', 'esports', 'games', 'football', 'ufc']],
  ['finance', ['finance', 'stocks', 'business', 'markets', 'earnings', 'ipo']],
  ['economics', ['economics', 'fed', 'fomc', 'fed-rates', 'economy', 'macro-indicators', 'us-cpi', 'inflation']],
  ['tech', ['tech', 'ai', 'technology', 'science', 'openai', 'space']],
  ['culture', ['culture', 'pop-culture', 'entertainment', 'movies', 'music', 'awards', 'celebrities']],
  ['weather', ['weather', 'climate', 'temperature', 'hurricane']],
  ['mentions', ['mentions', 'mention-markets']],
];

export function categoryFromTags(tags: string[]): string {
  const set = new Set(tags.map((t) => t.toLowerCase()));
  for (const [category, slugs] of CATEGORY_BY_TAG) {
    if (slugs.some((s) => set.has(s))) return category;
  }
  return 'other';
}

export type NormalizedMarket = { ok: true; market: TrackedMarket } | { ok: false; id: string; reason: string };

export interface NormalizeOptions {
  now?: Date;
  /** Minimum description length to consider the resolution rules documented. */
  minDescriptionChars?: number;
  eventTags?: string[];
  eventId?: string | null;
  eventNegRisk?: boolean | null;
}

/**
 * Turn a raw Gamma market into a tracked market, or explain why it is ignored.
 * Every rejection reason is a stable token so it can be counted and shown.
 */
export function normalizeMarket(raw: GammaMarket, options: NormalizeOptions = {}): NormalizedMarket {
  const now = options.now ?? new Date();
  const id = String(raw.id);
  const reject = (reason: string): NormalizedMarket => ({ ok: false, id, reason });

  if (raw.closed === true || raw.archived === true) return reject('closed_or_archived');
  if (raw.active === false) return reject('inactive');
  if (raw.enableOrderBook === false) return reject('no_order_book');
  if (raw.acceptingOrders === false) return reject('not_accepting_orders');
  if (!raw.conditionId) return reject('missing_condition_id');
  if (!raw.question || raw.question.trim().length < 8) return reject('missing_question');

  const description = (raw.description ?? '').trim();
  if (description.length < (options.minDescriptionChars ?? 40)) return reject('undocumented_resolution');

  const outcomes = parseStringArray(raw.outcomes);
  const tokenIds = parseStringArray(raw.clobTokenIds);
  if (!outcomes || outcomes.length !== 2) return reject('not_binary');
  if (!tokenIds || tokenIds.length !== 2 || tokenIds.some((t) => !/^\d{10,}$/.test(t))) return reject('missing_token_ids');

  const endMs = raw.endDate ? Date.parse(raw.endDate) : NaN;
  if (!Number.isFinite(endMs)) return reject('missing_end_date');
  if (endMs <= now.getTime()) return reject('past_end_date');

  const liquidity = raw.liquidityNum ?? toNumber(raw.liquidity) ?? 0;
  const volume24h = raw.volume24hr ?? 0;

  const ownTags = (raw.tags ?? []).map((t) => t.slug ?? t.label ?? '').filter(Boolean);
  const nestedEventTags = (raw.events ?? []).flatMap((e) => (e.tags ?? []).map((t) => t.slug ?? t.label ?? '')).filter(Boolean);
  const tags = Array.from(new Set([...ownTags, ...nestedEventTags, ...(options.eventTags ?? [])]));

  const fee: FeeSchedule = raw.feeSchedule
    ? { rate: raw.feeSchedule.rate, exponent: raw.feeSchedule.exponent ?? 1, takerOnly: raw.feeSchedule.takerOnly ?? true, source: 'gamma_fee_schedule' }
    : { rate: ASSUMED_MAX_FEE_RATE, exponent: 1, takerOnly: true, source: 'assumed_max' };

  const eventId = options.eventId ?? raw.events?.[0]?.id ?? null;
  const negRisk = raw.negRisk ?? options.eventNegRisk ?? raw.events?.[0]?.negRisk ?? false;

  return {
    ok: true,
    market: {
      id,
      conditionId: raw.conditionId,
      slug: raw.slug ?? id,
      question: raw.question.trim(),
      description,
      category: categoryFromTags(tags),
      tags,
      endDate: new Date(endMs).toISOString(),
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      outcomes: [outcomes[0]!, outcomes[1]!],
      fee,
      negRisk: Boolean(negRisk),
      eventId,
      liquidity,
      volume24h,
      minOrderSize: raw.orderMinSize ?? 5,
      tickSize: raw.orderPriceMinTickSize ?? 0.01,
      status: 'tracked',
    },
  };
}

/** Coerces defensively: the schema already converts strings, but a caller may pass raw CLOB levels. */
function toLevels(levels: ReadonlyArray<{ price: unknown; size: unknown }>, order: 'asc' | 'desc'): BookLevel[] {
  const clean: BookLevel[] = [];
  for (const l of levels) {
    const price = toNumber(l.price);
    const size = toNumber(l.size);
    if (price === undefined || size === undefined || price <= 0 || price >= 1 || size <= 0) continue;
    clean.push({ price, size });
  }
  clean.sort((a, b) => (order === 'asc' ? a.price - b.price : b.price - a.price));
  return clean;
}

type RawBookLike = Pick<ClobBook, 'asset_id'> & { bids?: ReadonlyArray<{ price: unknown; size: unknown }>; asks?: ReadonlyArray<{ price: unknown; size: unknown }>; timestamp?: unknown; hash?: string; tick_size?: unknown; min_order_size?: unknown };

/** CLOB books list levels worst-first; we store them best-first and drop malformed levels. */
export function normalizeBook(raw: ClobBook | RawBookLike): OrderBook {
  return {
    tokenId: raw.asset_id,
    bids: toLevels(raw.bids ?? [], 'desc'),
    asks: toLevels(raw.asks ?? [], 'asc'),
    timestampMs: toNumber(raw.timestamp) ?? 0,
    hash: raw.hash ?? '',
    tickSize: toNumber(raw.tick_size) ?? 0.01,
    minOrderSize: toNumber(raw.min_order_size) ?? 5,
  };
}

export function depthUsdc(levels: BookLevel[], maxLevels = HARD_CAPS.maxBookLevelsStored): number {
  return levels.slice(0, maxLevels).reduce((sum, l) => sum + l.price * l.size, 0);
}

export function observationFromBook(marketId: string, side: Side, book: OrderBook, now: Date = new Date()): PriceObservation {
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return {
    marketId,
    tokenId: book.tokenId,
    side,
    observedAt: now.toISOString(),
    bestBid,
    bestAsk,
    mid,
    spread,
    bidDepthUsdc: depthUsdc(book.bids),
    askDepthUsdc: depthUsdc(book.asks),
    bookTimestampMs: book.timestampMs,
    bookHash: book.hash,
    ageSeconds: book.timestampMs > 0 ? Math.max(0, (now.getTime() - book.timestampMs) / 1000) : Number.POSITIVE_INFINITY,
  };
}

export interface BookValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Freshness and coherence checks on a YES/NO book pair.
 * The NO book mirrors the YES book: 1 - bestAsk(NO) should sit within a few ticks of bestBid(YES).
 */
export function validateBookPair(yes: OrderBook, no: OrderBook, options: { now?: Date; maxAgeSeconds?: number; tickTolerance?: number } = {}): BookValidation {
  const now = options.now ?? new Date();
  const maxAge = options.maxAgeSeconds ?? 900;
  const tol = (options.tickTolerance ?? 2) * Math.max(yes.tickSize, 0.01);
  const problems: string[] = [];

  if (yes.asks.length === 0 && yes.bids.length === 0) problems.push('empty_yes_book');
  if (no.asks.length === 0 && no.bids.length === 0) problems.push('empty_no_book');
  for (const [label, book] of [['yes', yes], ['no', no]] as const) {
    if (book.timestampMs <= 0) problems.push(`${label}_missing_timestamp`);
    else if ((now.getTime() - book.timestampMs) / 1000 > maxAge) problems.push(`${label}_stale_book`);
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid !== undefined && ask !== undefined && bid >= ask) problems.push(`${label}_crossed_book`);
  }
  const yesBid = yes.bids[0]?.price;
  const noAsk = no.asks[0]?.price;
  if (yesBid !== undefined && noAsk !== undefined && Math.abs(1 - noAsk - yesBid) > tol) problems.push('incoherent_pair');
  const yesAsk = yes.asks[0]?.price;
  const noBid = no.bids[0]?.price;
  if (yesAsk !== undefined && noBid !== undefined && Math.abs(1 - noBid - yesAsk) > tol) problems.push('incoherent_pair');

  return { ok: problems.length === 0, problems: Array.from(new Set(problems)) };
}
