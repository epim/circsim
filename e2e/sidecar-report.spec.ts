/**
 * e2e/sidecar-report.spec.ts - issue #27, through the real main process.
 *
 * Covers what unit tests cannot: the main-process IPC handlers behind the setup
 * file (read, atomic write, board-path-only guard), the restore note on open,
 * the opt-in save, the recent-boards list, and the report export to markdown
 * and to a real PDF.
 *
 * The native open and save dialogs are stubbed in the main process so the test
 * can choose paths.
 *
 * Prerequisites: npm run build.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inflateSync } from 'zlib'
import { pipeAppOutput } from './util'

const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')
const FIXTURE = join(__dirname, '..', 'fixtures', 'fixture-555.kicad_pcb')

/**
 * Every distinct "r g b" non-stroking fill colour in a PDF's page content,
 * rounded to two decimals. Inflates the Flate streams; fonts and images that do
 * not inflate as text are skipped.
 */
function pdfFillColors(pdf: Buffer): string[] {
  const colors = new Set<string>()
  const raw = pdf.toString('latin1')
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    let text: string
    try {
      text = inflateSync(pdf.subarray(start, end)).toString('latin1')
    } catch {
      continue
    }
    for (const c of text.matchAll(/(\d*\.?\d+) (\d*\.?\d+) (\d*\.?\d+) rg\b/g)) {
      colors.add([c[1], c[2], c[3]].map(v => Number(v).toFixed(2)).join(' '))
    }
  }
  return [...colors]
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'circsim-e2e-userdata-'))
  const app = await electron.launch({
    args: [APP_MAIN, `--user-data-dir=${userData}`],
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  pipeAppOutput(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  await page.waitForTimeout(2500)
  return { app, page }
}

/** Make the native open dialog return `path`. */
async function stubOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog
  }, path)
}

/** Make the native save dialog return `path`. */
async function stubSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog
  }, path)
}

function workBoard(): { dir: string; board: string; sidecar: string } {
  const dir = mkdtempSync(join(tmpdir(), 'circsim-e2e-board-'))
  const board = join(dir, 'blinker.kicad_pcb')
  copyFileSync(FIXTURE, board)
  return { dir, board, sidecar: join(dir, 'blinker.circsim.json') }
}

