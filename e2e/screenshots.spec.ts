/**
 * e2e/screenshots.spec.ts — capture real app screenshots for the docs site.
 *
 * NOT a assertion test — it drives the built app through representative states
 * and writes PNGs into website/docs/public/img/ for the VitePress docs.
 * Run with: npx playwright test e2e/screenshots.spec.ts
 *
 * The app must be built first (npm run build), same as the other E2E specs.
 */

import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdirSync } from 'fs'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')
const IMG_DIR = join(__dirname, '..', 'website', 'docs', 'public', 'img')

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [APP_MAIN], env: { ...process.env, CIRCSIM_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.waitForTimeout(3000)
  return { app, page }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(IMG_DIR, `${name}.png`) })
  // eslint-disable-next-line no-console
  console.log(`[shot] ${name}.png`)
}

test('capture docs screenshots', async () => {
  // Local docs-capture tool, not a CI gate: it targets a fixed 1280×800 window
  // and writes PNGs into the docs site. CI runs a constrained window, so skip it.
  test.skip(!!process.env['CI'], 'screenshot capture is a local docs tool')
  mkdirSync(IMG_DIR, { recursive: true })
  test.setTimeout(180_000)
  const { app, page } = await launchApp()

  try {
    // 1. Empty / start state.
    await page.locator('[data-testid="open-first-light-btn"]').waitFor({ timeout: 15_000 })
    await shot(page, 'empty-state')

    // 2. First Light loaded (board + parts, not yet energized).
    await page.locator('[data-testid="open-first-light-btn"]').click()
    await page.locator('[data-testid="energize-btn"]').waitFor({ timeout: 15_000 })
    await page.locator('[data-testid="part-row"]').first().waitFor({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    await shot(page, 'first-light-loaded')

    // 3. First Light energized — LED glow + voltage overlay + labels + PSU panel.
    await page.locator('[data-testid="energize-btn"]').click()
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __circsimLedGlow?: { max: number } }
        return w.__circsimLedGlow !== undefined && w.__circsimLedGlow.max > 0.05
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )
    await page.waitForTimeout(1500)
    await shot(page, 'first-light-energized')

    // 3b. Just the bench shelf region (PSU panel with the lead).
    const shelf = page.locator('[data-testid="bench-shelf"]')
    if (await shelf.count()) {
      await shelf.screenshot({ path: join(IMG_DIR, 'bench-shelf.png') }).catch(() => {})
      // eslint-disable-next-line no-console
      console.log('[shot] bench-shelf.png')
    }

    // 3c. Tight crop on the glowing LED (top-of-board region) for the tutorial payoff.
    await page.screenshot({
      path: join(IMG_DIR, 'led-glow-closeup.png'),
      clip: { x: 300, y: 95, width: 460, height: 190 },
    }).catch(() => {})
    // eslint-disable-next-line no-console
    console.log('[shot] led-glow-closeup.png')

    // 3d. Mid-drag: a lead being drawn from an open jack toward the board.
    // Add a V-probe (open 'tip' jack), start dragging it onto the board, and
    // screenshot mid-motion (dashed lead following the cursor). Then cancel.
    try {
      await page.locator('[data-testid="add-instrument-btn"]').click()
      await page.locator('[data-testid="palette-voltage-probe"]').click()
      const jack = page.locator('[data-testid^="jack-voltage_probe"][data-wired="false"]').first()
      await jack.waitFor({ timeout: 5000 })
      const jb = (await jack.boundingBox())!
      // Aim at the board region above the shelf.
      const targetX = 520
      const targetY = 180
      await page.mouse.move(jb.x + jb.width / 2, jb.y + jb.height / 2)
      await page.mouse.down()
      await page.mouse.move((jb.x + targetX) / 2, (jb.y + targetY) / 2, { steps: 6 })
      await page.mouse.move(targetX, targetY, { steps: 6 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(IMG_DIR, 'drawing-a-lead.png') })
      // eslint-disable-next-line no-console
      console.log('[shot] drawing-a-lead.png')
      await page.keyboard.press('Escape')
      await page.mouse.up()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[shot] mid-drag capture skipped:', (e as Error).message)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[shot] first-light sequence error:', (e as Error).message)
  }

  await app.close()

  // 4. The 555 sample — richer board — energized, plus scope after a run.
  try {
    const r2 = await launchApp()
    const page2 = r2.page
    await page2.locator('[data-testid="open-sample-btn"]').waitFor({ timeout: 15_000 })
    await page2.locator('[data-testid="open-sample-btn"]').click()
    await page2.locator('[data-testid="energize-btn"]').waitFor({ timeout: 15_000 })
    await page2.locator('[data-testid="part-row"]').first().waitFor({ timeout: 15_000 })
    await page2.waitForTimeout(1500)
    await shot(page2, 'sample-loaded')

    // Energize the 555 board (voltage overlay + Board Critic populated).
    await page2.locator('[data-testid="energize-btn"]').click()
    await page2.waitForTimeout(6000)
    await shot(page2, 'sample-energized')

    // Board Critic panel close-up if present.
    const critic = page2.locator('[data-testid="critic-summary-info"]').first()
    if (await critic.count()) {
      await shot(page2, 'sample-critic')
    }
    await r2.app.close()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[shot] sample sequence error:', (e as Error).message)
  }
})
