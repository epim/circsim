/**
 * Unit tests for SimHost pacing + bounded bench windows + alter batching, driven
 * by a stub engine and an injected clock (Spec §7.4.3, §7.5). No real ngspice.
 *
 * These exercise the orchestration logic that the integration test cannot pin
 * deterministically (timing, RSS guard, restart sequencing).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  SimHost,
  TRAN_MEMORY_BUDGET_BYTES,
  buildAlterCommand,
  fitTranStop,
  formatNum,
  ngspiceTranMemoryBytes
} from '../index'
import type { EngineEvent, EngineEventListener, SpiceEngine } from '../engine'
import type { SimEvent } from '../protocol'

/** Minimal scriptable SpiceEngine stub: records commands, replays events. */
class StubEngine implements SpiceEngine {
  version = '46'
  commands: string[] = []
  private listeners: EngineEventListener[] = []
  running = false

  init(): void {}
  on(l: EngineEventListener): () => void {
    this.listeners.push(l)
    return () => {
      const i = this.listeners.indexOf(l)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
  emit(ev: EngineEvent): void {
    for (const l of this.listeners) l(ev)
  }
  loadCircuit(): void {}
  command(cmd: string): Promise<void> {
    this.commands.push(cmd)
    if (cmd.startsWith('bg_tran')) this.running = true
    if (cmd === 'bg_halt') this.running = false
    if (cmd === 'bg_resume') this.running = true
    return Promise.resolve()
  }
  currentPlot(): string {
    return 'tran1'
  }
  /** Vector names a transient plot reports; empty unless a test sets it. */
  vectors: string[] = []
  allVectors(): string[] {
    return this.vectors
  }
  vectorData(): Float64Array | undefined {
    return undefined
  }
  isRunning(): boolean {
    return this.running
  }
  dispose(): void {}
}

function makeHost(opts: {
  engine: StubEngine
  now: () => number
  rssBytes?: () => number
  benchWindowSeconds?: number
  tranMemoryBudgetBytes?: number
}): { host: SimHost; events: SimEvent[] } {
  const events: SimEvent[] = []
  const host = new SimHost({
    engine: opts.engine,
    emit: (e) => events.push(e),
    now: opts.now,
    rssBytes: opts.rssBytes,
    benchWindowSeconds: opts.benchWindowSeconds,
    tranMemoryBudgetBytes: opts.tranMemoryBudgetBytes,
    disableWatchdog: true,
    disableTimers: true // unit test steps pacingTick() manually
  })
  return { host, events }
}

describe('SimHost transient command', () => {
  it('runTransient issues bg_tran with uic and caps tstop to the bench window', async () => {
    const engine = new StubEngine()
    const t = 0
    const { host } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 1000 })
    await host.whenIdle()
    const tranCmd = engine.commands.find((c) => c.startsWith('bg_tran'))
    expect(tranCmd).toBeDefined()
    // tstop capped to 30 (the bench window), uic appended. JS String(1e-5) ===
    // '0.00001' (decimal down to 1e-6); never a SPICE letter suffix.
    expect(tranCmd).toContain('uic')
    expect(tranCmd).toBe('bg_tran 0.00001 30 uic')
    expect(host.isTransientActive()).toBe(true)
  })
})

describe('SimHost pacing', () => {
  it('halts (owner=pacing) when sim-time runs ahead of wall-clock', async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()

    // Advance wall-clock 50 ms but report sim-time of 5 s (way ahead of 1x target).
    t += 50
    engine.emit({ type: 'data', row: { time: 5, out: 1 }, scaleName: 'time' })
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('pacing')
    expect(engine.commands).toContain('bg_halt')
  })

  it("'max' pace never halts for pacing", async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    await host.whenIdle()

    t += 50
    engine.emit({ type: 'data', row: { time: 10, out: 1 }, scaleName: 'time' })
    host.pacingTick()
    expect(host.getHaltOwner()).toBe('none')
  })

  it('reports achieved realtimeFactor in a status event', async () => {
    const engine = new StubEngine()
    let t = 1000
    const { host, events } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()

    // After 1 s wall, sim-time 0.5 s → factor 0.5×.
    t += 1000
    engine.emit({ type: 'data', row: { time: 0.5, out: 1 }, scaleName: 'time' })
    host.pacingTick()
    const status = events.find((e) => e.type === 'status') as
      | Extract<SimEvent, { type: 'status' }>
      | undefined
    expect(status).toBeDefined()
    expect(status!.realtimeFactor).toBeCloseTo(0.5, 5)
  })
})

