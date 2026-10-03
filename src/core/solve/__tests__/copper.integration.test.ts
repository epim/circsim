import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { resolveAll } from '../../models/resolve'
import { deriveSolvedCurrents } from '../../critic/solvedCurrents'
import { runCritic } from '../../critic/run'
import { buildDeck, buildSolveInputs } from '../inputs'
import { runSolvePlan } from '../plan'
import type { SolveEngine } from '../types'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseSchematicSimData } from '../../kicad/schematic'
import type { LibraryEntry } from '../../models/types'
import { LOGIC4000 } from './switchedRail.fixture'

const SIMHOST = '../../../simhost/'
const ffi = await import(/* @vite-ignore */ SIMHOST + 'ngspiceFfi')

async function withEngine<T>(run: (engine: SolveEngine) => Promise<T>): Promise<T> {
  const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
    createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
  }
  const engine = await createInProcessSolveEngine()
  try { return await run(engine) } finally { await engine.dispose() }
}

export function resistorBoard() {
  const board = parseBoard(`(kicad_pcb (version 20221018) (generator pcbnew)
    (general (thickness 1.6)) (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Connector:Conn_01x02" (layer "F.Cu") (at 0 0)
      (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0 5) (size 1 1) (layers "F.Cu") (net 2 "GND")))
    (footprint "Resistor_SMD:R_0805" (layer "F.Cu") (at 100 0)
      (property "PowerRating" "0.25W")
      (fp_text reference "R1" (at 0 0) (layer "F.SilkS"))
      (fp_text value "50" (at 0 0) (layer "F.Fab"))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 0 5) (size 1 1) (layers "F.Cu") (net 2 "GND")))
    (segment (start 0 0) (end 100 0) (width 0.25) (layer "F.Cu") (net 1))
    (segment (start 0 5) (end 100 5) (width 0.25) (layer "F.Cu") (net 2))
    (gr_rect (start -5 -5) (end 105 10) (layer "Edge.Cuts") (width 0.1)))`)
  const circuit = extract(board, { groundNetId: 2 })
  const resolutions = resolveAll(circuit)
  return { board, circuit, resolutions }
}

