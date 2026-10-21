import type { BookLevel, FeeSchedule, SimulatedFill } from '@pes/shared';
import { walkBook } from './book.ts';
import { takerFeeForFill } from './fees.ts';

/**
 * Paper execution of a buy against a book snapshot. Nothing here talks to an exchange.
 * Assumptions are written down with the fill so a reader can judge the result later.
 */
export function simulateBuy(input: { asks: BookLevel[]; shares: number; fee: FeeSchedule; bookAgeSeconds: number }): SimulatedFill {
  const fill = walkBook(input.asks, input.shares);
  const bestAsk = input.asks[0]?.price ?? null;
  const feePaid = takerFeeForFill(fill.fills, input.fee);
  const slippage = bestAsk === null ? 0 : Math.max(0, fill.notional - fill.filledShares * bestAsk);
  const assumptions = [
    `Fill simulated against the order-book snapshot (age ${Math.round(input.bookAgeSeconds)}s); real fills may differ.`,
    `Taker fee rate ${input.fee.rate} (${input.fee.source}) applied level by level with the official formula rate*p*(1-p).`,
    'Immediate execution assumed: no latency, queue position, partial cancellation or adverse selection modelled.',
    'No gas, no bridging, no funding cost: USDC on Polygon assumed already in place.',
    'Simulation only: no order was created, signed or sent.',
  ];
  if (fill.partial) assumptions.push(`Book depth covered only ${fill.filledShares} of ${input.shares} requested shares.`);
  return {
    requestedShares: input.shares,
    filledShares: fill.filledShares,
    vwapPrice: fill.vwap,
    worstPrice: fill.worstPrice,
    notionalUsdc: fill.notional,
    feePaidUsdc: feePaid,
    slippageUsdc: slippage,
    partial: fill.partial,
    assumptions,
  };
}

/** Settlement of a simulated buy: a winning share redeems for 1 USDC, a losing one for 0. */
export function settleFill(fill: SimulatedFill, won: boolean): { payoutUsdc: number; pnlUsdc: number } {
  const payout = won ? fill.filledShares : 0;
  return { payoutUsdc: payout, pnlUsdc: payout - fill.notionalUsdc - fill.feePaidUsdc };
}
