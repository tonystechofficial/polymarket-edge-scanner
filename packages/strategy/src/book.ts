import type { BookLevel } from '@pes/shared';

export interface FillResult {
  filledShares: number;
  /** Volume-weighted price of the filled part, null when nothing filled. */
  vwap: number | null;
  worstPrice: number | null;
  notional: number;
  levelsUsed: number;
  /** The slice of levels actually consumed, with the consumed size per level. */
  fills: BookLevel[];
  partial: boolean;
}

/**
 * Walk a side of the book (levels sorted best-first) for `shares`.
 * This is the executable price. The displayed price is only the first level.
 */
export function walkBook(levels: BookLevel[], shares: number): FillResult {
  let remaining = Math.max(0, shares);
  let notional = 0;
  let filled = 0;
  let worst: number | null = null;
  const fills: BookLevel[] = [];
  for (const level of levels) {
    if (remaining <= 1e-9) break;
    const take = Math.min(level.size, remaining);
    if (take <= 0) continue;
    fills.push({ price: level.price, size: take });
    notional += take * level.price;
    filled += take;
    remaining -= take;
    worst = level.price;
  }
  return {
    filledShares: filled,
    vwap: filled > 0 ? notional / filled : null,
    worstPrice: worst,
    notional,
    levelsUsed: fills.length,
    fills,
    partial: remaining > 1e-9,
  };
}

/** VWAP for a full fill, or null when the book cannot absorb the whole size. */
export function executablePrice(levels: BookLevel[], shares: number): number | null {
  const fill = walkBook(levels, shares);
  return fill.partial || fill.vwap === null ? null : fill.vwap;
}

export function totalDepthShares(levels: BookLevel[]): number {
  return levels.reduce((s, l) => s + l.size, 0);
}
