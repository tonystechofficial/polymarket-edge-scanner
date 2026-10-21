// Bundles the dashboard into dist/ with esbuild. No framework, no client-side router: one page, JSON fetches.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(here, 'public'), dist, { recursive: true });

const options = {
  entryPoints: [join(here, 'src/main.ts')],
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  target: ['es2022'],
  format: 'esm',
  outfile: join(dist, 'app.js'),
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching dashboard sources');
} else {
  await build(options);
}
