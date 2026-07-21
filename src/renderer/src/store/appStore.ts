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
import {
  generateDeck,
  alterPlan,
  buildLedSpiceNames,
  isLedPart,
  ledSenseName,
  deriveMeasuredRailVHigh,
} from '../../../core/spicegen/generate'
import {
  wiredInstruments, isFullyWired, type Instrument,
} from '../../../core/spicegen/instruments'
import {
  defaultBenchInstrument, applyTerminal, clearTerminal, GROUND_INST_ID,
  type BenchKind, type Terminal, type AttachTarget,
} from '../bench/leads'
import {
  diagnoseDarkLeds,
  type CoachLed,
  type DarkLedNote,
  type DiagnoseInput,
} from '../../../core/live/coach'
import { parseBom } from '../../../core/bom/parseBom'
import type { BoardModel } from '../../../core/kicad/types'
import { runCritic } from '../../../core/critic/run'
import type { CriticReport, Finding, OpResult } from '../../../core/critic/types'

import type { SimClient } from '../ipc/simClient'
import { splitPath, type ReadFileFn } from '../ipc/fileOpen'
import { normalizeVectorKey, type OpSolveMethod, type SimCommand, type SimEvent } from '../../../simhost/protocol'
import { parseConvergenceCulprit, type ConvergenceCulprit } from './convergenceCulprit'
import { createRingBuffer, feedSamples, type RingBuffer } from '../scope/ringBuffer'
import { scopeSamplesEmitter } from '../scope/sampleEmitter'

// ─── derived helpers (pure, exported for the UI + tests) ─────────────────────────

export interface ResolutionSummary {
  total: number
  ok: number
  stubbed: number
  unresolved: number
  /** Known parts intentionally not modeled (library documented-open entries — M9). */
  documentedOpen: number
}

/** Count resolutions by status — drives the fidelity banner + parts badges. */
export function resolutionSummary(resolutions: Resolution[]): ResolutionSummary {
  const summary: ResolutionSummary = {
    total: resolutions.length, ok: 0, stubbed: 0, unresolved: 0, documentedOpen: 0,
  }
  for (const r of resolutions) {
    if (r.status === 'ok') summary.ok++
    else if (r.status === 'stubbed') summary.stubbed++
    else if (r.status === 'documented-open') summary.documentedOpen++
    else summary.unresolved++
  }
  return summary
}

/**
 * UI status badge color for a resolution: ok → green, stubbed → amber,
 * documented-open → grey ("open by design" — deliberate, not an error),
 * unresolved → red.
 */
export type StatusBadge = 'ok' | 'amber' | 'red' | 'grey'
export function statusBadge(r: Resolution): StatusBadge {
  if (r.status === 'ok') return 'ok'
  if (r.status === 'stubbed') return 'amber'
  if (r.status === 'documented-open') return 'grey'
  return 'red'
}

// ─── fidelity banner (Spec §8.6, §12) ───────────────────────────────────────────

export interface FidelityBannerItem {
  ref: string
  /** Plain-language mode, e.g. "stubbed (open)", "unresolved" or "open by design". */
  mode: string
}

/**
 * Build the persistent fidelity-banner list (Spec §8.6 / §12): one entry per part
 * whose `status !== 'ok'`, in resolution order, naming the ref + the stub mode.
 * Documented opens read "open by design" — they are still approximations, but
 * deliberate ones (M9), never lumped in with "unresolved".
 * Empty list ⇒ banner hidden (the simulation is fully resolved).
 */
export function fidelityBannerItems(resolutions: Resolution[]): FidelityBannerItem[] {
  const items: FidelityBannerItem[] = []
  for (const r of resolutions) {
    if (r.status === 'ok') continue
    let mode: string
    if (r.status === 'stubbed') {
      const stubMode = r.model?.kind === 'stub' ? r.model.mode : 'open'
      mode = `stubbed (${stubMode})`
    } else if (r.status === 'documented-open') {
      mode = 'open by design'
    } else {
      mode = 'unresolved'
    }
    items.push({ ref: r.ref, mode })
  }
  return items
}

/** True when any resolution is an xspice-digital part (sequential-logic caveat). */
export function hasDigitalParts(resolutions: Resolution[]): boolean {
  return resolutions.some(r => r.model?.kind === 'xspice-digital')
}

// ─── op fallback caveat (F1 — Spec §12 honesty surfaces) ─────────────────────────

/**
 * Plain-language banner text for an operating point that converged only via a
 * fallback rung (or not at all). Names the rung explicitly so the user knows
 * WHY the numbers are suspect — a fallback solve frequently reports 0.000 V on
 * nets it could not really resolve.
 */
export function opCaveatMessage(method: Exclude<OpSolveMethod, 'direct'>): string {
  const unreliable = 'Voltages may be unreliable — especially 0.000 V readings.'
  switch (method) {
    case 'gmin':
      return `Operating point found via fallback (gmin stepping — the direct solve did not converge). ${unreliable}`
    case 'source':
      return `Operating point found via fallback (source stepping — gmin stepping failed). ${unreliable}`
    case 'tran-fallback':
      return `Operating point found via fallback (transient-op — gmin and source stepping both failed). ${unreliable}`
    case 'failed':
      return (
        'The operating point did not converge at all — the displayed voltages ' +
        'come from the last failed attempt and should not be trusted.'
      )
  }
}

/**
 * Collapse the fidelity-banner ref list into a one-line count when it would be
 * a wall of refs (M7 F9): more than 3 problem parts → "N parts unresolved"
 * (naming stubs honestly when they're in the mix); 3 or fewer → null, meaning
 * the banner should keep listing the individual refs (that's useful).
 *
 * Documented opens (M9) are counted separately — never as "unresolved":
 * all-open → "N parts open by design"; mixed → "… · N open by design".
 */
export function collapsedFidelitySummary(items: FidelityBannerItem[]): string | null {
  if (items.length <= 3) return null
  const unresolved = items.filter(i => i.mode === 'unresolved').length
  const openByDesign = items.filter(i => i.mode === 'open by design').length
  const stubbed = items.length - unresolved - openByDesign
  if (unresolved + stubbed === 0) return `${items.length} parts open by design`
  const what =
    unresolved === 0 ? 'stubbed' : stubbed === 0 ? 'unresolved' : 'unresolved or stubbed'
  const openSuffix = openByDesign > 0 ? ` · ${openByDesign} open by design` : ''
  return `${unresolved + stubbed} parts ${what}${openSuffix}`
}

/**
 * Stable identity of the current fidelity problem set (Gemini finding 4).
 * Order-independent so a resolution re-order never spuriously re-expands the
 * minimized banner.
 */
export function fidelitySignature(items: FidelityBannerItem[]): string {
  return items
    .map(it => `${it.ref}:${it.mode}`)
    .sort()
    .join('|')
}

/**
 * Minimized iff the user minimized THIS exact problem set. Any change — new
 * part, mode change, item resolved — changes the signature → auto re-expand.
 * Honesty (Spec §8.6): the banner minimizes to a visible badge, never away.
 */
export function isFidelityMinimized(
  items: FidelityBannerItem[],
  minimizedSig: string | null,
): boolean {
  return minimizedSig !== null && fidelitySignature(items) === minimizedSig
}

/**
 * Stable id of the DC supply auto-attached on open (Spec §4 "see it work in 60
 * seconds"). Stable so the InstrumentRack can auto-select it (revealing its
 * voltage input) and so tests can assert on it.
 */
export const AUTO_SUPPLY_ID = 'auto-supply'

/**
 * Trace color rotation for voltage probes — shared by the rack's drag-drop
 * path and the store's click-to-probe path (attachProbeToNet) so probes get
 * the same palette no matter how they were attached.
 */
export const PROBE_COLORS = ['#6f6', '#f96', '#9cf', '#fc6', '#f6f', '#6ff', '#ff6']

/**
 * Allocate the next probe trace color: the FIRST PROBE_COLORS entry not held
 * by any existing probe (so removing a probe frees its color for the next
 * attach), wrapping to simple rotation only when the whole palette is taken.
 * THE single allocator — every probe-attach path (board drag-drop, rack
 * net-list drop, click-to-probe) gets its color here, so two traces can never
 * collide while palette slots remain (M7 review fix).
 */
export function nextProbeColor(instruments: Instrument[]): string {
  const used = new Set<string>()
  let colored = 0
  for (const inst of instruments) {
    if ('color' in inst) {
      used.add(inst.color)
      colored++
    }
  }
  return PROBE_COLORS.find(c => !used.has(c)) ?? PROBE_COLORS[colored % PROBE_COLORS.length]
}

/**
 * Bench palette id allocator: a monotonic counter suffixed onto the kind so
 * every shelf-added instrument gets a stable, unique SPICE-safe id
 * (`dc_supply_bench_1`, …). Mirrors the retired InstrumentRack's `genId`.
 */
let _benchIdCounter = 0
function benchId(kind: string): string {
  return `${kind.replace(/-/g, '_')}_bench_${++_benchIdCounter}`
}

// ─── transient analysis defaults (Spec §7.5) ─────────────────────────────────────

/** Default bench window in sim-seconds (Spec §7.5). NEVER unbounded. */
export const BENCH_WINDOW_SECONDS = 30

/** Hard cap on the transient time-step (Spec §7.5 / Task 24). */
export const MAX_TSTEP_SECONDS = 10e-6

/**
 * Compute the transient time-step from the fastest function-gen present:
 *   tstep = min( 1 / (200 · fmax), 10 µs )
 * When there is no function-gen, fmax is undefined and tstep falls back to the
 * 10 µs cap (Spec §7.5, Task 24).
 */
export function computeTstep(instruments: Instrument[]): number {
  let fmax = 0
  for (const inst of instruments) {
    if (inst.kind === 'function-gen' && inst.freqHz > fmax) fmax = inst.freqHz
  }
  if (fmax <= 0) return MAX_TSTEP_SECONDS
  return Math.min(1 / (200 * fmax), MAX_TSTEP_SECONDS)
}

// ─── board hooks (imperative viewport seam — Spec §10.2, §11) ─────────────────────

/**
 * The narrow imperative seam the orchestration slice uses to push results onto
 * the 3D board. In production these forward to the SceneManager
 * (`scene.applyNetVoltages` / `scene.showOpAnnotations`); unit tests inject a spy.
 * Kept optional so the store works headless (tests that don't care about the
 * viewport simply omit it).
 */
