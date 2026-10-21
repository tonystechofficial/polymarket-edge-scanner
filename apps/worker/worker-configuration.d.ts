// Bindings and variables declared in wrangler.jsonc, plus the one secret (`wrangler secret put ADMIN_TOKEN`).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AI: Ai;
    ASSETS: Fetcher;
    ADMIN_TOKEN?: string;
    SIMULATION_ONLY: string;
    CRON_SCHEDULE: string;
    AI_ENABLED: string;
    AI_MODEL: string;
    AI_MAX_CALLS_PER_RUN: string;
    AI_MAX_CALLS_PER_DAY: string;
    AI_MAX_NEURONS_PER_DAY: string;
    MAX_MARKETS_PER_RUN: string;
    MAX_TRACKED_MARKETS: string;
    DISCOVERY_EVERY_N_RUNS: string;
    RETENTION_DAYS: string;
    GAMMA_BASE_URL: string;
    CLOB_BASE_URL: string;
    GEOBLOCK_URL: string;
  }
}
interface Env extends Cloudflare.Env {}
