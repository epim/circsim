/**
 * Unit tests for the SimHost/engine disposal path and the engine-command
 * serializer — the two JS-side halves of the Linux CI exit fix.
 *
 * Background (gdb-verified on a starved Linux runner): ngspice's background
 * thread holds its internal fputsMutex while waiting for the JS main thread to
 * service a koffi callback relay; a SYNCHRONOUS ngSpice_Command on the main
 * thread blocks on that same mutex → AB-BA deadlock, and the vitest fork
 * worker bricks. Separately, koffi cross-thread relays still in flight while
 * Node tears the environment down SIGABRT the worker AFTER tests pass. Hence:
 *   1. every engine command goes through koffi's .async form, serialized on a
 *      promise chain (createCallSerializer) so calls never overlap inside the
 *      non-thread-safe engine;
 *   2. SimHost.dispose() is async and DRAINS: bg_halt → wait for the bg thread
 *      to report stopped → settle → only then engine.dispose() (which unloads
 *      the library).
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { createCallSerializer } from '../ngspiceFfi'
import type { EngineEvent, EngineEventListener, SpiceEngine } from '../engine'

// ─── createCallSerializer ─────────────────────────────────────────────────────

describe('createCallSerializer', () => {
  it('runs tasks strictly in enqueue order even when earlier tasks are slower', async () => {
    const serialize = createCallSerializer()
    const order: string[] = []
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    const a = serialize(async () => {
      await sleep(30)
      order.push('a')
    })
    const b = serialize(async () => {
      await sleep(1)
      order.push('b')
    })
    const c = serialize(async () => {
      order.push('c')
    })
    await Promise.all([a, b, c])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('a rejected task rejects its own caller but does not break the chain', async () => {
    const serialize = createCallSerializer()
    const order: string[] = []

    const bad = serialize(async () => {
      throw new Error('boom')
    })
    const after = serialize(async () => {
      order.push('after')
    })
    await expect(bad).rejects.toThrow('boom')
    await after
    expect(order).toEqual(['after'])
  })
})

// ─── SimHost.dispose drain ───────────────────────────────────────────────────

/** Stub engine that models a background run + records the teardown ordering. */
class DrainStubEngine implements SpiceEngine {
  version = '46'
  commands: string[] = []
  running = false
  disposed = false
  /** Set when dispose() ran while the bg thread was still "running". */
  disposedWhileRunning = false
  private listeners: EngineEventListener[] = []

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
    if (cmd.startsWith('bg_tran')) {
      this.running = true
      this.emit({ type: 'bgRunning', running: true })
    }
    if (cmd === 'bg_halt' && this.running) {
      this.running = false
      this.emit({ type: 'bgRunning', running: false })
    }
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
  dispose(): void {
    this.disposed = true
    if (this.running) this.disposedWhileRunning = true
  }
}

/** Stub whose command() throws like an uninitialized NgspiceFfiEngine. */
class UninitStubEngine extends DrainStubEngine {
  command(): Promise<void> {
    throw new Error('NgspiceFfiEngine.init() must be called before use')
  }
}

function makeHost(engine: SpiceEngine): SimHost {
  return new SimHost({
    engine,
    emit: () => {},
    disableWatchdog: true,
    disableTimers: true,
  })
}

describe('SimHost.dispose', () => {
  it('halts an active background run and waits for it before disposing the engine', async () => {
    const engine = new DrainStubEngine()
    const host = makeHost(engine)
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 1 })
    await host.whenIdle()
    expect(engine.isRunning()).toBe(true)

    await host.dispose()

    expect(engine.commands).toContain('bg_halt')
    expect(engine.disposed).toBe(true)
    expect(engine.disposedWhileRunning).toBe(false)
  })

  it('resolves and disposes the engine even when the engine was never started', async () => {
    const engine = new UninitStubEngine()
    const host = makeHost(engine)

    await host.dispose()

    expect(engine.disposed).toBe(true)
  })
})