describe.skipIf(!ffi.ngspiceResourcesAvailable())('copper-aware operating point', () => {
  it('leaves unpowered resolved parts unknown and thermal not assessed', async () => {
    const f = resistorBoard()
    f.board.tracks = []
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    expect(result.copper!.partPower.R1).toBeUndefined()
    const report = runCritic(f.board, f.circuit, { nodeVoltages: result.op.values, copper: result.copper, ...deriveSolvedCurrents(inputs, result) })
    expect(report.skipped.some((s) => s.check === 'thermal')).toBe(true)
  }, 90_000)

  it.each(['CD40106', 'CD4011'])('%s outputs and supply return follow their local physical ground', async (templateId) => {
    const f = resistorBoard()
    const ground = f.board.footprints.find((p) => p.ref === 'R1')!
    f.board.footprints.push({ ...ground, ref: 'U1', value: 'CD40106', libId: 'DIP', pads: [
      { ...ground.pads[0], number: '14' },
      { ...ground.pads[1], number: '7' },
      { ...ground.pads[1], number: '1' },
      { ...ground.pads[0], number: '2', netId: 3 },
      { ...ground.pads[1], number: '3' },
    ] })
    f.board.netById.set(3, { id: 3, name: 'OUT' })
    ground.pads[0].netId = 3
    ground.value = '1k'
    const circuit = extract(f.board, { groundNetId: 2 })
    const resolutions = resolveAll(circuit).map((r) => r.ref === 'U1' ? {
      ...r, status: 'ok' as const, tier: 3 as const, model: {
        kind: 'xspice-digital' as const, templateId, pinMap: { '1': '1A', '2': '1Y', '3': '1B', '7': 'GND', '14': 'VCC' },
      },
    } : r)
    const inputs = buildSolveInputs(f.board, circuit, resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true, modelTexts: { 'logic4000.json': LOGIC4000 } })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    const copper = result.copper!
    expect(copper.padCurrents.U1['14']).toBeGreaterThan(0.001)
    expect(copper.padCurrents.U1['2']).toBeLessThan(-0.001)
    expect(copper.padVoltages.R1['2']).toBeGreaterThan(0)
    expect(copper.padVoltages.U1['2']).toBeLessThan(copper.padVoltages.U1['14'])
    expect(copper.partPower.U1).toBeGreaterThan(0)
    const imbalance = Math.abs(Object.values(copper.padCurrents.U1).reduce((sum, i) => sum + i, 0))
    expect(imbalance / copper.padCurrents.U1['14']).toBeLessThan(1e-4)
  }, 90_000)

  it('solves both copper legs and makes the critic read the very same pad voltages', async () => {
    const f = resistorBoard()
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    const copper = result.copper!
    const expectedA = 5 / (50 + 2 * 0.193103448276 + 0.001)
    expect(copper.padCurrents.R1['1']).toBeCloseTo(expectedA, 8)
    expect(copper.padCurrents.R1['2']).toBeCloseTo(-expectedA, 8)
    expect(copper.padVoltages.R1['2']).toBeCloseTo(expectedA * 0.193103448276, 8)
    expect(copper.partPower.R1).toBeCloseTo(expectedA ** 2 * 50, 8)
    expect(copper.edgeCurrents.map(Math.abs)).toEqual([expect.closeTo(expectedA, 8), expect.closeTo(expectedA, 8)])
    const report = runCritic(f.board, f.circuit, {
      nodeVoltages: result.op.values, copper, ...deriveSolvedCurrents(inputs, result),
    }, { irDropWarnPct: 0.1, irDropErrPct: 10 })
    const drop = report.findings.find((finding) => finding.check === 'ir-drop' && finding.netId === 1)!
    expect(drop.metrics!.dropV).toBeCloseTo(5 - 0.001 * expectedA - copper.padVoltages.R1['1'], 8)
    expect(drop.metrics!.groundShiftV).toBeCloseTo(copper.padVoltages.R1['2'], 8)
  }, 90_000)

  it('reports unloaded bundled 555 power as its solved supply voltage times current', async () => {
    const root = join(__dirname, '../../../..')
    const board = parseBoard(readFileSync(join(root, 'resources/sample/blinker-555.kicad_pcb'), 'utf8'))
    const raw = extract(board)
    const gnd = raw.nets.find((n) => n.kicadName === 'GND')!
    const circuit = extract(board, { groundNetId: gnd.id })
    const sch = parseSchematicSimData(readFileSync(join(root, 'resources/sample/blinker-555.kicad_sch'), 'utf8'))
    const modelDir = join(root, 'resources/models')
    const library = (JSON.parse(readFileSync(join(modelDir, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
    const resolutions = resolveAll(circuit, sch, undefined, library).map((r) => r.ref === 'U1' ? r : {
      ...r, model: { kind: 'stub' as const, mode: 'open' as const },
    })
    const modelTexts = Object.fromEntries(readdirSync(modelDir).filter((f) => /\.(lib|json)$/.test(f)).map((f) => [f, readFileSync(join(modelDir, f), 'utf8')]))
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    const inputs = buildSolveInputs(board, circuit, resolutions, [
      { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.1 },
    ], gnd.id, { copperAware: true, modelTexts, copperOptions: { supplyEntries: [
      { netId: vcc.id, pos: { x: 32.34, y: 21.905 } },
      { netId: gnd.id, pos: { x: 27.66, y: 21.905 } },
    ] } })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    const copper = result.copper!
    const supplyPower = (copper.padVoltages.U1['8'] - copper.padVoltages.U1['1']) * copper.padCurrents.U1['8']
    expect(supplyPower).toBeGreaterThan(0.01)
    expect(copper.partPower.U1).toBeCloseTo(supplyPower, 6)
    if (process.env.CIRCSIM_MEASURE_COPPER === '1') console.log(`POWER MEASUREMENT 555 reportedW=${copper.partPower.U1} supplyVIW=${supplyPower}`)
  }, 90_000)
  it('keeps the ideal deck unchanged unless copperAware is enabled', () => {
    const f = resistorBoard()
    const instruments = [{ kind: 'dc-supply' as const, id: '1', netId: 1, volts: 5, seriesOhms: 0.001 }]
    const ideal = buildSolveInputs(f.board, f.circuit, f.resolutions, instruments, 2)
    const off = buildSolveInputs(f.board, f.circuit, f.resolutions, instruments, 2, { copperAware: false })
    const aware = buildSolveInputs(f.board, f.circuit, f.resolutions, instruments, 2, { copperAware: true })
    expect(buildDeck(off)).toEqual(buildDeck(ideal))
    expect(buildDeck(aware).join('\n')).toContain('r_copper_')
  })

  it('avoids collisions with real net names and preserves an explicitly selected ground', () => {
    const f = resistorBoard()
    f.circuit.nets.push({ id: 3, kicadName: 'cu_1_3', spiceNode: 'cu_1_3', padRefs: [] })
    f.circuit.nets.push({ id: 4, kicadName: 'vpad_r1_1_n', spiceNode: 'vpad_r1_1_n', padRefs: [] })
    f.circuit.nets.find((n) => n.id === 2)!.kicadName = 'COM'
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [], 2, { copperAware: true })
    expect(inputs.copperNetwork!.padNode('R1', '1')).not.toBe('cu_1_3')
    expect(inputs.copperNetwork!.rails.has(2)).toBe(true)
    expect(buildDeck(inputs)).toContain('vpad_r1_1 cu_1_3_ vpad_r1_1_n_ DC 0')
  })

  it('derives a real 0.5 W resistor load and fires thermal for its 0.25 W rating', async () => {
    const f = resistorBoard()
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2)
    const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
      createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
    }
    const engine = await createInProcessSolveEngine()
    try {
      const result = await runSolvePlan(inputs, engine)
      const currents = deriveSolvedCurrents(inputs, result)
      const report = runCritic(f.board, f.circuit, { nodeVoltages: result.op.values, ...currents })
      expect(report.skipped.some((s) => s.check === 'thermal')).toBe(false)
      expect(report.findings).toContainEqual(expect.objectContaining({
        check: 'thermal', severity: 'error', refs: ['R1'],
        metrics: expect.objectContaining({ watts: expect.closeTo(0.5, 3), ratedWatts: 0.25 }),
      }))
      if (process.env.CIRCSIM_MEASURE_COPPER === '1') console.log('THERMAL MEASUREMENT', report.findings.find((f) => f.id === 'thermal:rating:R1')?.metrics)
    } finally {
      await engine.dispose()
    }
  }, 90_000)
})
