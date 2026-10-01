/**
 * Unit tests for the SimHost sample channel (issues #25 and #78): samples are
 * READ from the plot vectors on a 16 ms tick instead of arriving through a
 * per-timepoint callback. Driven by a stub engine whose fake plot the tests
 * grow, and by an injected clock for the display-rate snapshot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SimHost, countAtMost } from '../index'
import type { SimEvent } from '../protocol'
import { StubEngine } from './stubEngine'

type Samples = Extract<SimEvent, { type: 'samples' }>

function makeHost(opts: { engine: StubEngine; now?: () => number; disableTimers?: boolean }): {
  host: SimHost
  events: SimEvent[]
} {
  const events: SimEvent[] = []
  const host = new SimHost({
    engine: opts.engine,
    emit: (e) => events.push(e),
    now: opts.now ?? (() => 1000),
    disableWatchdog: true,
    disableTimers: opts.disableTimers ?? true,
    resumeGapMs: 0
  })
  return { host, events }
}

/** Let the halt/resume commands queued on the host's engine chain run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

function samplesOf(events: SimEvent[]): Samples[] {
  return events.filter((e): e is Samples => e.type === 'samples')
}

/** Start a run. Unpaced by default, so the tests of the read mechanics are not about the pacing clock. */
async function startRun(host: SimHost, tstop = 30, pace: number | 'max' = 'max'): Promise<void> {
  host.handleCommand({ type: 'setPace', realtimeFactor: pace })
  host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: tstop })
  await host.whenIdle()
}

describe('sample tick cadence (#78)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes a pending point within 16 ms (a 15 ms tick), not on the 50 ms pacing tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine, disableTimers: false })
    await startRun(host)
    engine.pushPoint({ time: 0.001, out: 1 })

    vi.advanceTimersByTime(14)
    expect(samplesOf(events)).toHaveLength(0)
    vi.advanceTimersByTime(1) // 15 ms after the run started: within the documented 16 ms
    expect(samplesOf(events)).toHaveLength(1)
    expect(samplesOf(events)[0].simTime[0]).toBe(0.001)

    // And it keeps ticking every 15 ms, well inside the 50 ms pacing period.
    engine.pushPoint({ time: 0.002, out: 2 })
    vi.advanceTimersByTime(15)
    expect(samplesOf(events)).toHaveLength(2)
    await host.dispose()
  })

  it('stops ticking when the run is stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine, disableTimers: false })
    await startRun(host)
    engine.pushPoint({ time: 0.001, out: 1 })
    host.handleCommand({ type: 'stop' })
    await host.whenIdle()
    const afterStop = samplesOf(events).length // the tail was flushed by stop
    expect(afterStop).toBe(1)

    engine.pushPoint({ time: 0.002, out: 2 })
    vi.advanceTimersByTime(200)
    expect(samplesOf(events)).toHaveLength(afterStop)
    await host.dispose()
  })
})