describe('SimHost bounded bench windows (Spec §7.5)', () => {
  it('restarts when sim-time reaches the bench window and emits benchRestarted', async () => {
    const engine = new StubEngine()
    const t = 1000
    const { host, events } = makeHost({ engine, now: () => t, benchWindowSeconds: 5 })
    host.handleCommand({ type: 'loadCircuit', deckLines: ['* d', 'v1 in 0 dc 5', '.end'] })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()

    // Drive sim-time past the 5 s window.
    engine.emit({ type: 'data', row: { time: 5.0, out: 1 }, scaleName: 'time' })
    host.pacingTick()
    await host.whenIdle()

    const restart = events.find((e) => e.type === 'benchRestarted') as
      | Extract<SimEvent, { type: 'benchRestarted' }>
      | undefined
    expect(restart).toBeDefined()
    expect(restart!.reason).toBe('window-elapsed')
    expect(engine.commands).toContain('destroy all')
    // A fresh bg_tran was issued after the restart.
    expect(engine.commands.filter((c) => c.startsWith('bg_tran')).length).toBeGreaterThanOrEqual(2)
  })

  it('restarts on RSS guard with reason "memory"', async () => {
    const engine = new StubEngine()
    const t = 1000
    const { host, events } = makeHost({
      engine,
      now: () => t,
      benchWindowSeconds: 30,
      rssBytes: () => 2 * 1024 * 1024 * 1024 // 2 GB > 1.5 GB guard
    })
    host.handleCommand({ type: 'loadCircuit', deckLines: ['* d', 'v1 in 0 dc 5', '.end'] })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()

    engine.emit({ type: 'data', row: { time: 0.1, out: 1 }, scaleName: 'time' })
    host.pacingTick()
    await host.whenIdle()

    const restart = events.find((e) => e.type === 'benchRestarted') as
      | Extract<SimEvent, { type: 'benchRestarted' }>
      | undefined
    expect(restart).toBeDefined()
    expect(restart!.reason).toBe('memory')
  })
})

describe('SimHost alter batching (Spec §7.4.3)', () => {
  it('coalesces multiple alters into one bg_halt/bg_resume window', async () => {
    const engine = new StubEngine()
    const t = 1000
    const { host } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()
    engine.commands.length = 0 // clear the bg_tran

    host.handleCommand({ type: 'alter', device: 'V1', value: 6 })
    host.handleCommand({ type: 'alter', device: 'V1', value: 7 })
    host.flushAlters() // force the coalesce window closed
    await host.whenIdle()

    const halts = engine.commands.filter((c) => c === 'bg_halt').length
    const resumes = engine.commands.filter((c) => c === 'bg_resume').length
    expect(halts).toBe(1)
    expect(resumes).toBe(1)
    // Both alters issued (device lowercased), between halt and resume.
    expect(engine.commands).toContain('alter v1 = 6')
    expect(engine.commands).toContain('alter v1 = 7')
    const halI = engine.commands.indexOf('bg_halt')
    const resI = engine.commands.indexOf('bg_resume')
    const a1 = engine.commands.indexOf('alter v1 = 6')
    expect(a1).toBeGreaterThan(halI)
    expect(a1).toBeLessThan(resI)
  })

  it('alter during a user pause applies but does not resume', async () => {
    const engine = new StubEngine()
    const t = 1000
    const { host } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-3, tstopSeconds: 30 })
    await host.whenIdle()
    host.handleCommand({ type: 'halt' }) // user pause
    await host.whenIdle()
    expect(host.getHaltOwner()).toBe('user')
    engine.commands.length = 0

    host.handleCommand({ type: 'alter', device: 'v1', value: 9 })
    host.flushAlters()
    await host.whenIdle()

    expect(engine.commands).toContain('alter v1 = 9')
    // user pause must persist: no bg_resume issued by the alter batch.
    expect(engine.commands).not.toContain('bg_resume')
    expect(host.getHaltOwner()).toBe('user')
  })
})

