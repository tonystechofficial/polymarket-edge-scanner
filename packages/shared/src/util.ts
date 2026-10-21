export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Parse JSON without throwing. Returns `undefined` when the text is not valid JSON. */
export function safeJsonParse<T = unknown>(text: string | null | undefined): T | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Gamma returns arrays encoded as JSON strings. Accept both the encoded and the plain form. */
export function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = safeJsonParse<unknown>(value);
  return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? (parsed as string[]) : undefined;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** UTC day key (YYYY-MM-DD), the unit of every daily quota in this project. */
export function dayKey(date: Date | number | string = new Date()): string {
  const d = typeof date === 'object' ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string | Date, to: string | Date): number {
  const a = typeof from === 'string' ? Date.parse(from) : from.getTime();
  const b = typeof to === 'string' ? Date.parse(to) : to.getTime();
  return (b - a) / 86_400_000;
}

export function round(value: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Deterministic, dependency-free 32-bit FNV-1a hash rendered as 8 hex chars. Not cryptographic. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