describe('sample reads', () => {
  it('delivers each plot point once, in order, with every watched column the same length as simTime', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'a', 'b']
    const { host, events } = makeHost({ engine })
    await startRun(host)

    for (let i = 1; i <= 5; i++) engine.pushPoint({ time: i, a: i * 10, b: i * 100 })
    host.sampleTick()
    for (let i = 6; i <= 8; i++) engine.pushPoint({ time: i, a: i * 10, b: i * 100 })
    host.sampleTick()
    host.sampleTick() // nothing new: no event

    const s = samplesOf(events)
    expect(s).toHaveLength(2)
    expect(Array.from(s[0].simTime)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(s[1].simTime)).toEqual([6, 7, 8])
    expect(s[0].vectorNames).toEqual(['a', 'b'])
    expect(Array.from(s[1].columns[0])).toEqual([60, 70, 80])
    expect(Array.from(s[1].columns[1])).toEqual([600, 700, 800])
    for (const batch of s) {
      expect(batch.simTime).toBeInstanceOf(Float64Array)
      for (const c of batch.columns) expect(c.length).toBe(batch.simTime.length)
    }
  })

  it('emits the vector list once per run, without the scale vector', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'a', 'b']
    const { host, events } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, a: 1, b: 1 })
    host.sampleTick()
    const vectors = events.filter((e) => e.type === 'vectors')
    expect(vectors).toHaveLength(1)
    expect((vectors[0] as Extract<SimEvent, { type: 'vectors' }>).names).toEqual(['a', 'b'])
  })

  it('every vector read happens under the realloc lock', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'a', 'b']
    const { host } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, a: 1, b: 1 })
    host.handleCommand({ type: 'watch', vectors: ['a'] })
    await host.whenIdle()
    host.sampleTick()
    expect(engine.reads).toBeGreaterThan(0)
    expect(engine.unlockedReads).toBe(0)
    expect(engine.locked).toBe(false)
  })

  it('never reads while a queued command (such as a reload) may be rebuilding the plot', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, out: 1 })
    host.handleCommand({ type: 'loadCircuit', deckLines: ['* d', '.end'] }) // queued, not yet run
    host.sampleTick()
    expect(samplesOf(events)).toHaveLength(0)
    expect(engine.reads).toBe(0)
    await host.whenIdle()
    host.sampleTick()
    expect(samplesOf(events)).toHaveLength(1)
  })

  it('takes points only up to the shortest watched column, then catches up', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'a', 'b']
    const { host, events } = makeHost({ engine })
    await startRun(host)
    // ngspice appends the vectors of one timepoint one after the other; a read
    // can land after `time` and `a` got point 3 but before `b` did.
    engine.pushPoint({ time: 1, a: 1, b: 1 })
    engine.pushPoint({ time: 2, a: 2, b: 2 })
    engine.pushPoint({ time: 3, a: 3 })
    host.sampleTick()
    let s = samplesOf(events)
    expect(Array.from(s[0].simTime)).toEqual([1, 2])
    expect(Array.from(s[0].columns[1])).toEqual([1, 2])

    engine.plot.b.push(3)
    host.sampleTick()
    s = samplesOf(events)
    expect(Array.from(s[1].simTime)).toEqual([3])
    expect(Array.from(s[1].columns[0])).toEqual([3])
    expect(Array.from(s[1].columns[1])).toEqual([3])
  })

  it('fills a column whose vector cannot be read with NaN of the right length', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'a', '@d1[i]']
    engine.unreadable.add('@d1[i]')
    const { host, events } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, a: 5, '@d1[i]': 0 })
    engine.pushPoint({ time: 2, a: 6, '@d1[i]': 0 })
    host.sampleTick()
    const s = samplesOf(events)[0]
    expect(s.vectorNames).toEqual(['a', '@d1[i]'])
    expect(Array.from(s.columns[0])).toEqual([5, 6])
    expect(s.columns[1].length).toBe(2)
    expect(s.columns[1].every((v) => Number.isNaN(v))).toBe(true)
  })

  it('caps a batch at 4096 points and catches up over several back-to-back batches in one tick', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    for (let i = 1; i <= 10_000; i++) engine.pushPoint({ time: i, out: i })
    host.sampleTick()
    const s = samplesOf(events)
    expect(s.map((b) => b.simTime.length)).toEqual([4096, 4096, 1808])
    expect(s[2].simTime[1807]).toBe(10_000)
  })

  it('reports simTimeSeconds from the newest point it read (pacing and windows follow it)', async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host, events } = makeHost({ engine, now: () => t })
    await startRun(host)
    t += 1000
    engine.pushPoint({ time: 0.5, out: 1 })
    host.sampleTick()
    host.pacingTick()
    const status = events.find((e) => e.type === 'status') as Extract<SimEvent, { type: 'status' }>
    expect(status.simTimeSeconds).toBe(0.5)
    expect(status.realtimeFactor).toBeCloseTo(0.5, 5)
  })

  it('flushes the tail when the run is stopped', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, out: 1 })
    engine.pushPoint({ time: 2, out: 2 })
    host.handleCommand({ type: 'stop' })
    await host.whenIdle()
    const s = samplesOf(events)
    expect(s).toHaveLength(1)
    expect(Array.from(s[0].simTime)).toEqual([1, 2])
  })

  it('a finite run drains everything still unread before it reports done', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host, 5)
    // 40000 points to t = 8 s: one tick takes 8 x 4096 = 32768 of them (t = 6.55 s,
    // past the 5 s tstop) and leaves 7232 unread when the run finalizes.
    for (let i = 1; i <= 40_000; i++) engine.pushPoint({ time: i * 0.0002, out: i })
    host.sampleTick()
    engine.running = false // ngspice reached tstop on its own
    host.pacingTick()
    const rows = samplesOf(events).reduce((n, b) => n + b.simTime.length, 0)
    expect(rows).toBe(40_000)
    const lastStatus = [...events].reverse().find((e) => e.type === 'status') as Extract<SimEvent, { type: 'status' }>
    expect(lastStatus.running).toBe(false)
    expect(lastStatus.simTimeSeconds).toBeCloseTo(8, 9)
  })
})

