import type { ParamUpdate, StrategyParamSpec } from '@pes/shared';

/**
 * Every tunable of the strategy, with the range an operator may set through the admin API.
 * Anything outside this table (live trading, wallet, bypasses) does not exist as a parameter.
 */
export const DEFAULT_PARAMS = {
  safety_margin: { key: 'safety_margin', value: 0.02, min: 0, max: 0.2, description: 'USDC per share subtracted from the edge before a signal is accepted.' },
  min_net_edge: { key: 'min_net_edge', value: 0.03, min: 0.005, max: 0.3, description: 'Minimum net edge per share, computed on the lower confidence bound of the estimate.' },
  min_calibration_samples: { key: 'min_calibration_samples', value: 30, min: 10, max: 500, description: 'Resolved markets required in a price/horizon bin before the estimator speaks.' },
  max_spread: { key: 'max_spread', value: 0.05, min: 0.01, max: 0.3, description: 'Maximum bid-ask spread of the traded side.' },
  min_liquidity_usdc: { key: 'min_liquidity_usdc', value: 5_000, min: 0, max: 1_000_000, description: 'Minimum Gamma liquidity of a market to be evaluated.' },
  max_book_age_seconds: { key: 'max_book_age_seconds', value: 900, min: 30, max: 86_400, description: 'A book snapshot older than this is stale.' },
  bankroll_usdc: { key: 'bankroll_usdc', value: 1_000, min: 10, max: 1_000_000, description: 'Virtual bankroll of the simulation.' },
  kelly_fraction: { key: 'kelly_fraction', value: 0.25, min: 0, max: 1, description: 'Fraction of the Kelly stake actually used.' },
  max_position_usdc: { key: 'max_position_usdc', value: 25, min: 1, max: 100_000, description: 'Maximum notional of one simulated position.' },
  max_exposure_pct: { key: 'max_exposure_pct', value: 0.2, min: 0.01, max: 1, description: 'Maximum open exposure as a fraction of the bankroll.' },
  max_open_positions: { key: 'max_open_positions', value: 10, min: 1, max: 200, description: 'Maximum simultaneous open simulated positions.' },
  max_daily_new_positions: { key: 'max_daily_new_positions', value: 5, min: 0, max: 100, description: 'Maximum new simulated positions per UTC day.' },
  arb_min_sets: { key: 'arb_min_sets', value: 10, min: 1, max: 1_000, description: 'Minimum complete sets for a Dutch book to count.' },
  arb_max_sets: { key: 'arb_max_sets', value: 100, min: 1, max: 10_000, description: 'Maximum complete sets simulated for a Dutch book.' },
  min_days_to_end: { key: 'min_days_to_end', value: 0.02, min: 0, max: 365, description: 'Skip markets ending sooner than this (days).' },
  max_days_to_end: { key: 'max_days_to_end', value: 90, min: 1, max: 3_650, description: 'Skip markets ending later than this (days).' },
  discovery_liquidity_min: { key: 'discovery_liquidity_min', value: 10_000, min: 0, max: 10_000_000, description: 'Gamma liquidity filter used when discovering markets.' },
  discovery_volume_min: { key: 'discovery_volume_min', value: 5_000, min: 0, max: 10_000_000, description: 'Gamma volume filter used when discovering markets.' },
} as const satisfies Record<string, StrategyParamSpec>;

export type ParamKey = keyof typeof DEFAULT_PARAMS;
export type StrategyParams = { [K in ParamKey]: number };

export const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as ParamKey[];

export function defaultParams(): StrategyParams {
  const out = {} as StrategyParams;
  for (const key of PARAM_KEYS) out[key] = DEFAULT_PARAMS[key].value;
  return out;
}

/** Build params from stored rows; corrupt or out-of-range values fall back to the default. */
export function paramsFromRecords(rows: ReadonlyArray<{ key: string; value: string | number }>): StrategyParams {
  const params = defaultParams();
  for (const row of rows) {
    if (!(row.key in DEFAULT_PARAMS)) continue;
    const key = row.key as ParamKey;
    const value = typeof row.value === 'number' ? row.value : Number(row.value);
    const spec = DEFAULT_PARAMS[key];
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[key] = value;
  }
  return params;
}

export type ParamUpdateResult = { ok: true; params: StrategyParams; spec: StrategyParamSpec } | { ok: false; error: string };

export function applyParamUpdate(current: StrategyParams, update: ParamUpdate): ParamUpdateResult {
  if (!(update.key in DEFAULT_PARAMS)) return { ok: false, error: `unknown parameter: ${update.key}` };
  const key = update.key as ParamKey;
  const spec = DEFAULT_PARAMS[key];
  if (!Number.isFinite(update.value) || update.value < spec.min || update.value > spec.max) {
    return { ok: false, error: `${key} must be between ${spec.min} and ${spec.max}` };
  }
  return { ok: true, params: { ...current, [key]: update.value }, spec };
}

export function describeParams(params: StrategyParams): StrategyParamSpec[] {
  return PARAM_KEYS.map((key) => ({ ...DEFAULT_PARAMS[key], value: params[key] }));
}