export interface BoardHooks {
  /** Tint copper by per-net voltage (op result or latest transient sample). */
  applyNetVoltages(voltages: Map<number, number>, minVolts: number, maxVolts: number): void
  /** Show floating net-voltage labels from an op result. */
  showOpAnnotations(voltages: Map<number, number>): void
  /**
   * Drive per-LED emissive glow from op-point device currents (ref → amps).
   * Additive over voltage tint/annotations; LEDs at ~0 current stay dark.
   * Optional so older hook providers (and headless tests) can omit it.
   */
  applyLedCurrents?(currentsByRef: Map<string, number>): void

  // ── Board Critic overlay (read-only) ────────────────────────────────────────
  /** Place severity-colored markers at the located findings (replaces prior). */
  setCriticFindings?(findings: Finding[]): void
  /** Remove all critic markers. */
  clearCriticFindings?(): void
  /** Fly the camera to a finding + highlight its net/part (read-only). */
  focusFinding?(finding: Finding): void
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

/**
 * A gated-off rail warning: a digital chip whose VDD net measured below the rail
 * floor (~0 V) at the operating point, so the family-default swing was used. The
 * readout offers a one-click manual rail override (Spec: op-informed rail sensing).
 */
export interface RailNote {
  ref: string
  kicadName: string
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
  /**
   * Bundled model-library texts: filename → file contents for every referenced
   * .lib / .json model file (from `window.circsim.getModelLibrary`). The deck
   * generator inlines the matching .subckt/.model definitions and expands the
   * xspice-digital templates from these (ngspice loads decks from memory).
   */
  modelTexts: Record<string, string>
  resolutions: Resolution[]

  // ── user overrides (kept so re-resolve is deterministic + crash-safe) ─────────
  stubOverrides: Map<string, UserStubOverride>
  pinMapOverrides: Map<string, PinMap>
  /**
   * Manual per-net rail-voltage overrides, keyed by net kicadName (e.g. `/VGATED`).
   * Tier 2 of the digital rail precedence — bridged to the netId→volts map
   * generateDeck consumes via `railOverrideNetMap()`. Set/cleared by the user
   * from a gated-off warning or the net context (Spec: op-informed rail sensing).
   */
  railOverrides: Map<string, number>

  // ── bench state (survives SimHost crash → replayed) ──────────────────────────
  instruments: Instrument[]
  groundNetId: number | null
  suggestedSupplyNetIds: number[]
  /**
   * Id of the instrument selected in the rack (its properties panel is shown).
   * Owned by the store (not the rack) so actions like attachSupplyToNet can
   * reveal the supply they created/found. null = nothing selected.
   */
  selectedInstrumentId: string | null
  /**
   * Id of a supply CIRCSIM attached (open-time auto-attach / energize) that the
   * user hasn't touched yet — its props card announces the auto-attach (M7 F7).
   * Cleared when the user edits or removes that supply (at that point they
   * clearly know it exists); never set for user-attached supplies.
   */
  autoAttachedSupplyId: string | null

  // ── sim state ────────────────────────────────────────────────────────────────
  simState: SimRunState
  deckDirty: boolean
  /** Latest op-point node voltages, keyed by netId (for board annotations/tint). */
  opVoltages: Map<number, number> | null
  /**
   * True while the displayed opVoltages are from a PREVIOUS run: a new op solve
   * has started and retained the old numbers for continuity. Readout surfaces
   * (NetVoltages) dim + caption them; cleared the moment a fresh opResult
   * lands. Stays true if the new solve never lands — old data must never read
   * as current (M7 review fix).
   */
  opVoltagesStale: boolean
  /** Min/max voltage across the latest op result (for the voltage legend). */
  voltageRange: { min: number; max: number } | null
  /**
   * Latest op-point device currents, keyed by part ref (amps). Populated from
   * each opResult's saved LED device-current vectors (LED glow). Drives the
   * viewport's per-LED emissive intensity. Reset on board change.
   */
  currentsByRef: Map<string, number>
  /**
   * Plain-language "why isn't my LED glowing?" coach notes (First Light, L3).
   * Rebuilt after every op solve from diagnoseDarkLeds(buildCoachInput(...)).
   * Empty when every LED is lit (or there are no LEDs). Surfaced as a small
   * non-blocking panel (CoachNotes.tsx, data-testid="coach-note").
   */
  coachNotes: DarkLedNote[]
  /**
   * Op-measured switched/derived rail voltages from the latest powerOn solve,
   * keyed by netId. Cached so a subsequent transient/energize deck reuses the
   * sensed rails (tier 3) without re-sensing, and so powerOn's two-pass guard can
   * tell whether a fresh op changed any chip's vHigh. null before the first solve.
   */
  measuredRails: Map<number, number> | null
  /**
   * Gated-off rail warnings from the latest powerOn solve: a digital chip whose
   * VDD net measured below the rail floor (~0 V) at the operating point. The
   * default swing was used; the readout surfaces a note offering a manual
   * override (Task 6). Empty when no rail is gated off.
   */
  railNotes: RailNote[]
  ngspiceVersion: string | null
  /** Real-time pacing factor (0.1× / 1× / 'max'). */
  paceFactor: number | 'max'
  /** Achieved real-time factor from the latest `status` event (UI readout). */
  achievedRealtimeFactor: number | null
  /** Current sim-time (seconds) from the latest `status` event. */
  simTimeSeconds: number
  /** Vector names from the latest run (`vectors` event) — drives sample routing. */
  vectorNames: string[]

  // ── error / honesty state (Spec §12) ─────────────────────────────────────────
  parseError: ParseErrorInfo | null
  /** True when the board renders but simulation can't proceed (Spec §12). */
  viewerOnly: boolean

  // ── selection sync (PartsPanel ↔ viewport) ───────────────────────────────────
  selectedRef: string | null
  selectedNetId: number | null
  /**
   * Explicit "reveal this part's Model Doctor card" request. The nonce bumps on
   * EVERY revealInDoctor call, so re-requesting the already-selected ref still
   * scrolls/highlights (a selection-transition effect would no-op — M7 review).
   */
  revealDoctorRequest: { ref: string; nonce: number } | null

  // ── Board Critic (read-only pre-fab audit — Spec §7) ──────────────────────────
  /**
   * Latest critic report. Auto-rebuilt when a board opens (no-sim checks) and
   * after each operating-point solve (with real currents for ampacity/thermal).
   * null before the first audit. The critic never edits the board.
   */
  criticReport: CriticReport | null
  /** Finding the user clicked (drives the viewport fly-to + highlight). */
  selectedFindingId: string | null

  // ── Task 25: user models (llm-generated + user-import, in-memory) ────────────
  /**
   * In-memory user model store: ref → { subcktText, subcktName, pinMap, provenance }.
   * These are applied at tier 4 in resolveAll (via the library seam injected in
   * reResolve). Persisted externally by the caller via platformPaths.
   */
  userModels: Map<string /* ref */, {
    mpn: string
    subcktText: string
    subcktName: string
    pinMap: PinMap
    provenance: 'llm-generated' | 'user-import'
  }>

  // ── log stream ────────────────────────────────────────────────────────────────
  logLines: { level: 'info' | 'warn' | 'error'; text: string }[]
  lastBenchRestart: { reason: 'window-elapsed' | 'memory'; at: number } | null
  crashNotice: { willRespawn: boolean; at: number } | null

  // ── transient run honesty surfaces (Spec §7.5, §12) ───────────────────────────
  /**
   * Brief "bench restarted" toast (Spec §7.5). `sequentialLogicCaveat` is true
   * when digital parts are present (their state is lost across a restart).
   */
  benchRestartToast: {
    reason: 'window-elapsed' | 'memory'
    sequentialLogicCaveat: boolean
    at: number
  } | null
  /**
   * Plain-language convergence-failure card (Spec §12): friendly explanation +
   * the retry-ladder note + the raw ngspice log for the expandable section.
   */
  convergenceCard: {
    plainLanguage: string
    retryLadderNote: string
    rawDetail: string
    /**
     * The part/net ngspice named in its abort text ("trouble with
     * <model>-instance m_q7" / "trouble with node <n>"), mapped back to the
     * human refdes / net name. null when the raw text names nothing we can map.
     */
    culprit: ConvergenceCulprit | null
    at: number
  } | null

  /**
   * Caveat for an operating point that converged only via a fallback rung
   * (gmin stepping / source stepping / ngspice's transient-op fallback) — or
   * not at all ('failed'). A fallback solve frequently reports 0.000 V on nets
   * it could not really resolve, so the UI shows a persistent warning banner
   * while this is set (F1 trust fix). null after a direct solve, after an
   * opResult from an older SimHost that doesn't report `method`, or when no op
   * has run.
   */
  opCaveat: { method: Exclude<OpSolveMethod, 'direct'>; at: number } | null

  /**
   * Fidelity-banner minimize (Gemini finding 4): when non-null, the banner is
   * minimized to the header badge for AS LONG AS the live fidelity signature
   * still matches. Per-board, per-session, in-memory.
   */
  fidelityMinimizedSig: string | null

  // ── actions ────────────────────────────────────────────────────────────────
  /** Parse + extract + resolve a board from raw .kicad_pcb text. */
  openBoardFromText(boardText: string, fileName: string, opts?: OpenOpts): void
  /** Attach a sibling schematic's Sim.* data (re-resolves). */
  setSchematicFromText(schText: string, fileName: string): void
  /**
   * Manually attach a .kicad_sch BY PATH (M3): read the file, then feed it to
   * setSchematicFromText (re-parse Sim.* → re-resolve → deck dirty). Solves the
   * real-board gap where the schematic isn't a same-basename sibling of the
   * .kicad_pcb, so auto-pairing found nothing.
   *
   * `readFile` is injectable (tests pass a stub); it defaults to
   * `window.circsim.readFile`. No-op when no board is loaded. A read failure is
   * non-fatal — it surfaces a warning on the log stream instead of crashing.
   */
  attachSchematicFromPath(path: string, readFile?: ReadFileFn): Promise<void>
  /** Import a BOM CSV (re-resolves with BOM-merged values/mpn). */
  setBomFromText(csvText: string): void
  /** Provide the bundled library (re-resolves with tier-3 matching). */
  setLibrary(library: LibraryEntry[]): void
  /**
   * Provide the bundled model library AND its texts in one shot (boot path).
   * `texts` (filename → contents) lets the deck generator inline the matching
   * .subckt/.model definitions + expand xspice-digital templates. Re-resolves.
   */
  setModelLibrary(library: LibraryEntry[], texts: Record<string, string>): void

