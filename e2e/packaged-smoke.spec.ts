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
 * Packaged executable per platform (electron-builder --dir), resolved by
 * resolvePackagedExe in ./util (issue #66):
 *   win32  dist/win-unpacked/circsim.exe
 *   linux  dist/linux-unpacked/circsim
 *   darwin dist/mac[-arch]/circsim.app/Contents/MacOS/circsim
 * CIRCSIM_PACKAGED_EXE overrides the path.
 *
 * Prerequisite: `npm run package:dir` (produces the unpacked app).
 * Skips gracefully if the packaged binary is absent, unless
 * CIRCSIM_REQUIRE_PACKAGED=1 (set in CI), which turns a missing binary into a
 * failure so the gate cannot pass by skipping.
 */

import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { existsSync } from 'fs'
import { pipeAppOutput, resolvePackagedExe } from './util'

const PACKAGED_EXE: string =
  process.env['CIRCSIM_PACKAGED_EXE'] ?? resolvePackagedExe() ?? '<packaged binary not built>'

// The first op solve loads libngspice and the code models inside the SimHost
// utility process; on a loaded CI runner that has taken well over 10 s.
const OP_TIMEOUT_MS = 25_000

/**
 * On failure, print what the renderer shows (a failed op leaves no DOM trace
 * other than banners and cards) plus the renderer console, so a CI failure of
 * this gate is diagnosable from the log alone.
 */
async function dumpDiagnostics(
  page: Page,
  rendererLog: string[],
): Promise<void> {
  try {
    const state = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 4000),
      testIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map(e => e.getAttribute('data-testid'))
        .filter((v, i, a) => a.indexOf(v) === i),
    }))
    console.log(`[diag] testids: ${state.testIds.join(', ')}`)
    console.log('[diag] body text:')
    console.log(state.text)
  } catch (e) {
    console.log(`[diag] could not read page state: ${String(e)}`)
  }
  console.log(`[diag] renderer log (${rendererLog.length} lines):`)
  for (const line of rendererLog.slice(-60)) console.log(line)
}

/**
 * Launch the packaged app, run `body` against its first window, and on any
 * failure print the renderer state before rethrowing. Always closes the app.
 */
async function withPackagedApp(
  body: (page: Page) => Promise<void>,
): Promise<void> {
  if (process.env['CIRCSIM_REQUIRE_PACKAGED'] === '1') {
    expect(existsSync(PACKAGED_EXE), `packaged binary missing: ${PACKAGED_EXE}`).toBe(true)
  }
  test.skip(!existsSync(PACKAGED_EXE), 'packaged binary not built (run npm run package:dir)')

  const app = await electron.launch({ executablePath: PACKAGED_EXE, args: [] })
  pipeAppOutput(app)
  const rendererLog: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('console', m => rendererLog.push(`[console.${m.type()}] ${m.text()}`))
    page.on('pageerror', e => rendererLog.push(`[pageerror] ${e.message}`))
    await page.waitForLoadState('load')
    await page.waitForTimeout(3000)
    try {
      await body(page)
    } catch (err) {
      await dumpDiagnostics(page, rendererLog)
      throw err
    }
  } finally {
    await app.close()
  }
}

// The launch gate. The First Light demo is a plain R + LED board whose op
// converges directly, so this proves the bundled libngspice dlopens and a real
// solve completes on every platform without depending on a slow convergence
// path (the NE555 sample below always falls through to the transient-op rung,
// issue #19).
test('packaged app: open First Light → energize → op annotations (real ngspice from bundle)', async () => {
  await withPackagedApp(async page => {
    await expect(page.locator('[data-testid="open-first-light-btn"]')).toBeVisible({
      timeout: 15_000,
    })
    await page.locator('[data-testid="open-first-light-btn"]').click()

    // Board parses + resolves from the bundled library: R1 + D1, none unresolved.
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 20_000 })
    expect(await page.locator('[data-testid="part-row"]').count()).toBeGreaterThanOrEqual(2)
    expect(await page.locator('[data-testid="status-badge-red"]').count()).toBe(0)

    // Energize attaches ground and a supply, then runs a real DC operating
    // point through the bundled library (code models from the packaged
    // resources) and annotates the nets.
    const energize = page.locator('[data-testid="energize-btn"]')
    await expect(energize).toBeEnabled({ timeout: 10_000 })
    await energize.click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({
      timeout: OP_TIMEOUT_MS,
    })
  })
})

// The bundled 555 blinker (the app's first-run sample): exercises the larger
// library plus XSPICE code models. Its op always needs the transient-op
// fallback (issue #19). On the Intel macOS runner that rung did not finish
// inside the 30 s op timeout (the engine log ends at "Transient op started"),
// while arm64, Linux and Windows finish in seconds, so it is skipped there
// rather than letting a known slow convergence path fail the launch gate.
test('packaged app: open sample → power on → op annotations (555 blinker)', async () => {
  test.skip(
    process.platform === 'darwin' && process.arch === 'x64',
    'blinker-555 op needs the transient-op rung, which exceeds the op timeout on darwin-x64 (issue #19)',
  )
  await withPackagedApp(async page => {
    // Empty state renders (UI not blocked on the sim handshake).
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()

    // Board parses + resolves from the bundled library → parts appear, 0 unresolved.
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 20_000 })
    expect(await page.locator('[data-testid="part-row"]').count()).toBeGreaterThanOrEqual(7)
    expect(await page.locator('[data-testid="status-badge-red"]').count()).toBe(0)

    // Power On runs a real DC operating point through the bundled ngspice
    // (loads .cm code models from the packaged resources) → annotations appear.
    const powerOn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOn).toBeEnabled({ timeout: 10_000 })
    await powerOn.click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({
      timeout: OP_TIMEOUT_MS,
    })
  })
})
