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

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
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
  app: ElectronApplication,
  page: Page,
  rendererLog: string[],
): Promise<void> {
  try {
    const gpu = await app.evaluate(({ app: a }) => a.getGPUFeatureStatus())
    console.log(`[diag] gpu feature status: ${JSON.stringify(gpu)}`)
  } catch (e) {
    console.log(`[diag] could not read gpu status: ${String(e)}`)
  }
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
  body: (page: Page, app: ElectronApplication) => Promise<void>,
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
      await body(page, app)
    } catch (err) {
      await dumpDiagnostics(app, page, rendererLog)
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
  await withPackagedApp(async (page, app) => {
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

    // Silkscreen text renders in the packaged build (issue #39): one mesh with
    // glyph quads in it. Before the fix the labels never appeared.
    //
    // Some runners have no GL path under Electron 44 (macos-15-intel, issue
    // #133), so the 3D scene never starts and the viewport shows its fallback
    // notice (PR #110). There the glyph count cannot be asserted; assert the
    // notice instead. Legs with GL keep the exact glyph assertion, so this does
    // not weaken the check anywhere it can hold.
    const unavailable = page.locator('[data-testid="viewport-unavailable"]')
    const readGlyphs = (): Promise<number> =>
      page.evaluate(
        () => (window as unknown as { __circsimSilkscreen?: { glyphs: number } }).__circsimSilkscreen?.glyphs ?? 0,
      )
    await expect
      .poll(async () => (await unavailable.count()) > 0 || (await readGlyphs()) > 0, { timeout: 15_000 })
      .toBe(true)
    if ((await unavailable.count()) > 0) {
      await expect(unavailable).toBeVisible()
      await expect(unavailable).toContainText('3D view unavailable')
    } else {
      await expect.poll(readGlyphs, { timeout: 15_000 }).toBeGreaterThan(0)
    }

    // The offline promise holds in the packaged build (issue #38): the main
    // process saw the whole open and energize and not one request left the machine.
    // This holds with or without GL, so it is asserted on every leg.
    await page.waitForTimeout(1500)
    const audit = await app.evaluate(
      () =>
        (globalThis as unknown as { __circsimNetAudit?: { total: number; network: unknown[] } }).__circsimNetAudit ??
        null,
    )
    expect(audit, 'main-process request audit is missing').not.toBeNull()
    expect(audit!.total).toBeGreaterThan(0)
    expect(audit!.network).toEqual([])
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

// TEMPORARY (issue #133 experiment, removed before merge): probe which switch
// sets give a WebGL context on a GPU-less runner. Prints one JSON line per
// candidate; never fails.
const GL_PROBE_CANDIDATES: Array<{ label: string; args: string[] }> = [
  { label: 'baseline', args: [] },
  { label: 'gl-angle+angle-swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader'] },
  { label: 'angle-swiftshader-webgl', args: ['--use-angle=swiftshader-webgl'] },
  { label: 'gl-angle+swiftshader-webgl', args: ['--use-gl=angle', '--use-angle=swiftshader-webgl'] },
  { label: 'ignore-blocklist+nosandbox', args: ['--ignore-gpu-blocklist', '--disable-gpu-sandbox'] },
  {
    label: 'gl-angle+swiftshader+blocklist+nosandbox',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  },
  { label: 'angle-swiftshader+nosandbox', args: ['--use-angle=swiftshader', '--disable-gpu-sandbox'] },
  { label: 'angle-swiftshader+in-process-gpu', args: ['--use-angle=swiftshader', '--in-process-gpu'] },
  { label: 'angle-gl', args: ['--use-angle=gl'] },
  { label: 'angle-metal', args: ['--use-angle=metal'] },
  { label: 'disable-gpu', args: ['--disable-gpu'] },
  { label: 'disable-gpu+angle-swiftshader', args: ['--disable-gpu', '--use-angle=swiftshader'] },
]

test('gl probe (temporary, issue #133)', async () => {
  test.skip(process.platform !== 'darwin' || !existsSync(PACKAGED_EXE), 'macOS probe only')
  test.setTimeout(600_000)
  for (const cand of GL_PROBE_CANDIDATES) {
    let result: unknown
    try {
      const app = await electron.launch({
        executablePath: PACKAGED_EXE,
        args: ['--enable-logging=stderr', ...cand.args],
      })
      pipeAppOutput(app)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('load')
        await page.waitForTimeout(2500)
        const gpu = (await app.evaluate(({ app: a }) => a.getGPUFeatureStatus())) as Record<string, string>
        const ctx = await page.evaluate(() => {
          const out: Record<string, unknown> = {}
          for (const kind of ['webgl2', 'webgl']) {
            const c = document.createElement('canvas')
            const gl = c.getContext(kind) as WebGLRenderingContext | null
            if (!gl) {
              out[kind] = null
              continue
            }
            const ext = gl.getExtension('WEBGL_debug_renderer_info')
            out[kind] = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'context-no-ext'
          }
          return out
        })
        const unavailable = await page.locator('[data-testid="viewport-unavailable"]').count()
        result = { ctx, unavailable, webgl: gpu['webgl'], webgl2: gpu['webgl2'], gpu }
      } finally {
        await app.close()
      }
    } catch (e) {
      result = { error: String(e) }
    }
    console.log(`[probe] ${cand.label} ${cand.args.join(' ')} => ${JSON.stringify(result)}`)
  }
})
