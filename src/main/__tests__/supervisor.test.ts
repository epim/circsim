/**
 * Unit tests for SimhostSupervisor (Task 11, Spec §6, §12).
 *
 * These run entirely in Node — no Electron runtime. The supervisor is designed
 * with a "fork" dependency injection hook so we can substitute a stub child
 * that exits immediately and verify the respawn/backoff behaviour.
 *
 * Test coverage:
 *  - spawn: forks the child and performs the one-time port handshake
 *  - respawn/backoff: 250 ms → 1 s → 5 s delays between attempts
 *  - fatal state: ≥5 crashes within 30 s → stops respawning, sets fatal state
 *  - crash notification: calls onSimhostCrashed({ willRespawn }) callback
 *  - port handshake: sends port1 to child, port2 to webContents
 *  - re-handshake on respawn: new MessageChannel per spawn
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SimhostSupervisor,
  type ChildHandle,
  type ForkFn,
  type PortPair,
  type PortPairFactory,
  type WebContentsHandle
} from '../simhostSupervisor'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A stub ChildHandle whose exitListener is captured so tests can trigger exits. */
function makeStubChild(): {
  child: ChildHandle
  triggerExit: (code: number) => void
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
} {
  let exitListener: ((code: number) => void) | null = null
  const postMessage = vi.fn()
  const kill = vi.fn()

  const child: ChildHandle = {
    postMessage,
    kill,
    on(event: string, listener: (code: number) => void) {
      if (event === 'exit') exitListener = listener
    },
    off(_event: string, _listener: unknown) {}
  }

  return {
    child,
    triggerExit: (code) => exitListener?.(code),
    postMessage,
    kill
  }
}

/** A stub MessagePort pair. */
function makeStubPortPair(): PortPair {
  const makePort = () => ({
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  })
  return { port1: makePort(), port2: makePort() }
}

