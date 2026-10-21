#!/usr/bin/env node
// Verifies, before any deploy, that the Cloudflare account is on the Free plan and that the
// configured Workers AI model is actually available. Uses the Wrangler OAuth token or
// CLOUDFLARE_API_TOKEN. Read-only; exits non-zero when a paid plan or a missing model is detected.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const configPath = join(process.cwd(), 'apps/worker/wrangler.jsonc');
const wranglerConfig = readFileSync(configPath, 'utf8');
const model = /"AI_MODEL":\s*"([^"]+)"/.exec(wranglerConfig)?.[1] ?? '@cf/meta/llama-3.1-8b-instruct';

function wranglerToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, source: 'CLOUDFLARE_API_TOKEN' };
  const candidates = [
    process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, '.wrangler/config/default.toml'),
    process.env.APPDATA && join(process.env.APPDATA, 'xdg.config/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'),
    join(homedir(), '.wrangler/config/default.toml'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const token = /oauth_token\s*=\s*"([^"]+)"/.exec(text)?.[1];
    const expiry = /expiration_time\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (token) return { token, source: file, expiry };
  }
  return null;
}

async function cf(path, token) {
  const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(`${path}: HTTP ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body;
}

const auth = wranglerToken();
if (!auth) {
  console.error('No Cloudflare credential found. Run `npx wrangler login` first (or set CLOUDFLARE_API_TOKEN).');
  process.exit(2);
}
console.log(`credential: ${auth.source}${auth.expiry ? ` (expires ${auth.expiry})` : ''}`);

let exit = 0;
try {
  const accounts = await cf('/accounts?per_page=10', auth.token);
  for (const account of accounts.result) {
    console.log(`\naccount: ${account.name} (${account.id})`);
    let paid = false;
    try {
      const subs = await cf(`/accounts/${account.id}/subscriptions`, auth.token);
      const plans = subs.result.map((s) => `${s.rate_plan?.id ?? s.rate_plan?.public_name ?? 'unknown'}:${s.state ?? ''}`);
      console.log(`subscriptions: ${plans.length ? plans.join(', ') : 'none (Free)'}`);
      paid = subs.result.some((s) => /paid|enterprise|business|pro/i.test(JSON.stringify(s.rate_plan ?? {})) && s.state !== 'Cancelled');
    } catch (err) {
      console.log(`subscriptions: unavailable (${err.message.slice(0, 120)}); assuming Free`);
    }
    if (paid) {
      console.error('A paid subscription exists on this account. This project must stay at 0 EUR: deploy aborted by policy.');
      exit = 3;
    }
    try {
      const models = await cf(`/accounts/${account.id}/ai/models/search?per_page=100&task=Text%20Generation`, auth.token);
      const names = models.result.map((m) => m.name);
      const available = names.includes(model);
      console.log(`text-generation models visible: ${names.length}; configured ${model}: ${available ? 'available' : 'NOT FOUND'}`);
      if (!available) {
        console.error(`Model ${model} is not listed for this account. Candidates: ${names.filter((n) => /llama-3\.1-8b|qwen3-30b|gemma|gpt-oss/.test(n)).join(', ')}`);
        exit = 4;
      }
    } catch (err) {
      console.log(`model catalogue: unavailable (${err.message.slice(0, 160)})`);
    }
  }
} catch (err) {
  console.error(err.message);
  exit = 5;
}
process.exit(exit);
