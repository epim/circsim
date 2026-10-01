/**
 * e2e/big-board-open.spec.ts (issue #55)
 *
 * Opens the 1500-part, 20k-track synthetic board the issue measured and records
 * how long the renderer's main thread is blocked while it opens. Before the fix
 * the open ran parse, extract, resolve and the Board Critic audit inline on the
 * UI thread: the window produced no frame for about 2.1 s and showed no
 * progress. After it, those stages run in a Worker and the longest gap is the
 * cost of receiving the board and building the scene.
 *
 * The measure is taken in the page: the longest requestAnimationFrame delta,
 * i.e. how long the window was frozen as the user sees it. (The 'longtask'
 * PerformanceObserver reports nothing in this Electron renderer, even across a
 * 2 s block, so it is not used.)
 *
 * Prerequisites: npm run build.
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeAppOutput } from './util'
import { pathToFileURL } from 'url'
import type { BigBoardSize } from '../scripts/gen-big-board.mjs'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

/** Pre-fix freeze: about 2100 ms here. Post-fix: about 400 ms. The budget sits between, with room for a slow CI runner. */
const MAX_FROZEN_MS = 1200

test.describe('big board open (issue #55)', () => {
  let app: ElectronApplication | undefined
  let dir: string | undefined

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('opening a 1500-part board never freezes the window', async () => {
    test.setTimeout(180_000)
    dir = mkdtempSync(join(tmpdir(), 'circsim-big-'))
    const boardPath = join(dir, 'big.kicad_pcb')
    // The generator is an ES module; Playwright's loader transpiles specs to
    // CJS, so load it through a real dynamic import.
    const gen = (await new Function('u', 'return import(u)')(
      pathToFileURL(join(__dirname, '..', 'scripts', 'gen-big-board.mjs')).href,
    )) as { bigBoardText(size: BigBoardSize): string; ISSUE_BIG: BigBoardSize }
    const text = gen.bigBoardText(gen.ISSUE_BIG)
    writeFileSync(boardPath, text)

    app = await electron.launch({ args: [APP_MAIN], env: { ...process.env, CIRCSIM_E2E: '1' } })
    pipeAppOutput(app)
    const page = await app.firstWindow()
    await page.waitForLoadState('load')
    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 30_000 })

    // Answer the native dialog with the generated board.
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
    }, boardPath)

    await page.evaluate(() => {
      const w = window as unknown as {
        __frameGaps: number[]
        __probeOn: boolean
      }
      w.__frameGaps = []
      w.__probeOn = true
      let last = performance.now()
      const tick = (now: number): void => {
        w.__frameGaps.push(now - last)
        last = now
        if (w.__probeOn) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    const t0 = Date.now()
    await page.locator('[data-testid="open-board-header-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 120_000 })
    const boardVisibleMs = Date.now() - t0
    // Let the audit land and the scene settle before reading the probes.
    await expect(page.locator('[data-testid="critic-panel"]')).toBeVisible({ timeout: 120_000 })
    const settledMs = Date.now() - t0

    const maxGap = await page.evaluate(() => {
      const w = window as unknown as { __frameGaps: number[]; __probeOn: boolean }
      w.__probeOn = false
      return Math.max(0, ...w.__frameGaps)
    })

    // eslint-disable-next-line no-console
    console.log(
      `[big-board-open] ${(text.length / 1e6).toFixed(1)} MB: board visible ${boardVisibleMs} ms, ` +
        `critic shown ${settledMs} ms, longest frame gap ${maxGap.toFixed(0)} ms`,
    )

    expect(maxGap).toBeLessThan(MAX_FROZEN_MS)
  })
})
