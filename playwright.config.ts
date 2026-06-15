/**
 * playwright.config.ts — Task 26
 *
 * Playwright E2E configuration for circsim.
 *
 * Uses @playwright/test with _electron.launch to start the packaged/built app.
 * The app must be built first: npm run build.
 *
 * On Linux CI: run under xvfb-run (configured in .github/workflows/ci.yml).
 * On Windows: runs directly (Electron handles its own display).
 *
 * Spec §13 (E2E), Task 26.
 */

import { defineConfig } from '@playwright/test'
import { join } from 'path'

export default defineConfig({
  // E2E tests live in e2e/
  testDir: join(__dirname, 'e2e'),

  // Each test gets its own timeout (the app needs time to start + sim to converge)
  timeout: 60_000,

  // Retry once on CI to tolerate flaky startup timing
  retries: process.env['CI'] ? 1 : 0,

  // Sequential: the Electron app is a singleton process per test file
  workers: 1,

  // Report results
  reporter: [
    ['list'],
    // Save screenshots on failure as CI artifacts
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],

  // Screenshot on failure
  use: {
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
