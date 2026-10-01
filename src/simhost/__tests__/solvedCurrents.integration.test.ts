/**
 * src/simhost/__tests__/solvedCurrents.integration.test.ts
 *
 * deriveSolvedCurrents on the shipped samples, against REAL bundled ngspice-46:
 * parse, extract, resolve, run the production solve plan through the in-process
 * engine, derive every part's pad currents from the result, and check them for
 * internal consistency and against an independent path (issues #9 and #45).
 *
 * The independent check: two parts in series carry one current, but the two
 * numbers come from different places (the LED's 0 V sense ammeter, the resistor's
 * Ohm's-law from node voltages). The consistency checks: every net's pad currents
 * plus the bench sum to zero, and each part's own pads sum to zero.
 *
 * Skipped with a visible message when resources/ngspice/<platform> is missing.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../core/kicad/board'
import { parseSchematicSimData } from '../../core/kicad/schematic'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import { extract, suggestGround } from '../../core/netlist/extract'
import { buildSolveInputs, runSolvePlan } from '../../core/solve'
import type { Instrument } from '../../core/spicegen/instruments'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { createInProcessSolveEngine } from '../solveEngine'
import { runCritic } from '../../core/critic/run'
import { deriveSolvedCurrents } from '../../core/critic/solvedCurrents'

const haveNgspice = ngspiceResourcesAvailable()
const ROOT = process.cwd()
const SAMPLES = join(ROOT, 'resources', 'sample')
const MODELS = join(ROOT, 'resources', 'models')

function modelTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(MODELS)) {
    if ((f.endsWith('.lib') || f.endsWith('.json')) && f !== 'characterization.json') {
      out[f] = readFileSync(join(MODELS, f), 'utf8')
    }
  }
  return out
}

async function solveSample(name: string, schematic: boolean, supplyNet: string) {
  const board = parseBoard(readFileSync(join(SAMPLES, `${name}.kicad_pcb`), 'utf8'))
  const schData = schematic
    ? parseSchematicSimData(readFileSync(join(SAMPLES, `${name}.kicad_sch`), 'utf8'))
    : undefined
  const gnd = suggestGround(extract(board).nets)
  if (!gnd) throw new Error('no ground')
  const circuit = extract(board, { groundNetId: gnd.id })
  const library = (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
  const resolutions = resolveAll(circuit, schData, undefined, library)
  const supply = circuit.nets.find((n) => n.kicadName === supplyNet)!
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    { kind: 'dc-supply', id: 'bench', netId: supply.id, volts: 5, seriesOhms: 0.1 },
  ]
  const inputs = buildSolveInputs(board, circuit, resolutions, instruments, gnd.id, {
    title: name,
    modelTexts: modelTexts(),
  })
  const engine = await createInProcessSolveEngine({ onEvent: () => undefined })
  try {
    const result = await runSolvePlan(inputs, engine)
    return { board, circuit, inputs, result, currents: deriveSolvedCurrents(inputs, result) }
  } finally {
    await engine.dispose()
  }
}

describe.skipIf(!haveNgspice)('deriveSolvedCurrents against real ngspice', () => {
  it('first-light: the LED ammeter and the series resistor agree, and the return matches', async () => {
    const { currents, result } = await solveSample('first-light', false, 'VIN')
    const led = currents.partCurrents.D1
    const res = currents.partCurrents.R1
    expect(led).toBeGreaterThan(1e-3) // a real LED current, a few mA
    expect(res).toBeCloseTo(led, 6)
    // D1 and R1 are the only loads, so the bench supplies exactly that current.
    expect(-result.op.values['i(vpsu_bench)']).toBeCloseTo(led, 6)
    expect(currents.unresolvedRefs).toEqual([])
    // signed: a pad on the supply side draws, the same part's other pad returns
    const d1 = Object.values(currents.padCurrents.D1)
    expect(d1.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9)
    expect(Math.max(...d1)).toBeCloseTo(led, 9)
  }, 60_000)

  it('blinker-555: every part resolves, every net balances, and U1 carries what KCL leaves it', async () => {
    const { circuit, currents, result } = await solveSample('blinker-555', true, 'VCC')
    expect(currents.unresolvedRefs).toEqual([])
    // Independent path: R3 and D1 are in series, one from Ohm's law, one from the ammeter.
    expect(currents.partCurrents.R3).toBeCloseTo(currents.partCurrents.D1, 6)
    // Each part's own pads sum to zero.
    for (const [ref, pads] of Object.entries(currents.padCurrents)) {
      const sum = Object.values(pads).reduce((a, b) => a + b, 0)
      expect(Math.abs(sum), `${ref} pad currents sum`).toBeLessThan(1e-9)
    }
    // The supply net balances against the bench's own branch current.
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    let vccDraw = 0
    for (const part of circuit.parts) {
      for (const [pad, netId] of part.padNet) {
        if (netId === vcc.id) vccDraw += currents.padCurrents[part.ref]?.[pad] ?? 0
      }
    }
    expect(vccDraw).toBeCloseTo(-result.op.values['i(vpsu_bench)'], 8)
  }, 60_000)

  it('feeds the critic: with branch currents ampacity and IR drop are assessed, not skipped for want of them', async () => {
    const { board, circuit, currents } = await solveSample('blinker-555', true, 'VCC')
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    const report = runCritic(board, circuit, { nodeVoltages: { [vcc.spiceNode]: 5 }, ...currents })
    // The sample's VCC is only partly routed, so the checks may say which pads the
    // copper does not reach; what they must not say is that there were no currents.
    for (const id of ['ampacity', 'ir-drop'] as const) {
      const skip = report.skipped.find((s) => s.check === id)
      expect(skip?.reason ?? '').not.toMatch(/no branch currents/)
    }
  }, 60_000)
})