describe('initData repeated by a resume (alter batches, pacing halts)', () => {
  it('does not replay the plot from the start: the read cursor survives', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    for (let i = 1; i <= 4; i++) engine.pushPoint({ time: i, out: i })
    host.sampleTick()

    // ngspice re-sends SendInitData on bg_resume although the run, and the
    // plot, continue.
    engine.emit({ type: 'initData', plot: 'Transient Analysis', analysisType: 'transient', names: ['time', 'out'] })
    engine.pushPoint({ time: 5, out: 5 })
    host.sampleTick()

    const times = samplesOf(events).flatMap((b) => Array.from(b.simTime))
    expect(times).toEqual([1, 2, 3, 4, 5])
    expect(events.filter((e) => e.type === 'vectors')).toHaveLength(1)
  })

  it('starts over when the plot turns out shorter than what was delivered (a new plot)', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    for (let i = 1; i <= 6; i++) engine.pushPoint({ time: i, out: i })
    host.sampleTick()

    engine.plot = { time: [0.5, 1.5], out: [9, 9] } // a fresh, shorter plot
    host.sampleTick()
    const s = samplesOf(events)
    expect(Array.from(s[1].simTime)).toEqual([0.5, 1.5])
  })
})

describe('watch: full series for watched vectors, display-rate latest for the rest', () => {
  async function watchedHost(): Promise<{ host: SimHost; engine: StubEngine; events: SimEvent[]; clock: { t: number } }> {
    const engine = new StubEngine()
    engine.initNames = ['time', 'out', 'n1', 'n2', 'vsense_d1#branch']
    const clock = { t: 1000 }
    const { host, events } = makeHost({ engine, now: () => clock.t })
    host.handleCommand({ type: 'watch', vectors: ['OUT'] }) // case-insensitive
    await startRun(host)
    return { host, engine, events, clock }
  }

  const row = (t: number): Record<string, number> => ({
    time: t,
    out: t * 2,
    n1: t * 3,
    n2: t * 4,
    'vsense_d1#branch': t * 5
  })

  it('puts only the watched vectors in columns and the others in latest', async () => {
    const { host, engine, events } = await watchedHost()
    for (let i = 1; i <= 3; i++) engine.pushPoint(row(i))
    host.sampleTick()
    const s = samplesOf(events)[0]
    expect(s.vectorNames).toEqual(['out'])
    expect(Array.from(s.columns[0])).toEqual([2, 4, 6])
    expect(s.latest).toBeDefined()
    expect(s.latest!.vectorNames).toEqual(['n1', 'n2', 'vsense_d1#branch'])
    expect(Array.from(s.latest!.values)).toEqual([9, 12, 15])
  })

  it('refreshes latest about every 33 ms, not on every batch', async () => {
    const { host, engine, events, clock } = await watchedHost()
    engine.pushPoint(row(1))
    host.sampleTick() // t=1000: snapshot due
    clock.t += 16
    engine.pushPoint(row(2))
    host.sampleTick() // 16 ms later: none
    clock.t += 17
    engine.pushPoint(row(3))
    host.sampleTick() // 33 ms after the first: due again
    const s = samplesOf(events)
    expect(s.map((b) => b.latest !== undefined)).toEqual([true, false, true])
    expect(Array.from(s[2].latest!.values)).toEqual([9, 12, 15]) // newest point, t=3
  })

  it('sends no latest snapshot while nothing advanced (a paused bench stays quiet)', async () => {
    const { host, engine, events, clock } = await watchedHost()
    engine.pushPoint(row(1))
    host.sampleTick()
    clock.t += 500
    host.sampleTick()
    host.sampleTick()
    expect(samplesOf(events)).toHaveLength(1)
  })

  it('a vector that cannot be read shows as NaN in latest', async () => {
    const { host, engine, events } = await watchedHost()
    engine.unreadable.add('n2')
    engine.pushPoint(row(1))
    host.sampleTick()
    const v = samplesOf(events)[0].latest!.values
    expect(v[0]).toBe(3)
    expect(Number.isNaN(v[1])).toBe(true)
    expect(v[2]).toBe(5)
  })

  it('watch can be changed mid-run and applies from the next tick', async () => {
    const { host, engine, events } = await watchedHost()
    engine.pushPoint(row(1))
    host.sampleTick()
    host.handleCommand({ type: 'watch', vectors: ['out', 'n1'] })
    await host.whenIdle()
    engine.pushPoint(row(2))
    host.sampleTick()
    const s = samplesOf(events)
    expect(s[0].vectorNames).toEqual(['out'])
    expect(s[1].vectorNames).toEqual(['out', 'n1'])
    expect(Array.from(s[1].columns[1])).toEqual([6]) // n1 at t=2, from the cursor on
  })

  it('without any watch command every vector is a full series and there is no latest', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'out', 'n1']
    const { host, events } = makeHost({ engine })
    await startRun(host)
    engine.pushPoint({ time: 1, out: 1, n1: 2 })
    host.sampleTick()
    const s = samplesOf(events)[0]
    expect(s.vectorNames).toEqual(['out', 'n1'])
    expect(s.latest).toBeUndefined()
  })

  it('loading a new deck resets the watch to every vector', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'out', 'n1']
    const { host, events } = makeHost({ engine })
    host.handleCommand({ type: 'watch', vectors: ['out'] })
    host.handleCommand({ type: 'loadCircuit', deckLines: ['* d', '.end'] })
    await startRun(host)
    engine.pushPoint({ time: 1, out: 1, n1: 2 })
    host.sampleTick()
    expect(samplesOf(events)[0].vectorNames).toEqual(['out', 'n1'])
    expect(samplesOf(events)[0].latest).toBeUndefined()
  })

  it('the watch survives a bench-window restart', async () => {
    const engine = new StubEngine()
    engine.initNames = ['time', 'out', 'n1']
    const { host, events } = makeHost({ engine })
    host.handleCommand({ type: 'loadCircuit', deckLines: ['* d', '.end'] })
    host.handleCommand({ type: 'watch', vectors: ['out'] })
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 100 })
    await host.whenIdle()
    engine.pushPoint({ time: 31, out: 1, n1: 2 }) // past the 30 s window
    host.sampleTick()
    host.pacingTick()
    await host.whenIdle()
    engine.pushPoint({ time: 0.001, out: 1, n1: 2 }) // the restarted run
    host.sampleTick()
    const s = samplesOf(events)
    expect(s[s.length - 1].vectorNames).toEqual(['out'])
    expect(events.some((e) => e.type === 'benchRestarted')).toBe(true)
  })
})

