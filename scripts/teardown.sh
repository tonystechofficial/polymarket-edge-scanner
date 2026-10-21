#!/usr/bin/env bash
# Removes ONLY the resources this project created: the Worker (with its cron trigger and assets)
# and the D1 database `pes-db`. Each step asks for confirmation. Nothing else on the account is touched.
set -euo pipefail
cd "$(dirname "$0")/.."
WRANGLER="npx --no-install wrangler"
CONFIG="apps/worker/wrangler.jsonc"

read -r -p "Delete the Worker 'polymarket-edge-scanner' (cron trigger and dashboard assets included)? [y/N] " a
if [ "${a:-N}" = "y" ]; then $WRANGLER delete --name polymarket-edge-scanner --config "$CONFIG" --force; fi

read -r -p "Delete the D1 database 'pes-db' and ALL its data? This cannot be undone. [y/N] " b
if [ "${b:-N}" = "y" ]; then $WRANGLER d1 delete pes-db --skip-confirmation; fi

echo "teardown finished. No other resource was created by this project."
