/**
 * src/simhost/__tests__/realtime.integration.test.ts
 *
 * The live bench's sample channel, measured through the real SimHost and the
 * bundled libngspice (issue #25). Before the redesign every accepted timepoint
 * crossed the FFI boundary (about 18 us) and was decoded into a Record (about
 * 0.8 us per saved vector), so the channel cost several times the solve: the
 * bench topped out near 0.02x (555 sample) and 0.15x (lantern-class deck).
 *
 * The original ideal lantern remains a model/channel-cost control. The routed
 * lantern exercises full physical DC followed by a reduced physical transient;
 * it and the bundled 555 must sustain at least 1x real time (issue #25).
 *
 * The additional channel-cost ratio isolates polling overhead:
 * the achieved wall-clock factor is mostly ngspice's own solve time, which
 * scales with the runner (CI runners are 2x to 5x slower than a dev machine,
 * and `npm test` runs the other ngspice files in parallel on the same cores).
 * Both the absolute factors and the ratios are recorded on every CI platform.
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
import { lanternBoard } from '../../core/copper/__tests__/lanternFixture'
import { reduceCopperNetwork } from '../../core/copper/kron'
import { parseBoard } from '../../core/kicad/board'
import { parseSchematicSimData } from '../../core/kicad/schematic'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import { extract, suggestGround } from '../../core/netlist/extract'
import { buildDeck, buildDeckWithUndriven, buildSolveInputs } from '../../core/solve/inputs'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { NgspiceFfiEngine, ngspiceResourcesAvailable } from '../ngspiceFfi'
import { BENCH_TSTEP_MAX_SECONDS, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[realtime] resources/ngspice/<platform> missing: the real-time factor checks are SKIPPED (run npm run fetch:ngspice)')
}

const MODELS = join(process.cwd(), 'resources', 'models')


interface Bench {
  label: string
  deck: string[]
  opDeck: string[]
  windowSeconds: number
  copperNodes: number
  copperResistors: number
  instruments: Instrument[]
  /** SPICE node of the net a scope probe would sit on. */
  probeNode: string
}

/** The app flow for a board: ground, a 5 V / 0.1 ohm supply on `supplyNet`, one scope probe on `probeNet`. */
function makeBench(boardText: string, supplyNet: string, probeNet: string, mode: 'ideal' | 'full' | 'reduced' = 'ideal', bundled555 = false): Bench {
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
  const schematic = bundled555 ? parseSchematicSimData(readFileSync('resources/sample/blinker-555.kicad_sch', 'utf8')) : undefined
  const resolutions = resolveAll(circuit, schematic, undefined, library)
  const supply = circuit.nets.find((n) => n.kicadName === supplyNet)
  const probe = circuit.nets.find((n) => n.kicadName === probeNet)
  if (!supply || !probe) throw new Error(`nets ${supplyNet} / ${probeNet} not found`)
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    { kind: 'dc-supply', id: 'auto-supply', netId: supply.id, volts: 5, seriesOhms: 0.1 },
    { kind: 'voltage-probe', id: 'probe-1', netId: probe.id, color: '#ffd166' }
  ]
  const inputs = buildSolveInputs(board, circuit, resolutions, instruments, gnd.id, {
    copperAware: mode !== 'ideal',
    copperOptions: bundled555 ? { supplyEntries: [
      { netId: supply.id, pos: { x: 32.34, y: 21.905 } },
      { netId: gnd.id, pos: { x: 27.66, y: 21.905 } },
    ] } : undefined,
    title: 'realtime-bench',
    modelTexts
  })
  const opDeck = buildDeckWithUndriven(inputs).deck
  const deck = mode === 'full' ? opDeck : buildDeck(inputs)
  const probeNode = inputs.copperNetwork?.padNode(bundled555 ? 'U1' : 'R48', bundled555 ? '3' : '1') ?? probe.spiceNode
  const copperNodes = inputs.copperNetwork
    ? (mode === 'reduced' ? reduceCopperNetwork(inputs.copperNetwork).nodes.length : inputs.copperNetwork.nodes.length)
    : 0
  return { deck, opDeck, instruments, probeNode, windowSeconds: mode === 'full' ? 1 : 30,
    label: `${bundled555 ? 'bundled-555' : supplyNet === 'VCC' ? 'routed-lantern' : 'ideal-lantern'}/${mode}`,
    copperNodes, copperResistors: deck.filter(card => card.startsWith('r_copper_')).length }
}