/** A stub WebContents that records postMessage calls. */
function makeStubWebContents(): WebContentsHandle & { calls: { channel: string; msg: unknown }[] } {
  const calls: { channel: string; msg: unknown }[] = []
  return {
    calls,
    isDestroyed: () => false,
    postMessage(channel: string, msg: unknown) {
      calls.push({ channel, msg })
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SimhostSupervisor', () => {
  // Use fake timers throughout so we can advance backoff delays without sleeping.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Basic spawn ────────────────────────────────────────────────────────────

  it('calls fork with the simhost module path on start()', () => {
    const stubs = [makeStubChild()]
    let callCount = 0
    const fork: ForkFn = () => stubs[callCount++]!.child

    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()
    expect(callCount).toBe(1)
  })

  it('sends port1 to the child and port2 via webContents.postMessage on handshake', () => {
    const stub = makeStubChild()
    const fork: ForkFn = () => stub.child
    const pair = makeStubPortPair()
    const portPairFactory: PortPairFactory = () => pair
    const wc = makeStubWebContents()

    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()
    // Before webContents is ready, port2 should not yet have been sent.
    // Provide the webContents — this triggers the renderer-side handshake.
    supervisor.setWebContents(wc)
    supervisor.onRendererReady()

    // port1 should be sent to child
    expect(stub.postMessage).toHaveBeenCalledWith(
      { type: 'port' },
      expect.arrayContaining([pair.port1])
    )
    // port2 should be sent to renderer
    expect(wc.calls.some((c) => c.channel === 'simhost-port')).toBe(true)
  })

  // ── Crash notification ─────────────────────────────────────────────────────

  it('calls onSimhostCrashed with { willRespawn: true } when child exits', () => {
    const stub = makeStubChild()
    const fork: ForkFn = () => stub.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const crashed = vi.fn()

    const supervisor = new SimhostSupervisor({ fork, portPairFactory, onSimhostCrashed: crashed })
    supervisor.start()
    stub.triggerExit(1)

    expect(crashed).toHaveBeenCalledWith({ willRespawn: true })
  })

  // ── Respawn backoff ────────────────────────────────────────────────────────

  it('respawns after 250 ms on first crash', () => {
    let spawnCount = 0
    const stubs = Array.from({ length: 5 }, makeStubChild)
    const fork: ForkFn = () => {
      const s = stubs[spawnCount++]
      if (!s) throw new Error('Too many spawns')
      return s.child
    }
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()
    expect(spawnCount).toBe(1)

    stubs[0]!.triggerExit(1) // first crash
    expect(spawnCount).toBe(1) // not yet — waiting for backoff

    vi.advanceTimersByTime(249)
    expect(spawnCount).toBe(1) // still waiting

    vi.advanceTimersByTime(1) // 250 ms elapsed
    expect(spawnCount).toBe(2) // respawned
  })

  it('uses 1s backoff on second crash within 30s', () => {
    let spawnCount = 0
    const stubs = Array.from({ length: 5 }, makeStubChild)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()

    stubs[0]!.triggerExit(1) // crash 1
    vi.advanceTimersByTime(250) // respawn after 250 ms
    expect(spawnCount).toBe(2)

    stubs[1]!.triggerExit(1) // crash 2
    // Should wait 1 s now
    vi.advanceTimersByTime(999)
    expect(spawnCount).toBe(2)
    vi.advanceTimersByTime(1)
    expect(spawnCount).toBe(3)
  })

  it('uses 5s backoff on third+ crash within 30s', () => {
    let spawnCount = 0
    const stubs = Array.from({ length: 5 }, makeStubChild)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()

    stubs[0]!.triggerExit(1) // crash 1 → 250ms
    vi.advanceTimersByTime(250)
    stubs[1]!.triggerExit(1) // crash 2 → 1s
    vi.advanceTimersByTime(1000)
    stubs[2]!.triggerExit(1) // crash 3 → 5s

    vi.advanceTimersByTime(4999)
    expect(spawnCount).toBe(3)
    vi.advanceTimersByTime(1)
    expect(spawnCount).toBe(4)
  })

  // ── Fatal state: 5 crashes < 30 s apart ────────────────────────────────────

  it('enters fatal state and stops respawning after 5 rapid crashes', () => {
    let spawnCount = 0
    const stubs = Array.from({ length: 10 }, makeStubChild)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const crashed = vi.fn()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory, onSimhostCrashed: crashed })
    supervisor.start()

    // 5 crashes each within < 30s of the previous
    for (let i = 0; i < 5; i++) {
      stubs[i]!.triggerExit(1)
      const delay = i === 0 ? 250 : i === 1 ? 1000 : 5000
      vi.advanceTimersByTime(delay)
    }
    // The 5th crash puts us at spawnCount == 5, but
    // 5 crashes have now occurred — the supervisor should be fatal.
    stubs[4]!.triggerExit(1) // 5th exit
    vi.advanceTimersByTime(10000) // wait well past any backoff

    // No more spawns after the fatal threshold
    expect(spawnCount).toBeLessThanOrEqual(5)
    expect(supervisor.isFatal()).toBe(true)
  })

  it('calls onSimhostCrashed with { willRespawn: false } on the fatal crash', () => {
    // Backoff schedule: crash 1 → 250ms, crash 2 → 1s, crash 3+ → 5s.
    // We advance exactly the right backoff delay after each crash to trigger
    // the next spawn, then crash that one too.  After 5 crashes the supervisor
    // must enter the fatal state and the last onSimhostCrashed call must carry
    // { willRespawn: false }.
    let spawnCount = 0
    const stubs = Array.from({ length: 10 }, makeStubChild)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const crashed = vi.fn()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory, onSimhostCrashed: crashed })
    supervisor.start()

    // Trigger crashes 1-4 using the correct backoff delays so each subsequent
    // spawn actually happens before we crash it again.
    const backoffs = [250, 1000, 5000, 5000] // delays after crashes 1-4
    for (let i = 0; i < 4; i++) {
      stubs[i]!.triggerExit(1)
      vi.advanceTimersByTime(backoffs[i]!) // trigger the next respawn
    }
    // Crash 5: this is the fatal one (5 crashes < 30s apart)
    stubs[4]!.triggerExit(1)

    // The last call to crashed should have willRespawn: false
    const lastCall = crashed.mock.calls[crashed.mock.calls.length - 1]
    expect(lastCall?.[0]).toEqual({ willRespawn: false })
    expect(supervisor.isFatal()).toBe(true)
  })

  // ── Re-handshake on respawn ────────────────────────────────────────────────

  it('creates a new MessageChannel on each respawn', () => {
    let spawnCount = 0
    let pairCount = 0
    const stubs = Array.from({ length: 3 }, makeStubChild)
    const pairs = Array.from({ length: 3 }, makeStubPortPair)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => pairs[pairCount++]!

    const wc = makeStubWebContents()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.setWebContents(wc)
    supervisor.start()
    supervisor.onRendererReady()

    expect(pairCount).toBe(1)

    stubs[0]!.triggerExit(1)
    vi.advanceTimersByTime(250)
    supervisor.onRendererReady() // renderer re-connected after crash

    expect(pairCount).toBe(2)
    // Second pair's port1 should have been sent to the new child
    expect(stubs[1]!.postMessage).toHaveBeenCalledWith(
      { type: 'port' },
      expect.arrayContaining([pairs[1]!.port1])
    )
  })

  // ── Dispose ────────────────────────────────────────────────────────────────

  it('kills the child process on dispose()', () => {
    const stub = makeStubChild()
    const fork: ForkFn = () => stub.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()
    supervisor.dispose()
    expect(stub.kill).toHaveBeenCalled()
  })

  it('does not respawn after dispose()', () => {
    let spawnCount = 0
    const stubs = Array.from({ length: 3 }, makeStubChild)
    const fork: ForkFn = () => stubs[spawnCount++]!.child
    const portPairFactory: PortPairFactory = () => makeStubPortPair()
    const supervisor = new SimhostSupervisor({ fork, portPairFactory })
    supervisor.start()
    supervisor.dispose()

    stubs[0]!.triggerExit(0) // would normally trigger respawn
    vi.advanceTimersByTime(10000)
    expect(spawnCount).toBe(1) // no additional spawns
  })
})
