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

/**
 * What is left on the UI thread after the fix is receiving the board
 * (structured clone) and building the scene, and that scales with the machine: a CI runner measured about 1300 ms where the
 * developer box measured 360 ms. A fixed millisecond budget therefore either
 * fails slow runners or lets the regression through on fast ones.
 *
 * So the budget is a multiple of this machine's speed, measured in the same
 * page just before the open: CALIBRATION_MS is how long a fixed clone-and-build
 * workload takes here. The budget is BUDGET_PER_CALIBRATION times that, which
 * sits at about 2.5 times the post-fix gap and about 0.6 of the pre-fix freeze
 * (measured on the developer box: calibration 91 ms, post-fix gap 330-530 ms,
 * pre-fix freeze 2100 ms). FLOOR_MS stops a very fast machine from setting a
 * budget below frame-scheduling noise.
 */
const BUDGET_PER_CALIBRATION = 14
const FLOOR_MS = 1000

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

    // This machine's speed: the best of five runs of a fixed workload shaped
    // like the work that stays on the UI thread (clone a board-sized object
    // graph, then build many small derived records from it).
    const calibrationMs = await page.evaluate(() => {
      const make = (): unknown => {
        const tracks = []
        for (let i = 0; i < 80000; i++) {
          tracks.push({ net: i % 900, layer: i % 2 ? 'F.Cu' : 'B.Cu', w: 0.25, a: { x: i * 0.1, y: i * 0.2 }, b: { x: i * 0.3, y: i * 0.1 } })
        }
        return { tracks }
      }
      const src = make()
      let best = Infinity
      for (let run = 0; run < 5; run++) {
        const t = performance.now()
        const copy = structuredClone(src) as { tracks: { net: number; a: { x: number; y: number }; b: { x: number; y: number } }[] }
        const verts = new Float32Array(copy.tracks.length * 4)
        let acc = 0
        copy.tracks.forEach((tr, i) => {
          verts[i * 4] = tr.a.x
          verts[i * 4 + 1] = tr.a.y
          verts[i * 4 + 2] = tr.b.x
          verts[i * 4 + 3] = tr.b.y
          acc += tr.net
        })
        if (acc < 0) throw new Error('unreachable')
        best = Math.min(best, performance.now() - t)
      }
      return best
    })
    const budgetMs = Math.max(FLOOR_MS, calibrationMs * BUDGET_PER_CALIBRATION)

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
        `critic shown ${settledMs} ms, longest frame gap ${maxGap.toFixed(0)} ms, ` +
        `calibration ${calibrationMs.toFixed(1)} ms, budget ${budgetMs.toFixed(0)} ms`,
    )

    expect(maxGap).toBeLessThan(budgetMs)
  })
})