describe('pace set before the run starts', () => {
  it('a setPace sent before runTransient is the pace the run starts at', async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host } = makeHost({ engine, now: () => t })
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    t += 50
    engine.pushPoint({ time: 5, out: 1 }) // far ahead of wall-clock: would halt at 1x
    host.sampleTick()
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('none')
  })
})

describe('real-time pacing releases points on the wall clock', () => {
  /** A host running at `pace` with a controllable clock; the plot grows by pushing points. */
  async function pacedHost(pace: number): Promise<{ host: SimHost; engine: StubEngine; events: SimEvent[]; clock: { t: number } }> {
    const engine = new StubEngine()
    engine.initNames = ['time', 'out', 'n1']
    const clock = { t: 1000 }
    const { host, events } = makeHost({ engine, now: () => clock.t })
    host.handleCommand({ type: 'watch', vectors: ['out'] })
    await startRun(host, 30, pace)
    return { host, engine, events, clock }
  }

  const deliveredTimes = (events: SimEvent[]): number[] => samplesOf(events).flatMap((b) => Array.from(b.simTime))

  it('delivers only the points the pacing clock has reached, however far ahead ngspice is', async () => {
    const { host, engine, events, clock } = await pacedHost(1)
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i }) // 100 ms of sim, all computed at once

    clock.t += 16
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.016, 9)
    clock.t += 16
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.032, 9)
    clock.t += 16
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.048, 9)
    // Steady 16 points per tick, no bursts, nothing skipped or repeated.
    expect(samplesOf(events).map((b) => b.simTime.length)).toEqual([16, 16, 16])
  })

  it('pace 0.5 delivers half as fast', async () => {
    const { host, engine, events, clock } = await pacedHost(0.5)
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i })
    clock.t += 40
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.02, 9)
  })

  it('the latest snapshot is taken at the newest delivered point, not at the head of the plot', async () => {
    const { host, engine, events, clock } = await pacedHost(1)
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i * 10 })
    clock.t += 20
    host.sampleTick() // delivered up to point 20
    const latest = samplesOf(events)[0].latest!
    expect(latest.vectorNames).toEqual(['n1'])
    expect(latest.values[0]).toBe(200) // n1 at point 20, not 1000 at point 100
  })

  it('holds the sim back only once it is more than 0.3 s of wall time ahead, and lets go below 0.15 s', async () => {
    const { host, engine, clock } = await pacedHost(1)
    for (let i = 1; i <= 200; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i }) // head 0.2 s
    host.sampleTick()
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('none') // 0.2 s ahead: within the lead

    for (let i = 201; i <= 400; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i }) // head 0.4 s
    host.sampleTick()
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('pacing')
    await settle()
    expect(engine.commands.filter((c) => c === 'bg_halt')).toHaveLength(1)

    // The wall clock catches up; delivery drains the lead below 0.15 s.
    clock.t += 300 // delivered ~0.3 s: lead 0.1 s
    host.sampleTick()
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('none')
    await settle()
    expect(engine.commands.filter((c) => c === 'bg_resume')).toHaveLength(1)
  })

  it('a sim that is slower than real time is delivered as fast as it comes, and never repays the lag in a burst', async () => {
    const { host, engine, events, clock } = await pacedHost(1)
    clock.t += 1000 // a full second of wall time with only 0.1 s of sim computed
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i })
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.1, 9) // everything computed so far

    // The sim then jumps ahead by 10 s of sim time within the next 16 ms.
    clock.t += 16
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: 0.1 + i * 0.1, out: i, n1: i })
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeLessThan(0.1 + 0.017) // only the 16 ms of the new anchor
  })

  it('delivers nothing while the user has paused, and a resume continues from there without a burst', async () => {
    const { host, engine, events, clock } = await pacedHost(1)
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i })
    clock.t += 20
    host.sampleTick()
    const before = deliveredTimes(events).length
    expect(before).toBe(20)

    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    clock.t += 5000
    host.sampleTick()
    expect(deliveredTimes(events)).toHaveLength(before) // frozen

    host.handleCommand({ type: 'resume' })
    await host.whenIdle()
    clock.t += 16
    host.sampleTick()
    // 16 ms past the 20 ms already delivered, not 5 s of pause repaid at once.
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.036, 9)
  })

  it('a pace change applies from now on', async () => {
    const { host, engine, events, clock } = await pacedHost(1)
    for (let i = 1; i <= 1000; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i })
    clock.t += 10
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.01, 9)

    host.handleCommand({ type: 'setPace', realtimeFactor: 10 })
    await host.whenIdle()
    clock.t += 10
    host.sampleTick()
    expect(deliveredTimes(events).at(-1)).toBeCloseTo(0.01 + 0.1, 9)
  })

  it('stopping delivers the whole tail that pacing was still holding back', async () => {
    const { host, engine, events } = await pacedHost(1)
    for (let i = 1; i <= 100; i++) engine.pushPoint({ time: i * 0.001, out: i, n1: i })
    host.handleCommand({ type: 'stop' })
    await host.whenIdle()
    expect(deliveredTimes(events)).toHaveLength(100)
  })
})

