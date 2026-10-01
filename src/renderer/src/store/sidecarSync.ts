/**
 * renderer/store/sidecarSync.ts - saves the per-board setup file (issue #27).
 *
 * The store knows what the setup file should contain (buildSidecarText) and
 * whether saving is switched on (sidecar.autosave); this module is the only
 * thing that turns that into disk writes. It watches the slices of state that
 * make up the setup, debounces bursts (a knob drag fires many updates), and
 * writes through an injected `SidecarIO`, so tests use a fake and production
 * wires it to the preload bridge.
 *
 * Rules:
 *   - Nothing is written unless sidecar.autosave is true and the board has a path.
 *   - The state is read at write time, never captured earlier, so a write always
 *     holds one consistent snapshot (path and content from the same moment).
 *   - Writes are serialized; an unchanged setup is not rewritten.
 *   - A failed write is reported in sidecar.error and retried on the next change.
 *     The first write after opening an old, truncated or unreadable file asks the
 *     main process to keep the original as `<file>.bak`.
 */

import type { AppState, AppStore } from './appStore'

export interface SidecarIO {
  /** Write the setup text beside `boardPath`; rejects on failure. */
  write(boardPath: string, text: string, opts: { backupExisting: boolean }): Promise<void>
}

export interface SidecarSync {
  /** Write any pending change now (used on window close and by tests). */
  flush(): Promise<void>
  dispose(): void
}

export const SIDECAR_DEBOUNCE_MS = 600

function setupChanged(a: AppState, b: AppState): boolean {
  return (
    a.groundNetId !== b.groundNetId ||
    a.instruments !== b.instruments ||
    a.leadPositions !== b.leadPositions ||
    a.stubOverrides !== b.stubOverrides ||
    a.pinMapOverrides !== b.pinMapOverrides ||
    a.railOverrides !== b.railOverrides ||
    a.userModels !== b.userModels ||
    a.sidecar.autosave !== b.sidecar.autosave ||
    a.sidecar.path !== b.sidecar.path
  )
}

export function attachSidecarSync(
  store: AppStore,
  io: SidecarIO,
  opts: { debounceMs?: number } = {},
): SidecarSync {
  const debounceMs = opts.debounceMs ?? SIDECAR_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let chain: Promise<void> = Promise.resolve()
  /** path -> text last written, to skip identical rewrites. */
  const lastWritten = new Map<string, string>()

  async function writeNow(): Promise<void> {
    pending = false
    const s = store.getState()
    const { sidecar, project } = s
    if (!sidecar.autosave || !sidecar.path || !project.boardPath || !s.circuit) return
    const text = s.buildSidecarText()
    if (text === null) return
    const path = sidecar.path
    if (!sidecar.backupFirst && lastWritten.get(path) === text) return
    try {
      await io.write(project.boardPath, text, { backupExisting: sidecar.backupFirst })
      lastWritten.set(path, text)
      // Only touch the state if the same board is still open.
      if (store.getState().sidecar.path === path) {
        store.setState(st => ({
          sidecar: { ...st.sidecar, lastSavedAt: Date.now(), error: null, backupFirst: false, diskStatus: 'ok' },
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (store.getState().sidecar.path === path) {
        store.setState(st => ({
          sidecar: { ...st.sidecar, error: `Could not save the setup file: ${msg}` },
        }))
      }
    }
  }

  function enqueue(): Promise<void> {
    chain = chain.then(writeNow, writeNow)
    return chain
  }

  function schedule(delayMs: number): void {
    pending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void enqueue()
    }, delayMs)
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (!setupChanged(state, prev)) return
    if (!state.sidecar.autosave || !state.sidecar.path) return
    // A board just opened (the path changed): restoring is not an edit, so the
    // file is left alone until the user changes something.
    if (prev.sidecar.path !== state.sidecar.path) return
    // The user switching autosave on saves now; ordinary edits are debounced.
    schedule(!prev.sidecar.autosave ? 0 : debounceMs)
  })

  return {
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending) return enqueue()
      return chain
    },
    dispose() {
      unsubscribe()
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