describe('buildAlterCommand / formatNum (pure helpers)', () => {
  it('lowercases device tokens (gotcha 1)', () => {
    expect(buildAlterCommand({ type: 'alter', device: 'V1', value: 10 })).toBe('alter v1 = 10')
  })
  it('includes the param when present', () => {
    expect(buildAlterCommand({ type: 'alter', device: 'V1', param: 'dc', value: 10 })).toBe(
      'alter v1 dc = 10'
    )
  })
  it('uses the SIN vector form with exact spacing', () => {
    const cmd = buildAlterCommand({
      type: 'alter',
      device: '@vfgen_2[sin]',
      value: '0 5 1000'
    })
    expect(cmd).toBe('alter @vfgen_2[sin] [ 0 5 1000 ]')
  })
  it('formatNum emits a suffix-free token (JS compact form, no letter units)', () => {
    expect(formatNum(0.00001)).toBe('0.00001')
    expect(formatNum(30)).toBe('30')
    expect(formatNum(1e-9)).toBe('1e-9')
    expect(formatNum(0.000001)).toBe('0.000001')
    // critically: never a SPICE letter suffix like "10u"
    expect(formatNum(1e-5)).not.toMatch(/[a-z]$/i)
  })
})

describe('SimHost convergence detection (Spec §7.4.6)', () => {
  it('emits convergenceFailure on a known failure string', async () => {
    const engine = new StubEngine()
    const t = 1000
    const { host, events } = makeHost({ engine, now: () => t, benchWindowSeconds: 30 })
    void host
    engine.emit({ type: 'char', text: 'Timestep too small; time = 1.2e-15\n' })
    const fail = events.find((e) => e.type === 'convergenceFailure')
    expect(fail).toBeDefined()
    vi.clearAllMocks()
  })
})

