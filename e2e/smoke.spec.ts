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
 *   5. Click "Run" → wait 2 s → expect scope canvas non-blank (pixel sample).
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

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

// ── helpers ───────────────────────────────────────────────────────────────────

/** Launch the built Electron app. Returns the app + first window. */
async function launchApp(): Promise<{ app: ElectronApplication; page: import('@playwright/test').Page }> {
  const app = await electron.launch({
    args: [APP_MAIN],
    // Pass an env flag so the app can detect it is running under test
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  const page = await app.firstWindow()
  // Wait for network idle which indicates the JS bundle has finished loading.
  // The store boot sequence awaits the SimHost port handshake before rendering,
  // so we give it up to 30 s. domcontentloaded fires before React renders.
  await page.waitForLoadState('load')
  // Additional wait for the React app to finish mounting + store boot
  await page.waitForTimeout(3000)
  return { app, page }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test.describe('circsim smoke E2E', () => {
  let app: ElectronApplication

  test.afterEach(async () => {
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

  test('Run → scope canvas non-blank after 2 s', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // Open sample and wait for board
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // First power on (needed to set up DC operating point)
    const powerOnBtn = page.locator('[data-testid="power-on-btn"]')
    await expect(powerOnBtn).toBeEnabled({ timeout: 10_000 })
    await powerOnBtn.click()
    // Wait for op to complete
    await page.waitForTimeout(3000)

    // Now click Run
    const runBtn = page.locator('[data-testid="run-btn"]')
    await expect(runBtn).toBeEnabled({ timeout: 10_000 })
    await runBtn.click()

    // Wait 2 s for the transient to produce samples
    await page.waitForTimeout(2000)

    // Sample the scope canvas — it must not be blank.
    // The scope renders into a <canvas data-testid="scope-canvas">.
    const scopeCanvas = page.locator('[data-testid="scope-canvas"]')
    await expect(scopeCanvas).toBeVisible({ timeout: 10_000 })

    // Evaluate the canvas pixels; a non-blank canvas has at least one non-zero pixel.
    const isNonBlank = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="scope-canvas"]') as HTMLCanvasElement | null
      if (!canvas) return false
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 0; i < data.length; i += 4) {
        // Check for any non-background pixel (r,g,b not all < 10 for a dark background)
        if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) return true
      }
      return false
    })
    expect(isNonBlank).toBe(true)
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
