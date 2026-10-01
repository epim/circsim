/**
 * Issues #6 and #7 against the REAL libngspice: the log lines ngspice 46 prints
 * for a model-less diode, an empty-valued capacitor, a bare resistor and a
 * valueless source are turned into per-part diagnostics by
 * ngspiceLogDiagnostic, and an "ok" part named in them is demoted.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'
import { ngspiceLogDiagnostic, applyDeckDiagnostics, type DeckDiagnostic } from '../../core/models/resolve'
import type { Resolution } from '../../core/models/types'

const haveNgspice = ngspiceResourcesAvailable()

async function logLinesFor(deckBody: string[]): Promise<string[]> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e) })
  try {
    await host.start()
    host.handleCommand({
      type: 'loadCircuit',
      deckLines: ['* circsim deck diagnostics', 'v1 vin 0 dc 5', ...deckBody, '.op', '.end'],
    })
    try {
      await host.runOp()
    } catch {
      // A deck ngspice refused to parse has no op to run; the log is what we want.
    }
  } finally {
    await host.dispose()
  }
  return events.flatMap((e) => (e.type === 'log' ? [e.text] : []))
}

function diagnose(lines: string[], refs: string[]): DeckDiagnostic[] {
  const out: DeckDiagnostic[] = []
  let prev: string | undefined
  for (const line of lines) {
    const d = ngspiceLogDiagnostic(line, prev, refs)
    if (d) out.push(d)
    prev = line
  }
  return out
}

describe.skipIf(!haveNgspice)('ngspice log lines become per-part diagnostics (real libngspice)', () => {
  it('a model-less diode card names D1 (could not find a valid modelname)', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'd_d1 a 0'])
    const diags = diagnose(lines, ['D1', 'R1'])
    expect(diags.map((d) => d.ref)).toContain('D1')
  }, 30_000)

  it('an empty-quoted capacitor names C1 (ignored!)', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'r2 a 0 1k', 'c_c1 a 0 ""'])
    const diags = diagnose(lines, ['C1', 'R1', 'R2'])
    expect(diags.map((d) => d.ref)).toContain('C1')
  }, 30_000)

  it('a resistor card with no value names R2 (ignored!)', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'r_r2 a 0'])
    const diags = diagnose(lines, ['R1', 'R2'])
    expect(diags.map((d) => d.ref)).toContain('R2')
  }, 30_000)

  it('a valueless source names BT1 (DC 0 assumed)', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'v_bt1 a 0'])
    const diags = diagnose(lines, ['BT1', 'R1'])
    expect(diags.map((d) => d.ref)).toContain('BT1')
  }, 30_000)

  it('a clean deck produces no diagnostics', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'r2 a 0 1k'])
    expect(diagnose(lines, ['R1', 'R2'])).toEqual([])
  }, 30_000)

  it('applying the diagnostics leaves no ok part behind for the offending ref', async () => {
    const lines = await logLinesFor(['r1 vin a 1k', 'd_d1 a 0'])
    const ok: Resolution = {
      ref: 'D1', status: 'ok', tier: 1, warnings: [],
      model: { kind: 'primitive', card: 'd_d1 a 0' },
    }
    const out = applyDeckDiagnostics([ok], diagnose(lines, ['D1']))
    expect(out[0].status).not.toBe('ok')
  }, 30_000)
})
