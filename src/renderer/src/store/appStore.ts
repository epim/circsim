/**
 * renderer/store/appStore.ts — Task 21
 *
 * The single zustand store for the renderer. Holds project / circuit /
 * resolutions / instruments / simState / probes, and the orchestration actions
 * that connect the pure domain pipeline (parse → extract → resolve → spicegen)
 * to the SimHost via an INJECTED `SimClient`.
 *
 * Architecture rules (from the phase brief / Spec §6, §8.6, §11, §12):
 *   - Instrument + probe + pin-map + stub-override state lives HERE, so it
 *     survives a SimHost crash and can be replayed onto a fresh port.
 *   - The store accepts an injected `SimClient` (interface), so unit tests use a
 *     mock — never a live Electron MessagePort.
 *   - Crash recovery listens on `window.circsim.onSimhostCrashed` (NOT the dead
 *     port); on crash it re-sends loadCircuit + re-applies instrument/probe state.
 *   - alter-safe vs reload-required edits are routed via spicegen `alterPlan`.
 *
 * This module is built with the VANILLA zustand store (`zustand/vanilla`) so it
 * can be created per-instance (testable) and used outside React. A React hook
 * (`useAppStore`) is also exported for components.
 *
 * Spec §6.1, §8.6, §11, §12
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'

import { parseBoard } from '../../../core/kicad/board'
import { parseSchematicSimData, type SchematicSimData } from '../../../core/kicad/schematic'
import { extract, suggestGround, suggestSupplies, type Circuit } from '../../../core/netlist/extract'
import {
  resolveAll,
  type UserStubOverride,
  type BomData,
} from '../../../core/models/resolve'
import type { LibraryEntry, PinMap, Resolution } from '../../../core/models/types'
import { generateDeck, alterPlan } from '../../../core/spicegen/generate'
import type { Instrument } from '../../../core/spicegen/instruments'
import { parseBom } from '../../../core/bom/parseBom'
import type { BoardModel } from '../../../core/kicad/types'

import type { SimClient } from '../ipc/simClient'
import type { SimCommand, SimEvent } from '../../../simhost/protocol'

// ─── derived helpers (pure, exported for the UI + tests) ─────────────────────────

export interface ResolutionSummary {
  total: number
  ok: number
  stubbed: number
  unresolved: number
}

/** Count resolutions by status — drives the fidelity banner + parts badges. */
export function resolutionSummary(resolutions: Resolution[]): ResolutionSummary {
  const summary: ResolutionSummary = { total: resolutions.length, ok: 0, stubbed: 0, unresolved: 0 }
  for (const r of resolutions) {
    if (r.status === 'ok') summary.ok++
    else if (r.status === 'stubbed') summary.stubbed++
    else summary.unresolved++
  }
  return summary
}

/** UI status badge color for a resolution: ok → green, stubbed → amber, unresolved → red. */
export type StatusBadge = 'ok' | 'amber' | 'red'
export function statusBadge(r: Resolution): StatusBadge {
  if (r.status === 'ok') return 'ok'
  if (r.status === 'stubbed') return 'amber'
  return 'red'
}

// ─── store shape ─────────────────────────────────────────────────────────────

export type SimRunState = 'idle' | 'op' | 'running' | 'paused'

export interface ParseErrorInfo {
  message: string
  line?: number
  col?: number
  /** Source filename for the error card. */
  fileName?: string
}

export interface AppState {
  // ── project / source files ─────────────────────────────────────────────────
  project: {
    boardFileName: string | null
    boardText: string | null
    schematicFileName: string | null
  }

  // ── domain pipeline outputs ──────────────────────────────────────────────────
  board: BoardModel | null
  circuit: Circuit | null
  schematicSimData: SchematicSimData | null
  bom: BomData | null
  library: LibraryEntry[]
  resolutions: Resolution[]

  // ── user overrides (kept so re-resolve is deterministic + crash-safe) ─────────
  stubOverrides: Map<string, UserStubOverride>
  pinMapOverrides: Map<string, PinMap>

  // ── bench state (survives SimHost crash → replayed) ──────────────────────────
  instruments: Instrument[]
  groundNetId: number | null
  suggestedSupplyNetIds: number[]