  /** Re-run resolveAll with the current overrides/inputs. */
  reResolve(): void

  // Model Doctor actions (Spec §8.6) — each re-resolves + flags deckDirty
  stubPart(ref: string, mode: 'open' | 'short' | 'interactive-pins'): void
  clearPartOverride(ref: string): void
  setPinMap(ref: string, pinMap: PinMap): void

  // Rail-voltage overrides (Spec: op-informed rail sensing, tier 2)
  /** Set a manual rail-voltage override for a net (by kicadName). Ignored if volts ≤ 0 / non-finite. */
  setRailOverride(kicadName: string, volts: number): void
  /** Clear a net's manual rail-voltage override. */
  clearRailOverride(kicadName: string): void
  /** Resolve the kicadName-keyed railOverrides to the netId→volts map generateDeck consumes. */
  railOverrideNetMap(): Map<number, number>

  // selection
  selectComponent(ref: string | null): void
  selectNet(netId: number | null): void
  /**
   * Select a part AND explicitly ask the Model Doctor to reveal its card
   * (scroll + highlight). Nonce-based, so calling it again for the same ref
   * re-reveals — used by the parts list, board picks, and the fidelity
   * banner's "open Model Doctor" link (M7 review fix).
   */
  revealInDoctor(ref: string): void

  // ── Board Critic (Spec §7) ───────────────────────────────────────────────────
  /**
   * Run the read-only board audit. Builds the critic OpResult from the current op
   * state (net voltages by spiceNode + per-ref currents) when energized, else
   * passes undefined so the sim-dependent checks (ampacity/thermal) are reported
   * as skipped. Stores the report and pushes the located findings to the viewport
   * overlay. No-op when no board/circuit is loaded.
   */
  runCriticAudit(): void
  /** Select a finding: stores its id and tells the viewport to focus/highlight it. */
  selectFinding(id: string | null): void

  // ground / supply
  setGround(netId: number | null): void

  // instruments
  addInstrument(inst: Instrument): void
  removeInstrument(id: string): void
  /** Update an instrument; routes through alterPlan (alter-safe vs reload). */
  updateInstrument(id: string, next: Instrument): void
  /** Select an instrument in the rack (null clears the selection). */
  selectInstrument(id: string | null): void
  /**
   * Designate a net as a supply rail (Milestone 2 manual designation): if a
   * dc-supply instrument already sits on that net, select it; otherwise attach
   * a default supply (5 V, 0.1 Ω — same defaults as the auto supply) and
   * select it so its properties are immediately editable.
   */
  attachSupplyToNet(netId: number): void

  /**
   * Attach a V-Probe to a net without dragging (M7 F6 click-to-probe): if a
   * voltage-probe already sits on that net, select it; otherwise attach one
   * (rotating trace color — same palette as the rack's drag path) and select
   * it. Routes through addInstrument, the same action the drag-drop path uses.
   */
  attachProbeToNet(netId: number): void

  /** Bench palette: create an UNWIRED instrument on the shelf; returns its id. */
  addBenchInstrument(kind: BenchKind): string
  /** Wire one terminal to a net/component (lead drop). Ground routes to setGround. */
  assignTerminal(instId: string, terminal: Terminal, target: AttachTarget): void
  /** Unwire one terminal (clip dragged off the board). */
  detachTerminalWire(instId: string, terminal: Terminal): void

  /**
   * Test/synchronisation seam: resolves once the energized re-op coalescer is
   * quiescent (no op in flight and no pending re-op). When nothing is in flight
   * it resolves on the next microtask. Lets tests await the settled state
   * deterministically instead of guessing at timers/wall-clock.
   */
  whenReopSettled(): Promise<void>

  // sim orchestration (Task 24)
  /**
   * Provide the imperative board hooks (viewport seam). The renderer entrypoint
   * wires these to the SceneManager; tests inject a spy. Optional + replaceable.
   */
  setBoardHooks(hooks: BoardHooks | null): void

  /** Generate deck → loadCircuit → runOp; resolves with the op voltages. */
  powerOn(): Promise<Map<number, number> | null>

  /**
   * First Light (L3) — the one inviting verb. A friendly wrapper over the
   * power-on / op flow: ensure a designated ground AND a driving supply are
   * attached (auto-attaching a default DC supply on the top suggested supply net
   * when none exists, mirroring openBoardFromText), then run the operating-point
   * solve so the LEDs glow. Resolves with the op voltages (or null if nothing on
   * the board can be energized — e.g. no ground/supply net could be found).
   */
  energize(): Promise<Map<number, number> | null>

  /**
   * Start (or resume) the live transient bench (Spec §4 step 5, §7.5).
   *   - If paused with a clean deck → resume.
   *   - Otherwise (re)load the deck when dirty, reset the ring buffers, and issue
   *     a BOUNDED `runTransient` (tstep = min(1/(200·fmax),10µs), tstop = 30 s).
   */
  run(): void

  /** Pause the running transient (user-owner `halt`). */
  pause(): void

  /** Set the real-time pacing factor (0.1× / 1× / 'max') → `setPace`. */
  setPace(factor: number | 'max'): void

  /** Read the ring buffer for a voltage probe (scope reads this). */
  getProbeRingBuffer(probeId: string): RingBuffer | null

  /** Dismiss the bench-restart toast. */
  dismissBenchRestartToast(): void

  /** Dismiss the convergence-failure card. */
  dismissConvergenceCard(): void

  /** Minimize the fidelity banner to the header badge (Gemini finding 4). */
  minimizeFidelityBanner(): void

  /** Mark deck dirty (any deck-affecting change). */
  markDeckDirty(): void

  // crash recovery (Spec §6.1)
  /** Replay deck + instrument state onto a fresh client (after respawn). */
  replayAfterCrash(): void
  /** Record a crash notice (from window.circsim.onSimhostCrashed). */
  noteCrash(willRespawn: boolean): void

  // internal: ingest a SimEvent (wired to the client's onEvent in setup)
  ingestEvent(event: SimEvent): void

  // ── Task 25: LLM-assist + user .lib import ────────────────────────────────

  /**
   * Validate a pasted .subckt block by sending a minimal test deck to SimHost.
   * The test deck wraps the subckt with dummy sources so ngspice can load it.
   * Returns { ok: true } when ngspice accepts the deck; { ok: false, error }
   * when it rejects with an error message.
   *
   * Injected simClient is used (no separate IPC needed).
   */
  validateSubckt(
    subcktText: string,
    subcktName: string,
    nodeCount: number,
  ): Promise<{ ok: true } | { ok: false; error: string }>

