#!/usr/bin/env bash
# Idempotent deployment on Cloudflare's free tier. Creates only what is missing, never deletes.
# Usage: ADMIN_TOKEN=<random 32+ chars> ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx --no-install wrangler"
CONFIG="apps/worker/wrangler.jsonc"
DB_NAME="pes-db"

echo "== 1/7 plan and model check (aborts on a paid plan)"
node scripts/check-plan.mjs

echo "== 2/7 tests"
npm run typecheck
npm run test:unit
npm run test:worker

echo "== 3/7 dashboard build"
npm run build:dashboard

echo "== 4/7 D1 database"
DB_ID=$($WRANGLER d1 list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=JSON.parse(s);const db=l.find(x=>x.name==='$DB_NAME');process.stdout.write(db?db.uuid:'')})")
if [ -z "$DB_ID" ]; then
  echo "creating $DB_NAME"
  $WRANGLER d1 create "$DB_NAME" >/dev/null
  DB_ID=$($WRANGLER d1 list --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=JSON.parse(s);process.stdout.write(l.find(x=>x.name==='$DB_NAME').uuid)})")
fi
echo "database_id=$DB_ID"
node -e "
const fs=require('fs');const p='$CONFIG';let t=fs.readFileSync(p,'utf8');
t=t.replace(/(\"database_name\": \"$DB_NAME\",[\s\S]*?\"database_id\": \")[^\"]*(\")/, '\$1$DB_ID\$2');
fs.writeFileSync(p,t);"

echo "== 5/7 migrations (additive only)"
$WRANGLER d1 migrations apply "$DB_NAME" --remote --config "$CONFIG"

echo "== 6/7 deploy worker + assets + cron"
$WRANGLER deploy --config "$CONFIG"

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "== 7/7 admin secret"
  printf '%s' "$ADMIN_TOKEN" | $WRANGLER secret put ADMIN_TOKEN --config "$CONFIG"
else
  echo "== 7/7 ADMIN_TOKEN not provided: admin routes stay disabled (503) until you run: npx wrangler secret put ADMIN_TOKEN --config $CONFIG"
fi

echo "done. Smoke test: BASE_URL=https://polymarket-edge-scanner.<subdomain>.workers.dev npm run test:prod"
