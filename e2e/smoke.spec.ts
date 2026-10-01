/**
 * e2e/smoke.spec.ts — Task 26
 *
 * End-to-end smoke test for circsim using Playwright's _electron.launch.
 *
 * Prerequisites:
 *   npm run build   — must complete before running this test.
 *
 * Test path (Spec §4 primary scenario with sample project):
 *   1. Launch the built Electron app.
 *   2. Click "Open sample project" empty-state button.
 *   3. Expect the parts list to show 7 rows, 0 unresolved.
 *   4. Click "Power On" → expect ≥1 op annotation visible on the viewport.
 *   5. Probe the OUT net, click "Run" → expect trace-coloured scope pixels (none
 *      before Run), a measured mean in the legend, and a trace that keeps changing.
 *   6. Alter the DC supply to 9 V → expect the annotation text to change.
 *
 * CI: run on ubuntu-latest under xvfb (see .github/workflows/ci.yml).
 * On Windows: _electron.launch works without a virtual display (Electron manages it).
 *
 * NOTE: If the build has not been done or there is no display, _electron.launch
 * will fail. The test reports the error in e2eResult (see StructuredOutput).
 *
 * Spec §13 (E2E path), Task 26.
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'
import { pipeAppOutput, readSimDiagnostics } from './util'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

// ── helpers ───────────────────────────────────────────────────────────────────

/** Launch the built Electron app. Returns the app + first window. */
async function launchApp(): Promise<{ app: ElectronApplication; page: import('@playwright/test').Page }> {
  const app = await electron.launch({
    args: [APP_MAIN],
    // Pass an env flag so the app can detect it is running under test
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  pipeAppOutput(app)
  const page = await app.firstWindow()
  // Wait for network idle which indicates the JS bundle has finished loading.
  // The store boot sequence awaits the SimHost port handshake before rendering,
  // so we give it up to 30 s. domcontentloaded fires before React renders.
  await page.waitForLoadState('load')
  // Additional wait for the React app to finish mounting + store boot
  await page.waitForTimeout(3000)
  return { app, page }
}

/**
 * Flip to false when #128 (macOS: ngspice's free-memory pre-check aborts the
 * 30 s / 10 us bench transient, so Run never streams) is fixed. While true, the
 * Run test on darwin asserts the known symptom instead of the live trace; it
 * fails loudly the moment the bug stops reproducing so this flag cannot rot.
 */
const KNOWN_BUG_128_OPEN = true

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('circsim smoke E2E', () => {
  let app: ElectronApplication

  test.afterEach(async ({}, testInfo) => {
    // On failure, attach what ngspice said: CI legs (notably macOS) cannot be
    // reproduced locally, and the screenshot alone does not show the sim log.
    if (testInfo.status !== testInfo.expectedStatus && app) {
      const win = app.windows()[0]
      if (win) {
        const diag = await readSimDiagnostics(win)
        process.stdout.write(`[sim-diagnostics] ${testInfo.title}
${diag}
`)
        await testInfo.attach('sim-log', { body: diag, contentType: 'text/plain' })
      }
    }
    // Close the app after each test to avoid cross-contamination
    try {
      await app?.close()
    } catch {
      // ignore if already closed
    }
  })

  test('launch → open sample → parts list shows parts, 0 unresolved', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // 1. The empty state should be visible
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })

    // 2. Click "Open sample project"
    await page.locator('[data-testid="open-sample-btn"]').click()

    // 3. Wait for the parts panel to populate (the board is being parsed + resolved)
    // The parts panel renders a list of part rows; wait for at least one to appear.
    // Parts panel rows have data-testid="part-row" or are li/tr elements; the guard
    // test already ensures 7 parts resolve, so we look for 7 rows.
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })
    const partRows = page.locator('[data-testid="part-row"]')
    const rowCount = await partRows.count()
    expect(rowCount).toBeGreaterThanOrEqual(7)

    // 4. Expect 0 unresolved: no red status badges in the parts list
    const redBadges = page.locator('[data-testid="status-badge-red"]')
    expect(await redBadges.count()).toBe(0)
  })

  test('Power On → op annotations appear on viewport', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // Open sample project
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()
    // Wait for board to load
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // Click Power On
    const powerOnBtn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOnBtn).toBeEnabled({ timeout: 10_000 })
    await powerOnBtn.click()

    // Wait for op annotations: the toolbar should show "idle" again and voltage
    // overlays or labels appear. We test for an op annotation text element OR
    // the "voltage" overlay class/mode.
    await expect(
      page.locator('[data-testid="op-annotation"]').first()
    ).toBeVisible({ timeout: 20_000 })
  })

  test('Run → scope draws a live trace from streamed samples (issue #66)', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // Open sample and wait for board
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // Power On first: the transient starts from the DC operating point.
    const powerOnBtn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOnBtn).toBeEnabled({ timeout: 10_000 })
    await powerOnBtn.click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({ timeout: 20_000 })

    // The scope only has something to draw once a voltage probe is attached;
    // with no probe it paints the dark background and grid and nothing else.
    // Probe the 555 output through the Nets tab + "Probe this net".
    await page.locator('[data-testid="bottom-tab-nets"]').click()
    await page.locator('[data-testid="net-voltage-row"][data-net-name="OUT"]').click()
    await page.locator('[data-testid="probe-net-btn"]').click()

    const scopeCanvas = page.locator('[data-testid="scope-canvas"]')
    await expect(scopeCanvas).toBeVisible({ timeout: 10_000 })

    // Read the probe's trace colour from its legend swatch instead of guessing
    // it, so the check keys on the trace and never on background or grid pixels
    // (the scope paints #0d1117 and a grid on every frame, even with no data).
    const trace = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="scope-canvas"]') as HTMLCanvasElement
      const root = canvas.parentElement?.parentElement
      const swatch = [...(root?.querySelectorAll('span') ?? [])].find(
        s => (s as HTMLElement).style.background !== '',
      ) as HTMLElement | undefined
      const m = swatch ? getComputedStyle(swatch).backgroundColor.match(/\d+/g) : null
      return m ? m.slice(0, 3).map(Number) : null
    })
    expect(trace, 'probe legend swatch carries the trace colour').not.toBeNull()
    const [tr, tg, tb] = trace as [number, number, number]

    /** Count canvas pixels close to the trace colour and fingerprint where they are. */
    const traceStats = (): Promise<{ count: number; sig: number }> =>
      page.evaluate(
        ([r, g, b]) => {
          const canvas = document.querySelector('[data-testid="scope-canvas"]') as HTMLCanvasElement
          const ctx = canvas.getContext('2d')!
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          let count = 0
          let sig = 0
          for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i] - r) < 60 && Math.abs(d[i + 1] - g) < 60 && Math.abs(d[i + 2] - b) < 60) {
              count++
              sig = (sig * 31 + (i >> 2)) >>> 0
            }
          }
          return { count, sig }
        },
        [tr, tg, tb] as [number, number, number],
      )

    // Negative control: before Run no sample has streamed, so no trace pixel
    // exists. This is what the old any-pixel-above-10 check could not tell.
    expect((await traceStats()).count).toBe(0)

    // Now click Run
    const runBtn = page.locator('[data-testid="run-btn"]')
    await expect(runBtn).toBeEnabled({ timeout: 10_000 })
    await runBtn.click()

    if (KNOWN_BUG_128_OPEN && process.platform === 'darwin') {
      // Known bug #128: ngspice's macOS free-memory estimate rejects the bench
      // transient, so no sample ever streams. Pin the symptom and its cause.
      await expect
        .poll(() => readSimDiagnostics(page), {
          timeout: 20_000,
          message: 'known bug #128 no longer reproduces on macOS: set KNOWN_BUG_128_OPEN to false',
        })
        .toContain('memory required')
      expect((await traceStats()).count).toBe(0)
      return
    }

    // Samples must reach the ring buffer and be drawn: a one-pixel-wide trace
    // across a ~500 px canvas is several hundred trace-coloured pixels.
    await expect.poll(async () => (await traceStats()).count, { timeout: 20_000 }).toBeGreaterThan(200)

    // The legend reads the same ring: "Waiting for data" must be gone and a
    // measured mean must be shown for the probed net.
    const legend = scopeCanvas.locator('xpath=../..')
    await expect(legend).not.toContainText('Waiting for data')
    await expect(legend).toContainText(/Mean:\s*[\d.]+\s*m?V/)

    // simTime must keep advancing: the rolling window shifts, so the drawn
    // trace changes over time. A stuck ring buffer or a SimHost that stopped
    // streaming would leave the fingerprint frozen.
    const first = await traceStats()
    await expect.poll(async () => (await traceStats()).sig, { timeout: 15_000 }).not.toBe(first.sig)
  })

  test('alter DC supply voltage → op annotation changes', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // Open sample
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // Power On to get the initial annotation
    const powerOnBtn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOnBtn).toBeEnabled({ timeout: 10_000 })
    await powerOnBtn.click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({ timeout: 20_000 })

    // Read the VCC annotation text before the alter
    const annotationsBefore = await page.locator('[data-testid="op-annotation"]').allTextContents()

    // Find the DC supply voltage input in the instrument rack and change it to 9 V.
    // The supply is auto-suggested for the VCC net; the input has data-testid="supply-volts-input".
    const supplyInput = page.locator('[data-testid="supply-volts-input"]').first()
    await expect(supplyInput).toBeVisible({ timeout: 5_000 })
    await supplyInput.fill('9')
    await supplyInput.press('Enter')

    // Power On again and POLL until the fresh op result lands (no fixed sleep:
    // with the blinker's LED now correctly forward-biased, the 9 V op can take
    // several seconds — ngspice's gmin/source-stepping retry ladder engages on
    // the astable + conducting-diode circuit before it converges).
    await powerOnBtn.click()
    await expect
      .poll(
        async () => page.locator('[data-testid="op-annotation"]').allTextContents(),
        { timeout: 30_000 },
      )
      .not.toEqual(annotationsBefore)

    // The annotations must have changed (e.g. VCC went from ~5 to ~9)
    const annotationsAfter = await page.locator('[data-testid="op-annotation"]').allTextContents()
    expect(annotationsAfter).not.toEqual(annotationsBefore)
  })
})