describe('countAtMost', () => {
  it('counts the leading points at or below the limit', () => {
    const t = Float64Array.of(1, 2, 3, 4, 5)
    expect(countAtMost(t, 5, 0.5)).toBe(0)
    expect(countAtMost(t, 5, 1)).toBe(1)
    expect(countAtMost(t, 5, 3.5)).toBe(3)
    expect(countAtMost(t, 5, 5)).toBe(5)
    expect(countAtMost(t, 5, 99)).toBe(5)
    expect(countAtMost(t, 3, 99)).toBe(3) // only the first n elements count
  })
})

describe('halting and resuming the background thread', () => {
  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Real clock and a real settle gap: these tests are about the ORDER and spacing of bg_halt / bg_resume. */
  function settlingHost(engine: StubEngine, gapMs: number): { host: SimHost } {
    const host = new SimHost({
      engine,
      emit: () => {},
      disableWatchdog: true,
      disableTimers: true,
      resumeGapMs: gapMs
    })
    return { host }
  }

  it('never halts a run that has not announced itself yet (a pause right behind Run)', async () => {
    const engine = new StubEngine()
    const { host } = settlingHost(engine, 30)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    await sleepMs(100)
    expect(engine.commands).not.toContain('bg_halt') // the thread is still starting: no initData yet

    engine.pushPoint({ time: 1e-4, out: 1 }) // SendInitData: the run is going
    await sleepMs(150)
    expect(engine.commands).toContain('bg_halt')
    await host.dispose()
  })

  it('leaves a resumed thread alone until it has announced itself and run a moment', async () => {
    const engine = new StubEngine()
    const stamps: Record<string, number> = {}
    const command = engine.command.bind(engine)
    engine.command = (cmd: string): Promise<void> => {
      if (cmd === 'bg_halt' || cmd === 'bg_resume') stamps[cmd] = Date.now()
      return command(cmd)
    }
    const { host } = settlingHost(engine, 20)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 }) // initData: running
    await sleepMs(80)

    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    await sleepMs(30)
    host.handleCommand({ type: 'resume' })
    await host.whenIdle() // the settle gap has passed: the bg_resume is out
    expect(engine.commands).toContain('bg_resume')
    host.handleCommand({ type: 'halt' }) // right behind the resume
    await host.whenIdle()
    await sleepMs(200)

    // bg_halt, bg_resume (which announces itself in the stub), then the second
    // bg_halt only once the resumed thread has run a moment.
    const order = engine.commands.filter((c) => c === 'bg_halt' || c === 'bg_resume')
    expect(order).toEqual(['bg_halt', 'bg_resume', 'bg_halt'])
    expect(stamps['bg_halt'] - stamps['bg_resume']).toBeGreaterThanOrEqual(45)
    await host.dispose()
  })

  it('a resume still waiting when a new halt is asked for is dropped, not started and halted again', async () => {
    const engine = new StubEngine()
    const { host } = settlingHost(engine, 60)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)

    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    host.handleCommand({ type: 'resume' }) // waits out the 60 ms settle gap
    host.handleCommand({ type: 'halt' }) // paused again before it is out
    await host.whenIdle()
    await sleepMs(200)

    expect(engine.commands.filter((c) => c === 'bg_resume')).toEqual([])
    expect(host.getHaltOwner()).toBe('user')
    expect(engine.running).toBe(false)
    await host.dispose()
  })

  it('a resume waits out the settle gap after the halt completed', async () => {
    const engine = new StubEngine()
    const stamps: Record<string, number> = {}
    const orig = engine.command.bind(engine)
    engine.command = (cmd: string): Promise<void> => {
      if (cmd === 'bg_halt' || cmd === 'bg_resume') stamps[cmd] = Date.now()
      return orig(cmd)
    }
    const { host } = settlingHost(engine, 60)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)

    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    host.handleCommand({ type: 'resume' })
    await host.whenIdle()
    await sleepMs(250)
    expect(stamps['bg_resume'] - stamps['bg_halt']).toBeGreaterThanOrEqual(55)
    await host.dispose()
  })

  it('a stop that follows a resume cancels the resume that is still waiting', async () => {
    const engine = new StubEngine()
    const { host } = settlingHost(engine, 200)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)
    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    host.handleCommand({ type: 'resume' })
    await host.whenIdle()
    host.handleCommand({ type: 'stop' }) // the resume is still inside its settle gap
    await host.whenIdle()
    await sleepMs(500)
    expect(engine.commands).not.toContain('bg_resume')
    expect(engine.running).toBe(false)
    await host.dispose()
  })

  it('a run started right after a stop reaches ngspice only after the stop has halted the old one', async () => {
    const engine = new StubEngine()
    const { host } = settlingHost(engine, 30)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    // Stop and Run again at once: the stop's halt still waits for the young
    // thread to have run a moment.
    host.handleCommand({ type: 'stop' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    await sleepMs(150)
    const order = engine.commands.filter((c) => c === 'bg_halt' || c.startsWith('bg_tran'))
    expect(order).toEqual(['bg_tran 0.0001 30 uic', 'bg_halt', 'bg_tran 0.0001 30 uic'])
    expect(engine.running).toBe(true) // the new run was not halted by the old stop
    await host.dispose()
  })
})

