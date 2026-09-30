/**
 * createSimClientEngine: the SolveEngine the renderer uses, speaking the
 * SimHost message protocol through the store's SimClient. Driven here through
 * a minimal in-memory transport so no MessagePort or ngspice is involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SimCommand, SimEvent } from '../../../simhost/protocol'
import { createSimClientEngine, type SimTransport } from '../simClientEngine'

interface MockTransport extends SimTransport {
  sent: SimCommand[]
  emit(event: SimEvent): void
  /** Called after every send, so a test can reply the way SimHost would. */
  onSend?: (command: SimCommand) => void
}

function mockTransport(): MockTransport {
  const listeners = new Set<(e: SimEvent) => void>()
  const t: MockTransport = {
    sent: [],
    send(command) {
      t.sent.push(command)
      t.onSend?.(command)
    },
    emit(event) {
      for (const l of [...listeners]) l(event)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitFor(type, timeoutMs) {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const off = t.onEvent(e => {
          if (e.type !== type) return
          if (timer) clearTimeout(timer)
          off()
          resolve(e as never)
        })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            off()
            reject(new Error(`waitFor('${type}') timed out`))
          }, timeoutMs)
        }
      })
    },
  }
  return t
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createSimClientEngine', () => {
  it('loadCircuit sends the deck and settles', async () => {
    const t = mockTransport()
    await createSimClientEngine(t).loadCircuit(['* t', '.end'])
    expect(t.sent).toEqual([{ type: 'loadCircuit', deckLines: ['* t', '.end'] }])
  })

  it('runOp arms its reply listener before sending, so a synchronous reply is not lost', async () => {
    const t = mockTransport()
    t.onSend = cmd => {
      if (cmd.type === 'runOp') t.emit({ type: 'opResult', values: { out: 2.5 }, method: 'gmin' })
    }
    const op = await createSimClientEngine(t).runOp()
    expect(t.sent).toEqual([{ type: 'runOp' }])
    expect(op).toEqual({ values: { out: 2.5 }, method: 'gmin' })
  })

  it('runOp rejects when no reply lands within the op timeout', async () => {
    vi.useFakeTimers()
    const t = mockTransport()
    const op = createSimClientEngine(t, { opTimeoutMs: 1000 }).runOp()
    const settled = op.catch(e => e)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await settled).toBeInstanceOf(Error)
  })

  it('runTran starts an unpaced finite run and assembles the streamed batches', async () => {
    const t = mockTransport()
    t.onSend = cmd => {
      if (cmd.type !== 'setPace') return
      queueMicrotask(() => {
        t.emit({ type: 'vectors', names: ['V(OUT)', 'v1#branch'] })
        t.emit({
          type: 'samples',
          vectorNames: ['V(OUT)', 'v1#branch'],
          columns: [Float64Array.from([0, 1]), Float64Array.from([-1, -0.5])],
          simTime: Float64Array.from([0, 0.5e-3]),
        })
        // A pacing status mid-run (not running, short of tstop) must not end the run.
        t.emit({ type: 'status', running: false, simTimeSeconds: 0.5e-3, realtimeFactor: 1 })
        t.emit({
          type: 'samples',
          vectorNames: ['V(OUT)', 'v1#branch'],
          columns: [Float64Array.from([2]), Float64Array.from([-0.1])],
          simTime: Float64Array.from([1e-3]),
        })
        t.emit({ type: 'status', running: false, simTimeSeconds: 1e-3, realtimeFactor: 40 })
      })
    }

    const tran = await createSimClientEngine(t).runTran(1e-6, 1e-3)

    expect(t.sent).toEqual([
      { type: 'runTransient', tstepSeconds: 1e-6, tstopSeconds: 1e-3 },
      { type: 'setPace', realtimeFactor: 'max' },
    ])
    expect([...tran.time]).toEqual([0, 0.5e-3, 1e-3])
    expect(Object.keys(tran.vectors).sort()).toEqual(['i(v1)', 'out'])
    expect([...tran.vectors.out]).toEqual([0, 1, 2])
    expect([...tran.vectors['i(v1)']]).toEqual([-1, -0.5, -0.1])
  })

  it('runTran rejects on a convergence failure', async () => {
    const t = mockTransport()
    t.onSend = cmd => {
      if (cmd.type === 'setPace') queueMicrotask(() => t.emit({ type: 'convergenceFailure', detail: 'timestep too small' }))
    }
    await expect(createSimClientEngine(t).runTran(1e-6, 1e-3)).rejects.toThrow(/timestep too small/)
  })

  it('runTran refuses a stop time past the bench window (the run would never finish)', async () => {
    const t = mockTransport()
    await expect(createSimClientEngine(t, { benchWindowSeconds: 30 }).runTran(1e-3, 31)).rejects.toThrow(RangeError)
    await expect(createSimClientEngine(t).runTran(0, 1)).rejects.toThrow(RangeError)
    expect(t.sent).toEqual([])
  })

  it('runTran rejects on timeout and stops listening', async () => {
    vi.useFakeTimers()
    const t = mockTransport()
    const settled = createSimClientEngine(t, { tranTimeoutMs: 500 }).runTran(1e-6, 1e-3).catch(e => e)
    await vi.advanceTimersByTimeAsync(500)
    expect(await settled).toBeInstanceOf(Error)
  })
})