test.describe('setup file and report (issue #27)', () => {
  let app: ElectronApplication | null = null
  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
    app = null
  })

  test('the setup bridge only reads and writes a setup file beside a .kicad_pcb', async () => {
    const launched = await launch()
    app = launched.app
    const { page } = launched
    const { dir, board, sidecar } = workBoard()

    expect(await page.evaluate(p => window.circsim.readSidecar(p), board)).toEqual({ exists: false })

    await page.evaluate(([b, t]) => window.circsim.writeSidecar(b, t), [board, '{"format":"circsim-sidecar","version":1}'])
    expect(existsSync(sidecar)).toBe(true)
    expect(readFileSync(sidecar, 'utf8')).toBe('{"format":"circsim-sidecar","version":1}')
    const read = await page.evaluate(p => window.circsim.readSidecar(p), board)
    expect(read.exists).toBe(true)
    expect(read.text).toContain('circsim-sidecar')

    // A second write with backup keeps the original.
    await page.evaluate(([b, t]) => window.circsim.writeSidecar(b, t, { backupExisting: true }), [board, '{"v":2}'])
    expect(readFileSync(sidecar + '.bak', 'utf8')).toContain('circsim-sidecar')
    expect(readFileSync(sidecar, 'utf8')).toBe('{"v":2}')

    // Anything that is not a board path is refused; no file appears.
    const target = join(dir, 'notes.txt')
    const refused = await page.evaluate(async t => {
      try {
        await window.circsim.writeSidecar(t, 'x')
        return 'wrote'
      } catch {
        return 'refused'
      }
    }, target)
    expect(refused).toBe('refused')
    expect(existsSync(join(dir, 'notes.circsim.json'))).toBe(false)
  })

  test('opening a board restores its saved setup and shows the note', async () => {
    const { dir, board, sidecar } = workBoard()
    void dir
    writeFileSync(
      sidecar,
      JSON.stringify({
        format: 'circsim-sidecar',
        version: 1,
        ground: { net: 'GND' },
        railOverrides: { OUT: 3.3 },
        stubs: { D1: 'open' },
      }),
    )
    const launched = await launch()
    app = launched.app
    const { page } = launched
    await stubOpenDialog(app, board)
    await page.getByTestId('open-board-btn').click()

    await expect(page.getByTestId('setup-restored-note')).toContainText('Restored 3 saved settings from blinker.circsim.json')
    // A setup file exists, so autosave is on and there is no save offer.
    await expect(page.getByTestId('setup-save-btn')).toHaveCount(0)
    await expect(page.getByTestId('setup-autosave-status')).toBeVisible()
  })

  test('a damaged setup file never blocks the open', async () => {
    const { board, sidecar } = workBoard()
    writeFileSync(sidecar, '{"format":"circsim-sidecar","version":1,"ground":{"net":"GND"},"railOverrides":{"OUT":3.3},"inst')
    const launched = await launch()
    app = launched.app
    const { page } = launched
    await stubOpenDialog(app, board)
    await page.getByTestId('open-board-btn').click()
    await expect(page.getByTestId('setup-restored-note')).toContainText('Restored')
    await expect(page.getByTestId('setup-restored-note')).toContainText('note')
    await expect(page.getByTestId('parts-panel')).toBeVisible()
  })

  test('saving is opt-in; recent boards; report export to markdown and PDF', async () => {
    const { dir, board, sidecar } = workBoard()
    const launched = await launch()
    app = launched.app
    const { page } = launched

    await stubOpenDialog(app, board)
    await page.getByTestId('open-board-btn').click()

    // No setup file yet: nothing is written until the user asks.
    await expect(page.getByTestId('setup-save-btn')).toBeVisible()
    await page.waitForTimeout(800)
    expect(existsSync(sidecar)).toBe(false)

    await page.getByTestId('setup-save-btn').click()
    await expect.poll(() => existsSync(sidecar), { timeout: 10_000 }).toBe(true)
    const saved = JSON.parse(readFileSync(sidecar, 'utf8'))
    expect(saved.format).toBe('circsim-sidecar')
    expect(saved.version).toBe(1)
    expect(saved.board.fileName).toBe('blinker.kicad_pcb')

    // Report: markdown.
    const outDir = join(dir, 'out')
    mkdirSync(outDir)
    const md = join(outDir, 'report.md')
    await stubSaveDialog(app, md)
    await page.getByTestId('export-report-btn').click()
    await page.getByTestId('export-report-md').click()
    await expect.poll(() => existsSync(md), { timeout: 10_000 }).toBe(true)
    const text = readFileSync(md, 'utf8')
    expect(text).toContain('# circsim report: blinker.kicad_pcb')
    expect(text).toMatch(/Board sha256: [0-9a-f]{64}/)
    expect(text).toContain('## Part models')

    // Report: PDF.
    const pdf = join(outDir, 'report.pdf')
    await stubSaveDialog(app, pdf)
    await page.getByTestId('export-report-btn').click()
    await page.getByTestId('export-report-pdf').click()
    await expect.poll(() => existsSync(pdf), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // The report's inline <style> must survive the session's CSP: the table header
    // fill (th { background: #eee }) is a "0.93 0.93 0.93 rg" fill in the page
    // content. Without the stylesheet the PDF has no such fill.
    expect(pdfFillColors(readFileSync(pdf))).toContain('0.93 0.93 0.93')

    // Recent boards: after a restart the board is on the start screen list.
    const recent = await page.evaluate(() => window.circsim.getRecentBoards())
    expect(recent[0]).toBe(board)
  })

  test('a dropped lead records its copper position in board millimetres', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circsim-e2e-lead-'))
    const board = join(dir, 'first-light.kicad_pcb')
    copyFileSync(join(__dirname, '..', 'resources', 'sample', 'first-light.kicad_pcb'), board)
    const launched = await launch()
    app = launched.app
    const { page } = launched
    await stubOpenDialog(app, board)
    await page.getByTestId('open-board-btn').click()
    await expect(page.getByTestId('part-row').first()).toBeVisible({ timeout: 15_000 })

    // Drag a new voltage probe's jack onto the first lead clip (a pad of the board).
    await page.getByTestId('add-instrument-btn').click()
    await page.getByTestId('palette-voltage-probe').click()
    const openJack = page.locator('[data-testid^="jack-voltage_probe"][data-wired="false"]')
    await expect(openJack).toBeVisible()
    const clip = page.getByTestId('lead-clip').first()
    const clipX = Number(await clip.getAttribute('data-x'))
    const clipY = Number(await clip.getAttribute('data-y'))
    const layerBox = (await page.getByTestId('lead-layer').boundingBox())!
    const jackBox = (await openJack.boundingBox())!
    // The clip anchor is projected from a point slightly above the pad, so the
    // pixel exactly under it can miss the copper by a few px (it depends on the
    // canvas size). Try the anchor and a few nearby pixels, as first-light.spec
    // does; the first pixel that raycasts onto the net wires the jack.
    for (const [dx, dy] of [[0, 0], [0, -8], [0, -12], [0, -4], [0, 8], [8, 0], [-8, 0]]) {
      if ((await openJack.count()) === 0) break
      await page.mouse.move(jackBox.x + jackBox.width / 2, jackBox.y + jackBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(layerBox.x + clipX + dx, layerBox.y + clipY + dy, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(150)
    }
    await expect(openJack).toHaveCount(0)

    await page.getByTestId('setup-save-btn').click()
    const sidecar = join(dir, 'first-light.circsim.json')
    await expect.poll(() => existsSync(sidecar), { timeout: 10_000 }).toBe(true)
    // Wait for the write that includes the probe (the first write may precede nothing else; poll).
    await expect
      .poll(() => (existsSync(sidecar) ? readFileSync(sidecar, 'utf8').includes('voltage-probe') : false), { timeout: 10_000 })
      .toBe(true)
    const saved = JSON.parse(readFileSync(sidecar, 'utf8'))
    const probe = saved.instruments.find((i: { instrument: { kind: string } }) => i.instrument.kind === 'voltage-probe')
    const pos = probe.leads.net
    // The demo's four pads sit at y = 12 mm, x = 14.09, 15.91, 24.09 and 25.91 mm
    // (KiCad frame, y down). A wrong sign or offset in the world to board
    // conversion lands outside this window.
    expect(pos.y).toBeGreaterThan(10)
    expect(pos.y).toBeLessThan(14)
    const nearestPadDx = Math.min(...[14.0875, 15.9125, 24.0875, 25.9125].map(x => Math.abs(x - pos.x)))
    expect(nearestPadDx).toBeLessThan(2)
  })
})