  // ── sim state ────────────────────────────────────────────────────────────────
  simState: SimRunState
  deckDirty: boolean
  /** Latest op-point node voltages, keyed by netId (for board annotations/tint). */
  opVoltages: Map<number, number> | null
  /** Min/max voltage across the latest op result (for the voltage legend). */
  voltageRange: { min: number; max: number } | null
  ngspiceVersion: string | null

  // ── error / honesty state (Spec §12) ─────────────────────────────────────────
  parseError: ParseErrorInfo | null
  /** True when the board renders but simulation can't proceed (Spec §12). */
  viewerOnly: boolean

  // ── selection sync (PartsPanel ↔ viewport) ───────────────────────────────────
  selectedRef: string | null
  selectedNetId: number | null

  // ── log stream ────────────────────────────────────────────────────────────────
  logLines: { level: 'info' | 'warn' | 'error'; text: string }[]
  lastBenchRestart: { reason: 'window-elapsed' | 'memory'; at: number } | null
  crashNotice: { willRespawn: boolean; at: number } | null

  // ── actions ────────────────────────────────────────────────────────────────
  /** Parse + extract + resolve a board from raw .kicad_pcb text. */
  openBoardFromText(boardText: string, fileName: string, opts?: OpenOpts): void
  /** Attach a sibling schematic's Sim.* data (re-resolves). */
  setSchematicFromText(schText: string, fileName: string): void
  /** Import a BOM CSV (re-resolves with BOM-merged values/mpn). */
  setBomFromText(csvText: string): void
  /** Provide the bundled library (re-resolves with tier-3 matching). */
  setLibrary(library: LibraryEntry[]): void

  /** Re-run resolveAll with the current overrides/inputs. */
  reResolve(): void

  // Model Doctor actions (Spec §8.6) — each re-resolves + flags deckDirty
  stubPart(ref: string, mode: 'open' | 'short' | 'interactive-pins'): void
  clearPartOverride(ref: string): void
  setPinMap(ref: string, pinMap: PinMap): void

  // selection
  selectComponent(ref: string | null): void
  selectNet(netId: number | null): void

  // ground / supply
  setGround(netId: number | null): void

  // instruments
  addInstrument(inst: Instrument): void
  removeInstrument(id: string): void
  /** Update an instrument; routes through alterPlan (alter-safe vs reload). */
  updateInstrument(id: string, next: Instrument): void

  // sim orchestration (subset — Task 24 expands Run/Pause)
  /** Generate deck → loadCircuit → runOp; resolves with the op voltages. */
  powerOn(): Promise<Map<number, number> | null>
  /** Mark deck dirty (any deck-affecting change). */
  markDeckDirty(): void

  // crash recovery (Spec §6.1)
  /** Replay deck + instrument state onto a fresh client (after respawn). */
  replayAfterCrash(): void
  /** Record a crash notice (from window.circsim.onSimhostCrashed). */
  noteCrash(willRespawn: boolean): void

  // internal: ingest a SimEvent (wired to the client's onEvent in setup)
  ingestEvent(event: SimEvent): void
}

export interface OpenOpts {
  /** Sibling .kicad_sch text, if auto-detected. */
  schematicText?: string
  schematicFileName?: string
  /** Optional BOM CSV text. */
  bomText?: string
}

// ─── store factory (injectable simClient for tests) ─────────────────────────────

export interface CreateAppStoreOptions {
  simClient: SimClient
  /** Bundled library entries (tier-3). Optional; defaults to none. */
  library?: LibraryEntry[]
}

export type AppStore = StoreApi<AppState>

