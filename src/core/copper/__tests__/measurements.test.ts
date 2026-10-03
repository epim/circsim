import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseBoard } from '../../kicad/board'
import { parseSchematicSimData } from '../../kicad/schematic'
import { extract, suggestGround, suggestSupplies } from '../../netlist/extract'
import { resolveAll } from '../../models/resolve'
import type { LibraryEntry } from '../../models/types'
import { buildDeck, buildSolveInputs } from '../../solve/inputs'
import { runSolvePlan } from '../../solve/plan'
import type { SolveEngine } from '../../solve/types'

const SIMHOST = '../../../simhost/'
const root = join(__dirname, '../../../..')

/** Many distributed loads, a narrow supply pour and a broad via-stitched return. */
function lanternBoard(): string {
  const parts: string[] = []
  for (let i = 0; i < 48; i++) {
    const x = 10 + (i % 6) * 8
    const y = 12 + Math.floor(i / 6) * 10
    if (y > 24 && y < 40 && (x < 24 || x > 36)) continue
    parts.push(`(footprint "R" (layer "F.Cu") (at ${x} ${y})
      (fp_text reference "R${i + 1}" (at 0 0) (layer "F.SilkS"))
      (fp_text value "1k" (at 0 0) (layer "F.Fab"))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (net 2 "GND")))
      (segment (start ${x + 2} ${y}) (end ${x + 3} ${y}) (width 0.25) (layer "F.Cu") (net 2))
      (via (at ${x + 3} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2))`)
  }
  return `(kicad_pcb (version 20221018) (generator pcbnew) (general (thickness 1.6))
    (net 0 "") (net 1 "VCC") (net 2 "GND")
    (footprint "Connector" (layer "F.Cu") (at 10 8)
      (fp_text reference "J1" (at 0 0) (layer "F.SilkS"))
      (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.4) (layers "*.Cu") (net 1 "VCC"))
      (pad "2" thru_hole circle (at 2 0) (size 1 1) (drill 0.4) (layers "*.Cu") (net 2 "GND")))
    ${parts.join('\n')}
    (zone (net 1) (net_name "VCC") (layer "F.Cu") (polygon (pts
      (xy 8 6) (xy 52 6) (xy 52 24) (xy 36 24) (xy 36 40) (xy 52 40)
      (xy 52 86) (xy 8 86) (xy 8 40) (xy 24 40) (xy 24 24) (xy 8 24))))
    (zone (net 2) (net_name "GND") (layer "B.Cu") (polygon (pts (xy 6 4) (xy 56 4) (xy 56 90) (xy 6 90))))
    (gr_rect (start 4 2) (end 58 92) (layer "Edge.Cuts") (width 0.1)))`
}

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