  /**
   * Save a validated LLM-generated subckt to the in-memory user library store
   * and flag the part as resolved (tier 4, provenance 'llm-generated').
   * The actual .lib file write is handled externally via platformPaths; this
   * keeps the resolution state in sync and re-resolves.
   *
   * @param ref          Part reference (e.g. 'U1').
   * @param mpn          Part identifier string (MPN or value).
   * @param subcktText   The validated .subckt text.
   * @param subcktName   The .subckt name.
   * @param pinMap       User-verified pad → terminal map.
   * @param provenance   'llm-generated' or 'user-import'.
   */
  saveUserModel(
    ref: string,
    mpn: string,
    subcktText: string,
    subcktName: string,
    pinMap: PinMap,
    provenance: 'llm-generated' | 'user-import',
  ): void
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
  /** Bundled model-library texts (filename → contents). Optional; defaults to none. */
  modelTexts?: Record<string, string>
}

export type AppStore = StoreApi<AppState>

export function createAppStore(options: CreateAppStoreOptions): AppStore {
  const { simClient } = options

  // ── non-reactive closure state ───────────────────────────────────────────────
  // Board hooks (viewport seam) + per-probe ring buffers live OUTSIDE the reactive
  // store: they are imperative sinks (the scene + the scope), not render inputs.
  let boardHooks: BoardHooks | null = null
  const ringBuffers = new Map<string /* probe id */, RingBuffer>()

  // ── energized re-op coalescing (First Light dimmer — Spec §4) ─────────────────
  // A knob drag fires a flood of updateInstrument() calls. Re-solving the op on
  // every one would (a) overload SimHost and (b) drop the FINAL value when the
  // last change lands while an op is still in flight. We coalesce: at most one op
  // is in flight; while it runs, further changes set `reopRequested` and the op,
  // on completion, re-solves ONCE for the latest instrument state — but only if
  // the instruments actually changed since the last solve started (no-op guard
  // against an infinite loop). `reopSettled` lets tests await the quiescent point.
  let reopInFlight = false
  let reopRequested = false
  /**
   * True while powerOn owns an in-flight op (either pass). The permanent
   * ingestEvent listener also receives powerOn's opResult events (waitFor and
   * ingestEvent share onEvent); this flag makes powerOn the SOLE committer for
   * its own ops, so ingestEvent never commits powerOn's interim pass-1
   * (family-default) result during the tier-3 pass-2 re-solve. run() /
   * replayAfterCrash() ops still commit via ingestEvent normally.
   */
  let powerOnOpInFlight = false
  /** Snapshot of the instruments the in-flight (or last) op was solved for. */
  let lastSolvedInstruments: Instrument[] | null = null
  let reopSettledResolvers: Array<() => void> = []

  /** Resolve everyone awaiting whenReopSettled() now that the queue is drained. */
  function flushReopSettled(): void {
    const resolvers = reopSettledResolvers
    reopSettledResolvers = []
    for (const r of resolvers) r()
  }

  /**
   * Run the energized re-op loop: solve once for the current instrument state,
   * then — if more changes arrived while solving AND they differ from what we just
   * solved — solve again. Coalesces a burst of changes into the minimum number of
   * op solves, always ending on the LATEST value. Re-entrancy-safe via reopInFlight.
   */
  async function runCoalescedReop(): Promise<void> {
    if (reopInFlight) {
      // An op is already running; mark that another solve is wanted and return.
      reopRequested = true
      return
    }
    reopInFlight = true
    try {
      do {
        reopRequested = false
        lastSolvedInstruments = store.getState().instruments
        await store.getState().powerOn()
        // Loop again only if a change arrived during the solve AND it left the
        // instruments different from what we just solved (no-op guard).
      } while (
        reopRequested &&
        !sameInstruments(lastSolvedInstruments, store.getState().instruments)
      )
    } finally {
      reopInFlight = false
      reopRequested = false
      flushReopSettled()
    }
  }

  /** Ensure a ring buffer exists for every current voltage-probe; prune the rest. */
  function syncRingBuffers(instruments: Instrument[]): void {
    const liveIds = new Set<string>()
    for (const inst of instruments) {
      if (inst.kind === 'voltage-probe' && isFullyWired(inst)) {
        liveIds.add(inst.id)
        if (!ringBuffers.has(inst.id)) ringBuffers.set(inst.id, createRingBuffer())
      }
    }
    for (const id of [...ringBuffers.keys()]) {
      if (!liveIds.has(id)) ringBuffers.delete(id)
    }
  }

  /** Reset (clear) all ring buffers at the start of a fresh transient run. */
  function resetRingBuffers(instruments: Instrument[]): void {
    ringBuffers.clear()
    syncRingBuffers(instruments)
  }

  const store = createStore<AppState>((set, get) => ({
    // ── initial state ──────────────────────────────────────────────────────────
    project: { boardFileName: null, boardText: null, schematicFileName: null },
    board: null,
    circuit: null,
    schematicSimData: null,
    bom: null,
    library: options.library ?? [],
    modelTexts: options.modelTexts ?? {},
    resolutions: [],
    stubOverrides: new Map(),
    pinMapOverrides: new Map(),
    railOverrides: new Map(),
    instruments: [],
    groundNetId: null,
    suggestedSupplyNetIds: [],
    selectedInstrumentId: null,
    autoAttachedSupplyId: null,
    simState: 'idle',
    deckDirty: false,
    opVoltages: null,
    opVoltagesStale: false,
    voltageRange: null,
    currentsByRef: new Map(),
    coachNotes: [],
    measuredRails: null,
    railNotes: [],
    ngspiceVersion: null,
    paceFactor: 1,
    achievedRealtimeFactor: null,
    simTimeSeconds: 0,
    vectorNames: [],
    parseError: null,
    viewerOnly: false,
    selectedRef: null,
    selectedNetId: null,
    revealDoctorRequest: null,
    criticReport: null,
    selectedFindingId: null,
    userModels: new Map(),
    logLines: [],
    lastBenchRestart: null,
    crashNotice: null,
    benchRestartToast: null,
    convergenceCard: null,
    opCaveat: null,
    fidelityMinimizedSig: null,

    // ── open flow ────────────────────────────────────────────────────────────
    openBoardFromText(boardText, fileName, opts) {
      // Reset everything that depends on the old project.
      ringBuffers.clear()
      set({
        parseError: null,
        viewerOnly: false,
        opVoltages: null,
        opVoltagesStale: false,
        voltageRange: null,
        currentsByRef: new Map(),
        coachNotes: [],
        measuredRails: null,
        railNotes: [],
        instruments: [],
        selectedInstrumentId: null,
        autoAttachedSupplyId: null,
        stubOverrides: new Map(),
        pinMapOverrides: new Map(),
        railOverrides: new Map(),
        simState: 'idle',
        deckDirty: false,
        selectedRef: null,
        selectedNetId: null,
        revealDoctorRequest: null,
        criticReport: null,
        selectedFindingId: null,
        logLines: [],
        benchRestartToast: null,
        convergenceCard: null,
        opCaveat: null,
        fidelityMinimizedSig: null,
        vectorNames: [],
        simTimeSeconds: 0,
        achievedRealtimeFactor: null,
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
      const suggestedSupplyNetIds = supplies.map(s => s.id)

      // Auto-attach a default DC supply on the top suggested supply net so the
      // bench is immediately usable ("see it work in 60 seconds" — Spec §4): the
      // user lands with a designated ground AND a source, so Power On / Run are
      // live without manual rigging. The supply is editable/removable. We only
      // do this when a supply net was suggested AND it isn't the ground net.
      const instruments: Instrument[] = []
      const topSupplyNetId = suggestedSupplyNetIds.find(id => id !== groundNetId)
      if (topSupplyNetId !== undefined) {
        instruments.push({
          kind: 'dc-supply',
          id: AUTO_SUPPLY_ID,
          netId: topSupplyNetId,
          volts: 5,
          seriesOhms: 0.1, // Spec §9 default
        })
      }

      set({
        project: { boardFileName: fileName, boardText, schematicFileName },
        board,
        circuit,
        schematicSimData,
        bom,
        groundNetId,
        suggestedSupplyNetIds,
        instruments,
        // Reveal the auto supply's properties right away (the rack mirrors this).
        selectedInstrumentId: topSupplyNetId !== undefined ? AUTO_SUPPLY_ID : null,
        // Announce the silent auto-attach on the supply's card (M7 F7).
        autoAttachedSupplyId: topSupplyNetId !== undefined ? AUTO_SUPPLY_ID : null,
      })

      // Keep ring buffers in sync with the (possibly auto-attached) instruments.
      syncRingBuffers(instruments)

      // Resolve with current (empty) overrides.
      get().reResolve()

      // Viewer-only iff the netlist is unusable for simulation (no parts / no nets).
      const usable = circuit.parts.length > 0 && circuit.nets.length > 0
      set({ viewerOnly: !usable })

      // Auto-run the read-only critic audit (Spec §7 trigger): the no-sim checks
      // (floating / clearance / decoupling) run immediately on open; the
      // sim-dependent ones (ampacity / thermal) are reported as skipped until an
      // operating-point solve lands (which re-runs the audit with real currents).
      get().runCriticAudit()
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

    async attachSchematicFromPath(path, readFile) {
      // Guard: attaching a schematic only makes sense against a loaded board.
      if (!get().board) return
      const read = readFile ?? window.circsim.readFile
      let text: string
      try {
        text = await read(path)
      } catch (err) {
        // Non-fatal: mirror the open flow, which swallows a missing schematic —
        // but since the user explicitly asked to attach this file, surface a
        // plain-language warning on the log stream instead of failing silently.
        const msg = err instanceof Error ? err.message : String(err)
        set(s => ({
          logLines: [
            ...s.logLines,
            { level: 'warn' as const, text: `Couldn't read schematic ${path}: ${msg}` },
          ].slice(-2000),
        }))
        return
      }
      get().setSchematicFromText(text, splitPath(path).base)
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

    setModelLibrary(library, texts) {
      set({ library, modelTexts: texts })
      get().reResolve()
      get().markDeckDirty()
    },

    // ── resolution ──────────────────────────────────────────────────────────
    reResolve() {
      const { circuit, schematicSimData, bom, library, stubOverrides, pinMapOverrides, userModels } = get()
      if (!circuit) {
        set({ resolutions: [] })
        return
      }

      // Convert in-memory user models → LibraryEntry objects for tier 3/4 matching.
      // These are injected ahead of the bundled library so user models win.
      const userModelEntries: LibraryEntry[] = []
      for (const [_ref, um] of userModels) {
        userModelEntries.push({
          id: `user-model-${um.mpn}`,
          match: { mpn: [um.mpn] },
          model: {
            type: 'subckt',
            // Use an in-memory virtual path: the spicegen reads this via the
            // library entry; the actual text is stored in um.subcktText and
            // injected by the spicegen when generating the deck.
            file: `__user_model__:${um.mpn}`,
            name: um.subcktName,
          },
          pinMaps: { '.*': um.pinMap },
          defaultPinMap: um.pinMap,
          provenance: um.provenance,
        })
      }

      const effectiveLibrary = [...userModelEntries, ...library]
      const resolved = resolveAll(
        circuit,
        schematicSimData ?? undefined,
        bom ?? undefined,
        effectiveLibrary.length > 0 ? effectiveLibrary : undefined,
        stubOverrides.size > 0 ? stubOverrides : undefined,
      )

      // Apply the Model Doctor's manual pin-map overrides. resolveAll doesn't take
      // them (they correct a resolved model's terminal mapping, not which model is
      // chosen), so we override model.pinMap post-resolution for every part the
      // user has re-mapped — otherwise a Pin-map edit is stored but never reaches
      // the deck (only pinmaps bundled inside a saveUserModel took effect before).
      const resolutions =
        pinMapOverrides.size > 0
          ? resolved.map((r) => {
              const override = pinMapOverrides.get(r.ref)
              if (override && r.model && 'pinMap' in r.model) {
                return { ...r, model: { ...r.model, pinMap: override } }
              }
              return r
            })
          : resolved
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

    // ── rail-voltage overrides (op-informed rail sensing, tier 2) ────────────────
    setRailOverride(kicadName, volts) {
      if (!Number.isFinite(volts) || volts <= 0) return
      const next = new Map(get().railOverrides)
      next.set(kicadName, volts)
      set({ railOverrides: next })
      get().markDeckDirty()
    },

    clearRailOverride(kicadName) {
      const next = new Map(get().railOverrides)
      next.delete(kicadName)
      set({ railOverrides: next })
      get().markDeckDirty()
    },

    railOverrideNetMap() {
      const { circuit, railOverrides } = get()
      const map = new Map<number, number>()
      if (!circuit) return map
      for (const net of circuit.nets) {
        const v = railOverrides.get(net.kicadName)
        if (v !== undefined) map.set(net.id, v)
      }
      return map
    },

    // ── selection ──────────────────────────────────────────────────────────
    selectComponent(ref) {
      set({ selectedRef: ref })
    },
    selectNet(netId) {
      set({ selectedNetId: netId })
    },
    revealInDoctor(ref) {
      set(s => ({
        selectedRef: ref,
        revealDoctorRequest: { ref, nonce: (s.revealDoctorRequest?.nonce ?? 0) + 1 },
      }))
    },

    // ── Board Critic (Spec §7) ─────────────────────────────────────────────────
    runCriticAudit() {
      const { board, circuit, opVoltages, currentsByRef } = get()
      if (!board || !circuit) {
        set({ criticReport: null, selectedFindingId: null })
        boardHooks?.clearCriticFindings?.()
        return
      }
      // Build the critic OpResult from the live op state ONLY when energized (an
      // op result is present). Without it runCritic SKIPS ampacity/thermal — which
      // is fine: opening re-audits no-sim checks, the post-op re-audit feeds reals.
      const opResult = buildCriticOpResult(circuit, opVoltages, currentsByRef)
      const report = runCritic(board, circuit, opResult)
      set({ criticReport: report })
      // Drop a stale selection if the finding no longer exists.
      const sel = get().selectedFindingId
      if (sel && !report.findings.some(f => f.id === sel)) set({ selectedFindingId: null })
      // Push the located findings to the read-only viewport overlay.
      boardHooks?.setCriticFindings?.(report.findings)
    },

    selectFinding(id) {
      set({ selectedFindingId: id })
      if (id === null) return
      const finding = get().criticReport?.findings.find(f => f.id === id)
      if (finding) boardHooks?.focusFinding?.(finding)
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
      syncRingBuffers(get().instruments)
      get().markDeckDirty()
    },

    removeInstrument(id) {
      set(s => ({
        instruments: s.instruments.filter(i => !('id' in i) || i.id !== id),
        // A removed instrument can't stay selected.
        selectedInstrumentId: s.selectedInstrumentId === id ? null : s.selectedInstrumentId,
        // A removed auto supply needs no announcement any more (M7 F7).
        autoAttachedSupplyId: s.autoAttachedSupplyId === id ? null : s.autoAttachedSupplyId,
      }))
      syncRingBuffers(get().instruments)
      get().markDeckDirty()
    },

    selectInstrument(id) {
      set({ selectedInstrumentId: id })
    },

    attachSupplyToNet(netId) {
      // Never attach a supply to the designated ground net — that would drive
      // SPICE node 0 (the reference) with a source.
      if (netId === get().groundNetId) return
      // Already powered by a supply? Just reveal it — never stack a second
      // source on the same rail.
      const existing = get().instruments.find(
        i => i.kind === 'dc-supply' && i.netId === netId,
      )
      if (existing && 'id' in existing) {
        get().selectInstrument(existing.id)
        return
      }
      // Same defaults as the auto supply (5 V, 0.1 Ω — Spec §9). Deterministic
      // id: attach → remove → attach reuses it, and the existing-supply guard
      // above prevents any duplicate while it lives.
      const id = `dc_supply_net_${netId}`
      get().addInstrument({ kind: 'dc-supply', id, netId, volts: 5, seriesOhms: 0.1 })
      get().selectInstrument(id)
    },

    attachProbeToNet(netId) {
      // A probe already watching this net? Just reveal it — click-to-probe
      // should never stack duplicate probes on one net.
      const existing = get().instruments.find(
        i => i.kind === 'voltage-probe' && i.netId === netId,
      )
      if (existing && 'id' in existing) {
        get().selectInstrument(existing.id)
        return
      }
      // Deterministic id (attach → remove → attach reuses it; the guard above
      // prevents duplicates while it lives) + the shared color allocator (first
      // free palette slot — no collision with probes attached via drag-drop).
      // Attachment goes through addInstrument — the same action all paths use.
      const id = `voltage_probe_net_${netId}`
      get().addInstrument({
        kind: 'voltage-probe',
        id,
        netId,
        color: nextProbeColor(get().instruments),
      })
      get().selectInstrument(id)
    },

    addBenchInstrument(kind) {
      const id = benchId(kind)
      const inst = defaultBenchInstrument(kind, id, nextProbeColor(get().instruments))
      get().addInstrument(inst)
      get().selectInstrument(id)
      return id
    },

    assignTerminal(instId, terminal, target) {
      // Ground is the setGround flow (spec §7) — the ground panel's black lead.
      if (instId === GROUND_INST_ID && terminal === 'gnd') {
        if (target.kind === 'net') get().setGround(target.netId)
        return
      }
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = applyTerminal(inst, terminal, target)
      // applyTerminal returns the SAME object for invalid combos — no-op then;
      // otherwise route through updateInstrument so alter/re-op semantics fire.
      if (next !== inst) get().updateInstrument(instId, next)
    },

    detachTerminalWire(instId, terminal) {
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = clearTerminal(inst, terminal)
      if (next !== inst) get().updateInstrument(instId, next)
    },

    updateInstrument(id, next) {
      const { instruments, resolutions, simState, opVoltages } = get()
      const prev = instruments.find(i => 'id' in i && i.id === id)
      const updated = instruments.map(i => ('id' in i && i.id === id ? next : i))
      set({ instruments: updated })

      // The user touched the auto-attached supply → they clearly know it
      // exists; retire its announcement note (M7 F7).
      if (id === get().autoAttachedSupplyId) set({ autoAttachedSupplyId: null })

      // "Energized" = an op result is currently shown and we're NOT mid-transient
      // (a transient run is 'running'/'paused'). After energize()/powerOn the
      // store sits at 'idle' with opVoltages populated. When the user nudges an
      // instrument in that state (the supply DragKnob, a pot wiper, …), re-run the
      // operating-point solve so currentsByRef + the LED glow + the coach update
      // live — e.g. lowering the supply voltage dims the LED (First Light, L3).
      //
      // `reopInFlight` keeps us energized DURING a coalesced re-op: the re-op's own
      // powerOn flips simState to 'op', so a knob change that lands mid-solve would
      // otherwise read as not-energized and be dropped. Including reopInFlight lets
      // that change queue (runCoalescedReop's no-op guard prevents loops).
      const energized = (simState === 'idle' || reopInFlight) && opVoltages !== null

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

      // Re-op while energized: regenerate the deck with the new instrument values
      // and re-solve. Coalesced so a knob-drag flood collapses to the minimum
      // number of op solves and always ends on the FINAL value (runCoalescedReop):
      // if an op is in flight the latest value is queued and solved once it lands.
      if (energized) {
        void runCoalescedReop()
      }
    },

    whenReopSettled() {
      if (!reopInFlight && !reopRequested) return Promise.resolve()
      return new Promise<void>(resolve => {
        reopSettledResolvers.push(resolve)
      })
    },

    // ── sim orchestration ──────────────────────────────────────────────────────
    setBoardHooks(hooks) {
      boardHooks = hooks
    },

    async powerOn() {
      const { circuit, resolutions, instruments, groundNetId } = get()
      if (!circuit || groundNetId === null) {
        // Guided empty-state (Spec §12): nothing to power on.
        return null
      }
      // Guided empty-state: zero resolved (wired) sources → no-op (Spec §12).
      // An UNWIRED source added from the shelf palette (bench-leads) doesn't
      // count — it drives nothing until a lead is dropped on a net.
      const hasSource = wiredInstruments(instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
      if (!hasSource) return null

      // Snapshot the resolved rail overrides ONCE per powerOn so the pass-1 deck,
      // the sensing skip-list, and the pass-2 deck all agree even if the user
      // edits an override mid-solve (FIX 3).
      const railOverrides = get().railOverrideNetMap()

      const deckLines = generateDeck({
        circuit,
        resolutions,
        instruments: wiredInstruments(instruments),
        groundNetId,
        title: get().project.boardFileName ?? undefined,
        modelTexts: buildDeckModelTexts(get()),
        railOverrides,
      })

      // Retained voltages from a previous run are STALE until the new solve
      // lands — readouts dim/caption them instead of presenting them as truth
      // (M7 review fix). Nothing retained on the first solve → stays false.
      set({
        simState: 'op',
        convergenceCard: null,
        opCaveat: null,
        opVoltagesStale: get().opVoltages !== null,
      })

      // powerOn owns every commit for its own op(s): suppress the ingestEvent
      // listener's opResult handler for the whole section so the interim pass-1
      // (family-default) result is never committed during the pass-2 re-solve
      // (FIX 2). The finally covers all exits: success, pass-1 timeout, pass-2
      // timeout.
      powerOnOpInFlight = true
      try {
        simClient.send({ type: 'loadCircuit', deckLines })
        simClient.send({ type: 'runOp' })

        let result: Extract<SimEvent, { type: 'opResult' }>
        try {
          result = await simClient.waitFor('opResult', 30_000)
        } catch {
          // A timeout drops us back to idle; a convergenceFailure event (ingested
          // separately) already surfaces the plain-language card.
          if (get().simState === 'op') set({ simState: 'idle' })
          return null
        }

        // ── Op-informed rail sensing (tier 3): sense switched rails, re-solve once ──
        // Pass 1's deck knew only tiers 1/2/4 (family default for any switched or
        // derived rail with no attached supply). Sense those rails from the op
        // result; if a measured rail would actually change a chip's vHigh, rebuild
        // the deck with the measured rails and re-solve EXACTLY once. `deckLines` is
        // the family-default baseline (powerOn never seeds measuredRailVHigh into
        // its own first pass), so comparing the regenerated deck to it — ignoring
        // provenance comment lines — is precisely "did the measured rail change the
        // circuit vs the family default?" A measured rail equal to the family
        // default leaves the deck identical → no wasted second solve.
        const { rails, gatedOff } = deriveMeasuredRailVHigh({
          opValues: result.values,
          circuit,
          resolutions,
          instruments,
          groundNetId,
          railOverrides,
          modelTexts: buildDeckModelTexts(get()),
        })
        if (rails.size > 0) {
          const deck2 = generateDeck({
            circuit,
            resolutions,
            instruments: wiredInstruments(instruments),
            groundNetId,
            title: get().project.boardFileName ?? undefined,
            modelTexts: buildDeckModelTexts(get()),
            railOverrides,
            measuredRailVHigh: rails,
          })
          // Compare only the circuit lines (drop `*` comments — the measured-rail
          // provenance note differs even when the numeric rail matches the default).
          const circuitLines = (deck: string[]): string =>
            deck.filter(line => !line.trimStart().startsWith('*')).join('\n')
          if (circuitLines(deck2) !== circuitLines(deckLines)) {
            simClient.send({ type: 'loadCircuit', deckLines: deck2 })
            simClient.send({ type: 'runOp' })
            try {
              result = await simClient.waitFor('opResult', 30_000) // pass 2 (single re-run)
            } catch {
              // Pass-2 failure/timeout: keep the pass-1 `result` already in hand.
            }
          }
        }
        set({ measuredRails: rails })
        const railNotes: RailNote[] = gatedOff.map(g => ({ ref: g.ref, kicadName: g.kicadName }))

        // Map opResult.values (bare lowercase node names) → netId voltages.
        const opVoltages = mapOpResultToNetVoltages(result.values, circuit)
        const voltageRange = computeVoltageRange(opVoltages)
        const currentsByRef = applyOpCurrents(boardHooks, result.values, resolutions, circuit)

        // Coach: explain any dark LEDs in plain language (First Light, L3).
        const coachNotes = diagnoseDarkLeds(
          buildCoachInput(
            circuit,
            currentsByRef,
            opVoltages,
            hasSupplyAttached(instruments, groundNetId),
            resolutions,
          ),
        )

        set({
          opVoltages,
          opVoltagesStale: false, // fresh result — no longer showing old numbers
          voltageRange,
          currentsByRef,
          coachNotes,
          railNotes,
          // Honesty surface (F1): powerOn is now the sole committer for its own op,
          // so it carries ingestEvent's caveat logic — an op that converged only
          // via a fallback rung gets the persistent caveat (absent method ⇒ direct).
          opCaveat:
            result.method && result.method !== 'direct'
              ? { method: result.method, at: Date.now() }
              : null,
          deckDirty: false,
          simState: 'idle',
        })

        // Push onto the 3D board: floating voltage labels + copper voltage tint.
        applyOpToBoard(boardHooks, opVoltages, voltageRange)

        // Re-run the critic with the fresh op result so the sim-dependent checks
        // (ampacity / thermal) now run with real node voltages + currents (Spec §7).
        get().runCriticAudit()
        return opVoltages
      } finally {
        // Release ingestEvent to commit ordinary (run/replay) ops again.
        powerOnOpInFlight = false
      }
    },

    async energize() {
      const { circuit } = get()
      if (!circuit) return null

      // 1) Ensure a designated ground. openBoardFromText already runs the ground
      //    heuristic, but if the user cleared it (or none was found) re-suggest.
      if (get().groundNetId === null) {
        const gnd = suggestGround(circuit.nets)
        if (gnd) get().setGround(gnd.id)
      }
      const groundNetId = get().groundNetId
      if (groundNetId === null) return null // nothing we can tie to 0 V

      // 2) Ensure a driving source. Reuse the open-time auto-supply: attach a
      //    default 5 V DC supply on the top suggested supply net (≠ ground) when
      //    no WIRED source is present yet (an unwired shelf instrument doesn't
      //    count — it can't drive powerOn's solve either). Editable/removable
      //    afterwards.
      const hasSource = wiredInstruments(get().instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
      if (!hasSource) {
        const supplyNetId = chooseEnergizeSupplyNet(circuit, groundNetId)
        if (supplyNetId !== undefined) {
          get().addInstrument({
            kind: 'dc-supply',
            id: AUTO_SUPPLY_ID,
            netId: supplyNetId,
            volts: 5,
            seriesOhms: 0.1, // Spec §9 default
          })
          // Announce this auto-attach on the supply's card too (M7 F7).
          set({ autoAttachedSupplyId: AUTO_SUPPLY_ID })
        }
      }

      // 3) Run the operating-point solve so the LEDs glow (and the coach speaks).
      return get().powerOn()
    },

    run() {
      const { circuit, resolutions, instruments, groundNetId, simState, deckDirty } = get()
      if (!circuit || groundNetId === null) {
        // Guided empty-state (Spec §12): no ground → Run is a no-op, not a dead button.
        return
      }
      // Guided empty-state: zero resolved (wired) sources → no-op (Spec §12).
      const hasSource = wiredInstruments(instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
      if (!hasSource) return

      // Resume-from-pause with a clean deck: do NOT reload, just resume.
      if (simState === 'paused' && !deckDirty) {
        simClient.send({ type: 'resume' })
        set({ simState: 'running' })
        return
      }

      // Fresh start (or restart after a deck-dirtying edit): reload the deck +
      // reset ring buffers so the scope starts clean.
      const deckLines = generateDeck({
        circuit,
        resolutions,
        instruments: wiredInstruments(instruments),
        groundNetId,
        title: get().project.boardFileName ?? undefined,
        modelTexts: buildDeckModelTexts(get()),
        railOverrides: get().railOverrideNetMap(),
        measuredRailVHigh: get().measuredRails ?? undefined,
      })
      resetRingBuffers(instruments)

      const tstepSeconds = computeTstep(instruments)
      const tstopSeconds = BENCH_WINDOW_SECONDS

      simClient.send({ type: 'loadCircuit', deckLines })
      simClient.send({ type: 'setPace', realtimeFactor: get().paceFactor })
      simClient.send({ type: 'runTransient', tstepSeconds, tstopSeconds })
      set({
        simState: 'running',
        deckDirty: false,
        convergenceCard: null,
        vectorNames: [],
        simTimeSeconds: 0,
      })
    },

    pause() {
      // user-owner halt (Spec §7.4.3): only the user resume clears it.
      simClient.send({ type: 'halt' })
      set({ simState: 'paused' })
    },

    setPace(factor) {
      set({ paceFactor: factor })
      simClient.send({ type: 'setPace', realtimeFactor: factor })
    },

    getProbeRingBuffer(probeId) {
      return ringBuffers.get(probeId) ?? null
    },

    dismissBenchRestartToast() {
      set({ benchRestartToast: null })
    },

    dismissConvergenceCard() {
      set({ convergenceCard: null })
    },

    minimizeFidelityBanner() {
      set({ fidelityMinimizedSig: fidelitySignature(fidelityBannerItems(get().resolutions)) })
    },

    markDeckDirty() {
      // Any deck-dirtying edit (setGround, setPinMap, override changes, …) can
      // shift the reference frame or topology the sensed rails were measured in,
      // so the op-measured rail cache + gated-off notes must not survive it.
      set({ deckDirty: true, measuredRails: null, railNotes: [] })
    },

    // ── crash recovery (Spec §6.1) ─────────────────────────────────────────────
    noteCrash(willRespawn) {
      set({ crashNotice: { willRespawn, at: Date.now() } })
    },

    replayAfterCrash() {
      const { circuit, resolutions, instruments, groundNetId, simState, paceFactor } = get()
      if (!circuit || groundNetId === null) return

      // Re-send the full deck. All instrument state (including live-altered supply
      // voltages) lives in the store, so the regenerated deck already reflects it
      // — nothing extra to re-apply (Spec §6.1).
      const deckLines = generateDeck({
        circuit,
        resolutions,
        instruments: wiredInstruments(instruments),
        groundNetId,
        title: get().project.boardFileName ?? undefined,
        modelTexts: buildDeckModelTexts(get()),
        railOverrides: get().railOverrideNetMap(),
        measuredRailVHigh: get().measuredRails ?? undefined,
      })
      simClient.send({ type: 'loadCircuit', deckLines })

      // Re-establish the run state on the fresh process.
      if (simState === 'running') {
        // Restart the bounded transient from t=0 (the circuit settles again from
        // initial conditions — acceptable per Spec §7.5; scope ring buffers keep
        // their history). Re-apply the pace so the fresh process honours it.
        resetRingBuffers(instruments)
        simClient.send({ type: 'setPace', realtimeFactor: paceFactor })
        simClient.send({
          type: 'runTransient',
          tstepSeconds: computeTstep(instruments),
          tstopSeconds: BENCH_WINDOW_SECONDS,
        })
        set({ vectorNames: [], simTimeSeconds: 0 })
      } else if (simState === 'op') {
        simClient.send({ type: 'runOp' })
      }
    },

    // ── Task 25: LLM-assist + user .lib import ───────────────────────────────

    async validateSubckt(subcktText, subcktName, nodeCount) {
      // Build a minimal test deck: the pasted subckt + one dummy instance +
      // enough dummy sources/ground so ngspice can parse it without error.
      // We don't care about simulation convergence — only that ngspice PARSES
      // the subckt definition without emitting a fatal error (loadCircuit).
      // We use nodeCount dummy nodes (n1, n2, ...) tied to ground via 1G resistors
      // so the deck has a DC path and won't hit the "no DC path to ground" trap.
      const dummyNodes = Array.from({ length: nodeCount }, (_, i) => `_tst${i + 1}`)
      const dummyNodeStr = dummyNodes.join(' ')
      const dummyRs = dummyNodes
        .map((n, i) => `r_chk_${i + 1} ${n} 0 1000meg`)
        .join('\n')

      const testDeck = [
        `* circsim subckt validation test for ${subcktName}`,
        subcktText.trim(),
        `x_test ${dummyNodeStr} ${subcktName}`,
        dummyRs,
        `v_test _tst1 0 dc 0`,
        `.op`,
        `.end`,
      ]

      // Collect log lines during the load to detect errors.
      const errorLines: string[] = []
      let errorDetected = false

      const unsub = simClient.onEvent(event => {
        if (event.type === 'log' && event.level === 'error') {
          errorLines.push(event.text)
          errorDetected = true
        }
      })

      try {
        simClient.send({ type: 'loadCircuit', deckLines: testDeck })
        // Give SimHost up to 8 seconds to respond with opResult or an error.
        // If it loads cleanly we get an opResult (even a failed .op produces
        // one; what matters is that ngspice accepted the deck structure).
        // A parse/load error produces log{level:'error'} lines.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 8000)
          const innerUnsub = simClient.onEvent(evt => {
            if (evt.type === 'opResult' || evt.type === 'convergenceFailure') {
              clearTimeout(timer)
              innerUnsub()
              resolve()
            }
          })
          // Also resolve immediately if we already detected a hard error
          // (some errors fire before opResult).
          if (errorDetected) {
            clearTimeout(timer)
            innerUnsub()
            resolve()
          }
        })
      } finally {
        unsub()
      }

      if (errorDetected) {
        return { ok: false, error: errorLines.join('\n') }
      }
      return { ok: true }
    },

    saveUserModel(ref, mpn, subcktText, subcktName, pinMap, provenance) {
      set(s => {
        const next = new Map(s.userModels)
        next.set(ref, { mpn, subcktText, subcktName, pinMap, provenance })
        return { userModels: next }
      })
      // Re-resolve: the new model will be picked up as a tier-4 entry.
      get().reResolve()
      get().markDeckDirty()
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
          // powerOn is the sole committer for its own ops — skip the interim
          // pass-1 (family-default) result it is about to correct in pass 2 (FIX 2).
          if (powerOnOpInFlight) break
          const { circuit, resolutions, instruments, groundNetId } = get()
          if (!circuit) break
          const opVoltages = mapOpResultToNetVoltages(event.values, circuit)
          const voltageRange = computeVoltageRange(opVoltages)
          const currentsByRef = applyOpCurrents(boardHooks, event.values, resolutions, circuit)
          // Coach: rebuild the plain-language dark-LED notes for this op too.
          const coachNotes = diagnoseDarkLeds(
            buildCoachInput(
              circuit,
              currentsByRef,
              opVoltages,
              hasSupplyAttached(instruments, groundNetId),
              resolutions,
            ),
          )
          // Honesty surface (F1): an op that converged only via a fallback rung
          // (or not at all) gets a persistent caveat banner — its voltages,
          // especially 0.000 V readings, may be unreliable. An absent `method`
          // (older SimHost) is treated as direct.
          const opCaveat =
            event.method && event.method !== 'direct'
              ? { method: event.method, at: Date.now() }
              : null
          // A fresh result also retires any staleness flag (M7 review fix).
          set({ opVoltages, opVoltagesStale: false, voltageRange, currentsByRef, coachNotes, opCaveat })
          // Keep the board in sync after a replayed/standalone op too.
          applyOpToBoard(boardHooks, opVoltages, voltageRange)
          // Re-audit with the fresh op result (ampacity/thermal get real data).
          get().runCriticAudit()
          break
        }
        case 'vectors':
          set({ vectorNames: event.names })
          break
        case 'samples': {
          // Feed each probed net's samples into its ring buffer (the scope reads
          // these), forward the raw batch to the scope emitter, drive the live
          // copper overlay off the LATEST sample per probed net (Spec §4 step 5),
          // and drive the live LED glow off the LATEST sense-ammeter sample (L1b).
          ingestSamples(event, get, set, boardHooks, ringBuffers)
          break
        }
        case 'benchRestarted':
          set({
            lastBenchRestart: { reason: event.reason, at: Date.now() },
            benchRestartToast: {
              reason: event.reason,
              sequentialLogicCaveat: hasDigitalParts(get().resolutions),
              at: Date.now(),
            },
          })
          break
        case 'convergenceFailure':
          set({
            simState: 'idle',
            convergenceCard: {
              plainLanguage:
                "The simulator couldn't find a stable solution for this circuit. " +
                'Common causes: a missing or wrong model, a floating node with no DC path ' +
                'to ground, or component values that are far apart in scale.',
              retryLadderNote:
                'circsim already retried with gmin-stepping and source-stepping before reporting this.',
              rawDetail: event.detail,
              // Name the culprit part/net when ngspice's abort text carries one
              // ("trouble with mpmos_gen-instance m_q7" → Q7) — F2. One abort
              // can emit several matching lines and only one of them names the
              // culprit; a later culprit-less line must not wipe an earlier
              // identification, so keep the previous card's culprit when this
              // event's text parses to nothing.
              culprit:
                parseConvergenceCulprit(event.detail, get().circuit) ??
                get().convergenceCard?.culprit ??
                null,
              at: Date.now(),
            },
          })
          break
        case 'status':
          set({
            achievedRealtimeFactor: event.realtimeFactor,
            simTimeSeconds: event.simTimeSeconds,
            // A `status{running:false}` while we believe we're running means the
            // engine self-halted (window end / pacing). Reflect it as paused, but
            // never override an explicit user pause/idle.
            simState: event.running
              ? 'running'
              : get().simState === 'running'
                ? 'paused'
                : get().simState,
          })
          break
        default:
          // acResult handled by the future AC/Bode panel (Spec §17).
          break
      }
    },
  }))

  // Wire the client's events into the store. The store owns this subscription so
  // a respawn (which calls attachPort on a PortSimClient) keeps delivering events.
  simClient.onEvent(event => store.getState().ingestEvent(event))

  return store
}

// ─── deck model-texts assembly ──────────────────────────────────────────────────

/**
 * Build the filename → contents map the deck generator inlines definitions from.
 * Merges the bundled model texts (loaded at boot via getModelLibrary) with the
 * in-memory user models, which the spicegen library entries reference under the
 * virtual path `__user_model__:<mpn>` (see reResolve). User entries win on key
 * collision (they are added last).
 */
export function buildDeckModelTexts(state: AppState): Record<string, string> {
  const texts: Record<string, string> = { ...state.modelTexts }
  for (const [, um] of state.userModels) {
    texts[`__user_model__:${um.mpn}`] = um.subcktText
  }
  return texts
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

/**
 * Map an op result's LED-ammeter branch currents onto part refs.
 *
 * Each LED is emitted with a 0 V series ammeter `vsense_<ref>` on its anode (the
 * diode's own `@d_<ref>[i]` vector carries no data on ngspice 46 — see
 * src/simhost/__tests__/diode-op-current.integration.test.ts), so the glow data
 * source is the ammeter's branch current. The op result normalizer (protocol.ts
 * normalizeVectorKey) turns `vsense_<ref>#branch` → `i(vsense_<ref>)`, so that is
 * the canonical key; we also accept the raw `#branch` form defensively.
 *
 * `ledSpiceNames` is the ref → ammeter-name map from the deck generator
 * (buildLedSpiceNames → ledSenseName); we reverse it. The ABS value is stored
 * (ledIntensity uses magnitude, and a 0 V source's branch current sign just
 * reflects which way the ammeter was wired).
 *
 * Returns ref → amps (magnitude). Refs whose current is absent are omitted.
 */
export function mapOpResultToCurrents(
  values: Record<string, number>,
  ledSpiceNames: Map<string, string>,
): Map<string, number> {
  const out = new Map<string, number>()
  // Normalised lookup of every value key (lowercased, whitespace-stripped).
  const lower = new Map<string, number>()
  for (const [k, v] of Object.entries(values)) lower.set(k.toLowerCase(), v)

  for (const [ref, senseName] of ledSpiceNames) {
    const dev = senseName.toLowerCase()
    // Accepted encodings of the LED ammeter's branch current.
    const candidates = [`i(${dev})`, `${dev}#branch`, `@${dev}[i]`, `i(@${dev})`]
    for (const c of candidates) {
      const v = lower.get(c)
      if (v !== undefined) {
        out.set(ref, Math.abs(v))
        break
      }
    }
  }
  return out
}

/**
 * The LED sense-ammeter name prefix ("vsense_") — derived from ledSenseName (the
 * single source of the spelling in spicegen/generate.ts) so the two can never drift.
 */
const LED_SENSE_PREFIX = ledSenseName('')

/**
 * Map a single vector name to the LED part ref whose sense-ammeter current it
 * carries, or null for anything else (node voltages, scale vectors, non-LED
 * source currents, …).
 *
 * GOTCHA (led-current.integration.test.ts): op results arrive with NORMALIZED
 * keys (`i(vsense_<ref>)`), but transient `samples` batches carry ngspice's RAW
 * vector names (`vsense_<ref>#branch`) — the streaming path never calls
 * normalizeVectorKey. This helper accepts both spellings, case-insensitively,
 * by normalizing first. Refs are returned UPPERCASE (ledSenseName lowercases
 * them into the device name), matching the refs mapOpResultToCurrents produces.
 *
 * Pure + allocation-light (runs per vector column per ~60 Hz batch); exported
 * for unit testing.
 */
export function mapVectorNameToLedRef(name: string): string | null {
  // Raw "<dev>#branch" (and "@<dev>[i]") fold to "i(<dev>)", lowercased; a bare
  // node name stays bare — so only genuine current vectors can match below.
  const key = normalizeVectorKey(name)
  if (!key.startsWith(`i(${LED_SENSE_PREFIX}`) || !key.endsWith(')')) return null
  const ref = key.slice(2 + LED_SENSE_PREFIX.length, -1)
  return ref.length > 0 ? ref.toUpperCase() : null
}

// ─── critic OpResult construction (Spec §7) ──────────────────────────────────────

/**
 * Build the Board Critic's OpResult from the live op state, or undefined when the
 * board isn't energized (no op voltages) so runCritic SKIPS ampacity/thermal.
 *
 * `nodeVoltages` is keyed by SPICE NODE NAME (the critic's IR/thermal math works
 * in spice-node space), translated from the store's netId→volts map via the
 * circuit's net.spiceNode. `partCurrents` (ref → amps) comes straight from
 * currentsByRef. `partPower` is left undefined — circsim does not yet harvest
 * per-part power, and the thermal check derives its own estimate without it.
 *
 * Exported for unit testing.
 */
export function buildCriticOpResult(
  circuit: Circuit,
  opVoltages: Map<number, number> | null,
  currentsByRef: Map<string, number>,
): OpResult | undefined {
  if (!opVoltages || opVoltages.size === 0) return undefined

  const netToNode = new Map<number, string>()
  for (const net of circuit.nets) netToNode.set(net.id, net.spiceNode)

  const nodeVoltages: Record<string, number> = {}
  for (const [netId, volts] of opVoltages) {
    const node = netToNode.get(netId)
    if (node !== undefined) nodeVoltages[node] = volts
  }

  const partCurrents: Record<string, number> = {}
  for (const [ref, amps] of currentsByRef) partCurrents[ref] = amps

  return {
    nodeVoltages,
    partCurrents: Object.keys(partCurrents).length > 0 ? partCurrents : undefined,
  }
}

// ─── coach input construction (First Light, L3) ──────────────────────────────────

/**
 * Anode/cathode pad numbers for an LED footprint. KiCad LED footprints number
 * pad 1 = anode (+), pad 2 = cathode (−) — the convention the bundled samples
 * (blinker-555, first-light) follow. Used to read each LED's anode/cathode net.
 */
// KiCad LED footprint convention (and the bundled library's LED_* pinMap
// {"1":"2","2":"1"}): pad 1 is the CATHODE, pad 2 the anode. Used only as the
// fallback when a part has no resolved pinMap — the pinMap is the deck truth.
const LED_ANODE_PAD = '2'
const LED_CATHODE_PAD = '1'

/**
 * Build the pure `DiagnoseInput` the coach reasons over, from the live circuit +
 * latest op state. For every LED part (isLedPart) we read its anode/cathode
 * nets via the part's RESOLVED pinMap (pad → SPICE node position; a diode's
 * position 1 is the anode, 2 the cathode) — the same mapping generateDeck
 * orders the device nodes by, so the coach's polarity verdict always matches
 * what was actually simulated. Parts without a resolved pinMap fall back to
 * the KiCad convention (pad 1 = cathode). LEDs whose anode/cathode net can't
 * be determined are skipped (the coach can't reason about them). `hasSupply`
 * is true when a ground
 * net is designated AND at least one driving source is attached — the same
 * "can this board be energized?" test powerOn/energize use.
 *
 * `resolutions` (optional) is threaded through to isLedPart so the LED test sees
 * the resolved subckt/model-card NAME — exactly as buildLedSpiceNames does (which
 * drives the glow). Passing it keeps the coach's LED set identical to the glow
 * set: an LED resolved only by its model name (value/libId silent) is recognised
 * by both, never one but not the other.
 *
 * Pure + deterministic (LEDs in circuit-part order); exported for unit testing.
 */
export function buildCoachInput(
  circuit: Circuit | null,
  currentsByRef: Map<string, number>,
  netVoltages: Map<number, number> | null,
  hasSupply: boolean,
  resolutions?: Resolution[],
): DiagnoseInput {
  // ref → resolved subckt name (when the part resolved to a subckt/model-card),
  // mirroring buildLedSpiceNames so isLedPart sees the same evidence — plus the
  // resolved pinMap, which decides which pad is the anode (see doc above).
  const subcktNameByRef = new Map<string, string>()
  const pinMapByRef = new Map<string, PinMap>()
  for (const res of resolutions ?? []) {
    if (res.model && res.model.kind === 'subckt') {
      subcktNameByRef.set(res.ref, res.model.subcktName)
      pinMapByRef.set(res.ref, res.model.pinMap)
    }
  }

  const leds: CoachLed[] = []
  if (circuit) {
    for (const part of circuit.parts) {
      if (
        !isLedPart({
          ref: part.ref,
          value: part.value,
          libId: part.libId,
          subcktName: subcktNameByRef.get(part.ref),
        })
      )
        continue
      // Pad roles from the resolved pinMap (SPICE diode: position 1 = anode,
      // 2 = cathode) when present; KiCad-convention fallback otherwise.
      let anodePad = LED_ANODE_PAD
      let cathodePad = LED_CATHODE_PAD
      const pinMap = pinMapByRef.get(part.ref)
      if (pinMap) {
        for (const [pad, pos] of Object.entries(pinMap)) {
          if (pos === '1') anodePad = pad
          else if (pos === '2') cathodePad = pad
        }
      }
      const anodeNet = part.padNet.get(anodePad)
      const cathodeNet = part.padNet.get(cathodePad)
      if (anodeNet === undefined || cathodeNet === undefined) continue
      leds.push({ ref: part.ref, anodeNet, cathodeNet })
    }
  }
  return {
    leds,
    currentsByRef,
    netVoltages: netVoltages ?? undefined,
    hasSupply,
  }
}

/**
 * True when this board can be energized: a ground net is designated AND at least
 * one driving source (dc-supply / function-gen / logic-input) is attached. This
 * is the shared "hasSupply" predicate for both the coach input and energize().
 */
export function hasSupplyAttached(
  instruments: Instrument[],
  groundNetId: number | null,
): boolean {
  if (groundNetId === null) return false
  return instruments.some(
    i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
  )
}

/**
 * Pick the net energize() should drop its auto-supply on. Prefers a heuristic
 * supply rail (suggestSupplies — VCC / +5V / VIN / …) that isn't the ground net;
 * when none is named like a rail, falls back to the most-connected non-ground net
 * so a board with an unconventional rail name still lights up. The fallback
 * EXCLUDES any net wired directly to an LED pad (anode/cathode) so it can never
 * drop the supply on the node between a current limiter and an LED (which would
 * put the full supply across the LED, bypassing the limiter). Returns undefined
 * only when there is no usable non-ground net.
 *
 * Pure + deterministic (ties broken by lowest net id); exported for tests.
 */
export function chooseEnergizeSupplyNet(
  circuit: Circuit,
  groundNetId: number,
): number | undefined {
  // 1) A net that *looks* like a supply rail wins.
  const named = suggestSupplies(circuit.nets).map(s => s.id).find(id => id !== groundNetId)
  if (named !== undefined) return named

  // Nets wired straight to an LED pad are unsafe fallback targets — driving them
  // directly bypasses any series limiter. Collect them so the degree-based
  // fallback skips them.
  const ledNets = new Set<number>()
  for (const part of circuit.parts) {
    if (!isLedPart({ ref: part.ref, value: part.value, libId: part.libId })) continue
    for (const netId of part.padNet.values()) ledNets.add(netId)
  }

  // 2) Fallback: the non-ground, non-LED net touched by the most pads (a rail
  //    typically fans out to several parts), ties broken by lowest id.
  let best: { id: number; degree: number } | undefined
  for (const net of circuit.nets) {
    if (net.id === groundNetId) continue
    if (ledNets.has(net.id)) continue
    const degree = net.padRefs.length
    if (degree === 0) continue
    if (
      best === undefined ||
      degree > best.degree ||
      (degree === best.degree && net.id < best.id)
    ) {
      best = { id: net.id, degree }
    }
  }
  return best?.id
}

/**
 * Shallow structural equality for an instrument list — used by the energized
 * re-op coalescer's no-op guard so it never loops on an unchanged instrument set.
 * Compares each instrument's own enumerable scalar fields (the instrument shapes
 * are flat records of primitives), in order.
 */
export function sameInstruments(a: Instrument[], b: Instrument[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ia = a[i] as Record<string, unknown>
    const ib = b[i] as Record<string, unknown>
    const keys = new Set([...Object.keys(ia), ...Object.keys(ib)])
    for (const k of keys) {
      if (ia[k] !== ib[k]) return false
    }
  }
  return true
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

// ─── board-hook drivers (Task 24) ────────────────────────────────────────────────

/**
 * Push an op result onto the 3D board: floating net-voltage labels
 * (`showOpAnnotations`) + per-net copper tint (`applyNetVoltages`). No-op when no
 * board hooks are wired (headless tests, viewer before mount).
 */
function applyOpToBoard(
  hooks: BoardHooks | null,
  voltages: Map<number, number>,
  range: { min: number; max: number } | null,
): void {
  if (!hooks) return
  hooks.showOpAnnotations(voltages)
  if (range) hooks.applyNetVoltages(voltages, range.min, range.max)
}

/**
 * Compute LED device currents from an op result and push them onto the board
 * (additive over voltage tint/annotations). Returns the ref → amps map so the
 * caller can also store it in state. No-op-safe when no LEDs / no hooks.
 */
function applyOpCurrents(
  hooks: BoardHooks | null,
  values: Record<string, number>,
  resolutions: Resolution[],
  circuit: Circuit,
): Map<string, number> {
  const ledSpiceNames = buildLedSpiceNames(resolutions, circuit)
  const currentsByRef = mapOpResultToCurrents(values, ledSpiceNames)
  hooks?.applyLedCurrents?.(currentsByRef)
  return currentsByRef
}

/**
 * Ingest a `samples` batch:
 *   1. route each vector's column into its probe ring buffer (the scope reads these),
 *   2. forward the raw batch to the scope emitter (decoupled, no React churn),
 *   3. drive the live copper overlay from the LATEST sample per probed net,
 *      keeping un-probed nets on their op tint,
 *   4. drive the live LED glow from the LATEST sample of each LED sense-ammeter
 *      column — the SAME path the op result uses (currentsByRef +
 *      applyLedCurrents/publishLedGlow), so the LED blinks in step with the
 *      transient (L1b).
 *
 * NOTE — the glow data source is the 0 V series ammeter `vsense_<ref>` the deck
 * generator splices in front of every LED (ledSenseName): a diode's own `@dev[i]`
 * current does NOT stream over the transient SendData channel (proven in
 * led-current.integration.test.ts: saving it makes ngspice skip the whole run —
 * zero samples), but the ammeter's `<src>#branch` current streams cleanly.
 * GOTCHA: unlike op results, transient vector names are NOT normalized — the
 * batch carries the RAW ngspice name ("vsense_d1#branch", never "i(vsense_d1)")
 * — so the mapping (mapVectorNameToLedRef) accepts both spellings. Runs per
 * batch (~60 Hz): the currentsByRef copy is made lazily, only when the batch
 * actually carries a sense column.
 *
 * Exported for unit testing of the sample → ring-buffer → overlay/glow path.
 */
export function ingestSamples(
  event: Extract<SimEvent, { type: 'samples' }>,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  hooks: BoardHooks | null,
  ringBuffers: Map<string, RingBuffer>,
): void {
  const state = get()
  const circuit = state.circuit
  if (!circuit) return

  // spiceNode → netId, and netId → voltage-probe(s).
  const nodeToNet = new Map<string, number>()
  for (const net of circuit.nets) nodeToNet.set(net.spiceNode, net.id)

  const probesByNet = new Map<number, { id: string }[]>()
  for (const inst of state.instruments) {
    if (inst.kind !== 'voltage-probe') continue
    const list = probesByNet.get(inst.netId) ?? []
    list.push(inst)
    probesByNet.set(inst.netId, list)
  }

  // Start from the op tint so un-probed nets keep their op voltage, then overlay
  // the latest probed-net samples on top.
  const liveVoltages = new Map<number, number>(state.opVoltages ?? [])

  // Live LED currents, lazily copied from the current map so LEDs absent from
  // this batch keep their last-known current. Stays null when the batch carries
  // no sense column — the common no-LED case pays nothing and the glow path
  // (store + scene) is left completely untouched.
  let ledCurrents: Map<string, number> | null = null

  for (let ci = 0; ci < event.vectorNames.length; ci++) {
    const vecName = event.vectorNames[ci]
    const column = event.columns[ci]
    if (!column) continue

    // LED sense-ammeter column? (RAW transient name, e.g. "vsense_d1#branch" —
    // see the docstring gotcha.) Newest timepoint wins; magnitude, matching
    // mapOpResultToCurrents (a 0 V source's sign just reflects its wiring).
    const ledRef = mapVectorNameToLedRef(vecName)
    if (ledRef !== null) {
      if (column.length > 0) {
        ledCurrents ??= new Map(state.currentsByRef)
        ledCurrents.set(ledRef, Math.abs(column[column.length - 1]))
      }
      continue // a branch current is never a node voltage
    }

    const netId = nodeToNet.get(vecName) ?? nodeToNet.get(vecName.toLowerCase())
    if (netId === undefined) continue

    // Feed every probe on this net.
    const probes = probesByNet.get(netId)
    if (probes) {
      for (const probe of probes) {
        const ring = ringBuffers.get(probe.id)
        if (ring) feedSamples(ring, event.simTime, column)
      }
    }

    // Latest value for the live overlay.
    if (column.length > 0) {
      liveVoltages.set(netId, column[column.length - 1])
    }
  }

  // Forward the raw batch to the scope (module-level emitter; see Scope.tsx).
  scopeSamplesEmitter.dispatchEvent(new CustomEvent('samples', { detail: event }))

  // Live copper tint off the latest samples.
  if (hooks && liveVoltages.size > 0) {
    const range = computeVoltageRange(liveVoltages)
    if (range) hooks.applyNetVoltages(liveVoltages, range.min, range.max)
  }

  // Live LED glow off the newest sense-ammeter samples — the same store field +
  // scene hook the op result drives (applyLedCurrents → publishLedGlow), so the
  // op path, the E2E snapshot, and the live bench can never disagree (L1b).
  if (ledCurrents) {
    set({ currentsByRef: ledCurrents })
    hooks?.applyLedCurrents?.(ledCurrents)
  }
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