export function createAppStore(options: CreateAppStoreOptions): AppStore {
  const { simClient } = options

  const store = createStore<AppState>((set, get) => ({
    // ── initial state ──────────────────────────────────────────────────────────
    project: { boardFileName: null, boardText: null, schematicFileName: null },
    board: null,
    circuit: null,
    schematicSimData: null,
    bom: null,
    library: options.library ?? [],
    resolutions: [],
    stubOverrides: new Map(),
    pinMapOverrides: new Map(),
    instruments: [],
    groundNetId: null,
    suggestedSupplyNetIds: [],
    simState: 'idle',
    deckDirty: false,
    opVoltages: null,
    voltageRange: null,
    ngspiceVersion: null,
    parseError: null,
    viewerOnly: false,
    selectedRef: null,
    selectedNetId: null,
    logLines: [],
    lastBenchRestart: null,
    crashNotice: null,

    // ── open flow ────────────────────────────────────────────────────────────
    openBoardFromText(boardText, fileName, opts) {
      // Reset everything that depends on the old project.
      set({
        parseError: null,
        viewerOnly: false,
        opVoltages: null,
        voltageRange: null,
        instruments: [],
        stubOverrides: new Map(),
        pinMapOverrides: new Map(),
        simState: 'idle',
        deckDirty: false,
        selectedRef: null,
        selectedNetId: null,
        logLines: [],
      })

      let board: BoardModel
      try {
        board = parseBoard(boardText)
      } catch (err) {
        const e = err as { message?: string; line?: number; col?: number }
        set({
          parseError: { message: e.message ?? String(err), line: e.line, col: e.col, fileName },
          // A parse failure of the board means we cannot extract a netlist either.
          viewerOnly: false,
          board: null,
          circuit: null,
          resolutions: [],
          project: { boardFileName: fileName, boardText, schematicFileName: null },
        })
        return
      }

      // Optional schematic (sibling auto-detected by the caller / file-open flow).
      let schematicSimData: SchematicSimData | null = null
      let schematicFileName: string | null = null
      if (opts?.schematicText) {
        try {
          schematicSimData = parseSchematicSimData(opts.schematicText)
          schematicFileName = opts.schematicFileName ?? null
        } catch {
          // A bad schematic should not block the board; resolve without Sim.* data.
          schematicSimData = null
        }
      }

      // Optional BOM.
      let bom: BomData | null = null
      if (opts?.bomText) {
        const parsed = parseBom(opts.bomText)
        bom = parsed.rows
      }

      // Extract once (no ground) to run the ground heuristic, then re-extract
      // WITH the designated ground so circuit.nets[].spiceNode is "0" for ground
      // (generateDeck relies on this — Spec §8.8).
      const probe = extract(board)
      const gnd = suggestGround(probe.nets)
      const supplies = suggestSupplies(probe.nets)
      const groundNetId = gnd?.id ?? null
      const circuit = groundNetId !== null ? extract(board, { groundNetId }) : probe

      set({
        project: { boardFileName: fileName, boardText, schematicFileName },
        board,
        circuit,
        schematicSimData,
        bom,
        groundNetId,
        suggestedSupplyNetIds: supplies.map(s => s.id),
      })

      // Resolve with current (empty) overrides.
      get().reResolve()

      // Viewer-only iff the netlist is unusable for simulation (no parts / no nets).
      const usable = circuit.parts.length > 0 && circuit.nets.length > 0
      set({ viewerOnly: !usable })
    },

    setSchematicFromText(schText, fileName) {
      let data: SchematicSimData | null = null
      try {
        data = parseSchematicSimData(schText)
      } catch {
        data = null
      }
      set(s => ({
        schematicSimData: data,
        project: { ...s.project, schematicFileName: fileName },
      }))
      get().reResolve()
      get().markDeckDirty()
    },

    setBomFromText(csvText) {
      const parsed = parseBom(csvText)
      set({ bom: parsed.rows })
      get().reResolve()
      get().markDeckDirty()
    },

    setLibrary(library) {
      set({ library })
      get().reResolve()
      get().markDeckDirty()
    },

    // ── resolution ──────────────────────────────────────────────────────────
    reResolve() {
      const { circuit, schematicSimData, bom, library, stubOverrides } = get()
      if (!circuit) {
        set({ resolutions: [] })
        return
      }
      const resolutions = resolveAll(
        circuit,
        schematicSimData ?? undefined,
        bom ?? undefined,
        library.length > 0 ? library : undefined,
        stubOverrides.size > 0 ? stubOverrides : undefined,
      )
      set({ resolutions })
    },

    // ── Model Doctor actions ────────────────────────────────────────────────
    stubPart(ref, mode) {
      const next = new Map(get().stubOverrides)
      next.set(ref, { kind: 'stub', mode })
      set({ stubOverrides: next })
      get().reResolve()
      get().markDeckDirty()
    },

    clearPartOverride(ref) {
      const next = new Map(get().stubOverrides)
      next.delete(ref)
      const nextPins = new Map(get().pinMapOverrides)
      nextPins.delete(ref)
      set({ stubOverrides: next, pinMapOverrides: nextPins })
      get().reResolve()
      get().markDeckDirty()
    },

    setPinMap(ref, pinMap) {
      const next = new Map(get().pinMapOverrides)
      next.set(ref, pinMap)
      set({ pinMapOverrides: next })
      get().reResolve()
      get().markDeckDirty()
    },

    // ── selection ──────────────────────────────────────────────────────────
    selectComponent(ref) {
      set({ selectedRef: ref })
    },
    selectNet(netId) {
      set({ selectedNetId: netId })
    },

    // ── ground / supply ───────────────────────────────────────────────────────
    setGround(netId) {
      // Re-extract so the ground net's spiceNode becomes "0" (generateDeck relies
      // on circuit.nets[].spiceNode already being "0" for ground — Spec §8.8).
      const { board } = get()
      if (board) {
        const circuit = netId !== null ? extract(board, { groundNetId: netId }) : extract(board)
        set({ groundNetId: netId, circuit })
        get().reResolve()
      } else {
        set({ groundNetId: netId })
      }
      get().markDeckDirty()
    },

    // ── instruments ──────────────────────────────────────────────────────────
    addInstrument(inst) {
      set(s => ({ instruments: [...s.instruments, inst] }))
      get().markDeckDirty()
    },

    removeInstrument(id) {
      set(s => ({
        instruments: s.instruments.filter(i => !('id' in i) || i.id !== id),
      }))
      get().markDeckDirty()
    },

    updateInstrument(id, next) {
      const { instruments, resolutions, simState } = get()
      const prev = instruments.find(i => 'id' in i && i.id === id)
      const updated = instruments.map(i => ('id' in i && i.id === id ? next : i))
      set({ instruments: updated })

      // Route through alterPlan: alter-safe → live alter; reload-required → dirty.
      if (prev && 'id' in prev) {
        const plan = alterPlan(prev, next, resolutions)
        if (plan.kind === 'alter') {
          // Only send live alters when actually running/paused with a loaded deck.
          if ((simState === 'running' || simState === 'paused') && !get().deckDirty) {
            for (const cmdStr of plan.commands) {
              const parsed = parseAlterCommand(cmdStr)
              if (parsed) simClient.send(parsed)
            }
          }
        } else {
          // reload-required
          get().markDeckDirty()
        }
      } else {
        get().markDeckDirty()
      }
    },

    // ── sim orchestration ──────────────────────────────────────────────────────
    async powerOn() {
      const { circuit, resolutions, instruments, groundNetId } = get()
      if (!circuit || groundNetId === null) {
        // Guided empty-state (Spec §12): nothing to power on.
        return null
      }

      const deckLines = generateDeck({
        circuit,
        resolutions,
        instruments,
        groundNetId,
        title: get().project.boardFileName ?? undefined,
      })

      set({ simState: 'op' })
      simClient.send({ type: 'loadCircuit', deckLines })
      simClient.send({ type: 'runOp' })

      let result: { type: 'opResult'; values: Record<string, number> }
      try {
        result = await simClient.waitFor('opResult', 30_000)
      } catch {
        set({ simState: 'idle' })
        return null
      }

      // Map opResult.values (bare lowercase node names) → netId voltages.
      const opVoltages = mapOpResultToNetVoltages(result.values, circuit)
      const voltageRange = computeVoltageRange(opVoltages)

      set({ opVoltages, voltageRange, deckDirty: false, simState: 'idle' })
      return opVoltages
    },

    markDeckDirty() {
      set({ deckDirty: true })
    },

    // ── crash recovery (Spec §6.1) ─────────────────────────────────────────────
    noteCrash(willRespawn) {
      set({ crashNotice: { willRespawn, at: Date.now() } })
    },

    replayAfterCrash() {
      const { circuit, resolutions, instruments, groundNetId, simState } = get()
      if (!circuit || groundNetId === null) return

      const deckLines = generateDeck({
        circuit,
        resolutions,
        instruments,
        groundNetId,
        title: get().project.boardFileName ?? undefined,
      })
      simClient.send({ type: 'loadCircuit', deckLines })

      // Re-apply running state: if we were running, resume the transient; if op,
      // re-run op. Pace/instrument live-alters are folded into the deck already.
      if (simState === 'running') {
        // Task 24 owns the full tran restart; here we just re-issue op as a
        // baseline so the board annotations are correct after recovery.
        simClient.send({ type: 'runOp' })
      } else if (simState === 'op') {
        simClient.send({ type: 'runOp' })
      }
    },

    // ── event ingestion ──────────────────────────────────────────────────────
    ingestEvent(event) {
      switch (event.type) {
        case 'ready':
          set({ ngspiceVersion: event.ngspiceVersion })
          break
        case 'log':
          set(s => ({
            logLines: [...s.logLines, { level: event.level, text: event.text }].slice(-2000),
          }))
          break
        case 'opResult': {
          const circuit = get().circuit
          if (!circuit) break
          const opVoltages = mapOpResultToNetVoltages(event.values, circuit)
          set({ opVoltages, voltageRange: computeVoltageRange(opVoltages) })
          break
        }
        case 'benchRestarted':
          set({ lastBenchRestart: { reason: event.reason, at: Date.now() } })
          break
        case 'status':
          set({ simState: event.running ? 'running' : get().simState === 'running' ? 'paused' : get().simState })
          break
        default:
          // vectors / samples / acResult / convergenceFailure handled by Task 23/24.
          break
      }
    },
  }))

  // Wire the client's events into the store. The store owns this subscription so
  // a respawn (which calls attachPort on a PortSimClient) keeps delivering events.
  simClient.onEvent(event => store.getState().ingestEvent(event))

  return store
}

