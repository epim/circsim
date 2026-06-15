/**
 * e2e/packaged-smoke.spec.ts
 *
 * Smoke test against the PACKAGED app (dist/win-unpacked/circsim.exe), not the
 * dev `out/main/index.js`. This verifies the deploy-critical paths that only
 * exist when packaged: ngspice.dll + .cm code models loaded from the
 * asar-EXTERNAL resources dir (process.resourcesPath), koffi from
 * app.asar.unpacked, and the bundled sample/model library resolved from
 * extraResources. Proves the installer's app actually simulates.
 *
 * Prerequisite: `npm run package:dir` (produces dist/win-unpacked).
 * Skips gracefully if the packaged binary is absent.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { existsSync } from 'fs'

const PACKAGED_EXE = join(__dirname, '..', 'dist', 'win-unpacked', 'circsim.exe')

test('packaged app: open sample → power on → op annotations (real ngspice from bundle)', async () => {
  test.skip(!existsSync(PACKAGED_EXE), 'packaged binary not built (run npm run package:dir)')

  const app = await electron.launch({ executablePath: PACKAGED_EXE, args: [] })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    await page.waitForTimeout(3000)

    // Empty state renders (UI not blocked on the sim handshake).
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()

    // Board parses + resolves from the bundled library → parts appear, 0 unresolved.
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 20_000 })
    expect(await page.locator('[data-testid="part-row"]').count()).toBeGreaterThanOrEqual(7)
    expect(await page.locator('[data-testid="status-badge-red"]').count()).toBe(0)

    // Power On runs a real DC operating point through the bundled ngspice.dll
    // (loads .cm code models from the packaged resources) → annotations appear.
    const powerOn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOn).toBeEnabled({ timeout: 10_000 })
    await powerOn.click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({ timeout: 25_000 })
  } finally {
    await app.close()
  }
})
