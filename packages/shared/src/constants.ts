/**
 * Platform limits, copied from the official documentation on 2026-10-21.
 * They are used by the scanner to size batches and by the dashboard to show quota usage.
 * Sources:
 *  - https://developers.cloudflare.com/workers/platform/limits/
 *  - https://developers.cloudflare.com/d1/platform/limits/ and /pricing/
 *  - https://developers.cloudflare.com/workers-ai/platform/pricing/ and /limits/
 *  - https://docs.polymarket.com/quickstart/introduction/rate-limits
 */
export const CLOUDFLARE_FREE_LIMITS = {
  workers: {
    requestsPerDay: 100_000,
    cpuMsPerInvocation: 10,
    subrequestsPerInvocation: 50,
    simultaneousConnections: 6,
    cronTriggersPerAccount: 5,
    scheduledWallTimeMinutes: 15,
  },
  d1: {
    databasesPerAccount: 10,
    maxDatabaseBytes: 500 * 1024 * 1024,
    rowsReadPerDay: 5_000_000,
    rowsWrittenPerDay: 100_000,
    queriesPerInvocation: 50,
    maxBoundParameters: 100,
  },
  workersAi: {
    neuronsPerDay: 10_000,
    textGenerationRequestsPerMinute: 300,
  },
} as const;

/** Documented per-10-second IP limits on the public Polymarket endpoints this project reads. */
export const POLYMARKET_RATE_LIMITS = {
  gammaMarketsPer10s: 300,
  gammaEventsPer10s: 500,
  clobBookPer10s: 1_500,
  clobBooksBatchPer10s: 500,
  clobPricesHistoryPer10s: 1_000,
} as const;

/**
 * Workers AI neuron rates per million tokens for the text models this project may use
 * (pricing page, 2026-10-21). Used to estimate daily neuron consumption from token usage.
 */
export const AI_MODEL_NEURON_RATES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  '@cf/meta/llama-3.1-8b-instruct': { inputPerMTok: 25_608, outputPerMTok: 75_147 },
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': { inputPerMTok: 4_119, outputPerMTok: 34_868 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inputPerMTok: 26_668, outputPerMTok: 204_805 },
  '@cf/meta/llama-3.2-3b-instruct': { inputPerMTok: 4_625, outputPerMTok: 30_475 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { inputPerMTok: 4_625, outputPerMTok: 30_475 },
  '@cf/openai/gpt-oss-20b': { inputPerMTok: 18_182, outputPerMTok: 27_273 },
};

/** Fallback neuron rate when the model is unknown: the most expensive rate of the table above. */
export const AI_UNKNOWN_MODEL_NEURON_RATE = { inputPerMTok: 26_668, outputPerMTok: 204_805 } as const;

/** Hard ceilings the scanner never exceeds in one invocation, whatever the parameters say. */
export const HARD_CAPS = {
  maxMarketsPerRun: 20,
  maxTrackedMarkets: 200,
  maxSubrequestsPerRun: 12,
  maxD1StatementsPerRun: 40,
  maxAiCallsPerRun: 3,
  maxAiCallsPerDay: 150,
  maxAiNeuronsPerDay: 8_000,
  maxBookLevelsStored: 10,
  maxMarketsPerEvent: 8,
} as const;

export const STRATEGY_VERSION = 'v0.1-experimental';