// ─── alter command parsing ─────────────────────────────────────────────────────

/**
 * Translate a spicegen `alterPlan` command string into the protocol's structured
 * `alter` command. SimHost rebuilds the ngspice line from {device, value} via its
 * own `buildAlterCommand` (Spec §7.4.1).
 *
 * alterPlan emits two shapes:
 *   - scalar:  `alter @vpsu_1[dc] 5`              → device "@vpsu_1[dc]", value "5"
 *   - vector:  `alter @vfgen_2[sin] [ a b c ]`    → device "@vfgen_2[sin]", value "a b c"
 *
 * For the vector form SimHost re-wraps the value with `[ … ]` (it detects the
 * `[sin]`/`[pulse]` tag on the device), so we pass the inner numbers only.
 */
export function parseAlterCommand(cmdStr: string): Extract<SimCommand, { type: 'alter' }> | null {
  const m = cmdStr.match(/^alter\s+(\S+)\s+(.*)$/)
  if (!m) return null
  const device = m[1]
  let rest = m[2].trim()
  // Vector form: strip the surrounding brackets, keep the space-joined numbers.
  const vec = rest.match(/^\[\s*(.*?)\s*\]$/)
  if (vec) rest = vec[1].trim()
  return { type: 'alter', device, value: rest }
}

