// Config for the crash fixture run by src/simhost/__tests__/workerCrash.test.ts.
// It is the project config (so the globalSetup and setup file wired there are
// what is under test) with the include narrowed to the one fixture file. The
// root moves to this directory, so the project config's repo-relative setup
// paths are made absolute. Plain .mjs: the repo's tsconfig does not list the
// root vitest.config.ts, so a typed import of it would not compile.

import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

import base from '../../../vitest.config.ts'

const abs = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: [process.env.CIRCSIM_CRASH_FIXTURE ?? 'crash.fixture.ts'],
    globalSetup: (base.test?.globalSetup ?? []).map(abs),
    setupFiles: (base.test?.setupFiles ?? []).map(abs)
  }
})
