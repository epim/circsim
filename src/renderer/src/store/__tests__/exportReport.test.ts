/**
 * exportReport.test.ts - issue #27: the report built from the live store.
 *
 * The board is opened, a bench is rigged, an operating point is injected, and
 * the exported markdown / HTML is checked for the file name and sha256, the
 * bench with lead positions, the resolution table, the op-point table and the
 * Board Critic findings.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { createAppStore, AUTO_SUPPLY_ID } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { exportReport, suggestedReportName, type ReportExportApi } from '../exportReport'
import { buildReportInput } from '../reportInput'

const BOARD_TEXT = readFileSync(join(__dirname, '../../../../../fixtures/fixture-555.kicad_pcb'), 'utf-8')

async function openedStore(): Promise<ReturnType<typeof createAppStore>> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(BOARD_TEXT, 'fixture-555.kicad_pcb', { boardPath: '/w/fixture-555.kicad_pcb' })
  // The board hash lands asynchronously after open.
  await vi.waitFor(() => expect(store.getState().project.boardSha256).not.toBeNull())
  return store
}

function netId(store: ReturnType<typeof createAppStore>, name: string): number {
  return store.getState().circuit!.nets.find(n => n.kicadName === name)!.id
}

describe('buildReportInput / exportReport', () => {
  it('hashes the board text exactly as sha256 of the file bytes', async () => {
    const store = await openedStore()
    expect(store.getState().project.boardSha256).toBe(createHash('sha256').update(BOARD_TEXT, 'utf8').digest('hex'))
  })

  it('exports markdown with the file, hash, bench, models, op point and critic', async () => {
    const store = await openedStore()
    const s = store.getState()
    s.removeInstrument(AUTO_SUPPLY_ID)
    const sup = s.addBenchInstrument('dc-supply')
    s.assignTerminal(sup, 'net', { kind: 'net', netId: netId(store, 'VCC') }, { x: 12.5, y: -30.25 })
    s.stubPart('D1', 'open')
    s.setRailOverride('OUT', 3.3)
    store.setState({ opVoltages: new Map([[netId(store, 'VCC'), 5], [netId(store, 'GND'), 0]]) })
    store.getState().runCriticAudit()

    const calls: Parameters<ReportExportApi['exportReport']>[0][] = []
    const api: ReportExportApi = {
      async exportReport(req) {
        calls.push(req)
        return { cancelled: false, filePath: '/out/report.md' }
      },
    }
    const res = await exportReport(store, 'md', api, { appVersion: '9.9.9', now: () => new Date('2026-09-30T00:00:00Z') })
    expect(res).toEqual({ cancelled: false, filePath: '/out/report.md' })
    expect(calls).toHaveLength(1)
    expect(calls[0].format).toBe('md')
    expect(calls[0].suggestedName).toBe('fixture-555-report')
    const md = calls[0].content
    expect(md).toContain('# circsim report: fixture-555.kicad_pcb')
    expect(md).toContain(`Board sha256: ${store.getState().project.boardSha256}`)
    expect(md).toContain('KiCad format version: 20221018 (pcbnew)')
    expect(md).toContain('circsim version: 9.9.9')
    expect(md).toContain('Generated: 2026-09-30T00:00:00.000Z')
    expect(md).toContain('Ground net: GND')
    expect(md).toMatch(/\| dc_supply_bench_\d+ \| dc-supply \| net VCC \| 5 V, 0.1 ohm series \| net lead at \(12.50, -30.25\) mm \|/)
    expect(md).toContain('D1: stubbed as open')
    expect(md).toContain('OUT: rail set to 3.300 V')
    expect(md).toMatch(/\| D1 \| .* \| stubbed \| 6 \| stub \(open\) \|/)
    expect(md).toMatch(/\| VCC \| 5.000 \|/)
    expect(md).toContain('## Board Critic findings')
    expect(md).toContain('D1 is stubbed (open), not modeled.')
  })

  it('exports standalone HTML for the PDF path', async () => {
    const store = await openedStore()
    let got: Parameters<ReportExportApi['exportReport']>[0] | null = null
    await exportReport(store, 'pdf', { exportReport: async req => { got = req; return { cancelled: true } } }, { appVersion: '1' })
    expect(got!.format).toBe('pdf')
    expect(got!.content.startsWith('<!doctype html>')).toBe(true)
    expect(got!.content).toContain('<table>')
    expect(got!.content).not.toContain('<script')
  })

  it('does nothing without a board', async () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    const api: ReportExportApi = { exportReport: async () => { throw new Error('should not be called') } }
    expect(await exportReport(store, 'md', api, { appVersion: '1' })).toBeNull()
  })

  it('a report built without any operating point says so', async () => {
    const store = await openedStore()
    const input = buildReportInput(store.getState(), { appVersion: '1', generatedAt: 'x' })
    expect(input.op).toBeNull()
  })

  it('suggestedReportName strips the extension and falls back', () => {
    expect(suggestedReportName('blinker.kicad_pcb')).toBe('blinker-report')
    expect(suggestedReportName('C:\\x\\amp.KICAD_PCB')).toBe('amp-report')
    expect(suggestedReportName(null)).toBe('circsim-report')
  })
})
