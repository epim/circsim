import { defineConfig } from 'vitest/config'

/**
 * Real-board corpus suite (npm run test:corpus).
 *
 * Kept out of the default config (vitest.config.ts includes only src/**) because
 * it needs the fetched corpus (scripts/fetch-corpus.mjs, network on first run)
 * and takes minutes, not seconds. Same `forks` isolation as the default config:
 * libngspice is a process-global singleton, so each test file gets its own
 * process.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/corpus/**/*.corpus.test.ts'],
    exclude: ['node_modules', 'out', 'dist'],
    pool: 'forks',
    poolOptions: { forks: { isolate: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
