import type { StrategyParams } from './params.ts';

export interface RiskState {
  openExposureUsdc: number;
  openPositions: number;
  newPositionsToday: number;
}

/** Kelly fraction for a binary contract bought at `price` that pays 1: (p - price) / (1 - price). */
export function kellyFraction(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return Math.max(0, (p - price) / (1 - price));
}

export interface PositionSize {
  shares: number;
  notionalUsdc: number;
  reasons: string[];
}

/** Fractional Kelly, capped by the per-position maximum and by the remaining exposure allowance. */
export function positionSize(input: { p: number; price: number; params: StrategyParams; state: RiskState; minOrderSize?: number }): PositionSize {
  const { p, price, params, state } = input;
  const reasons: string[] = [];
  const f = kellyFraction(p, price);
  if (f <= 0) return { shares: 0, notionalUsdc: 0, reasons: ['no_edge'] };
  let notional = f * params.kelly_fraction * params.bankroll_usdc;
  if (notional > params.max_position_usdc) {
    notional = params.max_position_usdc;
    reasons.push('capped_max_position');
  }
  const exposureRoom = params.bankroll_usdc * params.max_exposure_pct - state.openExposureUsdc;
  if (notional > exposureRoom) {
    notional = Math.max(0, exposureRoom);
    reasons.push('capped_exposure');
  }
  const shares = Math.floor(notional / price);
  const minOrder = input.minOrderSize ?? 5;
  if (shares < minOrder) return { shares: 0, notionalUsdc: 0, reasons: [...reasons, 'below_min_order_size'] };
  return { shares, notionalUsdc: shares * price, reasons };
}

export function checkRiskLimits(params: StrategyParams, state: RiskState, proposedNotionalUsdc: number): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (state.openExposureUsdc + proposedNotionalUsdc > params.bankroll_usdc * params.max_exposure_pct + 1e-9) reasons.push('max_exposure');
  if (state.openPositions >= params.max_open_positions) reasons.push('max_open_positions');
  if (state.newPositionsToday >= params.max_daily_new_positions) reasons.push('max_daily_new_positions');
  return { ok: reasons.length === 0, reasons };
}
