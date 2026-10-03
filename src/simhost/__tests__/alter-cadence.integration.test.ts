/**
 * src/simhost/__tests__/alter-cadence.integration.test.ts
 *
 * Knob drags against the REAL libngspice (PR #129 review): a supply knob turned
 * continuously sends an alter every couple of hundred milliseconds, and every
 * alter batch is a bg_halt / alters / bg_resume cycle. Two failures this pins:
 *
 *  (1) an alter must only ever reach ngspice while the background thread is
 *      halted. When the alters were issued straight from the command queue,
 *      they overtook a bg_resume still waiting out its settle gap on the
 *      halt/resume chain and landed on a thread that was starting: ngspice
 *      aborted the run ("singular matrix"), the stream froze, and the worker
 *      crashed on dispose;
 *  (2) a bg_resume of a run that has already ended never announces itself
 *      (ngspice answers "run simulation not started"), and the sample tick
 *      waits for that announcement. Re-armed by every alter, the wait never
 *      ran out, so the tail of the run was never delivered.
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
import { alterPlan, generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { BENCH_TSTEP_MAX_SECONDS, type SimCommand, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[alter-cadence] resources/ngspice/<platform> missing: the knob-drag checks are SKIPPED (run npm run fetch:ngspice)')
}

const MODELS = join(process.cwd(), 'resources', 'models')
const RC_DECK = ['* rc charge', 'v1 in 0 dc 5', 'r1 in out 1k', 'c1 out 0 1u ic=0', '.ic v(out)=0', '.end']
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Supply = Extract<Instrument, { kind: 'dc-supply' }>

/** The lantern-shaped synthetic board on a 5 V supply, one scope probe, and the alter a supply knob sends. */
function lanternBench(): { deck: string[]; probeNode: string; knob: (volts: number) => SimCommand } {
  const board = parseBoard(generateBoard(lanternShape(10)))
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
  const supplyNet = circuit.nets.find((n) => n.kicadName === '/PACK+')
  const probeNet = circuit.nets.find((n) => n.kicadName === '/LED1_K')
  if (!supplyNet || !probeNet) throw new Error('lantern nets not found')
  const supply: Supply = { kind: 'dc-supply', id: 'auto-supply', netId: supplyNet.id, volts: 5, seriesOhms: 0.1 }
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    supply,
    { kind: 'voltage-probe', id: 'probe-1', netId: probeNet.id, color: '#ffd166' }
  ]
  const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: gnd.id, title: 'alter-cadence', modelTexts })
  const knob = (volts: number): SimCommand => {
    const plan = alterPlan(supply, { ...supply, volts }, resolutions)
    if (plan.kind !== 'alter') throw new Error('a supply volts change must be an alter')
    // The renderer's parseAlterCommand form: device with its [dc] tag, value as text.
    const m = plan.commands[0].match(/^alter\s+(\S+)\s+(.*)$/)!
    return { type: 'alter', device: m[1], value: m[2] }
  }
  return { deck, probeNode: probeNet.spiceNode, knob }
}

interface Trace {
  events: SimEvent[]
  /** Sim time delivered by samples events, summed over bench windows (a fast run reaches the 30 s window end). */
  delivered: () => number
  /** Convergence failures and aborted-run messages seen. */
  failures: () => string[]
  /** Optional per-event hook, called as each event arrives. */
  onEvent: ((e: SimEvent) => void) | null
}

function trace(): Trace & { emit: (e: SimEvent) => void } {
  const events: SimEvent[] = []
  let earlierWindows = 0
  let thisWindow = 0
  const tr: Trace & { emit: (e: SimEvent) => void } = {
    events,
    onEvent: null,
    emit: (e) => {
      events.push(e)
      if (e.type === 'benchRestarted') {
        earlierWindows += thisWindow
        thisWindow = 0
      }
      if (e.type === 'samples' && e.simTime.length > 0) thisWindow = Math.max(thisWindow, e.simTime[e.simTime.length - 1])
      tr.onEvent?.(e)
    },
    delivered: () => earlierWindows + thisWindow,
    failures: () =>
      events
        .filter((e) => e.type === 'convergenceFailure' || (e.type === 'log' && /singular matrix|simulation\(s\) aborted/i.test(e.text)))
        .map((e) => (e.type === 'convergenceFailure' ? e.detail : e.type === 'log' ? e.text : ''))
  }
  return tr
}

