import type { z, ZodType } from 'zod';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  /** Per-attempt timeout. Workers give 50 subrequests per invocation; a hung one must not eat the run. */
  timeoutMs?: number;
  /** Extra attempts after the first one. Bounded on purpose: never loop on a rate limit. */
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  /** Called once per attempt. The scanner uses it to enforce its subrequest budget. */
  budget?: SubrequestBudget;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
    public readonly retryable: boolean,
    public readonly kind: 'http' | 'timeout' | 'network' | 'invalid_json' | 'schema' | 'budget',
  ) {
    super(message);
    this.name = 'HttpError';
  }
  /** Parsed `Retry-After` of a 429/503, capped by the caller. */
  retryAfterMs?: number;
}

/** Counts outbound requests of one invocation and refuses to exceed the allowance. */
export class SubrequestBudget {
  private used = 0;
  constructor(public readonly limit: number) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
  get consumed(): number {
    return this.used;
  }
  take(url: string): void {
    if (this.used >= this.limit) {
      throw new HttpError(`Subrequest budget of ${this.limit} exhausted`, null, url, false, 'budget');
    }
    this.used += 1;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function retryAfterMs(res: Response, cap: number): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(cap, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(cap, Math.max(0, date - Date.now())) : undefined;
}

/**
 * Fetch a JSON document and validate it with a zod schema.
 * Retries only retryable failures (timeouts, network errors, 429, 5xx) with exponential backoff.
 * A schema failure is not retried: the payload will not change between attempts.
 */
// Constraint note: a bare `ZodType<T>` parameter makes tsc infer against zod 4 internals and
// exhausts memory; a schema-generic constraint keeps type-checking under a second.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchJson<S extends ZodType<any, any>>(url: string, schema: S, options: HttpOptions = {}, init: RequestInit = {}): Promise<z.output<S>> {
  const fetchImpl: FetchLike = options.fetch ?? ((input, i) => fetch(input, i));
  const timeoutMs = options.timeoutMs ?? 8_000;
  const retries = Math.max(0, Math.min(options.retries ?? 2, 4));
  const backoffMs = options.backoffMs ?? 300;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: HttpError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1));
      await sleep(lastError?.kind === 'http' && lastError.status === 429 ? Math.max(wait, lastError.retryAfterMs ?? 0) : wait);
    }
    options.budget?.take(url);

    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': options.userAgent ?? 'polymarket-edge-scanner/0.1 (read-only research; +https://github.com/tonystechofficial/polymarket-edge-scanner)',
            ...(init.headers as Record<string, string> | undefined),
          },
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      lastError = new HttpError(aborted ? `Timeout after ${timeoutMs}ms` : `Network error: ${(err as Error).message}`, null, url, true, aborted ? 'timeout' : 'network');
      continue;
    }

    if (!res.ok) {
      const retryable = isRetryableStatus(res.status);
      lastError = new HttpError(`HTTP ${res.status} for ${url}`, res.status, url, retryable, 'http');
      lastError.retryAfterMs = retryAfterMs(res, maxBackoffMs);
      if (!retryable) throw lastError;
      continue;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new HttpError(`Invalid JSON from ${url}`, res.status, url, false, 'invalid_json');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(`Unexpected payload from ${url}: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`, res.status, url, false, 'schema');
    }
    return parsed.data as z.output<S>;
  }
  throw lastError ?? new HttpError(`Request failed: ${url}`, null, url, false, 'network');
}

export function buildQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
