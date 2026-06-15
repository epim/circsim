/**
 * simClient.test.ts — Task 21
 *
 * Tests the injectable mock + the port-backed wrapper (using a minimal fake
 * MessagePort, since happy-dom is not configured). Covers send/onEvent/waitFor
 * and attachPort re-binding (crash recovery seam).
 */

import { describe, it, expect } from 'vitest'
import {
  createMockSimClient,
  createPortSimClient,
} from '../../ipc/simClient'
import type { SimCommand, SimEvent } from '../../../../simhost/protocol'

describe('createMockSimClient', () => {
  it('records sent commands', () => {
    const m = createMockSimClient()
    m.send({ type: 'runOp' })
    m.send({ type: 'loadCircuit', deckLines: ['.end'] })
    expect(m.sent.map(c => c.type)).toEqual(['runOp', 'loadCircuit'])
  })

  it('onEvent delivers emitted events; unsubscribe stops them', () => {
    const m = createMockSimClient()
    const seen: string[] = []
    const off = m.onEvent(e => seen.push(e.type))
    m.emit({ type: 'ready', ngspiceVersion: '46' })
    off()
    m.emit({ type: 'status', running: true, simTimeSeconds: 1, realtimeFactor: 1 })
    expect(seen).toEqual(['ready'])
  })

  it('waitFor resolves with the matching event', async () => {
    const m = createMockSimClient()
    const p = m.waitFor('opResult')
    m.emit({ type: 'log', level: 'info', text: 'noise' })
    m.emit({ type: 'opResult', values: { out: 2.5 } })
    const ev = await p
    expect(ev.values.out).toBe(2.5)
  })

  it('waitFor rejects on timeout', async () => {
    const m = createMockSimClient()
    await expect(m.waitFor('opResult', 5)).rejects.toThrow(/timed out/)
  })
})

// ── minimal fake MessagePort ───────────────────────────────────────────────────
class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null
  posted: unknown[] = []
  started = false
  postMessage(data: unknown): void {
    this.posted.push(data)
  }
  start(): void {
    this.started = true
  }
  /** Simulate SimHost emitting an event to the renderer. */
  deliver(data: SimEvent): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

describe('createPortSimClient', () => {
  it('posts commands to the attached port and delivers events to listeners', () => {
    const port = new FakePort()
    const client = createPortSimClient(port as unknown as MessagePort)
    const seen: SimEvent[] = []
    client.onEvent(e => seen.push(e))

    const cmd: SimCommand = { type: 'runOp' }
    client.send(cmd)
    expect(port.posted).toEqual([cmd])
    expect(port.started).toBe(true)

    port.deliver({ type: 'ready', ngspiceVersion: '46' })
    expect(seen).toEqual([{ type: 'ready', ngspiceVersion: '46' }])
  })

  it('drops sends when no port is attached (mid-respawn)', () => {
    const client = createPortSimClient()
    // No throw, just a no-op.
    expect(() => client.send({ type: 'runOp' })).not.toThrow()
  })

  it('attachPort re-binds events to a fresh port (crash recovery)', () => {
    const client = createPortSimClient()
    const seen: SimEvent[] = []
    client.onEvent(e => seen.push(e))

    const port1 = new FakePort()
    client.attachPort(port1 as unknown as MessagePort)
    port1.deliver({ type: 'log', level: 'info', text: 'on port1' })

    const port2 = new FakePort()
    client.attachPort(port2 as unknown as MessagePort)
    // old port no longer routes
    port1.deliver({ type: 'log', level: 'info', text: 'stale' })
    port2.deliver({ type: 'log', level: 'info', text: 'on port2' })

    const texts = seen.map(e => (e.type === 'log' ? e.text : ''))
    expect(texts).toEqual(['on port1', 'on port2'])

    // sends now go to port2
    client.send({ type: 'runOp' })
    expect(port2.posted).toEqual([{ type: 'runOp' }])
    expect(port1.posted).toEqual([])
  })

  it('detaching clears the old port onmessage handler', () => {
    const client = createPortSimClient()
    const port1 = new FakePort()
    client.attachPort(port1 as unknown as MessagePort)
    expect(typeof port1.onmessage).toBe('function')
    const port2 = new FakePort()
    client.attachPort(port2 as unknown as MessagePort)
    expect(port1.onmessage).toBeNull()
  })
})
