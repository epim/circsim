import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCopperNetwork } from '../../src/core/copper'
import { parseBoard } from '../../src/core/kicad/board'
import { extract } from '../../src/core/netlist/extract'
import { corpusBoards, readCorpusBoard } from './helpers/corpus'

const inputs = [
  ...corpusBoards().map((entry) => ({ name: entry.id, text: () => readCorpusBoard(entry) })),
  { name: 'sensor-node', text: () => readFileSync(join(process.cwd(), 'resources/sample/sensor-node.kicad_pcb'), 'utf8') },
  ...readdirSync(join(process.cwd(), 'fixtures/synthetic')).filter((file) => file.endsWith('.kicad_pcb')).map((file) => ({
    name: file, text: () => readFileSync(join(process.cwd(), 'fixtures/synthetic', file), 'utf8'),
  })),
]
const measurements: unknown[] = []
interface ExpectedGap {
  ref: string; padNumber: string; net: string
  drc: { type: string; description: string; items: { description: string; pos: { x: number; y: number }; uuid: string }[] }
}
const baseline = JSON.parse(readFileSync(join(process.cwd(), 'test/corpus/copper-connectivity.baseline.json'), 'utf8')) as {
  boards: Record<string, ExpectedGap[]>
}
let skippedSinglePadNets = 0
let checkedNets = 0
let expectedGapCount = 0

afterAll(() => {
  if (process.env.CIRCSIM_CHECK_COPPER === '1') {
    const dir = join(process.cwd(), 'test-results/corpus')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'copper-connectivity-data.json'), JSON.stringify(measurements, null, 2))
  }
  console.log(`COPPER CONNECTIVITY boards=${inputs.length} checkedNets=${checkedNets} singlePadNetsSkipped=${skippedSinglePadNets} KiCadConfirmedGaps=${expectedGapCount}`)
  expect(Object.keys(baseline.boards).every(name => inputs.some(input => input.name === name))).toBe(true)
})

describe.each(inputs)('all-net copper connectivity: $name', ({ name, text }) => {
  it('builds every multi-pad net with no unexpected unreached pad', () => {
    const board = parseBoard(text())
    const circuit = extract(board)
    const network = buildCopperNetwork(board, circuit, { allNets: true })
    // Duplicate physical shapes of one numbered pad are one logical terminal.
    const singlePadNets = new Set(circuit.nets.filter(net => new Set(net.padRefs.map(pad => `${pad.ref}\0${pad.pad}`)).size === 1).map(net => net.id))
    skippedSinglePadNets += singlePadNets.size
    checkedNets += circuit.nets.length - singlePadNets.size
    const gaps = network.unreachedPads.filter(pad => !singlePadNets.has(pad.netId)).map(pad => ({
      ref: pad.ref, padNumber: pad.padNumber, net: circuit.nets.find(net => net.id === pad.netId)!.kicadName,
    }))
    const expected = baseline.boards[name] ?? []
    expectedGapCount += expected.length
    for (const gap of expected) {
      expect(gap.drc.type).toBe('unconnected_items')
      expect(gap.drc.items).toHaveLength(2)
      expect(gap.drc.items.some(item => item.description.includes(`[${gap.net}]`))).toBe(true)
    }
    if (process.env.CIRCSIM_CHECK_COPPER === '1') measurements.push({ name, nets: circuit.nets.length, singlePadNets: singlePadNets.size, nodes: network.nodes.length, gaps })
    expect([...network.rails.keys()]).toEqual(circuit.nets.map((net) => net.id).sort((a, b) => a - b))
    const key = (pad: { ref: string; padNumber: string; net: string }) => `${pad.net}: ${pad.ref}.${pad.padNumber}`
    expect(gaps.map(key).sort()).toEqual(expected.map(key).sort())
  }, 60_000)
})
