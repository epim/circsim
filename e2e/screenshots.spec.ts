/**
 * e2e/screenshots.spec.ts — capture real app screenshots for the docs site.
 *
 * NOT a assertion test — it drives the built app through representative states
 * and writes PNGs into website/docs/public/img/ for the VitePress docs.
 * Run with: npx playwright test e2e/screenshots.spec.ts
 *
 * Two tests live here:
 *   1. "capture docs screenshots": the nine docs-site images (1280x800 window).
 *   2. "capture README hero and demo gif": the README hero still and a short
 *      GIF of a board going from open to energized to a Critic finding, taken
 *      in a larger window so the 3D board is legible. The GIF is cut from a
 *      Playwright video with ffmpeg; set CIRCSIM_FFMPEG to its path if it is
 *      not on PATH. Without ffmpeg the still is written and the GIF is skipped.
 *
 * The app must be built first (npm run build), same as the other E2E specs.
 * Only the project's own boards (the bundled First Light and 555 samples) are
 * ever captured: third-party corpus boards are never rendered into the repo.
 */

import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

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

const HERO_W = 1600
const HERO_H = 1000
const GIF_NAME = 'demo-open-energize-critic.gif'

/** Resize the first window to the hero size. Call after firstWindow() so the window exists. */
async function resizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(size.w, size.h)
      win.center()
    },
    { w: HERO_W, h: HERO_H },
  )
}

/** Cut a trimmed, palette-optimised GIF out of a recorded video. Returns false if ffmpeg is unavailable. */
function videoToGif(video: string, gif: string, startSeconds: number): boolean {
  const ffmpeg = process.env['CIRCSIM_FFMPEG'] || 'ffmpeg'
  const filter =
    'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
  const r = spawnSync(
    ffmpeg,
    ['-y', '-ss', startSeconds.toFixed(2), '-i', video, '-vf', filter, '-loop', '0', gif],
    { encoding: 'utf8' },
  )
  return r.status === 0
}

test('capture README hero and demo gif', async () => {
  test.skip(!!process.env['CI'], 'screenshot capture is a local docs tool')
  mkdirSync(IMG_DIR, { recursive: true })
  test.setTimeout(180_000)

  const videoDir = mkdtempSync(join(tmpdir(), 'circsim-demo-'))
  const app = await electron.launch({
    args: [APP_MAIN],
    env: { ...process.env, CIRCSIM_E2E: '1' },
    recordVideo: { dir: videoDir, size: { width: HERO_W, height: HERO_H } },
  })
  const page = await app.firstWindow()
  // Playwright's video clock starts when the page is created, which is just
  // before firstWindow() resolves. Measure from here, not from process spawn:
  // spawn-to-window time (seconds of Electron startup) is not in the video, and
  // using it cuts the start screen and the Open-sample click out of the GIF.
  const videoT0 = Date.now()
  await resizeWindow(app)
  await page.waitForLoadState('load')

  let startOffset = 0
  try {
    // Start screen, then open the bundled 555 sample.
    await page.locator('[data-testid="open-sample-btn"]').waitFor({ timeout: 15_000 })
    // Begin the GIF just before the start screen is ready (the video opens on a blank frame),
    // then hold on it so the viewer sees the open step before the click.
    startOffset = Math.max(0, (Date.now() - videoT0) / 1000 - 0.1)
    await page.waitForTimeout(1500)
    await page.locator('[data-testid="open-sample-btn"]').click()
    await page.locator('[data-testid="energize-btn"]').waitFor({ timeout: 15_000 })
    await page.locator('[data-testid="part-row"]').first().waitFor({ timeout: 15_000 })
    await page.waitForTimeout(1500)

    // Energize: voltage overlay, then the read-only Board Critic findings.
    await page.locator('[data-testid="energize-btn"]').click()
    await page.waitForTimeout(6000)
    await page.waitForTimeout(2500)
    await page.screenshot({ path: join(IMG_DIR, 'hero-sample-critic.png') })
    // eslint-disable-next-line no-console
    console.log('[shot] hero-sample-critic.png')
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[shot] sample hero sequence error:', (e as Error).message)
  }
  await app.close()

  // The video is finalised on close.
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  if (webm && statSync(join(videoDir, webm)).size > 0) {
    const ok = videoToGif(join(videoDir, webm), join(IMG_DIR, GIF_NAME), startOffset)
    // eslint-disable-next-line no-console
    console.log(ok ? `[shot] ${GIF_NAME}` : '[shot] gif skipped: ffmpeg failed or not found')
  } else {
    // eslint-disable-next-line no-console
    console.log('[shot] gif skipped: no video was recorded')
  }
  rmSync(videoDir, { recursive: true, force: true })

  // First Light still at the same size: the LED glow payoff.
  try {
    const r2 = await electron.launch({ args: [APP_MAIN], env: { ...process.env, CIRCSIM_E2E: '1' } })
    const p2 = await r2.firstWindow()
    await resizeWindow(r2)
    await p2.waitForLoadState('load')
    await p2.locator('[data-testid="open-first-light-btn"]').waitFor({ timeout: 15_000 })
    await p2.locator('[data-testid="open-first-light-btn"]').click()
    await p2.locator('[data-testid="energize-btn"]').waitFor({ timeout: 15_000 })
    await p2.locator('[data-testid="part-row"]').first().waitFor({ timeout: 15_000 })
    await p2.locator('[data-testid="energize-btn"]').click()
    await p2.waitForFunction(
      () => {
        const w = window as unknown as { __circsimLedGlow?: { max: number } }
        return w.__circsimLedGlow !== undefined && w.__circsimLedGlow.max > 0.05
      },
      undefined,
      { timeout: 30_000, polling: 250 },
    )
    await p2.waitForTimeout(1500)
    await p2.screenshot({ path: join(IMG_DIR, 'hero-first-light.png') })
    // eslint-disable-next-line no-console
    console.log('[shot] hero-first-light.png')
    await r2.close()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[shot] first-light hero error:', (e as Error).message)
  }
})
