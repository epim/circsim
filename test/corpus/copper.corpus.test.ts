import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../src/core/kicad/board'
import { extract } from '../../src/core/netlist/extract'
import type { Resolution } from '../../src/core/models/types'
import { buildSolveInputs } from '../../src/core/solve/inputs'
import { runSolvePlan } from '../../src/core/solve/plan'
import { deriveSolvedCurrents } from '../../src/core/critic/solvedCurrents'
import { runCritic } from '../../src/core/critic/run'
import { createInProcessSolveEngine } from '../../src/simhost/solveEngine'
import { ngspiceResourcesAvailable } from '../../src/simhost/ngspiceFfi'

describe.skipIf(!ngspiceResourcesAvailable())('pour-only fixture shared copper operating point (#107)', () => {
  it('matches Critic IR-drop to the native per-pad rail and return voltages', async () => {
    const board = parseBoard(readFileSync(join(process.cwd(), 'fixtures/synthetic/pour-only-rail-kicad10.kicad_pcb'), 'utf8'))
    const raw = extract(board)
    const gnd = raw.nets.find((n) => n.kicadName === 'GND')!
    const circuit = extract(board, { groundNetId: gnd.id })
    const vcc = circuit.nets.find((n) => n.kicadName === 'VCC')!
    expect(board.tracks.filter((t) => t.netId === vcc.id)).toHaveLength(0)
    const resolutions: Resolution[] = circuit.parts.map((part) => part.ref === 'U1' || part.ref === 'U2' ? {
      ref: part.ref, status: 'ok', tier: 3, warnings: [],
      model: { kind: 'subckt', libFile: 'load.lib', subcktName: part.ref === 'U1' ? 'LOAD40' : 'LOAD20', pinMap: { '8': 'supply', '4': 'return' } },
    } : { ref: part.ref, status: 'stubbed', tier: 6, warnings: [], model: { kind: 'stub', mode: 'open' } })
    const inputs = buildSolveInputs(board, circuit, resolutions, [
      { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.001 },
    ], gnd.id, { copperAware: true, modelTexts: { 'load.lib':
      '.subckt LOAD40 supply return\ni1 supply return DC 40\n.ends LOAD40\n.subckt LOAD20 supply return\ni1 supply return DC 20\n.ends LOAD20',
    } })
    const engine = await createInProcessSolveEngine()
    try {
      const result = await runSolvePlan(inputs, engine)
      const copper = result.copper!
      const report = runCritic(board, circuit, { nodeVoltages: result.op.values, copper, ...deriveSolvedCurrents(inputs, result) })
      const finding = report.findings.find((f) => f.check === 'ir-drop' && f.netId === vcc.id)!
      expect(finding).toBeDefined()
      expect(finding.refs).toContain('U1')
      const railDrop = result.op.values[vcc.spiceNode] - copper.padVoltages.U1['8']
      const groundRise = copper.padVoltages.U1['4']
      expect(railDrop).toBeGreaterThan(0.1)
      expect(groundRise).toBeGreaterThan(0)
      expect(finding.metrics!.dropV).toBeCloseTo(railDrop, 8)
      expect(finding.metrics!.groundShiftV).toBeCloseTo(groundRise, 8)
      expect(finding.metrics!.roundTripV).toBeCloseTo(railDrop + groundRise, 8)
      expect(copper.padCurrents.U1['8']).toBeCloseTo(40, 7)
      if (process.env.CIRCSIM_MEASURE_COPPER === '1') console.log(`POUR MEASUREMENT nativeDropV=${railDrop} criticDropV=${finding.metrics!.dropV} nativeGroundV=${groundRise} criticGroundV=${finding.metrics!.groundShiftV}`)
    } finally { await engine.dispose() }
  })
})
