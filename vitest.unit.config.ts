import { defineConfig } from 'vitest/config';

// Unit tests of the pure packages run in plain Node: no Cloudflare runtime needed.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
