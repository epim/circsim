/**
 * e2e/critic.spec.ts: Board Critic end to end (issue #66).
 *
 * No other spec asserted anything about the critic. This drives the built app
 * on the bundled blinker-555 sample: open it, wait for the audit, and check the
 * Critic panel renders the report faithfully, before and after Energize.
 *
 * The assertions are structural on purpose. They pin that findings reach the UI
 * with a known check id and a matching severity count, not which findings the
 * sample produces today (those are tracked by the clearance, decoupling and
 * floating-pin issues and will change as the checks get fixed).
 *
 * Prerequisite: npm run build.
 */

import { test, expect, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { launchBuiltApp } from './util'

const SAMPLE_BOARD = join(__dirname, '..', 'resources', 'sample', 'blinker-555.kicad_pcb')
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

// Mirrors CheckId in src/core/critic/types.ts.
const KNOWN_CHECKS = ['floating', 'ir-drop', 'ampacity', 'decoupling', 'thermal', 'clearance', 'loop-area']
const SEVERITIES = ['error', 'warn', 'info']

interface Row {
  id: string
  check: string
  severity: string
}

async function readFindings(page: Page): Promise<Row[]> {
  return page.locator('[data-testid="critic-finding"]').evaluateAll(els =>
    els.map(e => ({
      id: e.getAttribute('data-finding-id') ?? '',
      check: e.getAttribute('data-check') ?? '',
      severity: e.getAttribute('data-severity') ?? '',
    })),
  )
}

/** The count in a "<n> <severity>" summary badge. */
async function badgeCount(page: Page, sev: string): Promise<number> {
  const text = (await page.locator(`[data-testid="critic-summary-${sev}"]`).textContent()) ?? ''
  const m = text.match(/^\s*(\d+)\s/)
  expect(m, `summary badge text "${text}"`).not.toBeNull()
  return Number(m![1])
}

async function expectPanelMatchesRows(page: Page): Promise<Row[]> {
  const rows = await readFindings(page)
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) {
    expect(KNOWN_CHECKS, `unknown check id on ${r.id}`).toContain(r.check)
    expect(SEVERITIES, `unknown severity on ${r.id}`).toContain(r.severity)
    // Stable ids are "<check>:<detail>" (types.ts), so the prefix must agree.
    expect(r.id.startsWith(`${r.check}:`), `id ${r.id} does not start with ${r.check}:`).toBe(true)
  }
  // Each summary badge equals the number of rendered rows of that severity.
  for (const sev of SEVERITIES) {
    expect(await badgeCount(page, sev)).toBe(rows.filter(r => r.severity === sev).length)
  }
  return rows
}

test.describe('Board Critic E2E', () => {
  let app: ElectronApplication

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
  })

  test('sample board: critic panel lists findings with known check ids', async () => {
    const result = await launchBuiltApp()
    app = result.app
    const page = result.page

    await expect(page.locator('[data-testid="open-sample-btn"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="open-sample-btn"]').click()

    // The audit runs on load and the panel appears with the report.
    await expect(page.locator('[data-testid="critic-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="critic-finding"]').first()).toBeVisible({ timeout: 10_000 })
    const before = await expectPanelMatchesRows(page)

    // Energize adds op-informed checks; the panel must still render a coherent
    // report afterwards, and the geometry-only findings must not vanish.
    await page.locator('[data-testid="energize-btn"]').click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="critic-panel"]')).toBeVisible()
    const after = await expectPanelMatchesRows(page)
    const afterIds = new Set(after.map(r => r.id))
    for (const r of before.filter(b => b.check === 'clearance' || b.check === 'decoupling')) {
      expect(afterIds.has(r.id), `${r.id} disappeared after Energize`).toBe(true)
    }
  })

  test('clicking a finding leaves the board file and the report untouched', async () => {
    const boardHashBefore = sha256(SAMPLE_BOARD)
    const result = await launchBuiltApp()
    app = result.app
    const page = result.page

    await page.locator('[data-testid="open-sample-btn"]').click()
    const first = page.locator('[data-testid="critic-finding"]').first()
    await expect(first).toBeVisible({ timeout: 20_000 })

    // The critic is read-only: selecting a finding only flies the camera and
    // highlights. The app must stay responsive and keep the same findings.
    const idsBefore = (await readFindings(page)).map(r => r.id)
    await first.click()
    await expect(page.locator('[data-testid="critic-panel"]')).toBeVisible()
    expect((await readFindings(page)).map(r => r.id)).toEqual(idsBefore)
    expect(sha256(SAMPLE_BOARD)).toBe(boardHashBefore)
  })
})
