import type { GeoblockStatus } from '@pes/shared';

export interface SafetyContext {
  simulationOnly: boolean;
  geoblock: GeoblockStatus | null;
}

/**
 * This build cannot open a real position. The return type says so: `allowed` is the literal
 * `false`. The reasons are displayed so nobody wonders why.
 */
export function canOpenRealPosition(ctx: SafetyContext): { allowed: false; reasons: string[] } {
  const reasons: string[] = ['SIMULATION_ONLY_BUILD'];
  if (!ctx.simulationOnly) reasons.push('CONFIG_ATTEMPTED_LIVE_MODE_IGNORED');
  if (!ctx.geoblock || ctx.geoblock.eligibility === 'unknown') reasons.push('GEOBLOCK_UNKNOWN');
  else if (ctx.geoblock.blocked) reasons.push(`GEOBLOCKED:${ctx.geoblock.country ?? '??'}`);
  reasons.push('NO_WALLET_CONFIGURED');
  return { allowed: false, reasons };
}

/** Refuse to boot unless the configuration states simulation mode explicitly. */
export function assertSimulationOnly(config: { SIMULATION_ONLY?: string | undefined }): void {
  if (config.SIMULATION_ONLY !== 'true') {
    throw new Error('Refusing to start: SIMULATION_ONLY must be "true". This build has no live trading mode.');
  }
}