describe.skipIf(!haveNgspice)('knob drags: an alter every 200 ms (real libngspice)', () => {
  const lantern = haveNgspice ? lanternBench() : null

  for (const pace of ['max', 1] as const) {
    it(`(1) the lantern-class run keeps streaming through 6 s of alters at pace ${pace}`, async () => {
      const t = trace()
      const host = new SimHost({ emit: t.emit, disableWatchdog: true })
      try {
        await host.start()
        host.handleCommand({ type: 'loadCircuit', deckLines: lantern!.deck })
        host.handleCommand({ type: 'watch', vectors: [lantern!.probeNode] })
        host.handleCommand({ type: 'setPace', realtimeFactor: pace })
        host.handleCommand({ type: 'runTransient', tstepSeconds: BENCH_TSTEP_MAX_SECONDS, tstopSeconds: 1000 })
        await host.whenIdle()
        await sleep(500)

        const progress: number[] = []
        for (let k = 0; k < 30; k++) {
          await sleep(200)
          host.handleCommand(lantern!.knob(k % 2 === 0 ? 5.5 : 5))
          if (k % 5 === 4) progress.push(t.delivered())
        }
        await sleep(1000)
        progress.push(t.delivered())
        console.log(`[alter-cadence] lantern pace ${pace}: delivered ${progress.map((p) => p.toFixed(2)).join(' -> ')}`)

        expect(t.failures(), 'no alter may land on a starting thread').toEqual([])
        // The stream never froze: every 1 s stretch of the drag delivered new sim time.
        for (let i = 1; i < progress.length; i++) {
          expect(progress[i], `delivery stalled after ${i} s of alters`).toBeGreaterThan(progress[i - 1])
        }
      } finally {
        await host.dispose()
      }
    }, 60_000)
  }

  // SimHost counts the saved vectors with a few-step probe (tran, 3 steps) before
  // the run starts, and the probe logs its own "No. of Data Rows": only a row
  // count of a whole run marks the end of the bench run.
  const isRunEnd = (text: string): boolean => {
    const m = /No\. of Data Rows\s*:\s*(\d+)/.exec(text)
    return m !== null && Number(m[1]) > 100
  }

  for (const delayedStartup of [false, true]) {
    it(`(2) a run that ends while the knob is still turning delivers its tail and reports done${delayedStartup ? ' with a delayed startup waiter' : ''}`, async () => {
      const t = trace()
      const host = new SimHost({ emit: t.emit, disableWatchdog: true })
      let dragTimer: ReturnType<typeof setInterval> | undefined
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await host.start()
        host.handleCommand({ type: 'loadCircuit', deckLines: RC_DECK })
        host.handleCommand({ type: 'watch', vectors: ['out'] })
        host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
        await host.whenIdle()

        const step = 1e-4
        const dragIntervalMs = 200
        // Size the finite run from this process's solve rate. A fixed 300k-step
        // run may outlast the drag on a slow runner. Aim for four knob intervals
        // of unhalted solve work, capped at one non-continuous bench window.
        const calibrationStart = performance.now()
        await host.runTran(step, 1)
        const calibrationMs = performance.now() - calibrationStart
        const stop = Number(Math.min(30, 4 * dragIntervalMs / calibrationMs).toPrecision(6))

        let firstAlterOrder = -1
        let endedOrder = -1
        let doneOrder = -1
        let firstAlterWall = -1
        let endedWall = -1
        let doneWall = -1
        let postEndTurns = 0
        let doneAfterTurns = -1
        let turns = 0
        // Cap the drag so a run that never streams or never logs its end fails
        // as an assertion below with a reason, not at the 60 s test timeout. The
        // deadline covers the case where no sample ever starts the drag.
        // This is only a hang guard. Under another full suite's load, the
        // foreground calibration can overestimate background throughput, so
        // keep dragging until the native run and its eight post-end turns
        // finish. Completion and the one-turn delivery bound below are the
        // assertions; exhausting an eight-second drag was a false failure.
        const maxTurns = 160
        let resolveEnd!: () => void
        let resolveDrag!: () => void
        const runEnded = new Promise<void>((resolve) => { resolveEnd = resolve })
        const dragFinished = new Promise<void>((resolve) => { resolveDrag = resolve })
        const turn = (): void => {
          // Eight post-end alters exercise the old endlessly re-armed resume
          // wait. Leave one complete knob interval for the last batch to drain.
          if (postEndTurns === 8 || turns >= maxTurns) {
            clearInterval(dragTimer)
            resolveDrag()
            return
          }
          if (firstAlterOrder < 0) {
            firstAlterOrder = t.events.length
            firstAlterWall = performance.now()
          }
          if (endedOrder >= 0) postEndTurns++
          host.handleCommand({ type: 'alter', device: 'v1', value: turns++ % 2 === 0 ? 6 : 5 })
        }
        t.onEvent = (e): void => {
          if (firstAlterOrder < 0 && e.type === 'samples' && e.simTime.length > 0) {
            // Begin at the first streamed sample, independently of when the
            // caller's startup waiter returns. Register before launching the run.
            turn()
            dragTimer = setInterval(turn, dragIntervalMs)
          }
          if (endedOrder < 0 && e.type === 'log' && isRunEnd(e.text)) {
            endedOrder = t.events.length
            endedWall = performance.now()
            resolveEnd()
          }
          if (doneOrder < 0 && e.type === 'status' && !e.running && e.simTimeSeconds >= stop - step * 1e-6) {
            doneOrder = t.events.length
            doneWall = performance.now()
            doneAfterTurns = postEndTurns
          }
        }
        deadline = setTimeout(() => { resolveEnd(); resolveDrag() }, (maxTurns + 5) * dragIntervalMs)
        host.handleCommand({ type: 'runTransient', tstepSeconds: step, tstopSeconds: stop })
        await host.whenIdle()
        // Reproduce a caller that does not regain control until the background
        // run has finished, without relying on this machine's solve speed. With
        // the drag now registered before the run launches, this case behaves like
        // the normal one: the drag starts at the first streamed sample whatever
        // this waiter does. It only guards against moving the drag back to after
        // this waiter, which would let the run finish before any alter.
        if (delayedStartup) await runEnded
        await dragFinished
        await host.whenIdle()
        console.log(
          `[alter-cadence] rc pace max${delayedStartup ? ' delayed startup' : ''}: calibrated ${calibrationMs.toFixed(1)} ms/s; ` +
            `delivered ${t.delivered()}/${stop} s; ngspice done ${(endedWall - firstAlterWall).toFixed(1)} ms after the first alter; ` +
            `renderer told ${(doneWall - endedWall).toFixed(1)} ms after that (${doneAfterTurns} post-end turns)`
        )

        expect(firstAlterOrder, 'a streamed sample started the knob drag').toBeGreaterThanOrEqual(0)
        expect(endedOrder, 'the run was still going when the knob started turning').toBeGreaterThan(firstAlterOrder)
        // ngspice's decimal endpoint can differ from the requested stop by an
        // IEEE-754 rounding bit. This tolerance is far smaller than one step.
        expect(t.delivered(), 'the whole run reached the renderer').toBeCloseTo(stop, 10)
        expect(doneOrder, 'a final status says the run is over').toBeGreaterThan(endedOrder)
        // Guards the resume-settle wait (RESUME_SETTLE_MAX_MS, 500 ms): the
        // final status must arrive within one knob turn (200 ms cadence) of the
        // run ending, while the drag continues, rather than after a wait for a
        // never-coming resume announcement. One turn is at least as strict as
        // the old 400 ms bound; two turns would allow 400 to 600 ms and straddle
        // the 500 ms wait this test exists to catch.
        expect(doneAfterTurns).toBeLessThanOrEqual(1)
        expect(t.failures()).toEqual([])
        expect(t.events.some((e) => e.type === 'log' && /run simulation not started/i.test(e.text)), 'no resume of a finished run').toBe(false)
      } finally {
        clearInterval(dragTimer)
        clearTimeout(deadline)
        t.onEvent = null
        await host.dispose()
      }
    }, 60_000)
  }
})