/** ngspice's accepted solver timepoints, rather than the number of saved rows. */
async function printNativeStats(engine: NgspiceFfiEngine, bench: Bench, tstep: number, channel: string): Promise<void> {
  const lines: string[] = []
  const unsub = engine.on(e => { if (e.type === 'char') lines.push(e.text.replace(/^stdout\s+/, '')) })
  try { await engine.command('rusage all', false) } finally { unsub() }
  const value = (name: string): number => Number(lines.find(line => line.startsWith(`${name} = `))?.split(' = ')[1])
  const iterations = value('Transient iterations')
  const accepted = value('Accepted timepoints')
  const rejected = value('Rejected timepoints')
  expect(accepted).toBeGreaterThan(0)
  expect(iterations).toBeGreaterThan(0)
  console.log(`[realtime] ${bench.label} ${channel} stats: tstep=${tstep}, copper nodes=${bench.copperNodes}, resistors=${bench.copperResistors}, ` +
    `Newton iterations=${iterations}, accepted solver timepoints=${accepted}, rejected=${rejected}, iterations/accepted=${(iterations / accepted).toFixed(3)}, ` +
    `tran=${value('Transient analysis time').toFixed(6)}s, load=${value('Transient load time').toFixed(6)}s, factor=${value('Transient factor time').toFixed(6)}s`)
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
async function measure(bench: Bench, pace: number | 'max', warmMs: number, measureMs: number, tstep = BENCH_TSTEP_MAX_SECONDS): Promise<Measurement> {
  let batches = 0
  let sampledUntil = 0
  let windowHead = 0
  let earlierWindows = 0
  let statuses = 0
  let notRunning = 0
  const engine = new NgspiceFfiEngine()
  const host = new SimHost({
    engine,
    emit: (e: SimEvent) => {
      if (e.type === 'status') {
        statuses++
        if (!e.running) notRunning++
      }
      if (e.type === 'samples') {
        batches++
        if (e.simTime.length > 0) {
          windowHead = Math.max(windowHead, e.simTime[e.simTime.length - 1])
          sampledUntil = earlierWindows + windowHead
        }
      }
      if (e.type === 'benchRestarted') {
        earlierWindows += windowHead
        windowHead = 0
      }
    },
    disableWatchdog: true,
    benchWindowSeconds: bench.windowSeconds
  })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: bench.opDeck })
    host.handleCommand({ type: 'runOp' })
    await host.whenIdle()
    host.handleCommand({ type: 'loadCircuit', deckLines: bench.deck })
    // The scope probe is the only series the renderer asks for at full rate;
    // everything else is tinted from display-rate snapshots.
    host.handleCommand({ type: 'watch', vectors: [bench.probeNode] })
    host.handleCommand({ type: 'setPace', realtimeFactor: pace })
    host.handleCommand({ type: 'runTransient', tstepSeconds: tstep, tstopSeconds: 300 })
    await host.whenIdle()
    await new Promise((r) => setTimeout(r, warmMs))
    const cpu0 = cpuSeconds()
    const sim0 = sampledUntil
    const wall0 = performance.now()
    await new Promise((r) => setTimeout(r, measureMs))
    const cpuFactor = (sampledUntil - sim0) / (cpuSeconds() - cpu0)
    // Very fast decks can finish every window before the next status tick.
    // Measure delivered sample timestamps across restarts against elapsed wall
    // time, which also accounts for restart overhead and delayed JS delivery.
    const factor = (sampledUntil - sim0) / ((performance.now() - wall0) / 1000)
    host.handleCommand({ type: 'stop' })
    await host.whenIdle()
    await printNativeStats(engine, bench, tstep, 'live')
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
async function measureBare(bench: Bench, t1: number, t2: number, tstep = BENCH_TSTEP_MAX_SECONDS): Promise<{ cpuFactor: number; factor: number }> {
  const engine = new NgspiceFfiEngine()
  const host = new SimHost({ engine, emit: () => {}, disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: bench.deck })
    await host.whenIdle()
    const run = async (tstop: number): Promise<{ cpu: number; wall: number }> => {
      const cpu = cpuSeconds()
      const wall = Date.now()
      await host.runTran(tstep, tstop)
      return { cpu: cpuSeconds() - cpu, wall: (Date.now() - wall) / 1000 }
    }
    const a = await run(t1)
    const b = await run(t2)
    await printNativeStats(engine, bench, tstep, 'foreground')
    return { cpuFactor: (t2 - t1) / (b.cpu - a.cpu), factor: (t2 - t1) / (b.wall - a.wall) }
  } finally {
    await host.dispose()
  }
}

/** Floor for live / bare sim seconds per CPU second (see the file header). */
const CHANNEL_OVERHEAD_FLOOR = 0.6

