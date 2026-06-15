/**
 * renderer/ipc/simClient.ts
 *
 * Task 21 — MessagePort wrapper around the SimHost ⇄ Renderer protocol (Spec §6.1),
 * plus an INJECTABLE `SimClient` interface so the zustand store can be unit-tested
 * with a mock (no live Electron MessagePort needed).
 *
 * Two layers:
 *   1. `SimClient` interface  — the seam the store depends on. A promise API for
 *      commands + an event emitter for SimEvents. Unit tests inject a mock.
 *   2. `createPortSimClient(port)` — the production implementation that wires a
 *      real MessagePort (from `window.circsim.getSimPort()`) to that interface.
 *
 * IMPORTANT ergonomics:
 *   - The MessagePort can be REPLACED on a SimHost respawn (the old port dies with
 *     the process). `createPortSimClient` exposes `attachPort(newPort)` so the
 *     store can re-bind after a crash without losing its event subscriptions.
 *   - `crashed` is NOT a SimEvent (the dead port can't carry it). It arrives via
 *     `window.circsim.onSimhostCrashed` and is handled in the store directly.
 *
 * Crash notification: see Spec §6.1 + preload `onSimhostCrashed`.
 */

import type { SimCommand, SimEvent } from '../../../simhost/protocol'

// ─── injectable interface ──────────────────────────────────────────────────────

export type SimEventListener = (event: SimEvent) => void

/**
 * The seam the store depends on. Anything that can send SimCommands and surface
 * SimEvents satisfies this — the production port wrapper and unit-test mocks alike.
 */
export interface SimClient {
  /** Send a command to SimHost. Fire-and-forget (the protocol is event-driven). */
  send(command: SimCommand): void

  /**
   * Subscribe to ALL SimEvents from SimHost. Returns an unsubscribe function.
   * The store filters by `event.type`.
   */
  onEvent(listener: SimEventListener): () => void

  /**
   * Wait for the next event of a given type (one-shot). Resolves with the event.
   * Used for request/response style flows (e.g. send `runOp`, await `opResult`).
   *
   * @param type      the SimEvent discriminant to wait for
   * @param timeoutMs optional timeout; rejects if no matching event arrives in time
   */
  waitFor<T extends SimEvent['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<SimEvent, { type: T }>>
}

// ─── port-backed implementation ─────────────────────────────────────────────────

export interface PortSimClient extends SimClient {
  /**
   * Re-bind to a fresh MessagePort (after a SimHost respawn). Existing `onEvent`
   * subscriptions survive; the old port (if any) is detached.
   */
  attachPort(port: MessagePort): void
}

/**
 * Create a SimClient backed by a live MessagePort.
 *
 * @param initialPort optional initial port; if omitted, call `attachPort` later.
 */
export function createPortSimClient(initialPort?: MessagePort): PortSimClient {
  let port: MessagePort | null = null
  const listeners = new Set<SimEventListener>()

  const handleMessage = (ev: MessageEvent): void => {
    const data = ev.data as SimEvent
    if (!data || typeof (data as { type?: unknown }).type !== 'string') return
    for (const l of listeners) {
      l(data)
    }
  }

  const attachPort = (newPort: MessagePort): void => {
    if (port) {
      port.onmessage = null
      // Do NOT close the old (dead) port explicitly — on a crash it is already
      // gone; on a clean swap Electron GC handles it. Closing a dead port throws.
    }
    port = newPort
    port.onmessage = handleMessage
    // The preload delivers the port to the main world via window.postMessage and
    // does NOT start it (starting it in the preload world races the entanglement);
    // the main-world consumer starts it here, in the world that uses it.
    port.start?.()
  }

  if (initialPort) attachPort(initialPort)

  return {
    send(command: SimCommand): void {
      if (!port) {
        // No live port (e.g. mid-respawn). The store re-sends loadCircuit +
        // instrument state once the new port arrives, so dropping here is safe.
        return
      }
      port.postMessage(command)
    },

    onEvent(listener: SimEventListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    waitFor<T extends SimEvent['type']>(
      type: T,
      timeoutMs?: number,
    ): Promise<Extract<SimEvent, { type: T }>> {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const unsubscribe = this.onEvent(event => {
          if (event.type === type) {
            if (timer) clearTimeout(timer)
            unsubscribe()
            resolve(event as Extract<SimEvent, { type: T }>)
          }
        })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            unsubscribe()
            reject(new Error(`simClient.waitFor('${type}') timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        }
      })
    },

    attachPort,
  }
}

// ─── test helper: an in-memory mock ─────────────────────────────────────────────

export interface MockSimClient extends SimClient {
  /** All commands sent through this client, in order. */
  readonly sent: SimCommand[]
  /** Push a SimEvent as if SimHost emitted it (drives `onEvent`/`waitFor`). */
  emit(event: SimEvent): void
  /** Clear the recorded command log. */
  clearSent(): void
}

/**
 * A simple in-memory SimClient for unit tests. Records sent commands and lets the
 * test drive events. No MessagePort, no Electron, no ngspice.
 */
export function createMockSimClient(): MockSimClient {
  const sent: SimCommand[] = []
  const listeners = new Set<SimEventListener>()

  return {
    sent,
    send(command: SimCommand): void {
      sent.push(command)
    },
    clearSent(): void {
      sent.length = 0
    },
    emit(event: SimEvent): void {
      for (const l of listeners) l(event)
    },
    onEvent(listener: SimEventListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    waitFor<T extends SimEvent['type']>(
      type: T,
      timeoutMs?: number,
    ): Promise<Extract<SimEvent, { type: T }>> {
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const unsubscribe = this.onEvent(event => {
          if (event.type === type) {
            if (timer) clearTimeout(timer)
            unsubscribe()
            resolve(event as Extract<SimEvent, { type: T }>)
          }
        })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            unsubscribe()
            reject(new Error(`mockSimClient.waitFor('${type}') timed out`))
          }, timeoutMs)
        }
      })
    },
  }
}
