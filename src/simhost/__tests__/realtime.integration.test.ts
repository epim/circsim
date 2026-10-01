/**
 * src/simhost/__tests__/realtime.integration.test.ts
 *
 * The live bench's achieved real-time factor, measured through the real SimHost
 * and the bundled libngspice (issue #25). Before the sample-channel redesign
 * the bench topped out near 0.02x (555 sample) to 0.15x (lantern-class deck)
 * because every accepted timepoint crossed the FFI boundary and was decoded
 * into a Record, and the renderer capped tstep at 10 us. This file pins the
 * ceiling so it cannot regress silently:
 *
 *  - the fixture-555 sample and a lantern-shaped deck (the synthetic board
 *    from scripts/gen-synthetic-board.mjs, a stand-in for the private lantern)
 *    each run at 1x real time or better with pace `max`, at the tstep the app
 *    uses on a bench with no function generator (BENCH_TSTEP_MAX_SECONDS);
 *  - with pace 1x the pacing halt engages and the achieved factor holds near 1.
 *
 * The factor is read from the `status` events SimHost emits (simTimeSeconds
 * against the wall clock at emission), over a window that starts after a
 * warm-up, so ngspice start-up does not count against the run.
 *
 * Skipped with a visible message when resources/ngspice/<platform> is missing.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateBoard, lanternShape } from '../../../scripts/gen-synthetic-board.mjs'
import { parseBoard } from '../../core/kicad/board'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import { extract, suggestGround } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { BENCH_TSTEP_MAX_SECONDS, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[realtime] resources/ngspice/<platform> missing: the real-time factor checks are SKIPPED (run npm run fetch:ngspice)')
}

const MODELS = join(process.cwd(), 'resources', 'models')

interface Bench {
  deck: string[]
  instruments: Instrument[]
  /** SPICE node of the net a scope probe would sit on. */
  probeNode: string
}

/** The app flow for a board: ground, a 5 V / 0.1 ohm supply on `supplyNet`, one scope probe on `probeNet`. */
function makeBench(boardText: string, supplyNet: string, probeNet: string): Bench {
  const board = parseBoard(boardText)
  const library = (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
  const modelTexts: Record<string, string> = {}
  for (const f of readdirSync(MODELS)) {
    if (f === 'index.json') continue
    if (f.endsWith('.lib') || f.endsWith('.json')) modelTexts[f] = readFileSync(join(MODELS, f), 'utf8')
  }
  const gnd = suggestGround(extract(board).nets)
  if (!gnd) throw new Error('no ground suggested')
  const circuit = extract(board, { groundNetId: gnd.id })
  const resolutions = resolveAll(circuit, undefined, undefined, library)
  const supply = circuit.nets.find((n) => n.kicadName === supplyNet)
  const probe = circuit.nets.find((n) => n.kicadName === probeNet)
  if (!supply || !probe) throw new Error(`nets ${supplyNet} / ${probeNet} not found`)
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    { kind: 'dc-supply', id: 'auto-supply', netId: supply.id, volts: 5, seriesOhms: 0.1 },
    { kind: 'voltage-probe', id: 'probe-1', netId: probe.id, color: '#ffd166' }
  ]
  const deck = generateDeck({
    circuit,
    resolutions,
    instruments,
    groundNetId: gnd.id,
    title: 'realtime-bench',
    modelTexts
  })
  return { deck, instruments, probeNode: probe.spiceNode }
}

interface Measurement {
  /** sim seconds advanced per wall second across the measurement window. */
  factor: number
  /** samples events received during the whole run. */
  batches: number
  /** simTime covered by the samples events (proves the channel kept up). */
  sampledUntil: number
  /** status events received, and how many of them said running:false. */
  statuses: number
  notRunning: number
}

/** Run the bench for `warmMs + measureMs` of wall time and report the factor over the last `measureMs`. */
async function measure(bench: Bench, pace: number | 'max', warmMs: number, measureMs: number): Promise<Measurement> {
  const status: { wall: number; simTime: number }[] = []
  let batches = 0
  let sampledUntil = 0
  let statuses = 0
  let notRunning = 0
  const host = new SimHost({
    emit: (e: SimEvent) => {
      if (e.type === 'status') {
        status.push({ wall: Date.now(), simTime: e.simTimeSeconds })
        statuses++
        if (!e.running) notRunning++
      }
      if (e.type === 'samples') {
        batches++
        if (e.simTime.length > 0) sampledUntil = Math.max(sampledUntil, e.simTime[e.simTime.length - 1])
      }
    },
    disableWatchdog: true
  })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: bench.deck })
    // The scope probe is the only series the renderer asks for at full rate;
    // everything else is tinted from display-rate snapshots.
    host.handleCommand({ type: 'watch', vectors: [bench.probeNode] })
    host.handleCommand({ type: 'setPace', realtimeFactor: pace })
    host.handleCommand({ type: 'runTransient', tstepSeconds: BENCH_TSTEP_MAX_SECONDS, tstopSeconds: 30 })
    await host.whenIdle()
    await new Promise((r) => setTimeout(r, warmMs + measureMs))
    const end = status[status.length - 1]
    const startWall = end.wall - measureMs
    const start = [...status].reverse().find((s) => s.wall <= startWall) ?? status[0]
    const factor = (end.simTime - start.simTime) / ((end.wall - start.wall) / 1000)
    return { factor, batches, sampledUntil, statuses, notRunning }
  } finally {
    await host.dispose()
  }
}

describe.skipIf(!haveNgspice)('live bench real-time factor (real libngspice, issue #25)', () => {
  const b555 = haveNgspice ? makeBench(readFileSync('fixtures/fixture-555.kicad_pcb', 'utf8'), 'VCC', 'OUT') : null
  const lantern = haveNgspice ? makeBench(generateBoard(lanternShape(10)), '/PACK+', '/LED1_K') : null

  it('the fixture-555 sample runs at 1x real time or better with pace max', async () => {
    const m = await measure(b555!, 'max', 1000, 3000)
    console.log(`[realtime] fixture-555 pace max: ${m.factor.toFixed(2)}x`)
    expect(m.factor).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('a lantern-class deck runs at 1x real time or better with pace max', async () => {
    const m = await measure(lantern!, 'max', 1000, 3000)
    console.log(`[realtime] lantern-shape pace max: ${m.factor.toFixed(2)}x`)
    expect(m.factor).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('pace 1x holds the achieved factor near 1 on the lantern-class deck', async () => {
    const m = await measure(lantern!, 1, 1000, 3000)
    console.log(`[realtime] lantern-shape pace 1x: ${m.factor.toFixed(2)}x`)
    expect(m.factor).toBeGreaterThan(0.85)
    expect(m.factor).toBeLessThan(1.15)
    // The probe series kept flowing while the pacing halt toggled the run.
    expect(m.batches).toBeGreaterThan(50)
    expect(m.sampledUntil).toBeGreaterThan(2.5)
    // The pacing halts are the engine's scheduling: the run is live, so no
    // status may say running:false (the toolbar would show Paused while the
    // scope streams).
    expect(m.statuses).toBeGreaterThan(10)
    expect(m.notRunning).toBe(0)
  }, 30_000)
})
