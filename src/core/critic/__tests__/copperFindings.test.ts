import { describe, expect, it } from 'vitest'
import { buildCopperNetwork, type CopperOp } from '../../copper'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { withCopperFindings } from '../copperFindings'
import type { CriticReport } from '../types'

function fixture(lead = false) {
  const board = parseBoard(`(kicad_pcb (version 20240108) (net 0 "") (net 1 "SIGNAL")
    (footprint "Connector" (layer "F.Cu") (at 10 20 90)
      (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd rect (at 2 3 90) (size 1 1) (layers "F.Cu") (net 1 "SIGNAL")))
    (footprint "Connector" (layer "F.Cu") (at 30 20)
      (fp_text reference "J2" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIGNAL"))))`)
  const network = buildCopperNetwork(board, extract(board), { allNets: true,
    supplyEntries: lead ? [{ netId: 1, pos: { x: 13, y: 18 } }] : undefined,
  })
  const copper: CopperOp = { network, method: 'failed', unreachedPads: network.unreachedPads,
    nodeVoltages: {}, padVoltages: {}, padCurrents: {}, edgeCurrents: [], partPower: {},
  }
  const report: CriticReport = { findings: [], ranBy: ['floating'], skipped: [{ check: 'thermal', reason: 'no electrical readings' }], summary: { error: 0, warn: 0, info: 0 } }
  return { board, copper, report }
}

describe('shared copper-gap findings adapter', () => {
  it('keeps geometry findings after a failed solve without changing electrical assessment', () => {
    const { board, copper, report } = fixture()
    const before = JSON.stringify({ board, copper, report })
    const result = withCopperFindings(report, board, copper)
    expect(result.findings.map(finding => finding.id)).toEqual(['floating:copper-gap:J1:1', 'floating:copper-gap:J2:1'])
    expect(result.findings[0]).toMatchObject({ check: 'floating', severity: 'warn', refs: ['J1'], netId: 1, location: { x: 13, y: 18 } })
    expect(result.findings[0].detail).toContain('physical copper network')
    expect(result.ranBy).toEqual(report.ranBy)
    expect(result.skipped).toEqual(report.skipped)
    expect(result.summary).toEqual({ error: 0, warn: 2, info: 0 })
    expect(JSON.stringify({ board, copper, report })).toBe(before)
  })

  it('does not describe a guessed signal-net anchor as an attached bench lead', () => {
    const { board, copper, report } = fixture()
    expect(withCopperFindings(report, board, copper).findings[0].detail).not.toContain('A lead feeds')
    const attached = fixture(true)
    expect(withCopperFindings(attached.report, attached.board, attached.copper).findings[0].detail).toContain('A lead feeds')
  })

  it('retains existing findings and counts only the appended warnings', () => {
    const { board, copper, report } = fixture()
    report.findings.push({ id: 'existing', check: 'clearance', severity: 'error', title: 'Existing', detail: 'Existing' })
    report.summary.error = 1
    const result = withCopperFindings(report, board, copper)
    expect(result.findings[0]).toBe(report.findings[0])
    expect(result.summary).toEqual({ error: 1, warn: 2, info: 0 })
  })

  it('keeps gaps when their footprint geometry is unavailable', () => {
    const { board, copper, report } = fixture()
    copper.unreachedPads = [{ ref: 'MISSING', padNumber: '7', netId: 1, hasCopper: true, connectedToSource: false, isSource: false }]
    const finding = withCopperFindings(report, board, copper).findings[0]
    expect(finding.title).toContain('no copper path')
    expect(finding.location).toBeUndefined()
  })

  it('returns the original report when no gap data needs adding', () => {
    const { board, copper, report } = fixture()
    expect(withCopperFindings(report, board)).toBe(report)
    copper.unreachedPads = []
    expect(withCopperFindings(report, board, copper)).toBe(report)
  })
})
