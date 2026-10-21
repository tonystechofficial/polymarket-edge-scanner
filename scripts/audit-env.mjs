#!/usr/bin/env node
// Capability audit: toolchain, Cloudflare authentication, Polymarket endpoints, geoblock. Read-only.
import { execSync } from 'node:child_process';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'WARN'} ${name}${detail ? `: ${detail}` : ''}`);
}
function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000 }).trim();
  } catch (err) {
    return `ERROR ${(err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-1)[0]}`;
  }
}
async function probe(name, url, init) {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    record(name, res.ok, `HTTP ${res.status} in ${Date.now() - started} ms, ${text.length} bytes`);
    return text;
  } catch (err) {
    record(name, false, err.message);
    return null;
  }
}

console.log('# Toolchain');
record('node', true, process.version);
record('npm', true, sh('npm --version'));
record('git', true, sh('git --version'));
const wranglerVersion = sh('npx --no-install wrangler --version');
record('wrangler (workspace)', !wranglerVersion.startsWith('ERROR'), wranglerVersion.split('\n').pop());

console.log('\n# Cloudflare authentication');
const whoami = sh('npx --no-install wrangler whoami');
const authed = /Account Name|Account ID|You are logged in/i.test(whoami);
record('wrangler whoami', authed, authed ? whoami.split('\n').filter((l) => /Account|logged/i.test(l)).join(' | ') : 'not authenticated: run `npx wrangler login` (browser OAuth) or set CLOUDFLARE_API_TOKEN');

console.log('\n# Polymarket public endpoints');
await probe('Gamma /markets', 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=1');
await probe('Gamma /events', 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=1');
const ok = await probe('CLOB /', 'https://clob.polymarket.com/');
if (ok !== null) await probe('CLOB POST /books (empty batch)', 'https://clob.polymarket.com/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
const geo = await probe('Geoblock (this machine)', 'https://polymarket.com/api/geoblock');
if (geo) {
  try {
    const g = JSON.parse(geo);
    record('geoblock verdict', !g.blocked, `blocked=${g.blocked} country=${g.country} region=${g.region} (trading stays disabled in this build regardless)`);
  } catch {
    record('geoblock verdict', false, 'unparseable answer');
  }
}

console.log('\n# Summary');
const warn = results.filter((r) => !r.ok);
console.log(warn.length === 0 ? 'Everything needed is available.' : `${warn.length} item(s) need attention: ${warn.map((w) => w.name).join(', ')}`);
process.exit(0);
