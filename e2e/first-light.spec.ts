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
 *   5. Bench leads: assert the auto-attached supply + ground already render as
 *      drawn leads (lead-path SVG elements), then add a voltage-probe from the
 *      palette and drag its open jack onto the board — dropped on the first
 *      lead-clip's projected anchor (data-x/data-y). On this 2-part demo
 *      board VIN/GND are single-pad nets whose only pad sits directly under
 *      its component's 3D body, so a naive nearest-hit raycast there would
 *      resolve to the *component* (ref: "D1"), not the net. The hit-test
 *      (scene.ts pickAttachTargetAt via picking.ts raycastTargets) scans the
 *      full ray instead of just the nearest hit, so the net-accepting
 *      voltage-probe jack still lands on the occluded copper — exactly the
 *      gesture this test proves end-to-end. Assert the lead count grows by
 *      one and the probe's jack goes from data-wired="false" to wired.
 *   6. Turn the supply knob DOWN (the tactile path, not the numeric field):
 *      a 20 px downward drag on supply-volts-knob (0-30 V range) clamps the
 *      5 V supply to 0 V (DragKnob math: (startY-clientY)/100 * (max-min) =
 *      (-20/100)*30 = -6 V). updateInstrument sees the energized state and
 *      runs the coalesced re-op; poll until the glow settles LOWER, then
 *      assert the decrease.
 *
 * No fixed sleeps for the sim itself: all op-result waits go through
 * page.waitForFunction polling the glow instrumentation.
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'
import { pipeAppOutput } from './util'

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

  test('open demo → Energize → LED glows → run a lead → turn the knob → LED dims', async () => {
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

    // 4. Bench leads: the auto-attached supply + ground render as drawn leads.
    const leadPaths = page.locator('[data-testid="lead-path"]')
    await expect(leadPaths.first()).toBeVisible({ timeout: 10_000 })
    const leadCountBefore = await leadPaths.count()
    expect(leadCountBefore).toBeGreaterThanOrEqual(2) // supply + ground

    // 5. Run a lead: add a voltage-probe from the palette, drag its open jack
    //    onto the board. Drop target: the first lead-clip's anchor
    //    (data-x/data-y are container-relative px). That pixel is a
    //    component-covered pad (see comment above) — proving the net-accepting
    //    jack attaches through the occluding component box.
    await page.locator('[data-testid="add-instrument-btn"]').click()
    await page.locator('[data-testid="palette-voltage-probe"]').click()
    const openJack = page.locator('[data-testid^="jack-voltage_probe"][data-wired="false"]')
    await expect(openJack).toBeVisible()
    const clip = page.locator('[data-testid="lead-clip"]').first()
    const clipX = Number(await clip.getAttribute('data-x'))
    const clipY = Number(await clip.getAttribute('data-y'))
    const layerBox = (await page.locator('[data-testid="lead-layer"]').boundingBox())!
    const jackBox = (await openJack.boundingBox())!
    await page.mouse.move(jackBox.x + jackBox.width / 2, jackBox.y + jackBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(layerBox.x + clipX, layerBox.y + clipY, { steps: 10 })
    await page.mouse.up()
    await expect(leadPaths).toHaveCount(leadCountBefore + 1, { timeout: 10_000 })
    await expect(openJack).toHaveCount(0) // the jack is now wired

    // 6. Turn the supply knob DOWN (the tactile path — spec §6 replaces the
    //    typed set-value step). The shipped SupplyPanel knob range is 0-30 V
    //    (verified in bench/panels.tsx), not the 0-24 V a stale comment might
    //    suggest: DragKnob's value math is (startY-clientY)/100 * (max-min),
    //    so a +20 px downward drag ≈ (-20/100)*30 = -6 V. From the 5 V
    //    starting point that clamps at the knob's 0 V floor — the LED goes
    //    fully dark, which is well past the margin the waitForFunction below
    //    already requires.
    const knob = page.locator('[data-testid="supply-volts-knob"]')
    const knobBox = (await knob.boundingBox())!
    const kx = knobBox.x + knobBox.width / 2
    const ky = knobBox.y + knobBox.height / 2
    await page.mouse.move(kx, ky)
    await page.mouse.down()
    await page.mouse.move(kx, ky + 20, { steps: 5 })
    await page.mouse.up()

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

    const glowAfterKnobDown = await readGlow(page)
    expect(glowAfterKnobDown).not.toBeNull()
    expect(glowAfterKnobDown!.max).toBeLessThan(glowAt5V!.max)
    expect(glowAfterKnobDown!.byRef['D1']).toBeLessThan(glowAt5V!.byRef['D1'])

    // Diagnostic breadcrumb for CI logs (list reporter prints test stdout).
    console.log(
      `[first-light] D1 glow: ${glowAt5V!.byRef['D1'].toFixed(3)} @ 5 V → ${glowAfterKnobDown!.byRef['D1'].toFixed(3)} after knob-down drag`,
    )
  })
})
