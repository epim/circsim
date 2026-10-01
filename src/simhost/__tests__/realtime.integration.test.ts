/**
 * src/simhost/__tests__/realtime.integration.test.ts
 *
 * The live bench's sample channel, measured through the real SimHost and the
 * bundled libngspice (issue #25). Before the redesign every accepted timepoint
 * crossed the FFI boundary (about 18 us) and was decoded into a Record (about
 * 0.8 us per saved vector), so the channel cost several times the solve: the
 * bench topped out near 0.02x (555 sample) and 0.15x (lantern-class deck).
 *
 * What these tests gate, and why not "1x real time" (issue #25 stays open):
 * the achieved wall-clock factor is mostly ngspice's own solve time, which
 * scales with the runner (CI runners are 2x to 5x slower than a dev machine,
 * and `npm test` runs the other ngspice files in parallel on the same cores).
 * An absolute 1x floor on a lantern-class deck passed on a dev machine and
 * failed on every CI leg, so it gated the runner, not the code. The gates
 * below are ratios measured in one process, which hold on any machine:
 *
 *  - channel overhead: sim seconds per CPU second of the whole process (the
 *    ngspice thread, the 15 ms poll, the event emission) during a live
 *    pace-max run, against a foreground `tran` of the same deck at the same
 *    step with no channel at all. The polled channel measures about 0.9 to
 *    1.05 of the bare solve; the per-timepoint channel it replaced works out
 *    to about 0.25 (555) and 0.3 (lantern) at this step from the costs above,
 *    so a 0.6 floor catches a return to per-point costs with margin. CPU time,
 *    not wall time, so a loaded runner does not move the ratio.
 *  - pacing: at pace 1x the achieved factor never runs ahead of 1x, and is
 *    not held below what the same process reached at pace max (the old
 *    halt-based pacer produced bursts and stalls).
 *
 * Every measured factor is printed (`[realtime] ...`) so CI logs carry the
 * numbers. Skipped with a visible message when resources/ngspice/<platform>
 * is missing.
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

/** CPU seconds this process has used so far, every thread (the ngspice one included). */
function cpuSeconds(): number {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1e6
}

interface Measurement {
  /** sim seconds advanced per wall second across the measurement window. */
  factor: number
  /** sim seconds delivered per CPU second of this process across the window. */
  cpuFactor: number
  /** samples events received during the whole run. */
  batches: number
  /** simTime covered by the samples events (proves the channel kept up). */
  sampledUntil: number
  /** status events received, and how many of them said running:false. */
  statuses: number
  notRunning: number
}

/** Run the bench for `warmMs + measureMs` of wall time and report the factors over the last `measureMs`. */
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
    await new Promise((r) => setTimeout(r, warmMs))
    const cpu0 = cpuSeconds()
    const sim0 = sampledUntil
    await new Promise((r) => setTimeout(r, measureMs))
    const cpuFactor = (sampledUntil - sim0) / (cpuSeconds() - cpu0)
    const end = status[status.length - 1]
    const startWall = end.wall - measureMs
    const start = [...status].reverse().find((s) => s.wall <= startWall) ?? status[0]
    const factor = (end.simTime - start.simTime) / ((end.wall - start.wall) / 1000)
    return { factor, cpuFactor, batches, sampledUntil, statuses, notRunning }
  } finally {
    await host.dispose()
  }
}

/**
 * The same deck solved by a foreground `tran` at the bench step with no sample
 * channel: sim seconds per CPU second and per wall second between the `t1` and
 * `t2` marks (two runs, so the start-up transient and the run setup cancel).
 */
