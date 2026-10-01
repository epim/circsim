/**
 * e2e/layout.spec.ts: issue #33.
 *
 * The 3D board must never collapse to a sliver and the page must never scroll,
 * at the default window size and at 1280x720, in the loaded and energized
 * states, with the shelf and dock expanded (the defaults).
 *
 * Prerequisites: npm run build.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { pipeAppOutput } from './util'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

/** Smallest board canvas we accept (CSS px). */
const MIN_BOARD_H = 240
const MIN_BOARD_W = 480

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // A throwaway profile: the shelf and dock collapse flags persist in
  // localStorage, and must not leak into other specs or the real app profile.
  const userData = mkdtempSync(join(tmpdir(), 'circsim-e2e-layout-'))
  const app = await electron.launch({
    args: [APP_MAIN, `--user-data-dir=${userData}`],
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  pipeAppOutput(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.waitForTimeout(2000)
  return { app, page }
}

async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(0, 0)
    win.setContentSize(size.width, size.height)
  }, { width, height })
}

interface Metrics {
  canvasW: number
  canvasH: number
  scrollH: number
  clientH: number
  scrollW: number
  clientW: number
  bodyMargin: string
}

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="viewport-region"] canvas') as HTMLCanvasElement | null
    const r = canvas?.getBoundingClientRect()
    const de = document.documentElement
    return {
      canvasW: r ? Math.round(r.width) : 0,
      canvasH: r ? Math.round(r.height) : 0,
      scrollH: Math.max(de.scrollHeight, document.body.scrollHeight),
      clientH: de.clientHeight,
      scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
      clientW: de.clientWidth,
      bodyMargin: getComputedStyle(document.body).margin,
    }
  })
}

// Content-area sizes of a 1280x800 and a 1280x720 window (title bar and menu
// bar excluded), as measured in the issue.
const SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: 'default 1280x800 window', w: 1264, h: 735 },
  { name: '1280x720 window', w: 1264, h: 655 },
]

test.describe('circsim viewport layout (#33)', () => {
  let app: ElectronApplication | undefined

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
    app = undefined
  })

  for (const size of SIZES) {
    test(`board stays usable and page does not scroll at ${size.name}`, async () => {
      const launched = await launch()
      app = launched.app
      const page = launched.page
      await setContentSize(app, size.w, size.h)

      await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
      await page.locator('[data-testid="open-sample-btn"]').click()
      await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(500)

      const loaded = await measure(page)
      expect.soft(loaded.bodyMargin, 'body margin reset').toBe('0px')
      expect.soft(loaded.scrollH, 'no vertical page scroll (loaded)').toBeLessThanOrEqual(loaded.clientH)
      expect.soft(loaded.scrollW, 'no horizontal page scroll (loaded)').toBeLessThanOrEqual(loaded.clientW)
      expect.soft(loaded.canvasH, 'board canvas height (loaded)').toBeGreaterThanOrEqual(MIN_BOARD_H)
      expect.soft(loaded.canvasW, 'board canvas width (loaded)').toBeGreaterThanOrEqual(MIN_BOARD_W)

      await page.locator('[data-testid="energize-btn"]').click()
      await page.waitForTimeout(3000)

      const energized = await measure(page)
      expect.soft(energized.scrollH, 'no vertical page scroll (energized)').toBeLessThanOrEqual(energized.clientH)
      expect.soft(energized.canvasH, 'board canvas height (energized)').toBeGreaterThanOrEqual(MIN_BOARD_H)
      expect.soft(energized.canvasW, 'board canvas width (energized)').toBeGreaterThanOrEqual(MIN_BOARD_W)
    })
  }

  test('collapsing the shelf and the dock gives the height back to the board', async () => {
    const launched = await launch()
    app = launched.app
    const page = launched.page
    await setContentSize(app, 1264, 655)

    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)

    try {
      const before = await measure(page)
      await page.locator('[data-testid="shelf-toggle"]').click()
      await page.locator('[data-testid="dock-toggle"]').click()
      await page.waitForTimeout(500)
      const after = await measure(page)

      await expect(page.locator('[data-testid="bench-panels"]')).toHaveCount(0)
      await expect(page.locator('[data-testid="bottom-dock-collapsed"]')).toBeVisible()
      expect(after.canvasH).toBeGreaterThan(before.canvasH + 100)
      expect(after.scrollH).toBeLessThanOrEqual(after.clientH)
    } finally {
      // Belt and braces: never leave a collapse flag behind.
      await page.evaluate(() => {
        localStorage.removeItem('circsim.layout.collapsed.shelf')
        localStorage.removeItem('circsim.layout.collapsed.dock')
      })
    }
  })
})
