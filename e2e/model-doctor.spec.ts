/**
 * e2e/model-doctor.spec.ts: Model Doctor end to end (issue #66).
 *
 * The bundled samples resolve every part, so the Doctor drawer never appears on
 * them. This opens a small board that deliberately carries one part no model
 * library knows (U9, "UNKNOWN-IC-9000") and walks the Doctor path: the drawer
 * appears with a "no model" card, "Stub open" moves the part to "stubbed",
 * and Reset takes it back.
 *
 * The board is derived at test time from fixtures/fixture-rc.kicad_pcb into the
 * OS temp dir (nothing new is committed), and opened by stubbing the native
 * open dialog in the main process, since Playwright cannot drive it.
 *
 * Prerequisite: npm run build.
 */

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchBuiltApp } from './util'

const BASE_BOARD = join(__dirname, '..', 'fixtures', 'fixture-rc.kicad_pcb')

/** fixture-rc with R2 swapped for a part nothing can resolve. */
function unknownPartBoard(): string {
  let text = readFileSync(BASE_BOARD, 'utf8')
  const r2Start = text.indexOf('(footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")\n    (at 20 10)')
  expect(r2Start, 'R2 footprint found in fixture-rc').toBeGreaterThan(0)
  const head = text.slice(0, r2Start)
  const tail = text
    .slice(r2Start)
    .replace('"Resistor_SMD:R_0805_2012Metric"', '"Package_SO:SOIC-8_3.9x4.9mm_P1.27mm"')
    .replace('"R2"', '"U9"')
    .replace('"10k"', '"UNKNOWN-IC-9000"')
  text = head + tail
  const dir = mkdtempSync(join(tmpdir(), 'circsim-e2e-'))
  const file = join(dir, 'unknown-part.kicad_pcb')
  writeFileSync(file, text, 'utf8')
  return file
}

test.describe('Model Doctor E2E', () => {
  let app: ElectronApplication
  let boardFile: string | null = null

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
    if (boardFile) rmSync(join(boardFile, '..'), { recursive: true, force: true })
    boardFile = null
  })

  test('unresolved part: doctor card appears, Stub open stubs it, Reset restores it', async () => {
    boardFile = unknownPartBoard()
    const result = await launchBuiltApp()
    app = result.app
    const page = result.page

    // No board yet: the doctor drawer is absent.
    await expect(page.locator('[data-testid="model-doctor"]')).toHaveCount(0)

    // Answer the native open dialog with our board.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    }, boardFile)
    await page.locator('[data-testid="open-board-header-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 15_000 })

    // The doctor drawer lists exactly the unresolved part, as "no model".
    const doctor = page.locator('[data-testid="model-doctor"]')
    await expect(doctor).toBeVisible({ timeout: 10_000 })
    const card = doctor.locator('[data-ref="U9"]')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('doctor-status-pill')).toHaveAttribute('data-status', 'no-model')
    await expect(card).toContainText('UNKNOWN-IC-9000')
    await expect(doctor.locator('[data-ref]')).toHaveCount(1) // R1 resolved, not listed

    // The parts list marks it red, and the resolved resistor stays ok.
    await expect(page.locator('[data-testid="status-badge-red"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="status-badge-ok"]')).toHaveCount(1)

    // Stub open: the card flips to "stubbed" and a Reset action appears.
    await card.getByTestId('doctor-stub-open').click()
    await expect(card.getByTestId('doctor-status-pill')).toHaveAttribute('data-status', 'stubbed', { timeout: 10_000 })
    await expect(page.locator('[data-testid="status-badge-red"]')).toHaveCount(0)

    // Reset: the override is cleared and the part is unresolved again.
    await card.getByTestId('doctor-reset').click()
    await expect(card.getByTestId('doctor-status-pill')).toHaveAttribute('data-status', 'no-model', { timeout: 10_000 })
    await expect(page.locator('[data-testid="status-badge-red"]')).toHaveCount(1)
  })
})
