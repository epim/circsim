import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { extract, suggestGround } from '../../netlist/extract'
import { resolveAll } from '../../models/resolve'
import type { LibraryEntry } from '../../models/types'
import { buildDeck, buildDeckWithUndriven, buildSolveInputs } from '../../solve/inputs'
import { lanternBoard } from './lanternFixture'
import type { Resolution } from '../../models/types'
import type { SolveEngine } from '../../solve/types'
import { copperResult } from '../../solve/copperResult'

const SIMHOST = '../../../simhost/'
const ffi = await import(/* @vite-ignore */ SIMHOST + 'ngspiceFfi') as { ngspiceResourcesAvailable(): boolean }

const root = join(__dirname, '../../../..')
const library = (JSON.parse(readFileSync(join(root, 'resources/models/index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries

describe('terminal reduction for the transient deck', () => {
  it('removes lantern mesh nodes and retains every pad terminal', () => {
    const board = parseBoard(lanternBoard())
    const gnd = suggestGround(extract(board).nets)!
    const circuit = extract(board, { groundNetId: gnd.id })
    const inputs = buildSolveInputs(board, circuit, resolveAll(circuit, undefined, undefined, library), [
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ], gnd.id, { copperAware: true })
    const full = buildDeckWithUndriven(inputs).deck
    const reduced = buildDeck(inputs)
    const copperNodes = (deck: string[]): Set<string> => new Set(deck.filter((s) => s.startsWith('r_copper_')).flatMap((s) => s.split(/\s+/).slice(1, 3)))
    const terminals = new Set([...inputs.copperNetwork!.rails.values()].flatMap((rail) => rail.graph.pads.map((pad) => rail.nodeNames[pad.node])))
    expect(copperNodes(reduced).size).toBeLessThan(copperNodes(full).size / 10)
    expect([...copperNodes(reduced)].every((node) => terminals.has(node))).toBe(true)
    for (const part of circuit.parts) for (const pad of part.padNet.keys()) {
      expect(reduced.join('\n')).toContain(inputs.copperNetwork!.padNode(part.ref, pad)!)
    }
  })

  it.skipIf(!ffi.ngspiceResourcesAvailable()).each(['pour-only', 'lantern'])('%s: reduced and full native pad voltages agree within 0.1 microvolt', async (name) => {
    const board = parseBoard(name === 'lantern' ? lanternBoard() : readFileSync(join(root, 'fixtures/synthetic/pour-only-rail-kicad10.kicad_pcb'), 'utf8'))
    const gnd = suggestGround(extract(board).nets)!
    const circuit = extract(board, { groundNetId: gnd.id })
    const vcc = circuit.nets.find((net) => net.kicadName === 'VCC')!
    const resolutions: Resolution[] = name === 'lantern' ? resolveAll(circuit, undefined, undefined, library) : circuit.parts.map((part) => part.ref === 'U1' || part.ref === 'U2' ? {
      ref: part.ref, status: 'ok', tier: 3, warnings: [],
      model: { kind: 'subckt', libFile: 'load.lib', subcktName: part.ref === 'U1' ? 'LOAD40' : 'LOAD20', pinMap: { '8': 'supply', '4': 'return' } },
    } : { ref: part.ref, status: 'stubbed', tier: 6, warnings: [], model: { kind: 'stub', mode: 'open' } })
    const inputs = buildSolveInputs(board, circuit, resolutions, [
      { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.001 },
    ], gnd.id, { copperAware: true, modelTexts: { 'load.lib': '.subckt LOAD40 supply return\ni1 supply return DC 40\n.ends LOAD40\n.subckt LOAD20 supply return\ni1 supply return DC 20\n.ends LOAD20' } })
    const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
      createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
    }
    const engine = await createInProcessSolveEngine()
    try {
      const fullDeck = buildDeckWithUndriven(inputs).deck
      await engine.loadCircuit(fullDeck)
      const fullOp = await engine.runOp()
      expect(fullOp.method).not.toBe('failed')
      const full = copperResult(inputs, fullOp, fullDeck)!
      const reducedDeck = buildDeck(inputs)
      await engine.loadCircuit(reducedDeck)
      const reducedOp = await engine.runOp()
      expect(reducedOp.method).not.toBe('failed')
      const reduced = copperResult(inputs, reducedOp, reducedDeck)!
      expect(Object.keys(full.padVoltages).length).toBeGreaterThan(1)
      for (const [ref, pads] of Object.entries(full.padVoltages)) for (const [pad, volts] of Object.entries(pads)) {
        expect(Math.abs(reduced.padVoltages[ref][pad] - volts), `${ref}.${pad}`).toBeLessThan(1e-7)
      }
      // Include connector and omitted-model terminals, which do not appear in
      // the modeled-part padVoltages map. Missing native readings stay unknown.
      for (const rail of inputs.copperNetwork!.rails.values()) for (const pad of rail.graph.pads) {
        const node = rail.nodeNames[pad.node].toLowerCase()
        const volts = full.nodeVoltages[node]
        if (volts === undefined) expect(reduced.nodeVoltages[node], `${pad.ref}.${pad.padNumber}`).toBeUndefined()
        else expect(Math.abs(reduced.nodeVoltages[node] - volts), `${pad.ref}.${pad.padNumber}`).toBeLessThan(1e-7)
      }
      for (let edge = 0; edge < full.edgeCurrents.length; edge++) {
        expect(Math.abs(reduced.edgeCurrents[edge] - full.edgeCurrents[edge]), `edge ${edge}`).toBeLessThan(1e-6)
      }
    } finally { await engine.dispose() }
  }, 60_000)
})
