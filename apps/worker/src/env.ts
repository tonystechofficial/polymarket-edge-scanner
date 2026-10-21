import { HARD_CAPS, clamp } from '@pes/shared';

export type WorkerEnv = Env;

export interface ScannerConfig {
  simulationOnly: boolean;
  cronSchedule: string;
  aiEnabled: boolean;
  aiModel: string;
  aiMaxCallsPerRun: number;
  aiMaxCallsPerDay: number;
  aiMaxNeuronsPerDay: number;
  maxMarketsPerRun: number;
  maxTrackedMarkets: number;
  discoveryEveryNRuns: number;
  retentionDays: number;
  gammaBaseUrl: string;
  clobBaseUrl: string;
  geoblockUrl: string;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

/** Variables come in as strings; every number is clamped by the hard caps whatever the deploy says. */
export function parseConfig(env: Partial<WorkerEnv>): ScannerConfig {
  return {
    simulationOnly: env.SIMULATION_ONLY === 'true',
    cronSchedule: env.CRON_SCHEDULE ?? '*/15 * * * *',
    aiEnabled: env.AI_ENABLED !== 'false',
    aiModel: env.AI_MODEL ?? '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    aiMaxCallsPerRun: int(env.AI_MAX_CALLS_PER_RUN, 1, 0, HARD_CAPS.maxAiCallsPerRun),
    aiMaxCallsPerDay: int(env.AI_MAX_CALLS_PER_DAY, 60, 0, HARD_CAPS.maxAiCallsPerDay),
    aiMaxNeuronsPerDay: int(env.AI_MAX_NEURONS_PER_DAY, 3000, 0, HARD_CAPS.maxAiNeuronsPerDay),
    maxMarketsPerRun: int(env.MAX_MARKETS_PER_RUN, 8, 1, HARD_CAPS.maxMarketsPerRun),
    maxTrackedMarkets: int(env.MAX_TRACKED_MARKETS, 60, 1, HARD_CAPS.maxTrackedMarkets),
    discoveryEveryNRuns: int(env.DISCOVERY_EVERY_N_RUNS, 6, 1, 1000),
    retentionDays: int(env.RETENTION_DAYS, 30, 1, 365),
    gammaBaseUrl: env.GAMMA_BASE_URL ?? 'https://gamma-api.polymarket.com',
    clobBaseUrl: env.CLOB_BASE_URL ?? 'https://clob.polymarket.com',
    geoblockUrl: env.GEOBLOCK_URL ?? 'https://polymarket.com/api/geoblock',
  };
}

/** Next firing of the cron expressions this project uses: every N minutes (star-slash-N) or a fixed minute. */
export function nextCronRun(expression: string, from: Date): Date | null {
  const [minuteField] = expression.trim().split(/\s+/);
  if (!minuteField) return null;
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  const step = minuteField.match(/^\*\/(\d+)$/);
  if (step) {
    const n = Number(step[1]);
    if (!(n > 0 && n <= 60)) return null;
    const minutes = next.getUTCMinutes();
    next.setUTCMinutes(minutes - (minutes % n) + n);
    return next;
  }
  const fixed = minuteField.match(/^(\d+)$/);
  if (fixed) {
    const m = Number(fixed[1]);
    if (m > 59) return null;
    if (next.getUTCMinutes() >= m || next.getTime() <= from.getTime()) next.setUTCHours(next.getUTCHours() + 1);
    next.setUTCMinutes(m);
    return next;
  }
  if (minuteField === '*') {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    return next;
  }
  return null;
}
