/**
 * e2e/first-light.spec.ts — First Light (L3/L5)
 *
 * End-to-end test for the "First Light" flow using Playwright's _electron.launch
 * (same launch pattern as e2e/smoke.spec.ts).
 *
 * Prerequisites:
 *   npm run build   — must complete before running this test.
 *
 * Test path (First Light L3 — "energize a board and watch the LED glow"):
 *   1. Launch the built Electron app.
 *   2. Click "Open First Light demo" (bundled resources/sample/first-light.kicad_pcb,
 *      a one-LED dimmer: VIN → R1 330 Ω → D1 LED → GND).
 *   3. Click "⚡ Energize" — the store auto-attaches ground + a 5 V DC supply and
 *      runs the DC operating-point solve.
 *   4. Poll window.__circsimLedGlow (published by scene.ts applyLedCurrents →
 *      publishLedGlow on every op solve) until max > 0.05 — the LED is lit.
 *      Cross-check the <html data-led-glow-max> mirror attribute.
 *   5. Lower the supply to 2.5 V via the supply voltage input (the auto supply is
 *      auto-selected in the InstrumentRack so data-testid="supply-volts-input" is
 *      visible). updateInstrument sees the energized state and runs the coalesced
 *      re-op; poll until the glow settles LOWER, then assert the decrease.
 *
 * No fixed sleeps for the sim itself: all op-result waits go through
 * page.waitForFunction polling the glow instrumentation.
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

// Shape published on window.__circsimLedGlow by scene.ts publishLedGlow.
interface LedGlowSnapshot {
  byRef: Record<string, number>
  max: number
}

/** Read the current LED-glow snapshot from the page (null when not yet published). */
async function readGlow(page: import('@playwright/test').Page): Promise<LedGlowSnapshot | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __circsimLedGlow?: { byRef: Record<string, number>; max: number } }
    return w.__circsimLedGlow ?? null
  })
}

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

test.describe('First Light E2E', () => {
  let app: ElectronApplication

  test.afterEach(async () => {
    // Close the app after each test to avoid cross-contamination
    try {
      await app?.close()
    } catch {
      // ignore if already closed
    }
  })

  test('open demo → Energize → LED glows → lower supply → LED dims', async () => {
    const result = await launchApp()
    app = result.app
    const page = result.page

    // 1. The empty state should offer the First Light demo
    await expect(page.locator('[data-testid="open-first-light-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-first-light-btn"]').click()

    // 2. Wait for the board to load: the toolbar (and its Energize button) only
    //    renders once a circuit exists, and the parts panel populates (R1 + D1).
    const energizeBtn = page.locator('[data-testid="energize-btn"]')
    await expect(energizeBtn).toBeVisible({ timeout: 15_000 })
    await expect(energizeBtn).toBeEnabled({ timeout: 10_000 })
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // 3. Energize: auto-attaches ground + 5 V supply, runs the op → LED glows.
    await energizeBtn.click()

    // Poll the glow instrumentation until the op lands and the LED is lit.
    // (Op typically completes in a couple of seconds; 30 s matches the store's
    // own opResult timeout.)
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __circsimLedGlow?: { max: number } }
        return w.__circsimLedGlow !== undefined && w.__circsimLedGlow.max > 0.05
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )

    const glowAt5V = await readGlow(page)
    expect(glowAt5V).not.toBeNull()
    // Healthy glow: 5 V through 330 Ω into the LED ≈ 9 mA → intensity well above 0.05.
    expect(glowAt5V!.max).toBeGreaterThan(0.05)
    // D1 is the demo's only LED, so it carries the max glow.
    expect(glowAt5V!.byRef['D1']).toBeGreaterThan(0.05)

    // The <html data-led-glow-max> mirror agrees with the window snapshot.
    const attr = await page.locator('html').getAttribute('data-led-glow-max')
    expect(attr).not.toBeNull()
    expect(parseFloat(attr!)).toBeCloseTo(glowAt5V!.max, 2)

    // 4. Lower the supply 5 V → 2.5 V. The auto-attached supply is auto-selected
    //    in the InstrumentRack, so its voltage input is already visible.
    const supplyInput = page.locator('[data-testid="supply-volts-input"]')
    await expect(supplyInput).toBeVisible({ timeout: 10_000 })
    await supplyInput.fill('2.5')
    await supplyInput.press('Enter')

    // updateInstrument (while energized) triggers the coalesced re-op; poll until
    // the glow settles clearly LOWER than before (margin guards against reading a
    // stale pre-re-op snapshot).
    await page.waitForFunction(
      (before) => {
        const w = window as unknown as { __circsimLedGlow?: { max: number } }
        return w.__circsimLedGlow !== undefined && w.__circsimLedGlow.max < before - 0.02
      },
      glowAt5V!.max,
      { timeout: 30_000, polling: 250 },
    )

    const glowAt2V5 = await readGlow(page)
    expect(glowAt2V5).not.toBeNull()
    expect(glowAt2V5!.max).toBeLessThan(glowAt5V!.max)
    expect(glowAt2V5!.byRef['D1']).toBeLessThan(glowAt5V!.byRef['D1'])

    // Diagnostic breadcrumb for CI logs (list reporter prints test stdout).
    console.log(
      `[first-light] D1 glow: ${glowAt5V!.byRef['D1'].toFixed(3)} @ 5 V → ${glowAt2V5!.byRef['D1'].toFixed(3)} @ 2.5 V`,
    )
  })
})