describe('knob drags: alters at a steady cadence (PR #129 review)', () => {
  const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Real clock and settle gap; records whether the thread was running when each alter reached the engine. */
  function dragHost(engine: StubEngine, gapMs: number): { host: SimHost; events: SimEvent[]; altersWhileRunning: string[] } {
    const events: SimEvent[] = []
    const altersWhileRunning: string[] = []
    const command = engine.command.bind(engine)
    engine.command = (cmd: string): Promise<void> => {
      if (cmd.startsWith('alter') && engine.running) altersWhileRunning.push(cmd)
      return command(cmd)
    }
    const host = new SimHost({
      engine,
      emit: (e) => events.push(e),
      disableWatchdog: true,
      disableTimers: true,
      resumeGapMs: gapMs
    })
    return { host, events, altersWhileRunning }
  }

  const turn = (host: SimHost, volts: number): void => {
    host.handleCommand({ type: 'alter', device: 'v1', value: volts })
    host.flushAlters() // the 30 ms coalesce window, closed now
  }

  const haltsResumesAlters = (engine: StubEngine): string[] =>
    engine.commands.filter((c) => c === 'bg_halt' || c === 'bg_resume' || c.startsWith('alter'))

  it('an alter is applied inside its own halt / resume window, never ahead of a resume still waiting out its gap', async () => {
    const engine = new StubEngine()
    const { host, altersWhileRunning } = dragHost(engine, 60)
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)

    turn(host, 6)
    await host.whenIdle() // applied; its bg_resume now waits out the 60 ms gap
    turn(host, 7) // the next step of the drag lands inside that gap
    await host.whenIdle()
    await sleepMs(300)

    expect(haltsResumesAlters(engine)).toEqual([
      'bg_halt',
      'alter v1 = 6',
      'bg_resume',
      'bg_halt',
      'alter v1 = 7',
      'bg_resume'
    ])
    expect(altersWhileRunning).toEqual([])
    await host.dispose()
  })

  it('alters that arrive while a batch waits for its halt join that batch', async () => {
    const engine = new StubEngine()
    const { host, altersWhileRunning } = dragHost(engine, 60)
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)

    turn(host, 6)
    await host.whenIdle()
    turn(host, 7) // waits behind the resume of the 6 V batch
    await sleepMs(10)
    turn(host, 8) // the drag goes on meanwhile
    turn(host, 9)
    await host.whenIdle()
    await sleepMs(300)

    // One halt / resume cycle per batch, not one per alter.
    expect(haltsResumesAlters(engine)).toEqual([
      'bg_halt',
      'alter v1 = 6',
      'bg_resume',
      'bg_halt',
      'alter v1 = 7',
      'alter v1 = 8',
      'alter v1 = 9',
      'bg_resume'
    ])
    expect(altersWhileRunning).toEqual([])
    await host.dispose()
  })

  it('a pause during a drag is not held up behind the alter batches', async () => {
    const engine = new StubEngine()
    const { host } = dragHost(engine, 60)
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)

    turn(host, 6)
    await host.whenIdle()
    turn(host, 7) // its halt waits behind the 6 V batch's resume
    host.handleCommand({ type: 'halt' })
    await host.whenIdle() // the command queue is free at once
    expect(host.getHaltOwner()).toBe('user')
    expect(engine.commands).not.toContain('alter v1 = 7')
    turn(host, 8) // still dragging while paused: applied, never resumed
    await host.whenIdle()
    await sleepMs(300)

    // Both batches' resumes are dropped: the pause asked for since then would
    // only halt the thread again (the bg_halts after the first find it halted).
    expect(haltsResumesAlters(engine)).toEqual([
      'bg_halt',
      'alter v1 = 6',
      'bg_halt',
      'alter v1 = 7',
      'alter v1 = 8',
      'bg_halt'
    ])
    expect(engine.running).toBe(false)
    await host.dispose()
  })

  it('samples keep flowing while an alter batch waits for its halt', async () => {
    const engine = new StubEngine()
    const { host, events } = dragHost(engine, 60)
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-4, tstopSeconds: 30 })
    await host.whenIdle()
    engine.pushPoint({ time: 1e-4, out: 1 })
    await sleepMs(80)
    turn(host, 6)
    await host.whenIdle()
    turn(host, 7) // in the queue, waiting behind the 6 V batch's resume
    await sleepMs(10)
    expect(engine.commands).not.toContain('alter v1 = 7')

    engine.pushPoint({ time: 2e-4, out: 2 })
    host.sampleTick()
    const delivered = samplesOf(events).flatMap((b) => Array.from(b.simTime))
    expect(delivered).toEqual([1e-4, 2e-4])
    await host.whenIdle()
    await host.dispose()
  })

  it('a run that ended by itself is not resumed by a knob turn, and its tail is delivered at once', async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host, events } = makeHost({ engine, now: () => t }) // the settle bound never runs out on this clock
    await startRun(host)
    for (let i = 1; i <= 5; i++) engine.pushPoint({ time: i, out: i })
    host.sampleTick()
    for (let i = 6; i <= 10; i++) engine.pushPoint({ time: i, out: i }) // computed, not delivered yet
    engine.endRun() // ngspice stopped by itself (the run failed, or reached its stop)

    for (let k = 0; k < 5; k++) {
      turn(host, 6 + k)
      await host.whenIdle()
      await settle()
      host.sampleTick()
    }

    expect(engine.commands.filter((c) => c === 'bg_resume')).toEqual([])
    expect(engine.commands.filter((c) => c.startsWith('alter'))).toHaveLength(5)
    const delivered = samplesOf(events).flatMap((b) => Array.from(b.simTime))
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    t += 1000
    host.pacingTick()
    const status = [...events].reverse().find((e) => e.type === 'status') as Extract<SimEvent, { type: 'status' }>
    expect(status.running).toBe(false) // over, though the knob keeps halting and "resuming" it
  })

  it('a resume that finds the run already over stops the wait for its announcement and is not repeated', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost({ engine })
    await startRun(host)
    for (let i = 1; i <= 3; i++) engine.pushPoint({ time: i, out: i })
    host.sampleTick()
    host.handleCommand({ type: 'halt' })
    await host.whenIdle()
    await settle()
    // The run had reached its end just as the halt arrived: there is nothing
    // left to resume, which only the resume itself finds out.
    for (let i = 4; i <= 6; i++) engine.pushPoint({ time: i, out: i })
    engine.endRun()

    host.handleCommand({ type: 'resume' })
    await host.whenIdle()
    await settle()
    host.sampleTick()
    expect(samplesOf(events).flatMap((b) => Array.from(b.simTime))).toEqual([1, 2, 3, 4, 5, 6])

    turn(host, 7)
    await host.whenIdle()
    await settle()
    expect(engine.commands.filter((c) => c === 'bg_resume')).toHaveLength(1)
  })
})