describe('SimHost sizes transients to its memory budget, not to ngspice free-memory check', () => {
  // ngspice-46 allocates a transient's whole output at its first saved point,
  // vectors x (tstop/tstep + 100) x 8 B, and its own check weighs that against
  // the OS free-memory figure at every saved point (macOS: vm_stat free_count).
  // SimHost turns that check off and keeps every run within a fixed budget.
  const MB = 1024 * 1024
  const deck = ['* d', 'v1 in 0 dc 5', '.end']
  // The shipped 555 sample saves 26 vectors, the scale included.
  const names = Array.from({ length: 26 }, (_, i) => (i === 0 ? 'time' : `v${i}`))

  it('start() turns off ngspice free-memory check before anything else runs', async () => {
    const engine = new StubEngine()
    const { host } = makeHost({ engine, now: () => 0 })
    await host.start()
    expect(engine.commands[0]).toBe('set no_mem_check')
  })

  it('fitTranStop: the longest stop whose estimate fits, never under 1000 steps, never past tstop', () => {
    const stop = fitTranStop(26, 1e-5, 30, 100 * MB)
    expect(ngspiceTranMemoryBytes(26, 1e-5, stop)).toBeLessThanOrEqual(100 * MB)
    // One more step would not fit.
    expect(ngspiceTranMemoryBytes(26, 1e-5, stop + 2e-5)).toBeGreaterThan(100 * MB)
    expect(fitTranStop(26, 1e-5, 0.5, 100 * MB)).toBe(0.5)
    expect(fitTranStop(26, 1e-5, 30, 1)).toBeCloseTo(1000 * 1e-5, 12)
  })

  for (const [tstep, label] of [
    [1e-5, 'the default 10 us'],
    [5e-6, 'the 5 us a 1 kHz function generator sets'],
  ] as const) {
    it(`a 30 s bench at ${label} on a 26-vector deck fits the budget: a finite 30 s run, as before`, async () => {
      const engine = new StubEngine()
      engine.vectors = names
      const { host, events } = makeHost({ engine, now: () => 0, benchWindowSeconds: 30 })
      host.handleCommand({ type: 'loadCircuit', deckLines: deck })
      host.handleCommand({ type: 'runTransient', tstepSeconds: tstep, tstopSeconds: 30 })
      await host.whenIdle()
      expect(ngspiceTranMemoryBytes(26, tstep, 30)).toBeLessThan(TRAN_MEMORY_BUDGET_BYTES)
      expect(engine.commands.find((c) => c.startsWith('bg_tran'))).toBe(`bg_tran ${formatNum(tstep)} 30 uic`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((host as any).tran.continuous).toBe(false)
      expect(events.some((e) => e.type === 'log' && /limited to/.test(e.text))).toBe(false)
    })
  }

  it('shortens a window whose samples exceed the budget and keeps the bench restarting', async () => {
    const engine = new StubEngine()
    engine.vectors = names
    const { host, events } = makeHost({ engine, now: () => 0, benchWindowSeconds: 30 })
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    // A 2.5 kHz function generator sets 2 us steps: 3.1 GB over 30 s.
    host.handleCommand({ type: 'runTransient', tstepSeconds: 2e-6, tstopSeconds: 30 })
    await host.whenIdle()
    const cmd = engine.commands.find((c) => c.startsWith('bg_tran'))!
    const stop = Number(cmd.split(' ')[2])
    expect(stop).toBeGreaterThan(15)
    expect(stop).toBeLessThan(16)
    expect(ngspiceTranMemoryBytes(26, 2e-6, stop)).toBeLessThanOrEqual(TRAN_MEMORY_BUDGET_BYTES)
    // A window cut by memory, not finished: the bench goes on into the next one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((host as any).tran.continuous).toBe(true)
    // The vectors were counted once, by a few-step probe before the real run.
    expect(engine.commands.filter((c) => c.startsWith('tran '))).toEqual(['tran 0.000002 0.000006 uic'])
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /limited to/.test(e.text))).toBe(true)
  })

  it('runTran refuses a run over the budget, without asking ngspice for it', async () => {
    const engine = new StubEngine()
    engine.vectors = names
    const { host } = makeHost({ engine, now: () => 0, tranMemoryBudgetBytes: 100 * MB })
    await host.loadCircuit(deck)
    await expect(host.runTran(1e-6, 30)).rejects.toThrow(/need \d+ MB, over the 100 MB budget/)
    expect(engine.commands.filter((c) => c.startsWith('tran 0.000001 30'))).toEqual([])
  })

  it('runTran with tstart keeps the steps of the run from 0 and only drops the points before it', async () => {
    const engine = new StubEngine()
    engine.vectors = names
    const { host } = makeHost({ engine, now: () => 0 })
    await host.loadCircuit(deck)
    await host.runTran(1e-5, 1e-3)
    await host.runTran(2e-6, 0.7, 0.6)
    await host.runTran(0.1, 1, 0.5)
    await expect(host.runTran(1e-5, 1e-3, 1e-3)).rejects.toThrow(/tstart < tstop/)
    expect(engine.commands.filter((c) => c.startsWith('tran ')).slice(1)).toEqual([
      // No tstart: the command is the bench start, unchanged.
      'tran 0.00001 0.001 uic',
      // The step limit is pinned to min(tstep, tstop/50), the run from 0's own:
      // without it ngspice would use (tstop - tstart)/50 when that is smaller.
      'tran 0.000002 0.7 0.6 0.000002 uic',
      'tran 0.1 1 0.5 0.02 uic',
    ])
  })
})