async function measureBare(bench: Bench, t1: number, t2: number): Promise<{ cpuFactor: number; factor: number }> {
  const host = new SimHost({ emit: () => {}, disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: bench.deck })
    await host.whenIdle()
    const run = async (tstop: number): Promise<{ cpu: number; wall: number }> => {
      const cpu = cpuSeconds()
      const wall = Date.now()
      await host.runTran(BENCH_TSTEP_MAX_SECONDS, tstop)
      return { cpu: cpuSeconds() - cpu, wall: (Date.now() - wall) / 1000 }
    }
    const a = await run(t1)
    const b = await run(t2)
    return { cpuFactor: (t2 - t1) / (b.cpu - a.cpu), factor: (t2 - t1) / (b.wall - a.wall) }
  } finally {
    await host.dispose()
  }
}

/** Floor for live / bare sim seconds per CPU second (see the file header). */
const CHANNEL_OVERHEAD_FLOOR = 0.6

describe.skipIf(!haveNgspice)('live bench sample channel cost (real libngspice, issue #25)', () => {
  const b555 = haveNgspice ? makeBench(readFileSync('fixtures/fixture-555.kicad_pcb', 'utf8'), 'VCC', 'OUT') : null
  const lantern = haveNgspice ? makeBench(generateBoard(lanternShape(10)), '/PACK+', '/LED1_K') : null
  /** Wall-clock factor the lantern-class deck reached at pace max in this process. */
  let lanternMax: number | null = null

  it('the fixture-555 sample: the live channel costs little next to the solve', async () => {
    const bare = await measureBare(b555!, 2, 8)
    const live = await measure(b555!, 'max', 1000, 3000)
    const ratio = live.cpuFactor / bare.cpuFactor
    console.log(
      `[realtime] fixture-555: live pace max ${live.factor.toFixed(2)}x real time, bare tran ${bare.factor.toFixed(2)}x; ` +
        `sim s per CPU s live ${live.cpuFactor.toFixed(2)} / bare ${bare.cpuFactor.toFixed(2)} = ${ratio.toFixed(2)}`
    )
    expect(ratio).toBeGreaterThanOrEqual(CHANNEL_OVERHEAD_FLOOR)
  }, 90_000)

  it('a lantern-class deck: the live channel costs little next to the solve', async () => {
    const bare = await measureBare(lantern!, 1, 3)
    const live = await measure(lantern!, 'max', 1000, 3000)
    lanternMax = live.factor
    const ratio = live.cpuFactor / bare.cpuFactor
    console.log(
      `[realtime] lantern-shape: live pace max ${live.factor.toFixed(2)}x real time, bare tran ${bare.factor.toFixed(2)}x; ` +
        `sim s per CPU s live ${live.cpuFactor.toFixed(2)} / bare ${bare.cpuFactor.toFixed(2)} = ${ratio.toFixed(2)}`
    )
    expect(ratio).toBeGreaterThanOrEqual(CHANNEL_OVERHEAD_FLOOR)
  }, 90_000)

  it('pace 1x on the lantern-class deck: never ahead of real time, not held below the pace max factor', async () => {
    const m = await measure(lantern!, 1, 1000, 3000)
    // What the machine delivered flat out in this process (measured here when
    // the pace max test did not run first).
    const max = lanternMax ?? (await measure(lantern!, 'max', 1000, 3000)).factor
    const due = Math.min(1, max)
    console.log(`[realtime] lantern-shape pace 1x: ${m.factor.toFixed(2)}x (pace max reached ${max.toFixed(2)}x, so ${due.toFixed(2)}x is due)`)
    expect(m.factor).toBeLessThan(1.15)
    // 0.75 of what is due: the two runs are seconds apart, and the load on a
    // shared runner moves the wall-clock factor between them.
    expect(m.factor).toBeGreaterThan(0.75 * due)
    // The probe series kept flowing while the pacing halt toggled the run.
    expect(m.batches).toBeGreaterThan(50)
    expect(m.sampledUntil).toBeGreaterThan(0)
    // The pacing halts are the engine's scheduling: the run is live, so no
    // status may say running:false (the toolbar would show Paused while the
    // scope streams).
    expect(m.statuses).toBeGreaterThan(10)
    expect(m.notRunning).toBe(0)
  }, 90_000)
})