describe.skipIf(!haveNgspice)('live bench sample channel cost (real libngspice, issue #25)', () => {
  const b555 = haveNgspice ? makeBench(readFileSync('resources/sample/blinker-555.kicad_pcb', 'utf8'), 'VCC', 'OUT', 'reduced', true) : null
  const ideal555 = haveNgspice ? makeBench(readFileSync('resources/sample/blinker-555.kicad_pcb', 'utf8'), 'VCC', 'OUT', 'ideal', true) : null
  const lantern = haveNgspice ? makeBench(generateBoard(lanternShape(10)), '/PACK+', '/LED1_K') : null
  const routedFull = haveNgspice ? makeBench(lanternBoard(), 'VCC', 'VCC', 'full') : null
  const routedReduced = haveNgspice ? makeBench(lanternBoard(), 'VCC', 'VCC', 'reduced') : null
  /** Wall-clock factor the lantern-class deck reached at pace max in this process. */
  let lanternMax: number | null = null

  it.skipIf(process.env.CIRCSIM_PROFILE_REALTIME !== '1')('profiles the original 100 us step on all benchmark fixtures', async () => {
    for (const bench of [b555!, routedFull!, routedReduced!, lantern!]) {
      const bare = await measureBare(bench, 0.1, 0.3, 100e-6)
      console.log(`[realtime] baseline ${bench.label}, tstep=0.0001: bare ${bare.factor.toFixed(2)}x`)
    }
  }, 120_000)

  it('the quiet ceiling preserves the ideal 555 oscillator edges relative to 100 us', async () => {
    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      await host.loadCircuit(ideal555!.deck)
      const crossings = async (step: number): Promise<number[]> => {
        const result = await host.runTran(step, 1.4)
        const out = result.vectors[ideal555!.probeNode]
        const edges: number[] = []
        for (let i = 1; i < out.length; i++) {
          if (out[i - 1] < 2.5 !== out[i] < 2.5) edges.push(result.time[i])
        }
        return edges
      }
      const fine = await crossings(100e-6)
      const coarse = await crossings(BENCH_TSTEP_MAX_SECONDS)
      expect(fine).toHaveLength(3)
      expect(coarse).toHaveLength(fine.length)
      coarse.forEach((time, i) => expect(Math.abs(time - fine[i]) / fine[i]).toBeLessThan(0.02))
    } finally { await host.dispose() }
  }, 90_000)

  it('the bundled 555 with direct U1.8/1 leads sustains 1x with a physical transient', async () => {
    const bare = await measureBare(b555!, 20, 80)
    const live = await measure(b555!, 'max', 1000, 3000)
    const ratio = live.cpuFactor / bare.cpuFactor
    console.log(
      `[realtime] bundled-555 physical reduced, direct U1.8/1, tstep=${BENCH_TSTEP_MAX_SECONDS}: live pace max ${live.factor.toFixed(2)}x real time, bare tran ${bare.factor.toFixed(2)}x; ` +
        `sim s per CPU s live ${live.cpuFactor.toFixed(2)} / bare ${bare.cpuFactor.toFixed(2)} = ${ratio.toFixed(2)}`
    )
    expect(live.factor).toBeGreaterThanOrEqual(1)
  }, 90_000)

  it('records the routed lantern full-mesh cost', async () => {
    const bare = await measureBare(routedFull!, 0.5, 1.5)
    const live = await measure(routedFull!, 'max', 1000, 3000)
    console.log(`[realtime] routed lantern physical full, tstep=${BENCH_TSTEP_MAX_SECONDS}: live pace max ${live.factor.toFixed(2)}x, bare ${bare.factor.toFixed(2)}x`)
    expect(live.sampledUntil).toBeGreaterThan(0)
  }, 90_000)

  it('the routed lantern sustains 1x after full physical DC and a reduced transient', async () => {
    const bare = await measureBare(routedReduced!, 1, 3)
    const live = await measure(routedReduced!, 'max', 1000, 3000)
    console.log(`[realtime] routed lantern physical reduced, tstep=${BENCH_TSTEP_MAX_SECONDS}: live pace max ${live.factor.toFixed(2)}x, bare ${bare.factor.toFixed(2)}x`)
    expect(live.factor).toBeGreaterThanOrEqual(1)
    expect(live.sampledUntil).toBeGreaterThan(0)
  }, 90_000)

  it('a lantern-class deck: the live channel costs little next to the solve', async () => {
    const bare = await measureBare(lantern!, 10, 30)
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
    // Half of what is due: the two runs are seconds apart, and the load on a
    // shared runner moves the wall-clock factor between them (the slowest CI
    // leg, macos-15-intel at about 0.13x, measured 0.10x against 0.13x). A
    // pacer that holds the solver back (the old halt-based one) lands far below.
    expect(m.factor).toBeGreaterThan(0.5 * due)
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
