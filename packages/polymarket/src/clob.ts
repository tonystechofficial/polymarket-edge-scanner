import { z } from 'zod';
import { clobBooksResponseSchema, type OrderBook } from '@pes/shared';
import { fetchJson, type HttpOptions } from './http.ts';
import { normalizeBook } from './normalize.ts';

export const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';

const pricesHistorySchema = z.object({ history: z.array(z.object({ t: z.number(), p: z.number() })) });

export class ClobClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_CLOB_BASE_URL,
    private readonly http: HttpOptions = {},
  ) {}

  /**
   * Order books for several tokens in ONE request (`POST /books`), which is how the scanner
   * prices a whole batch with a single subrequest. Books missing from the answer are reported.
   */
  async getBooks(tokenIds: string[]): Promise<{ books: Map<string, OrderBook>; missing: string[] }> {
    const unique = Array.from(new Set(tokenIds)).slice(0, 100);
    if (unique.length === 0) return { books: new Map(), missing: [] };
    const raw = await fetchJson(`${this.baseUrl}/books`, clobBooksResponseSchema, this.http, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(unique.map((token_id) => ({ token_id }))),
    });
    const books = new Map<string, OrderBook>();
    for (const book of raw) books.set(book.asset_id, normalizeBook(book));
    return { books, missing: unique.filter((id) => !books.has(id)) };
  }

  async getPricesHistory(tokenId: string, interval: '1h' | '6h' | '1d' | '1w' | '1m' | 'max' = '1d', fidelity = 60): Promise<Array<{ t: number; p: number }>> {
    const url = `${this.baseUrl}/prices-history?market=${encodeURIComponent(tokenId)}&interval=${interval}&fidelity=${fidelity}`;
    const body = await fetchJson(url, pricesHistorySchema, this.http);
    return body.history;
  }
}
