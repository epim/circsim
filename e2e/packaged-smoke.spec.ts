/**
 * e2e/packaged-smoke.spec.ts
 *
 * Smoke test against the PACKAGED app (electron-builder --dir output), not the
 * dev `out/main/index.js`. This verifies the deploy-critical paths that only
 * exist when packaged: the ngspice shared library + .cm code models loaded
 * from the asar-EXTERNAL resources dir (process.resourcesPath), koffi from
 * app.asar.unpacked, and the bundled sample/model library resolved from
 * extraResources. Proves the installer's app actually simulates, which also
 * proves libngspice dlopens on the host (a missing shared library such as the
 * libfftw3 of issue #15 leaves the app looking healthy but the sim never ready).
 *
 * Packaged executable per platform (electron-builder --dir):
 *   win32  dist/win-unpacked/circsim.exe
 *   linux  dist/linux-unpacked/circsim
 *   darwin dist/mac[-arm64]/circsim.app/Contents/MacOS/circsim
 * CIRCSIM_PACKAGED_EXE overrides the path.
 *
 * Prerequisite: `npm run package:dir` (produces the unpacked app).
 * Skips gracefully if the packaged binary is absent, unless
 * CIRCSIM_REQUIRE_PACKAGED=1 (set in CI), which turns a missing binary into a
 * failure so the gate cannot pass by skipping.
 */

import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { existsSync } from 'fs'
import { pipeAppOutput } from './util'

function packagedExePath(): string {
  const override = process.env['CIRCSIM_PACKAGED_EXE']
  if (override) return override
  const dist = join(__dirname, '..', 'dist')
  switch (process.platform) {
    case 'win32':
      return join(dist, 'win-unpacked', 'circsim.exe')
    case 'darwin': {
      // electron-builder names the dir after the host arch: mac (x64) or mac-arm64.
      const dir = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
      return join(dist, dir, 'circsim.app', 'Contents', 'MacOS', 'circsim')
    }
    default:
      return join(dist, 'linux-unpacked', 'circsim')
  }
}

const PACKAGED_EXE = packagedExePath()

test('packaged app: open sample → power on → op annotations (real ngspice from bundle)', async () => {
  if (process.env['CIRCSIM_REQUIRE_PACKAGED'] === '1') {
    expect(existsSync(PACKAGED_EXE), `packaged binary missing: ${PACKAGED_EXE}`).toBe(true)
  }
  test.skip(!existsSync(PACKAGED_EXE), 'packaged binary not built (run npm run package:dir)')

  const app = await electron.launch({ executablePath: PACKAGED_EXE, args: [] })
  pipeAppOutput(app)
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
