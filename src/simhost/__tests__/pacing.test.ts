/**
 * Unit tests for SimHost pacing + bounded bench windows + alter batching, driven
 * by a stub engine and an injected clock (Spec §7.4.3, §7.5). No real ngspice.
 *
 * These exercise the orchestration logic that the integration test cannot pin
 * deterministically (timing, RSS guard, restart sequencing).
 */

import { describe, expect, it, vi } from 'vitest'

import { SimHost, buildAlterCommand, formatNum } from '../index'
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
  allVectors(): string[] {
    return []
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
}): { host: SimHost; events: SimEvent[] } {
  const events: SimEvent[] = []
  const host = new SimHost({
    engine: opts.engine,
    emit: (e) => events.push(e),
    now: opts.now,
    rssBytes: opts.rssBytes,
    benchWindowSeconds: opts.benchWindowSeconds,
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
