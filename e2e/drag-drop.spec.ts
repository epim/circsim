/**
 * e2e/drag-drop.spec.ts (issue #34)
 *
 * Dropping a board file onto the window must resolve the file's real path via
 * the preload's webUtils.getPathForFile bridge (Electron 32 removed the
 * nonstandard File.path), so the project opens WITH its same-basename sibling
 * .kicad_sch. Without the path the drop silently falls back to File.text() and
 * the schematic-authoritative pin maps are lost.
 *
 * Playwright cannot start a native OS drag, so the test obtains genuine,
 * disk-backed File objects from an <input type=file> (setInputFiles) and
 * dispatches a synthetic `drop` event carrying them. webUtils.getPathForFile
 * resolves those exactly as it does for an OS drop; a JS-constructed File has
 * no path.
 *
 * Prerequisites: npm run build.
 */

import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeAppOutput } from './util'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')
const SAMPLE_DIR = join(__dirname, '..', 'resources', 'sample')
const BOARD = join(SAMPLE_DIR, 'blinker-555.kicad_pcb')
const SCHEMATIC = join(SAMPLE_DIR, 'blinker-555.kicad_sch')

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [APP_MAIN],
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  pipeAppOutput(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 30_000 })
  return { app, page }
}

/** Add a hidden file input to the page, fill it with real files, return its id. */
async function stageRealFiles(page: Page, id: string, filePaths: string[]): Promise<void> {
  await page.evaluate((inputId: string) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = inputId
    document.body.appendChild(input)
  }, id)
  await page.locator(`#${id}`).setInputFiles(filePaths)
}

/**
 * Drop real, disk-backed files (chosen through a file input so they carry a
 * path) onto the app root. `filePaths` are absolute paths.
 *
 * Every dropped File has its text() replaced with a rejecting stub that counts
 * its calls. The File.text() fallback in App.tsx would otherwise produce the
 * same UI as the by-path route, so a test could not tell them apart; with the
 * stub, only a successful getPathForFile resolution attaches anything.
 * `textFallbackCalls` reads back how many times text() was called (must be 0
 * on the by-path route).
 */
async function dropRealFiles(page: Page, filePaths: string[]): Promise<void> {
  const id = '__e2e-drop-source'
  await stageRealFiles(page, id, filePaths)
  await page.evaluate((inputId: string) => {
    const input = document.getElementById(inputId) as HTMLInputElement
    const w = window as unknown as { __e2eTextCalls?: number }
    w.__e2eTextCalls = 0
    const dt = new DataTransfer()
    for (const f of Array.from(input.files ?? [])) {
      f.text = () => {
        w.__e2eTextCalls = (w.__e2eTextCalls ?? 0) + 1
        return Promise.reject(new Error('File.text() fallback used; getPathForFile returned no path'))
      }
      dt.items.add(f)
    }
    // The drop handler lives on the App root element (first child of #root).
    const target = document.querySelector('#root > div') as HTMLElement
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    input.remove()
  }, id)
}

async function textFallbackCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __e2eTextCalls?: number }).__e2eTextCalls ?? -1)
}

test.describe('drag-drop path resolution (#34)', () => {
  let app: ElectronApplication
  let tmp: string | null = null

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // ignore if already closed
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = null
    }
  })

  test('preload getPathForFile resolves a real file to its absolute path', async () => {
    const r = await launchApp()
    app = r.app
    const page = r.page
    await stageRealFiles(page, '__e2e-path-source', [BOARD])
    const resolved = await page.evaluate(() => {
      const input = document.getElementById('__e2e-path-source') as HTMLInputElement
      return window.circsim.getPathForFile(input.files![0])
    })
    expect(resolved.toLowerCase()).toBe(BOARD.toLowerCase())
  })

  test('dropping a board auto-attaches its same-basename sibling schematic', async () => {
    const r = await launchApp()
    app = r.app
    const page = r.page

    await dropRealFiles(page, [BOARD])

    // The Schematic row names the attached file only when the sibling was
    // discovered via the real path (not the File.text() fallback).
    await expect(page.getByText('blinker-555.kicad_sch').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No schematic')).toHaveCount(0)
    expect(await textFallbackCalls(page)).toBe(0)
  })

  test('dropping a schematic onto a loaded board attaches it by path', async () => {
    // A board copied alone into a temp dir has no sibling schematic.
    tmp = mkdtempSync(join(tmpdir(), 'circsim-drop-'))
    const lonelyBoard = join(tmp, 'blinker-555.kicad_pcb')
    copyFileSync(BOARD, lonelyBoard)

    const r = await launchApp()
    app = r.app
    const page = r.page

    await dropRealFiles(page, [lonelyBoard])
    await expect(page.getByText('No schematic').first()).toBeVisible({ timeout: 30_000 })

    await dropRealFiles(page, [SCHEMATIC])
    await expect(page.getByText('blinker-555.kicad_sch').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('No schematic')).toHaveCount(0)
    expect(await textFallbackCalls(page)).toBe(0)
  })
})
