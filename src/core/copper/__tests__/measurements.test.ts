import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { parseSchematicSimData } from '../../kicad/schematic'
import { extract, suggestGround, suggestSupplies } from '../../netlist/extract'
import { resolveAll } from '../../models/resolve'
import type { LibraryEntry } from '../../models/types'
import { buildDeck, buildDeckWithUndriven, buildSolveInputs } from '../../solve/inputs'
import { reduceCopperNetwork } from '../kron'
import { runSolvePlan } from '../../solve/plan'
import type { SolveEngine } from '../../solve/types'

const SIMHOST = '../../../simhost/'
const root = join(__dirname, '../../../..')

import { lanternBoard } from './lanternFixture'

it.skipIf(process.env.CIRCSIM_MEASURE_COPPER !== '1')('measures ideal and physical op costs on 555 and a lantern-shaped synthetic board', async () => {
  const models = join(root, 'resources/models')
  const library = (JSON.parse(readFileSync(join(models, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
  const modelTexts = Object.fromEntries(readdirSync(models).filter((f) => /\.(lib|json)$/.test(f)).map((f) => [f, readFileSync(join(models, f), 'utf8')]))
  const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
    createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
  }
  const engine = await createInProcessSolveEngine()
  try {
    for (const name of ['bundled-555', 'lantern-synthetic']) {
      const board = parseBoard(name === 'bundled-555' ? readFileSync(join(root, 'resources/sample/blinker-555.kicad_pcb'), 'utf8') : lanternBoard())
      const gnd = suggestGround(extract(board).nets)!
      const circuit = extract(board, { groundNetId: gnd.id })
      const sch = name === 'bundled-555' ? parseSchematicSimData(readFileSync(join(root, 'resources/sample/blinker-555.kicad_sch'), 'utf8')) : undefined
      const resolutions = resolveAll(circuit, sch, undefined, library)
      const vcc = suggestSupplies(circuit.nets)[0]
      for (const copperAware of [false, true]) {
        const inputs = buildSolveInputs(board, circuit, resolutions, [
          { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.1 },
        ], gnd.id, { copperAware, modelTexts, copperOptions: name === 'bundled-555' ? { supplyEntries: [
          { netId: vcc.id, pos: { x: 32.34, y: 21.905 } },
          { netId: gnd.id, pos: { x: 27.66, y: 21.905 } },
        ] } : undefined })
        const fresh = await runSolvePlan(inputs, engine)
        console.log(`COPPER PLAN ${name} copperAware=${copperAware} method=${fresh.op.method ?? 'unknown'}`)
        await engine.loadCircuit(buildDeck(inputs))
        for (let i = 0; i < 3; i++) await engine.runOp()
        const times: number[] = []
        const methods = new Set<string>()
        for (let i = 0; i < 15; i++) {
          const start = performance.now()
          const op = await engine.runOp()
          times.push(performance.now() - start)
          methods.add(op.method ?? 'unknown')
          expect(Object.values(op.values).every(Number.isFinite)).toBe(true)
          expect(op.method).not.toBe('failed')
        }
        times.sort((a, b) => a - b)
        console.log(`COPPER MEASUREMENT ${name} copperAware=${copperAware} medianOpMs=${times[7].toFixed(3)} runs=15 networkNodes=${inputs.copperNetwork?.nodes.length ?? 0} networkEdges=${inputs.copperNetwork?.edges.length ?? 0} methods=${[...methods].join(',')}`)
      }
    }
  } finally { await engine.dispose() }
}, 120_000)

// Run one board/mode per Vitest process so no post-transient circuit reload is
// included in the measurements or exposed to the native state issue in #163.
it.skipIf(process.env.CIRCSIM_MEASURE_COPPER_TRANSIENT !== '1')('measures warm transient costs for ideal, full and reduced copper', async () => {
  const name = process.env.CIRCSIM_MEASURE_BOARD
  const mode = process.env.CIRCSIM_MEASURE_MODE
  expect(['bundled-555', 'lantern-synthetic']).toContain(name)
  expect(['ideal', 'full', 'reduced']).toContain(mode)
  const models = join(root, 'resources/models')
  const library = (JSON.parse(readFileSync(join(models, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
  const modelTexts = Object.fromEntries(readdirSync(models).filter(f => /\.(lib|json)$/.test(f)).map(f => [f, readFileSync(join(models, f), 'utf8')]))
  const board = parseBoard(name === 'bundled-555' ? readFileSync(join(root, 'resources/sample/blinker-555.kicad_pcb'), 'utf8') : lanternBoard())
  const gnd = suggestGround(extract(board).nets)!
  const circuit = extract(board, { groundNetId: gnd.id })
  const sch = name === 'bundled-555' ? parseSchematicSimData(readFileSync(join(root, 'resources/sample/blinker-555.kicad_sch'), 'utf8')) : undefined
  const vcc = suggestSupplies(circuit.nets)[0]
  const inputs = buildSolveInputs(board, circuit, resolveAll(circuit, sch, undefined, library), [
    { kind: 'dc-supply', id: '1', netId: vcc.id, volts: 5, seriesOhms: 0.1 },
  ], gnd.id, { copperAware: mode !== 'ideal', modelTexts, copperOptions: name === 'bundled-555' ? { supplyEntries: [
    { netId: vcc.id, pos: { x: 32.34, y: 21.905 } },
    { netId: gnd.id, pos: { x: 27.66, y: 21.905 } },
  ] } : undefined })
  const before = inputs.copperNetwork?.nodes.length ?? 0
  const after = mode === 'reduced' ? reduceCopperNetwork(inputs.copperNetwork!).nodes.length : before
  const deck = mode === 'full' ? buildDeckWithUndriven(inputs).deck : buildDeck(inputs)
  const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
    createInProcessSolveEngine(): Promise<SolveEngine & { dispose(): Promise<void> }>
  }
  const engine = await createInProcessSolveEngine()
  const tstep = 1e-4
  const tstop = 0.1
  try {
    await engine.loadCircuit(deck)
    const run = async () => {
      const start = performance.now()
      const result = await engine.runTran(tstep, tstop)
      const elapsed = performance.now() - start
      expect(result.time.length).toBeGreaterThan(1)
      expect(result.time.at(-1)).toBeCloseTo(tstop, 8)
      expect(Object.values(result.vectors).every(vector => vector.every(Number.isFinite))).toBe(true)
      return { elapsed, points: result.time.length, usPerPoint: elapsed * 1000 / result.time.length }
    }
    for (let i = 0; i < 3; i++) await run()
    const samples: Awaited<ReturnType<typeof run>>[] = []
    for (let i = 0; i < 15; i++) samples.push(await run())
    const median = (values: number[]) => values.sort((a, b) => a - b)[7]
    console.log(`COPPER TRANSIENT ${JSON.stringify({ board: name, mode, warmups: 3, runs: 15, tstep, tstop,
      medianTranMs: median(samples.map(sample => sample.elapsed)), medianUsPerPoint: median(samples.map(sample => sample.usPerPoint)),
      medianPoints: median(samples.map(sample => sample.points)), copperNodesBefore: before, copperNodesAfter: after,
      copperEdges: deck.filter(line => line.startsWith('r_copper_')).length, gaps: inputs.copperNetwork?.unreachedPads.length ?? 0,
    })}`)
  } finally { await engine.dispose() }
}, 120_000)
