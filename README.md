# Polymarket Edge Scanner

A read-only, **simulation-only** scanner of [Polymarket](https://polymarket.com) markets that runs
entirely on Cloudflare's free tier: a Worker on a cron trigger, a D1 database, Workers AI for
structured analysis of resolution rules, and a static dashboard served by the same Worker.

It discovers liquid markets through the public Gamma API, prices them from the CLOB order books,
looks for value with an explainable engine, simulates paper orders against executable prices
(fees, spread and slippage included), settles them when markets resolve, and measures its own
calibration against reference strategies. It never signs a transaction, never asks for a wallet
key, and shows the official geoblock verdict instead of working around it.

**Recurring cost: 0 EUR.** No paid plan, no paid model, no server.

## Status

| Item | State |
| --- | --- |
| Code, migrations, dashboard | complete |
| Tests | 79 unit + 17 integration (D1 inside workerd), all passing on 2026-10-21 |
| Type-check, dry-run deploy | passing |
| Production verification | done on 2026-10-21 on a **temporary preview account** (`wrangler deploy --temporary`): migrations applied, 17 manual scans all `ok`, 23 production checks passing, 4 Workers AI models measured |
| Deployment on the owner's account | **pending a one-time `npx wrangler login`** (see Deploy); the temporary account has no cron trigger quota and expires unless claimed |
| Live URL on the owner's account | not yet verified; it will be `https://polymarket-edge-scanner.<your-subdomain>.workers.dev` |

## Architecture

```
cron (*/15 * * * *) ─► Worker.scheduled ─► runScan()
                                             ├─ lock (D1 system_state, atomic upsert)
                                             ├─ discover  (Gamma /events, 1 request, ≤24 markets)   every 6th run
                                             │  or price  (CLOB POST /books, 1 request, ≤8 markets)
                                             │     ├─ validate books (freshness, mirror coherence)
                                             │     ├─ estimate: empirical calibration or INSUFFICIENT_EVIDENCE
                                             │     ├─ decide: net edge on the CI lower bound, risk limits
                                             │     ├─ structural: multi-outcome Dutch book on negRisk events
                                             │     └─ simulate accepted signals (paper fills, fees, slippage)
                                             ├─ resolve  (Gamma /markets?id=…&closed=any, settle, calibration samples)
                                             ├─ analyze  (Workers AI, ≤1 call/run, daily neuron budget, schema-validated)
                                             └─ maintenance (bounded retention deletes), quotas, run log, unlock

browser ─► static assets (free, unlimited) ─► /api/* JSON (Hono) ─► D1
```

Everything is sized for the free plan's hard limits: **10 ms CPU per cron run, 50 subrequests and
50 D1 queries per invocation**. A run touches at most 12 subrequests and 40 D1 statements, and the
universe is walked slice by slice with a cursor persisted in D1. Nothing loops, nothing retries
without a bound, and a killed run leaves a `running` row that the dashboard reports as an error.

### Monorepo

```
apps/worker            Worker: Hono API, scheduled handler, D1 repository, scan orchestrator, wrangler.jsonc
apps/dashboard         Static dashboard (plain TypeScript + esbuild) served from the Worker's assets binding
packages/shared        Types, zod schemas (Polymarket payloads, AI output, admin input), limits, batching helpers
packages/polymarket    Gamma/CLOB/geoblock clients: timeouts, bounded retries with backoff, subrequest budget, validation
packages/strategy      Fees, book walking, edge, calibration estimator, Dutch books, risk, dedup, decision, simulator, safety
packages/ai            Workers AI client: prompt, JSON-schema response, zod validation, epistemic guard, neuron budget
migrations/            Versioned D1 migrations (additive only)
tests/unit             Pure-logic tests (Node)      tests/prod   production smoke test (see scripts/smoke-prod.mjs)
apps/worker/test       Integration tests inside workerd with migrations applied to a local D1
scripts/               audit-env, check-plan, deploy (sh + ps1), teardown, smoke-prod
.github/workflows      CI: typecheck, unit + integration tests, dry-run deploy (no credentials)
```

### Stack and versions (2026-10-21)

Node 22.23.3 · npm 10.9.9 · TypeScript 5.9.3 · Wrangler 4.151.3 · Hono 4.13.13 · zod 4.6.5 ·
Vitest 4.1.12 + `@cloudflare/vitest-plugin` 1.4.6 · esbuild 0.28.2 · `@cloudflare/workers-types` 5.20261021.1.
Workers AI model: `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (measured, see below; configurable with `AI_MODEL`).

## The strategy, honestly

The market price is **never** used as an estimate of the market's own probability. The engine has
two sources of independent evidence, and when neither applies the answer is `INSUFFICIENT_EVIDENCE`:

1. **Empirical calibration.** "Markets that traded at a similar price with a similar time to
   resolution resolved YES x % of the time", computed from the resolved markets this scanner has
   itself observed, in price bins of 0.05 and time-to-end buckets (< 1 d, 1–7 d, 7–30 d, > 30 d).
   It speaks only once a bin holds at least 30 resolved samples (parameter `min_calibration_samples`)
   and uses the lower bound of a 95 % Wilson interval for the edge, so the first weeks of a fresh
   deployment produce rejections, by design.
2. **Structural Dutch books.** On a mutually exclusive, exhaustive event (`negRisk`), if the YES
   asks of **all** outcomes sum below 1 after taker fees and the safety margin, a basket pays
   exactly 1 whichever outcome wins. This is priced on book depth, never on the top-of-book
   display. A binary YES/NO pair cannot do this on Polymarket (the NO book mirrors the YES book),
   so a pair that looks like free money is flagged as inconsistent data instead.

For every evaluated market a signal row records the side, the estimate with its interval and
sample count, the executable price for the suggested size, the fee per share from the market's
own `feeSchedule` (`fee = shares × rate × p(1−p)`), the slippage, the safety margin, the net edge,
and the full list of reasons for acceptance or rejection. Signals are deduplicated by
market, type, side, price bucket and UTC day.

Risk limits (all bounded parameters): fractional Kelly on the interval's lower bound, per-position
cap, exposure cap, maximum open and daily positions. Calibration metrics (Brier, log loss,
reliability table) compare the estimator with the market-implied and uniform baselines on the same
resolved samples. The model is **experimental**; treat every number as a measurement of the model,
not as advice.

## Workers AI, boxed in

The model receives the question, the resolution rules (truncated), the end date, the category and
the liquidity, and must answer in a JSON schema (`response_format: json_schema`). The answer is
validated with zod, then a guard enforces the rules the prompt states: a probability needs at least
two pieces of evidence, a source and fresh data, otherwise it becomes `null`; `REVIEW` needs
evidence; `AVOID` needs a stated risk; unsupported `high` confidence becomes `low`. Every
adjustment is stored next to the analysis. The model cannot place orders, change limits, see
secrets or decide about quotas: it only ever produces a row in `ai_analyses`.

Budget: at most 1 call per run (pricing runs only) and 60 calls or 3,000 estimated neurons per UTC
day (configurable, hard-capped at 150 calls and 8,000 neurons), out of the 10,000 free neurons.
Usage is estimated from the returned token counts and the published per-token rates. When the
budget is spent, the model errors, or the output is invalid, the scanner continues without it and
records why. A model reported as deprecated or unknown is latched in `system_state` and not
called again until `AI_MODEL` changes.

### Model choice, measured on 2026-10-21

The model listed on the official JSON-mode page, `@cf/meta/llama-3.1-8b-instruct`, answers
`5028: deprecated on 2026-05-30` at call time. Four live candidates were tested on the deployed
Worker with the same prompt and `response_format: json_schema` (3 calls each for the finalists):

| Model | Schema-valid output | Neurons / call | Wall time of the run |
| --- | --- | --- | --- |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (default) | 4 / 4 | 7.8 – 13.7 | 1.1 – 2.3 s |
| `@cf/ibm-granite/granite-4.0-h-micro` | 4 / 4 | 2.6 – 3.7 | 5.0 – 9.1 s |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 0 / 1 (reasoning consumed the 450-token budget, no JSON) | 15.8 – 17.3 | 3.4 – 4.5 s |
| `@cf/openai/gpt-oss-20b` | 0 / 1 (same) | 24.9 | 5.2 s |

Newer models answer in the OpenAI-style envelope (`choices[0].message.content`) rather than the
legacy `response` field; the parser accepts both, strips `<think>` blocks and fences, and
extracts the first JSON object from surrounding prose before validating.

## Simulation only, geoblock respected

* `SIMULATION_ONLY` must be `"true"` or the Worker refuses to start; there is no other mode.
* `simulated_orders.is_simulation` has a `CHECK (is_simulation = 1)` constraint.
* `canOpenRealPosition()` returns the literal `false` with the reasons, shown on the dashboard.
* The official check `GET https://polymarket.com/api/geoblock` is called from the Worker every
  6 hours and displayed. It describes the Worker's egress; the project never proxies around it.
  Public market data is read regardless, as the documentation allows; trading is impossible regardless.
* Fills are simulated against the order-book snapshot that produced the signal, level by level,
  with fees per level and assumptions written into the row. Simulated and real results cannot be
  confused because real results do not exist in this system.

## Dashboard and API

The dashboard (`/`) shows: system state, last and next run, tracked markets, observed prices,
signals with their reasons and evidence, simulations and PnL, calibration, AI analyses, recent
runs and errors, free-tier quota usage, and strategy parameters. Public JSON endpoints under
`/api/*` are read-only and cacheable for 30 s. Administrative routes (`POST /api/admin/run`,
`POST /api/admin/params`, `POST /api/admin/geoblock-check`) require `Authorization: Bearer <ADMIN_TOKEN>`:
a Cloudflare secret of at least 24 characters, compared in constant time, with a failure limiter
per IP. A token in a URL never works. Nothing secret is ever sent to the browser.

## Quotas (free tier, documented values)

| Resource | Free limit | This project, worst case |
| --- | --- | --- |
| Worker requests | 100,000 / day | 96 cron runs + dashboard API calls; asset requests are free and unlimited |
| CPU per invocation | 10 ms | ≤ 8 markets priced per run, small JSON, no heavy parsing |
| Subrequests per invocation | 50 | ≤ 12 (typically 2–4) |
| D1 queries per invocation | 50 | ≤ 40 statements, enforced in the run |
| D1 rows written | 100,000 / day | ≈ 1,000–3,000 / day (observations, signals, logs) |
| D1 storage | 500 MB per DB | bounded retention: observations 30 d, run logs 14 d |
| Workers AI | 10,000 neurons / day | ≤ 3,000 estimated neurons, ≤ 60 calls / day |
| Cron triggers | 5 per account | 1 |
| Polymarket Gamma `/markets` | 300 / 10 s per IP | ≤ 2 per run |
| Polymarket CLOB `/books` | 500 / 10 s per IP | 1 per run |

Live counters are on the dashboard (`/api/quotas`).

## Run locally

```bash
npm install                  # .npmrc sets legacy-peer-deps (npm 10 arborist bug on vitest's optional peers)
npm run audit:env            # toolchain, wrangler auth, Polymarket endpoints, geoblock of this machine
npm run typecheck
npm run test:unit            # 79 pure-logic tests
npm run test:worker          # 17 integration tests inside workerd (builds the dashboard first)
npm run dev                  # http://localhost:8787  (dashboard + API; cron: curl localhost:8787/cdn-cgi/local/scheduled)
```

Local admin token: create `apps/worker/.dev.vars` with `ADMIN_TOKEN=<random 32+ chars>` (git-ignored).

## Deploy

### Without an account (preview, verified on 2026-10-21)

Wrangler can deploy to a **temporary preview account** that needs no login and can be claimed into
a real account from the link it prints (valid about one hour). It is how the production checks of
this repository were run. Its limits differ from a normal Free account: **0 cron triggers**, so
only manual scans run there.

```bash
npx wrangler d1 create pes-db --temporary                       # prints the database_id and the claim URL
# put the database_id into apps/worker/wrangler.jsonc, then:
npx wrangler d1 migrations apply pes-db --remote --temporary --config apps/worker/wrangler.jsonc
npx wrangler deploy --temporary --config apps/worker/wrangler.jsonc
printf '%s' "$(openssl rand -hex 24)" | npx wrangler secret put ADMIN_TOKEN --temporary --config apps/worker/wrangler.jsonc
```

### On your own account

One-time, on the deploying machine (opens the browser for Cloudflare's OAuth consent):

```bash
npx wrangler login
```

Then:

```bash
ADMIN_TOKEN="$(openssl rand -hex 32)" ./scripts/deploy.sh      # bash / Git Bash
# or, on Windows PowerShell:
$env:ADMIN_TOKEN = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }); .\scripts\deploy.ps1
```

The script: checks the account has no paid plan and that the model is listed for the account
(`scripts/check-plan.mjs`), runs the tests, builds the dashboard, creates the D1 database `pes-db`
if missing and writes its id into `wrangler.jsonc`, applies migrations (additive), deploys the
Worker with its cron trigger and assets, sets the admin secret. Finally:

```bash
BASE_URL=https://polymarket-edge-scanner.<subdomain>.workers.dev ADMIN_TOKEN=... npm run test:prod
```

runs the production checks: health, status (`simulationOnly`, `tradingAllowed: false`), every
public endpoint, the dashboard asset, admin refusal without token, and one manual scan.

Redeploy after a change: `npm run deploy` (or `./scripts/deploy.sh` again). Logs: `npx wrangler tail --config apps/worker/wrangler.jsonc`.

### Resources created on Cloudflare

* Worker `polymarket-edge-scanner` (workers.dev route, cron `*/15 * * * *`, static assets)
* D1 database `pes-db`
* Secret `ADMIN_TOKEN` on that Worker

Nothing else. No paid feature is enabled; `scripts/check-plan.mjs` aborts if a paid subscription is found.

### Remove everything

```bash
./scripts/teardown.sh        # asks before deleting the Worker, then before deleting pes-db
```

## Known limits and open points

* **Cold start of the evidence.** The calibration estimator needs resolved markets observed by this
  deployment; until then value signals are rejected with `INSUFFICIENT_EVIDENCE`. This is the intended behaviour, not a bug.
* **Multi-outcome Dutch books** are only checked when every outcome of an event sits in the same
  8-market batch (events with more than 8 markets are capped at discovery), so large events are not covered.
* **Resolution detection** relies on Gamma's `umaResolutionStatus` / final prices; disputed or
  slow resolutions are retried every run for 60 days, then the market is ignored.
* **CPU is not measurable from inside a Worker.** Batch sizes are conservative; a run killed by the
  10 ms limit shows up as a `running` row older than 20 minutes in `/api/errors`.
* **Workers AI JSON mode** can refuse an output ("JSON Mode couldn't be met"); the run records an
  `error` row and continues. The model's availability on the Free plan is verified at deploy time by
  `scripts/check-plan.mjs`, not assumed.
* **Admin auth** is a bearer secret; for a team, put the Worker behind Cloudflare Access (free for up to 50 users).
* Nothing here is financial advice. The strategy is an experiment designed to be measured.

## Data sources and terms

Only documented public endpoints are used, well inside the documented per-IP rate limits:
Gamma `https://gamma-api.polymarket.com` (`/events`, `/markets`), CLOB `https://clob.polymarket.com`
(`POST /books`, `GET /prices-history`), and the geoblock check on `polymarket.com`. No web page is scraped.

## License

MIT.
