import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Integration tests run inside workerd with a local D1 (migrations applied in the setup file).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, '../../migrations'));
  return {
    root: import.meta.dirname,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