// ─── op-result mapping helpers ─────────────────────────────────────────────────

/**
 * Map opResult.values (keyed by bare lowercase SPICE node name) onto netId →
 * volts using the circuit's spiceNode mapping. Currents (i(...)) are skipped.
 */
export function mapOpResultToNetVoltages(
  values: Record<string, number>,
  circuit: Circuit,
): Map<number, number> {
  const out = new Map<number, number>()
  // Build spiceNode → netId. Ground node "0" → its net (0 V) too.
  const nodeToNet = new Map<string, number>()
  for (const net of circuit.nets) {
    nodeToNet.set(net.spiceNode, net.id)
  }
  for (const [key, volts] of Object.entries(values)) {
    if (key.startsWith('i(')) continue // current, not a node voltage
    const netId = nodeToNet.get(key)
    if (netId !== undefined) out.set(netId, volts)
  }
  // Ground nets read 0 V even if ngspice omits node "0".
  for (const net of circuit.nets) {
    if (net.spiceNode === '0' && !out.has(net.id)) out.set(net.id, 0)
  }
  return out
}

/** Min/max across a netId→volts map (for the voltage legend). */
export function computeVoltageRange(
  voltages: Map<number, number>,
): { min: number; max: number } | null {
  if (voltages.size === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const v of voltages.values()) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

// ─── React binding ───────────────────────────────────────────────────────────

/**
 * Bind a vanilla store to React. Components call `useAppStore(store, selector)`.
 * The single app-wide store is created in the renderer entrypoint (with the real
 * port-backed simClient) and threaded down; tests create their own.
 */
export function useAppStore<T>(store: AppStore, selector: (s: AppState) => T): T {
  return useStore(store, selector)
}
