import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    exclude: ['node_modules', 'out', 'dist'],
    // libngspice is a PROCESS-GLOBAL singleton (one ngSpice_Init per process —
    // this is exactly why SimHost runs in an isolated utilityProcess in
    // production, Spec §6). Loading it from two integration test FILES in one
    // worker process corrupts its global state and segfaults on teardown. The
    // `forks` pool with isolate:true runs each test file in its own child
    // process, so ngspice is initialized at most once per process.
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  }
})
