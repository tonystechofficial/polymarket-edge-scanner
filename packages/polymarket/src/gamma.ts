import { z } from 'zod';
import { gammaEventSchema, gammaMarketSchema, type GammaEvent, type GammaMarket } from '@pes/shared';
import { buildQuery, fetchJson, type HttpOptions } from './http.ts';

export const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

export interface MarketFilters {
  limit: number;
  offset?: number;
  /** Gamma sort field, e.g. `volume24hr` or `liquidity`. */
  order?: string;
  ascending?: boolean;
  liquidityMin?: number;
  volumeMin?: number;
  endDateMin?: string;
  endDateMax?: string;
  tagId?: number;
}

export interface EventFilters extends MarketFilters {
  tagSlug?: string;
}

/** Validates each element on its own so one malformed object never drops a whole page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseEach<S extends z.ZodType<any, any>>(schema: S, items: unknown): { items: z.output<S>[]; rejected: number } {
  if (!Array.isArray(items)) return { items: [], rejected: 0 };
  const out: z.output<S>[] = [];
  let rejected = 0;
  for (const item of items) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else rejected += 1;
  }
  return { items: out, rejected };
}

export class GammaClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_GAMMA_BASE_URL,
    private readonly http: HttpOptions = {},
  ) {}

  /** Open markets. Gamma caps nothing by itself, so `limit` is clamped here to keep CPU bounded. */
  async listMarkets(filters: MarketFilters): Promise<{ markets: GammaMarket[]; rejected: number }> {
    const query = buildQuery({
      active: true,
      closed: false,
      archived: false,
      include_tag: true,
      limit: Math.min(Math.max(1, filters.limit), 50),
      offset: filters.offset,
      order: filters.order ?? 'volume24hr',
      ascending: filters.ascending ?? false,
      liquidity_num_min: filters.liquidityMin,
      volume_num_min: filters.volumeMin,
      end_date_min: filters.endDateMin,
      end_date_max: filters.endDateMax,
      tag_id: filters.tagId,
    });
    const body = await fetchJson(`${this.baseUrl}/markets${query}`, z.array(z.unknown()), this.http);
    const { items, rejected } = parseEach(gammaMarketSchema, body);
    return { markets: items, rejected };
  }

  /** Open events with their nested markets and tags (one request gives the category). */
  async listEvents(filters: EventFilters): Promise<{ events: GammaEvent[]; rejected: number }> {
    const query = buildQuery({
      active: true,
      closed: false,
      archived: false,
      limit: Math.min(Math.max(1, filters.limit), 25),
      offset: filters.offset,
      order: filters.order ?? 'volume24hr',
      ascending: filters.ascending ?? false,
      liquidity_min: filters.liquidityMin,
      volume_min: filters.volumeMin,
      end_date_min: filters.endDateMin,
      end_date_max: filters.endDateMax,
      tag_slug: filters.tagSlug,
    });
    const body = await fetchJson(`${this.baseUrl}/events${query}`, z.array(z.unknown()), this.http);
    const { items, rejected } = parseEach(gammaEventSchema, body);
    return { events: items, rejected };
  }

  /** Markets by id, open or closed. Used to detect resolutions. At most 100 ids per call (documented cap). */
  async getMarketsByIds(ids: string[]): Promise<GammaMarket[]> {
    if (ids.length === 0) return [];
    const query = buildQuery({ id: ids.slice(0, 100), closed: 'any' });
    const body = await fetchJson(`${this.baseUrl}/markets${query}`, z.array(z.unknown()), this.http);
    return parseEach(gammaMarketSchema, body).items;
  }
}
