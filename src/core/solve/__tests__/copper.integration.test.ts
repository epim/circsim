import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'
import { resolveAll } from '../../models/resolve'
import { deriveSolvedCurrents } from '../../critic/solvedCurrents'
import { runCritic } from '../../critic/run'
import { buildDeck, buildSolveInputs } from '../inputs'
import { runSolvePlan } from '../plan'
import { copperResult } from '../copperResult'
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
  it('keeps gnd ports local through nested subcircuits and behavioral expressions', async () => {
    const f = resistorBoard()
    f.resolutions = f.resolutions.map((r) => r.ref === 'R1' ? {
      ...r, model: {
        kind: 'subckt' as const, libFile: 'return.lib', subcktName: 'COPPER_LOAD',
        pinMap: { '1': 'vcc', '2': 'gnd' },
      },
    } : r)
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true, modelTexts: { 'return.lib': [
      '.subckt COPPER_LOAD vcc gnd', 'xload vcc gnd RETURN_LOAD', '.ends COPPER_LOAD',
      '.subckt RETURN_LOAD vcc gnd', 'rload vcc gnd 50',
      'bload vcc gnd i = v(vcc,gnd)/50', '.ends RETURN_LOAD',
    ].join('\n') } })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    const copper = result.copper!
    const expectedA = 5 / (25 + 2 * 0.193103448276 + 0.001)
    expect(copper.padCurrents.R1['1']).toBeCloseTo(expectedA, 8)
    expect(copper.padCurrents.R1['2']).toBeCloseTo(-expectedA, 8)
    expect(copper.padVoltages.R1['2']).toBeCloseTo(expectedA * 0.193103448276, 8)
    expect(copper.partPower.R1).toBeCloseTo(expectedA ** 2 * 25, 8)
  }, 90_000)

  it('assesses zero power for a connected idle pulldown without skipping the active load', async () => {
    const f = resistorBoard()
    const fp = f.board.footprints.find((p) => p.ref === 'R1')!
    f.board.netById.set(3, { id: 3, name: 'SIG' })
    f.board.footprints.push({ ...fp, ref: 'R2', value: '10k', pads: fp.pads.map((p) => ({
      ...p, netId: p.number === '1' ? 3 : 2,
    })) })
    const circuit = extract(f.board, { groundNetId: 2 })
    const inputs = buildSolveInputs(f.board, circuit, resolveAll(circuit), [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    expect(result.copper!.partPower.R2).toBe(0)
    const currents = deriveSolvedCurrents(inputs, result)
    expect(currents.unresolvedRefs).not.toContain('R2')
    const report = runCritic(f.board, circuit, { nodeVoltages: result.op.values, copper: result.copper, ...currents })
    for (const check of ['ir-drop', 'ampacity', 'thermal']) {
      expect(report.skipped.some((s) => s.check === check)).toBe(false)
    }
  }, 90_000)

  it('leaves an unavailable digital model unknown instead of reporting zero power', async () => {
    const f = resistorBoard()
    const part = f.circuit.parts.find((p) => p.ref === 'R1')!
    f.resolutions = f.resolutions.map((r) => r.ref === 'R1' ? {
      ...r, status: 'ok' as const, tier: 3 as const, model: {
        kind: 'xspice-digital' as const, templateId: 'CD40106', pinMap: { '1': 'VCC', '2': 'GND' },
      },
    } : r)
    part.value = 'CD40106'
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    expect(result.deck.join('\n')).toContain('template text unavailable')
    expect(result.copper!.partPower.R1).toBeUndefined()
    expect(deriveSolvedCurrents(inputs, result).unresolvedRefs).toContain('R1')
  }, 90_000)

  it('leaves a skipped incomplete primitive unknown instead of reporting zero power', async () => {
    const f = resistorBoard()
    f.resolutions = f.resolutions.map((r) => r.ref === 'R1' ? {
      ...r, model: { kind: 'primitive' as const, card: 'r_r1 vcc 0' },
    } : r)
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    expect(result.deck.join('\n')).toContain('skipped incomplete primitive card')
    expect(result.copper!.partPower.R1).toBeUndefined()
    expect(deriveSolvedCurrents(inputs, result).unresolvedRefs).toContain('R1')
  }, 90_000)

  it('leaves unpowered resolved parts unknown and thermal not assessed', async () => {
    const f = resistorBoard()
    const poweredInputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const powered = await withEngine((engine) => runSolvePlan(poweredInputs, engine))
    expect(powered.copper!.partPower.R1).toBeGreaterThan(0.49)
    expect(powered.copper!.padVoltages.R1['2']).toBeGreaterThan(0)
    f.board.tracks = []
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    expect(inputs.copperNetwork!.unreachedPads.map((p) => `${p.ref}.${p.padNumber}`)).toEqual(['J1.1', 'R1.1', 'J1.2', 'R1.2'])
    expect(result.copper!.unreachedPads).toEqual(inputs.copperNetwork!.unreachedPads)
    expect(result.copper!.partPower.R1).toBeUndefined()
    const currents = deriveSolvedCurrents(inputs, result)
    expect(currents.unresolvedRefs).not.toContain('R1')
    expect(currents.unknownPowerRefs).toContain('R1')
    const report = runCritic(f.board, f.circuit, { nodeVoltages: result.op.values, copper: result.copper, ...currents })
    expect(report.skipped.some((s) => s.check === 'thermal')).toBe(true)
    for (const check of ['ir-drop', 'ampacity']) {
      expect(report.skipped.find((s) => s.check === check)?.reason).toContain('R1.1')
      expect(report.skipped.find((s) => s.check === check)?.reason).toContain('R1.2')
    }
  }, 90_000)

  it('exposes the bundled sample unreached pads even when the native solve fails (#160)', () => {
    const root = join(__dirname, '../../../..')
    const board = parseBoard(readFileSync(join(root, 'resources/sample/blinker-555.kicad_pcb'), 'utf8'))
    const raw = extract(board)
    const gnd = raw.nets.find((n) => n.kicadName === 'GND')!
    const circuit = extract(board, { groundNetId: gnd.id })
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    const inputs = buildSolveInputs(board, circuit, resolveAll(circuit), [
      { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.001 },
    ], gnd.id, { copperAware: true })
    const expected = ['C1.2', 'C2.2', 'D1.1', 'U1.1', 'U1.8']
    const names = inputs.copperNetwork!.unreachedPads.map((p) => `${p.ref}.${p.padNumber}`)
    expect(names).toEqual(expect.arrayContaining(expected))
    const copper = copperResult(inputs, { method: 'failed', values: { [vcc.spiceNode]: 5 } }, buildDeck(inputs))!
    expect(copper.unreachedPads).toEqual(inputs.copperNetwork!.unreachedPads)
    expect(copper.partPower).toEqual({})
    expect(copper.edgeCurrents.every(Number.isNaN)).toBe(true)
    const report = runCritic(board, circuit, { nodeVoltages: {}, copper })
    for (const check of ['ir-drop', 'ampacity']) {
      const reason = report.skipped.find((s) => s.check === check)?.reason
      for (const pad of expected) expect(reason).toContain(pad)
      expect(reason).toContain('did not converge')
    }
  })

  it('names a disconnected supply entry without claiming all load pads miss copper', async () => {
    const f = resistorBoard()
    f.board.tracks[0].start = { x: 90, y: 0 }
    const inputs = buildSolveInputs(f.board, f.circuit, f.resolutions, [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.001 },
    ], 2, { copperAware: true, copperOptions: { supplyEntries: [{ netId: 1, pos: { x: 0, y: 0 } }] } })
    const result = await withEngine((engine) => runSolvePlan(inputs, engine))
    const report = runCritic(f.board, f.circuit, { nodeVoltages: result.op.values, copper: result.copper, ...deriveSolvedCurrents(inputs, result) })
    for (const check of ['ir-drop', 'ampacity']) {
      const reason = report.skipped.find((s) => s.check === check)?.reason
      expect(reason).toMatch(/supply.entry.*J1.*1.*no modelled copper/i)
      expect(reason).not.toContain('no modelled copper touches any pad')
    }
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
    // Independent unloaded supply estimate: the 1.8k shunt and 15k divider
    // in the bundled block-diagram model draw about 3.1 mA at 5 V.
    const expectedSupplyA = (copper.padVoltages.U1['8'] - copper.padVoltages.U1['1']) * (1 / 1800 + 1 / 15000)
    expect(copper.padCurrents.U1['8']).toBeCloseTo(expectedSupplyA, 5)
    expect(copper.padCurrents.U1['1']).toBeCloseTo(-copper.padCurrents.U1['8'], 6)
    expect(Object.values(copper.padCurrents.U1).reduce((sum, amps) => sum + amps, 0)).toBeCloseTo(0, 9)
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
    const report = runCritic(f.board, f.circuit, { nodeVoltages: { vcc: 5 }, partCurrents: { R1: 0.1 } })
    for (const check of ['ir-drop', 'ampacity']) {
      const reason = report.skipped.find((s) => s.check === check)?.reason
      expect(reason).toMatch(/ideal-net operating point.*copperAware: true/)
      expect(reason).not.toContain('partly assessed')
    }
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
