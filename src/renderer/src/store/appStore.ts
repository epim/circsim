/**
 * renderer/store/appStore.ts — Task 21
 *
 * The single zustand store for the renderer. Holds project / circuit /
 * resolutions / instruments / simState / probes, and the orchestration actions
 * that connect the pure domain pipeline (parse → extract → resolve → spicegen)
 * to the SimHost via an INJECTED `SimClient`. Deck assembly and the two-pass
 * operating-point solve live in src/core/solve; the store snapshots its bench
 * state into that seam and commits what comes back.
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

import { parseSchematicSimData, type SchematicSimData } from '../../../core/kicad/schematic'
import { extract, suggestGround, suggestSupplies, type Circuit } from '../../../core/netlist/extract'
import {
  ngspiceLogDiagnostic,
  applyDeckDiagnostics,
  resolutionNoteLines,
  type UserStubOverride,
  type BomData,
} from '../../../core/models/resolve'
import type { LibraryEntry, PinMap, Resolution } from '../../../core/models/types'
import {
  alterPlan,
  buildLedSpiceNames,
  isLedPart,
  ledSenseName,
} from '../../../core/spicegen/generate'
import {
  buildDeck,
  buildSolveInputs,
  createSimClientEngine,
  mapOpResultToNetVoltages,
  railOverridesByNetId,
  runSolvePlan,
  SolveFailedError,
  type SolveInputs,
  type SolveResult,
  type UndrivenNet,
} from '../../../core/solve'
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
import { parseBom, describeBomImport, type BomParseResult } from '../../../core/bom/parseBom'
import type { BoardModel } from '../../../core/kicad/types'
import { primeStaticOutputs, runCritic } from '../../../core/critic/run'
import { buildSupplyEntries } from '../../../core/critic/supplyEntries'
import type { CriticReport, Finding, OpResult, SupplyEntry } from '../../../core/critic/types'
import {
  buildEffectiveLibrary,
  openBoardPipeline,
  resolveWithOverrides,
  type OpenedBoard,
  type OpenOutcome,
  type OpenRequest,
  type OpenStage,
} from '../boardOpen/pipeline'
import { createInlineRunner, type BoardOpenRunner } from '../boardOpen/runner'
import { deriveSolvedCurrents, type SolvedCurrents } from '../../../core/critic/solvedCurrents'
import type { CopperOp } from '../../../core/copper'
import { copperResult } from '../../../core/solve/copperResult'
import { padVoltageRange } from '../viewport/padVoltage'
import { withCopperFindings } from './copperFindings'

import {
  autosaveAllowed,
  buildSidecar,
  GROUND_LEAD_KEY,
  leadKey,
  overwriteIsSafe,
  serializeSidecar,
  type LeadPosition,
  type LoadOutcome,
  type SidecarStatus,
  type UserModelRecord,
} from '../../../core/persist/sidecar'
import { sidecarPathFor, baseName } from '../../../core/persist/paths'
import { sha256Hex } from '../../../core/persist/hash'

import type { SimClient } from '../ipc/simClient'
import { splitPath, type ReadFileFn } from '../ipc/fileOpen'
import {
  BENCH_TSTEP_MAX_SECONDS,
  normalizeVectorKey,
  type OpSolveMethod,
  type SimCommand,
  type SimEvent,
} from '../../../simhost/protocol'
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
  const unreliable = 'Voltages may be unreliable, especially 0.000 V readings.'
  switch (method) {
    case 'gmin':
      return `The steady-state voltages (operating point) were found with a fallback: a gentler solve (gmin stepping), because the direct solve did not settle. ${unreliable}`
    case 'source':
      return `The steady-state voltages (operating point) were found with a fallback: a ramped solve (source stepping), after the gentler solve (gmin stepping) failed. ${unreliable}`
    case 'tran-fallback':
      return `The steady-state voltages (operating point) were found with a last-resort fallback (transient-op, a short live run), after the gentler and ramped solves both failed. ${unreliable}`
    case 'failed':
      return (
        'The steady-state solve (operating point) did not converge at all: the displayed voltages ' +
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

/**
 * Keep the allocator ahead of ids that came from a restored sidecar, so a
 * shelf-added instrument can never reuse a restored instrument's id.
 */
function reserveBenchIds(instruments: Instrument[]): void {
  for (const inst of instruments) {
    if (!('id' in inst)) continue
    const m = /_bench_(\d+)$/.exec(inst.id)
    if (m) _benchIdCounter = Math.max(_benchIdCounter, Number(m[1]))
  }
}

/** A copy of the lead-position map without any lead of instrument `instId`. */
function dropLeadPositionsOf(map: Map<string, LeadPosition>, instId: string): Map<string, LeadPosition> {
  const prefix = `${instId}:`
  let any = false
  for (const k of map.keys()) if (k.startsWith(prefix)) any = true
  if (!any) return map
  const next = new Map<string, LeadPosition>()
  for (const [k, v] of map) if (!k.startsWith(prefix)) next.set(k, v)
  return next
}

// ─── transient analysis defaults (Spec §7.5) ─────────────────────────────────────

/** Default bench window in sim-seconds (Spec §7.5). NEVER unbounded. */
export const BENCH_WINDOW_SECONDS = 30

/**
 * Coarsest transient time-step (issue #25): what a bench with no fast source
 * runs at. It was a 10 µs cap on every bench, which alone held the live bench
 * under real time; ngspice refines below the step by itself wherever the
 * circuit demands it (a PULSE edge, a switching node), and the scope decimates
 * to pixel columns anyway, so a bench with nothing fast on it needs no finer
 * step.
 */
export const MAX_TSTEP_SECONDS = BENCH_TSTEP_MAX_SECONDS

/**
 * Compute the transient time-step from the signal bandwidth on the bench: the
 * fastest function-gen sets it at 200 points per cycle,
 *   tstep = min( 1 / (200 · fmax), 100 µs )
 * and with no function-gen (nothing periodic to resolve) it is the 100 µs
 * ceiling (Spec §7.5, Task 24, issue #25).
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
  /** Replace physical pad tint and labels; null clears the previous physical op. */
  applyPadVoltages?(copper: CopperOp | null, range: { min: number; max: number } | null): void
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

/** Why a start attempt was blocked (Spec §12 guided empty-states). */
export type GuidedBlock = 'no-ground' | 'no-source'

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

/**
 * State of the per-board setup file (`<board>.circsim.json`, issue #27).
 *
 * Restore is automatic whenever the file exists. Writing is opt-in per board:
 * with no file on disk nothing is written until the user asks (enableAutosave),
 * so circsim never drops a file beside a version-controlled KiCad project
 * unasked. Once the file exists (or the user opted in) every change to the setup
 * is saved, debounced, by the sync module (store/sidecarSync.ts).
 */
export interface SidecarState {
  /** Where the setup file lives; null when nothing can be persisted (no board path). */
  path: string | null
  /** What was on disk when the board opened. null before any board has opened. */
  diskStatus: SidecarStatus | 'absent' | null
  /** True once changes are being saved to `path`. */
  autosave: boolean
  /** The next write must first copy the existing file to `<file>.bak`. */
  backupFirst: boolean
  /** Visible "restored N settings" note (also carries what was skipped). Dismissable. */
  note: { restored: number; messages: string[]; status: SidecarStatus; fileName: string } | null
  lastSavedAt: number | null
  /** Last write failure, plain language. null when the last write succeeded. */
  error: string | null
}

export const INITIAL_SIDECAR_STATE: SidecarState = {
  path: null,
  diskStatus: null,
  autosave: false,
  backupFirst: false,
  note: null,
  lastSavedAt: null,
  error: null,
}

export type { LeadPosition }

export interface AppState {
  // ── project / source files ─────────────────────────────────────────────────
  project: {
    boardFileName: string | null
    boardText: string | null
    schematicFileName: string | null
    /** Absolute path of the open board; null for bundled samples and raw-text opens. */
    boardPath: string | null
    /**
     * sha256 of boardText. Null means "not hashed yet" (or no board), never
     * "unknown for good": Web Crypto is async, so openBoardFromText returns
     * before the hash lands. openBoard resolves only after it has landed, and
     * awaitBoardHash waits for it after either open. Consumers that can run
     * right after an open (setup-file write, diagnostics, report) treat null as
     * pending: they omit the hash or say "not computed", and must not treat it
     * as a final answer.
     */
    boardSha256: string | null
  }

  // ── per-board setup file (issue #27) ─────────────────────────────────────────
  sidecar: SidecarState
  /**
   * Where each bench lead was clipped on the board, in KiCad board millimetres,
   * keyed `${instrumentId}:${terminal}` (the JackDef key; the ground lead is
   * `ground:gnd`). Set when a lead is dropped on the board, cleared when it is
   * detached. Persisted in the setup file; the Board Critic lane reads it to find
   * the pad a supply actually enters through.
   */
  leadPositions: Map<string, LeadPosition>

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
   * Tier 2 of the digital rail precedence, resolved to the netId→volts map the
   * deck consumes by buildSolveInputs (src/core/solve). Set/cleared by the user
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
  /**
   * Why the last Energize / Power On / Run attempt could not proceed (Spec §12
   * guided empty-state): 'no-ground' (no ground net designated) or 'no-source'
   * (no wired source). The UI mounts NoGroundState / NoSourceState from this so
   * a blocked click is never silent. Cleared on a successful start, on dismiss,
   * and when a board is opened.
   */
  guidedBlock: GuidedBlock | null

  // ── sim state ────────────────────────────────────────────────────────────────
  simState: SimRunState
  /** Bench fidelity selection. The critic always solves physical copper. */
  copperAware: boolean
  copperOp: CopperOp | null
  criticOp: OpResult | null
  criticPending: boolean
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
   * Branch currents of every part from the latest op solve (LEDs, resistors and
   * bench sources measured, other parts by KCL at the nets), for the Board
   * Critic's ampacity and IR-drop checks (issues #9 and #45). Unlike
   * currentsByRef it is not LED-only. null before the first solve. Reset on
   * board change.
   */
  criticCurrents: SolvedCurrents | null
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
  /**
   * Nets the latest powerOn deck held at 0 V through a bleed resistor because
   * nothing on the board drives them (issue #43). Their 0 V readings are not
   * measurements; WarningsBar lists them. Empty when every net has a path to
   * ground or a driver.
   */
  undrivenNets: UndrivenNet[]
  ngspiceVersion: string | null
  /** Real-time pacing factor (0.1× / 1× / 'max'). */
  paceFactor: number | 'max'
  /** Achieved real-time factor from the latest `status` event (UI readout). */
  achievedRealtimeFactor: number | null
  /** Current sim-time (seconds) from the latest `status` event. */
  simTimeSeconds: number
  /** Vector names from the latest run (`vectors` event) — drives sample routing. */
  vectorNames: string[]

  /**
   * Set while a board is opening (openBoard): which file, and which stage the
   * pipeline is in. null when idle. 'auditing' means the board is already on
   * screen and only the Board Critic is still running.
   */
  openProgress: { fileName: string; stage: OpenStage } | null

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
   * reResolve). Persisted in the per-board setup file (see SidecarState).
   */
  userModels: Map<string /* ref */, UserModelRecord>

  // ── log stream ────────────────────────────────────────────────────────────────
  logLines: { level: 'info' | 'warn' | 'error'; text: string }[]
  lastBenchRestart: { reason: 'window-elapsed' | 'memory'; at: number } | null
  crashNotice: {
    willRespawn: boolean
    at: number
    /** The SimHost child's exit code, when main reported one (issue #26). */
    exitCode?: number | null
    /** 'watchdog' (exit 86, a stuck solve) or 'crashed'; absent when unknown. */
    reason?: 'watchdog' | 'crashed'
    /** A paused run could not be recovered by the respawn (master #16). */
    pausedRunLost?: boolean
  } | null
  /**
   * The last operating-point solve, kept for the diagnostics bundle (issue #26):
   * both decks, whether pass 2 ran, and the committed op. Cleared on board open.
   * A failed pass 1 (timeout, convergence failure) is recorded too, with
   * status 'pass1-failed': the deck that was sent, no pass 2, no op.
   */
  lastSolve: {
    status: 'solved' | 'pass1-failed'
    pass1Deck: string[]
    pass2Deck: string[] | null
    pass2: SolveResult['pass2'] | null
    opValues: Record<string, number>
    opMethod: OpSolveMethod | null
    at: number
  } | null
  /** The deck the last transient run or crash replay loaded (diagnostics). */
  lastRunDeck: string[] | null

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
  /**
   * Parse + extract + resolve + audit a board from raw .kicad_pcb text, all on
   * the calling thread, and return when it is done. Kept for headless callers
   * and tests; the app opens boards with openBoard so a large one cannot freeze
   * the window.
   */
  openBoardFromText(boardText: string, fileName: string, opts?: OpenOpts): void
  /**
   * Open a board through the store's BoardOpenRunner (a Worker in the app):
   * parse, extract, resolve and the Board Critic audit run off the UI thread
   * with `openProgress` set, the board appears as soon as it is resolved, and
   * the audit lands after. A newer open supersedes this one. Resolves when the
   * run is over (audit applied, parse error shown, or superseded).
   */
  openBoard(boardText: string, fileName: string, opts?: OpenOpts): Promise<void>
  /**
   * Resolve with the sha256 of the open board once it has been computed (it is
   * also in project.boardSha256 by then); null when no board is open or Web
   * Crypto is unavailable. Resolves at once when the hash already landed. For
   * callers that open synchronously and need the hash (issue #144).
   */
  awaitBoardHash(): Promise<string | null>
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
  /** Resolve the kicadName-keyed railOverrides to the netId→volts map the deck consumes. */
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
  /**
   * Wire one terminal to a net/component (lead drop). Ground routes to setGround.
   * `position` is where the clip landed on the board (KiCad mm); it is recorded in
   * leadPositions, and a rewire without one clears any stale position.
   */
  assignTerminal(instId: string, terminal: Terminal, target: AttachTarget, position?: LeadPosition): void
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
  setCopperAware(enabled: boolean): Promise<void>

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
  /** Dismiss the guided no-ground / no-source card (see `guidedBlock`). */
  dismissGuidedBlock(): void

  /** Dismiss the convergence-failure card. */
  dismissConvergenceCard(): void

  /** Minimize the fidelity banner to the header badge (Gemini finding 4). */
  minimizeFidelityBanner(): void

  // ── per-board setup file (issue #27) ──────────────────────────────────────────
  /**
   * The setup file text for the current bench (ground, instruments with leads and
   * lead positions, stub / pin-map / rail overrides, user models), or null with
   * no board open. Pure read; the sync module decides when to write it.
   */
  buildSidecarText(): string | null
  /**
   * The user chose to save the setup beside this board: turn autosave on. The
   * sync module writes immediately. No-op when the board has no path.
   */
  enableAutosave(): void
  /** Dismiss the "restored N settings" note. */
  dismissSidecarNote(): void

  /** Mark deck dirty (any deck-affecting change). */
  markDeckDirty(): void

  // crash recovery (Spec §6.1)
  /** Replay deck + instrument state onto a fresh client (after respawn). */
  replayAfterCrash(): void
  /** Record a crash notice (from window.circsim.onSimhostCrashed). */
  noteCrash(
    willRespawn: boolean,
    detail?: { exitCode: number | null; reason: 'watchdog' | 'crashed' },
  ): void

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
  /**
   * Absolute path of the board being opened. Enables the per-board setup file
   * (restore + save). Omit for bundled samples and raw-text opens: with no path
   * there is no file to save beside.
   */
  boardPath?: string
  /** Text of `<board>.circsim.json` when it exists. Absent or null: no setup file. */
  sidecarText?: string | null
  /** The setup file exists but could not be read (I/O error); the open proceeds without it. */
  sidecarError?: string | null
}

// ─── store factory (injectable simClient for tests) ─────────────────────────────

export interface CreateAppStoreOptions {
  simClient: SimClient
  /** Resolves after a fresh engine is attached and ready. Required to recover a critic fallback safely. */
  restartSimhost?: () => Promise<void>
  /** Bundled library entries (tier-3). Optional; defaults to none. */
  library?: LibraryEntry[]
  /** Bundled model-library texts (filename → contents). Optional; defaults to none. */
  modelTexts?: Record<string, string>
  /**
   * Runs the board-open pipeline for openBoard. The app passes a Worker-backed
   * runner (createRendererStore); the default runs inline, which is what tests
   * and a Worker-less environment get.
   */
  openRunner?: BoardOpenRunner
}

export type AppStore = StoreApi<AppState>

export function createAppStore(options: CreateAppStoreOptions): AppStore {
  const { simClient } = options
  const openRunner = options.openRunner ?? createInlineRunner()
  /** The solve seam's engine over this store's SimHost client (src/core/solve). */
  const solveEngine = createSimClientEngine(simClient)

  // ── non-reactive closure state ───────────────────────────────────────────────
  // Board hooks (viewport seam) + per-probe ring buffers live OUTSIDE the reactive
  // store: they are imperative sinks (the scene + the scope), not render inputs.
  let boardHooks: BoardHooks | null = null
  const ringBuffers = new Map<string /* probe id */, RingBuffer>()

  /** Previous ngspice log line: the "could not find a valid modelname" message does not name its card; the line before it does. */
  let previousLogText: string | undefined

  /**
   * Put load-time notes on the sim log, after resolution (issues #4, #5): a BOM's
   * parse errors and unmatched rows (warn) and what it changed on each part
   * (info); with `polarity`, each resolved diode whose polarity is a footprint
   * guess (warn). A part that resolved has no Model Doctor card, so the log is
   * where its notes are read.
   */
  function logLoadNotes(bomParsed: BomParseResult | null, polarity: boolean): void {
    const { circuit, resolutions } = store.getState()
    const lines: AppState['logLines'] = []
    if (bomParsed) {
      const refs = (circuit?.parts ?? []).map(p => p.ref)
      for (const text of describeBomImport(bomParsed, refs)) lines.push({ level: 'warn', text })
      for (const text of resolutionNoteLines(resolutions, 'bom')) lines.push({ level: 'info', text })
    }
    if (polarity) {
      for (const text of resolutionNoteLines(resolutions, 'polarity')) lines.push({ level: 'warn', text })
    }
    if (lines.length === 0) return
    store.setState(s => ({ logLines: [...s.logLines, ...lines].slice(-2000) }))
  }

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
  let criticSolveInFlight = false
  let primaryLoadFailed = false
  let criticLoadFailed = false
  let engineNeedsRestart = false
  let pendingCriticRefresh: (() => Promise<void>) | null = null
  let engineIdleResolvers: Array<() => void> = []
  let runQueuedAfterCritic = false

  async function awaitEngineIdle(): Promise<void> {
    while (powerOnOpInFlight) await new Promise<void>(resolve => engineIdleResolvers.push(resolve))
  }

  function releasePowerOnEngine(): void {
    powerOnOpInFlight = false
    const resolvers = engineIdleResolvers
    engineIdleResolvers = []
    for (const resolve of resolvers) resolve()
  }
  /**
   * True while validateSubckt's probe deck owns the engine. Same idea as
   * powerOnOpInFlight: the probe's opResult / convergenceFailure describe a
   * dummy circuit and must not reach the board readouts or the convergence card.
   */
  let subcktProbeInFlight = false
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
        if (powerOnOpInFlight) await awaitEngineIdle()
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
      // Knob steps await only their bench ops. Refresh the physical critic once
      // for the final snapshot, after the burst, using the same serialized engine.
      const refresh = pendingCriticRefresh
      pendingCriticRefresh = null
      if (refresh) {
        powerOnOpInFlight = true
        try { await refresh() } finally { releasePowerOnEngine() }
      }
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

  /**
   * The vectors the scope needs as full series: one per fully-wired voltage
   * probe, by SPICE node name. Every other net is only tinted from the display
   * rate snapshot SimHost sends in `samples.latest` (issue #25).
   */
  function watchedNodes(): string[] {
    const { circuit, instruments } = store.getState()
    if (!circuit) return []
    const nodes = new Set<string>()
    for (const inst of instruments) {
      if (inst.kind !== 'voltage-probe' || !isFullyWired(inst)) continue
      const net = circuit.nets.find(n => n.id === inst.netId)
      if (net) nodes.add(net.spiceNode)
    }
    return [...nodes]
  }

  function sendWatch(): void {
    simClient.send({ type: 'watch', vectors: watchedNodes() })
  }

  /**
   * Snapshot the current bench as SolveInputs: the ONE place this store gathers
   * deck inputs (powerOn, run and replayAfterCrash all load a deck built from
   * it). null when there is no circuit or no ground to solve against.
   */
  function currentSolveInputs(copperAware = store.getState().copperAware): SolveInputs | null {
    const s = store.getState()
    if (!s.circuit || s.groundNetId === null) return null
    return buildSolveInputs(s.board, s.circuit, s.resolutions, s.instruments, s.groundNetId, {
      title: s.project.boardFileName ?? undefined,
      modelTexts: s.modelTexts,
      userModels: s.userModels.values(),
      railOverrides: s.railOverrides,
      measuredRails: s.measuredRails,
      copperAware,
      copperOptions: { supplyEntries: buildSupplyEntries(s.instruments, s.leadPositions, s.groundNetId) },
    })
  }

  // ── board open (issue #55) ────────────────────────────────────────────────────
  /** Bumped by every open; a run whose token no longer matches is superseded. */
  let openToken = 0
  /** Bumped by every runCriticAudit; lets an in-flight open audit see it was overtaken. */
  let auditEpoch = 0

  /** Start a new open: cancel whatever is running and return this open's token. */
  function supersedeOpen(): number {
    openRunner.cancel()
    return ++openToken
  }

  function openRequest(boardText: string, opts: OpenOpts | undefined): OpenRequest {
    const s = store.getState()
    return {
      boardText,
      schematicText: opts?.schematicText,
      schematicFileName: opts?.schematicFileName,
      bomText: opts?.bomText,
      // Restored in the pipeline (it can name the ground and the overrides the
      // resolution must see). A setup file that could not be read never reaches it.
      sidecarText:
        opts?.boardPath && !opts.sidecarError && typeof opts.sidecarText === 'string'
          ? opts.sidecarText
          : undefined,
      library: buildEffectiveLibrary(s.userModels.values(), s.library),
    }
  }

  /** Drop everything that depends on the previous project. */
  function resetForOpen(): void {
    ringBuffers.clear()
    store.setState({
      openProgress: null,
      parseError: null,
      viewerOnly: false,
      opVoltages: null,
      copperOp: null,
      criticOp: null,
      criticPending: false,
      opVoltagesStale: false,
      voltageRange: null,
      currentsByRef: new Map(),
      criticCurrents: null,
      coachNotes: [],
      measuredRails: null,
      railNotes: [],
      undrivenNets: [],
      instruments: [],
      selectedInstrumentId: null,
      autoAttachedSupplyId: null,
      guidedBlock: null,
      stubOverrides: new Map(),
      pinMapOverrides: new Map(),
      railOverrides: new Map(),
      leadPositions: new Map(),
      // Stop saving the previous board's setup before anything else changes.
      sidecar: INITIAL_SIDECAR_STATE,
      simState: 'idle',
      deckDirty: false,
      selectedRef: null,
      selectedNetId: null,
      revealDoctorRequest: null,
      criticReport: null,
      selectedFindingId: null,
      logLines: [],
      lastSolve: null,
      lastRunDeck: null,
      benchRestartToast: null,
      convergenceCard: null,
      opCaveat: null,
      fidelityMinimizedSig: null,
      vectorNames: [],
      simTimeSeconds: 0,
      achievedRealtimeFactor: null,
    })
  }

  /**
   * Commit a pipeline outcome. Returns false (after recording the parse error)
   * when the board did not parse.
   */
  /** The in-flight (or finished) hash of the current board; null when there is none. */
  let boardHashJob: Promise<string | null> | null = null

  function applyOpenOutcome(
    outcome: OpenOutcome,
    boardText: string,
    fileName: string,
    opts: OpenOpts | undefined,
  ): boolean {
    if (!outcome.ok) {
      const e = outcome.error
      boardHashJob = null
      store.setState({
        parseError: { message: e.message, line: e.line, col: e.col, fileName },
        // A parse failure of the board means we cannot extract a netlist either.
        viewerOnly: false,
        board: null,
        circuit: null,
        resolutions: [],
        project: {
          boardFileName: fileName, boardText, schematicFileName: null, boardPath: null, boardSha256: null,
        },
      })
      return false
    }
    const o = outcome.opened

    // Per-board setup file (issue #27): the pipeline restored what it could
    // (o.restore; never throws, never blocks the open). A file that exists but
    // could not be read arrives as opts.sidecarError and becomes an 'unreadable'
    // restore with a note. The state is derived here and set with the board, so
    // the sync module saves only once the open has built a consistent state.
    const sidecarPath = opts?.boardPath ? sidecarPathFor(opts.boardPath) : null
    const sidecarFileName = sidecarPath ? baseName(sidecarPath) : ''
    let restore: LoadOutcome | null = null
    if (sidecarPath) {
      if (opts?.sidecarError) {
        restore = {
          status: 'unreadable',
          plan: null,
          restored: 0,
          notes: [`Could not read ${sidecarFileName} (${opts.sidecarError}); the board opened without its saved setup.`],
        }
      } else {
        restore = o.restore
      }
    }
    const plan = restore?.plan ?? null
    let sidecarState: SidecarState = {
      ...INITIAL_SIDECAR_STATE,
      path: sidecarPath,
      diskStatus: sidecarPath ? (restore ? restore.status : 'absent') : null,
    }
    if (sidecarPath && restore) {
      const autosave = autosaveAllowed(restore.status)
      sidecarState = {
        ...sidecarState,
        autosave,
        backupFirst: autosave && !overwriteIsSafe(restore.status),
        note:
          restore.restored > 0 || restore.notes.length > 0
            ? { restored: restore.restored, messages: restore.notes, status: restore.status, fileName: sidecarFileName }
            : null,
      }
    }

    // Auto-attach a default DC supply on the top suggested supply net so the
    // bench is immediately usable ("see it work in 60 seconds", Spec 4): the
    // user lands with a designated ground AND a source, so Power On / Run are
    // live without manual rigging. The supply is editable/removable. We only
    // do this when a supply net was suggested AND it isn't the ground net.
    // A restored bench replaces the auto supply: the sidecar's instrument list
    // (even an empty one: the user removed the supply) is the user's own rigging.
    const restoredBench = plan?.instruments
    const instruments: Instrument[] = restoredBench ? [...restoredBench] : []
    if (restoredBench) reserveBenchIds(restoredBench)
    const topSupplyNetId = restoredBench
      ? undefined
      : o.suggestedSupplyNetIds.find(id => id !== o.groundNetId)
    if (topSupplyNetId !== undefined) {
      instruments.push({
        kind: 'dc-supply',
        id: AUTO_SUPPLY_ID,
        netId: topSupplyNetId,
        volts: 5,
        seriesOhms: 0.1, // Spec 9 default
      })
    }

    // Viewer-only iff the netlist is unusable for simulation (no parts / no nets).
    const usable = o.circuit.parts.length > 0 && o.circuit.nets.length > 0

    store.setState(st => ({
      project: {
        boardFileName: fileName,
        boardText,
        schematicFileName: o.schematicFileName,
        boardPath: opts?.boardPath ?? null,
        boardSha256: null,
      },
      board: o.board,
      circuit: o.circuit,
      schematicSimData: o.schematicSimData,
      bom: o.bom,
      groundNetId: o.groundNetId,
      suggestedSupplyNetIds: o.suggestedSupplyNetIds,
      instruments,
      // The resolution already saw the restored overrides and user models; they
      // are set together with the board so state and resolution agree. User
      // models merge over any imported earlier this session.
      resolutions: o.resolutions,
      ...(plan
        ? {
            stubOverrides: new Map(plan.stubOverrides),
            pinMapOverrides: new Map(plan.pinMapOverrides),
            railOverrides: new Map(plan.railOverrides),
            leadPositions: new Map(plan.leadPositions),
            userModels: new Map([...st.userModels, ...plan.userModels]),
          }
        : {}),
      viewerOnly: !usable,
      // Reveal the auto supply's properties right away (the rack mirrors this).
      selectedInstrumentId: topSupplyNetId !== undefined ? AUTO_SUPPLY_ID : null,
      // Announce the silent auto-attach on the supply's card (M7 F7).
      autoAttachedSupplyId: topSupplyNetId !== undefined ? AUTO_SUPPLY_ID : null,
      sidecar: sidecarState,
    }))

    // Keep ring buffers in sync with the (possibly auto-attached) instruments.
    syncRingBuffers(instruments)

    // A BOM that failed to parse, or whose rows match no board ref, says so in
    // the log instead of silently doing nothing, and so do the BOM changes and
    // polarity guesses on parts that resolved (issues #4, #5).
    logLoadNotes(o.bomParsed, true)

    // Tie results to the exact file: hash the board text in the background.
    // The state above carries a null hash until this lands (see AppState).
    const job: Promise<string | null> = sha256Hex(boardText).then(hash => {
      if (hash && boardHashJob === job && store.getState().project.boardText === boardText) {
        store.setState(st => ({ project: { ...st.project, boardSha256: hash } }))
      }
      return hash
    })
    boardHashJob = job
    return true
  }

  /** Store a critic report, drop a stale selection, and push findings to the overlay. */
  function applyCriticReport(report: CriticReport): void {
    store.setState({ criticReport: report })
    const sel = store.getState().selectedFindingId
    if (sel && !report.findings.some(f => f.id === sel)) store.setState({ selectedFindingId: null })
    boardHooks?.setCriticFindings?.(report.findings)
  }

  /** Set (or with null, clear) one lead position; no state change when already equal. */
  function setLeadPosition(key: string, position: LeadPosition | null): void {
    const cur = store.getState().leadPositions
    const prev = cur.get(key)
    if (position === null ? prev === undefined : prev !== undefined && prev.x === position.x && prev.y === position.y) return
    const next = new Map(cur)
    if (position === null) next.delete(key)
    else next.set(key, { x: position.x, y: position.y })
    store.setState({ leadPositions: next })
  }

  const store = createStore<AppState>((set, get) => ({
    // ── initial state ──────────────────────────────────────────────────────────
    project: {
      boardFileName: null, boardText: null, schematicFileName: null, boardPath: null, boardSha256: null,
    },
    sidecar: INITIAL_SIDECAR_STATE,
    leadPositions: new Map(),
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
    guidedBlock: null,
    simState: 'idle',
    copperAware: false,
    copperOp: null,
    criticOp: null,
    criticPending: false,
    deckDirty: false,
    opVoltages: null,
    opVoltagesStale: false,
    voltageRange: null,
    currentsByRef: new Map(),
    criticCurrents: null,
    coachNotes: [],
    measuredRails: null,
    railNotes: [],
    undrivenNets: [],
    ngspiceVersion: null,
    paceFactor: 1,
    achievedRealtimeFactor: null,
    simTimeSeconds: 0,
    vectorNames: [],
    openProgress: null,
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
    lastSolve: null,
    lastRunDeck: null,
    benchRestartToast: null,
    convergenceCard: null,
    opCaveat: null,
    fidelityMinimizedSig: null,

    // ── open flow ────────────────────────────────────────────────────────────
    openBoardFromText(boardText, fileName, opts) {
      supersedeOpen()
      resetForOpen()
      const outcome = openBoardPipeline(openRequest(boardText, opts))
      if (!applyOpenOutcome(outcome, boardText, fileName, opts)) return
      // Auto-run the read-only critic audit (Spec §7 trigger): the no-sim checks
      // (floating / clearance / decoupling) run immediately on open; the
      // sim-dependent ones (ampacity / thermal) are reported as skipped until an
      // operating-point solve lands (which re-runs the audit with real currents).
      get().runCriticAudit()
    },

    async awaitBoardHash() {
      return boardHashJob ?? get().project.boardSha256
    },

    async openBoard(boardText, fileName, opts) {
      const token = supersedeOpen()
      const live = (): boolean => token === openToken
      resetForOpen()
      boardHashJob = null
      // No project while the next one is being built: leaving the old board up
      // would let Power On and the panels act on a circuit whose bench state was
      // just reset. The progress strip stands in for it.
      set({
        board: null,
        circuit: null,
        resolutions: [],
        schematicSimData: null,
        bom: null,
        groundNetId: null,
        suggestedSupplyNetIds: [],
        project: {
          boardFileName: null, boardText: null, schematicFileName: null, boardPath: null, boardSha256: null,
        },
        openProgress: { fileName, stage: 'parsing' },
      })

      let opened: OpenedBoard | null = null
      let auditEpochAtOpen = 0
      let auditApplied = false

      try {
        await openRunner.run(openRequest(boardText, opts), {
          onStage(stage) {
            if (live()) set({ openProgress: { fileName, stage } })
          },
          onOpened(outcome) {
            if (!live()) return
            if (!applyOpenOutcome(outcome, boardText, fileName, opts)) {
              set({ openProgress: null })
              return
            }
            opened = outcome.ok ? outcome.opened : null
            auditEpochAtOpen = auditEpoch
            // The board is on screen; only the audit is outstanding.
            set({ openProgress: { fileName, stage: 'auditing' } })
          },
          onAudit(report, staticOutputs) {
            if (!live() || !opened) return
            auditApplied = true
            // A worker's audit memoised the no-sim checks (clearance is the slow
            // one) against ITS copy of the circuit. Prime this thread's critic
            // cache so the re-audit after an operating point reuses them (#97).
            if (staticOutputs) primeStaticOutputs(opened.board, opened.circuit, staticOutputs)
            // An audit that ran while this one was in flight (an operating point
            // landed, say) is newer than this report, and a changed circuit
            // (new ground) makes it stale. Keep the newer state in either case.
            const unchanged = auditEpoch === auditEpochAtOpen && get().circuit === opened.circuit
            if (unchanged) {
              applyCriticReport(report)
            } else if (get().criticReport === null) {
              get().runCriticAudit()
            }
            set({ openProgress: null })
          },
        })
      } catch (err) {
        if (live()) {
          set({
            openProgress: null,
            parseError: {
              message: `Opening the board failed: ${err instanceof Error ? err.message : String(err)}`,
              fileName,
            },
          })
        }
        return
      }

      if (!live()) return
      // The run ended without an audit (the worker died mid-audit): the board is
      // up, so audit it here rather than leave the Critic empty.
      if (opened && !auditApplied && get().criticReport === null) get().runCriticAudit()
      if (get().openProgress !== null) set({ openProgress: null })
      // The open is not over until the board is tied to its file: no consumer
      // that waits for openBoard can observe a null hash (issue #144).
      if (opened) await get().awaitBoardHash()
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
      logLoadNotes(parsed, false)
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

      // User models become library entries ahead of the bundled library, so a
      // user model wins tier 3/4 matching (shared with the board-open pipeline).
      const effectiveLibrary = buildEffectiveLibrary(userModels.values(), library)
      const resolutions = resolveWithOverrides(
        circuit,
        schematicSimData,
        bom,
        effectiveLibrary,
        stubOverrides,
        pinMapOverrides,
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
      return circuit ? railOverridesByNetId(circuit, railOverrides) : new Map()
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
      const { board, circuit, opVoltages, currentsByRef, criticCurrents, instruments, leadPositions, groundNetId } = get()
      if (!board || !circuit) {
        set({ criticReport: null, selectedFindingId: null })
        boardHooks?.clearCriticFindings?.()
        return
      }
      // Build the critic OpResult from the live op state ONLY when energized (an
      // op result is present). Without it runCritic SKIPS ampacity/thermal — which
      // is fine: opening re-audits no-sim checks, the post-op re-audit feeds reals.
      const opResult = get().criticOp ?? buildCriticOpResult(
        circuit,
        opVoltages,
        currentsByRef,
        criticCurrents,
        buildSupplyEntries(instruments, leadPositions, groundNetId),
      )
      auditEpoch++
      applyCriticReport(withCopperFindings(runCritic(board, circuit, opResult), board, opResult?.copper))
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
      // A new ground net invalidates where the old ground lead was clipped.
      setLeadPosition(GROUND_LEAD_KEY, null)
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
        // Its leads are gone, so are their board positions.
        leadPositions: dropLeadPositionsOf(s.leadPositions, id),
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

    assignTerminal(instId, terminal, target, position) {
      // Ground is the setGround flow (spec §7) — the ground panel's black lead.
      if (instId === GROUND_INST_ID && terminal === 'gnd') {
        if (target.kind === 'net') {
          get().setGround(target.netId) // clears any stale ground lead position
          if (position) setLeadPosition(GROUND_LEAD_KEY, position)
        }
        return
      }
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = applyTerminal(inst, terminal, target)
      // applyTerminal returns the SAME object for invalid combos — no-op then;
      // otherwise route through updateInstrument so alter/re-op semantics fire.
      if (next !== inst) {
        get().updateInstrument(instId, next)
        // Record where the clip landed; a rewire with no position drops the old one.
        setLeadPosition(leadKey(instId, terminal), position ?? null)
      }
    },

    detachTerminalWire(instId, terminal) {
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = clearTerminal(inst, terminal)
      if (next !== inst) {
        get().updateInstrument(instId, next)
        setLeadPosition(leadKey(instId, terminal), null)
      }
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
      // The audit can land before the viewport (and so its hooks) exists; hand
      // it the report that is already in the store.
      const report = get().criticReport
      if (hooks && report) hooks.setCriticFindings?.(report.findings)
    },

    async setCopperAware(enabled) {
      const s = get()
      if (s.copperAware === enabled || s.simState !== 'idle') return
      set({ copperAware: enabled })
      get().markDeckDirty()
      if (s.opVoltages !== null) await get().powerOn()
    },

    async powerOn() {
      if (powerOnOpInFlight) {
        if (!criticSolveInFlight) return null
        await awaitEngineIdle()
      }
      if (engineNeedsRestart) return null
      const { circuit, resolutions, instruments, groundNetId } = get()
      if (!circuit) return null
      if (groundNetId === null) {
        // Guided empty-state (Spec §12): surface the no-ground card, never a
        // silent no-op.
        set({ guidedBlock: 'no-ground' })
        return null
      }
      // Guided empty-state: zero resolved (wired) sources (Spec §12). An
      // UNWIRED source added from the shelf palette (bench-leads) doesn't
      // count: it drives nothing until a lead is dropped on a net.
      const hasSource = wiredInstruments(instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
      if (!hasSource) {
        set({ guidedBlock: 'no-source' })
        return null
      }
      if (get().guidedBlock !== null) set({ guidedBlock: null })

      // Snapshot every deck input ONCE per powerOn so the pass-1 deck, the
      // sensing skip-list, and the pass-2 deck all agree even if the user edits
      // an override mid-solve (FIX 3).
      const inputs = currentSolveInputs()
      if (!inputs) return null
      const token = openToken
      const supplyEntries = buildSupplyEntries(instruments, get().leadPositions, groundNetId)
      // Capture both modes and the lead entry positions before either solve.
      const physicalInputs = inputs.copperAware || !inputs.board ? inputs : currentSolveInputs(true)!

      // Retained voltages from a previous run are STALE until the new solve
      // lands — readouts dim/caption them instead of presenting them as truth
      // (M7 review fix). Nothing retained on the first solve → stays false.
      set({
        simState: 'op',
        convergenceCard: null,
        opCaveat: null,
        opVoltagesStale: get().opVoltages !== null,
        criticOp: null,
        criticPending: false,
      })

      // powerOn owns every commit for its own op(s): suppress the ingestEvent
      // listener's opResult handler for the whole section so the interim pass-1
      // (family-default) result is never committed during the pass-2 re-solve
      // (FIX 2). The finally covers all exits: success, pass-1 timeout, pass-2
      // timeout.
      powerOnOpInFlight = true
      primaryLoadFailed = false
      if (reopInFlight) pendingCriticRefresh = null
      try {
        // The two-pass op with tier-3 rail sensing (src/core/solve/plan.ts). Pass
        // 1's load and op go out synchronously, inside this gate; pass 2 runs
        // only if a measured rail changed the deck, and a pass-2 failure keeps
        // pass 1's op.
        let solved: SolveResult
        try {
          solved = await runSolvePlan(inputs, solveEngine)
        } catch (err) {
          // A pass-1 timeout drops us back to idle; a convergenceFailure event
          // (ingested separately) already surfaces the plain-language card.
          if (get().simState === 'op') set({ simState: 'idle' })
          if (err instanceof SolveFailedError) {
            // The bundle's whole point on a convergence card is the deck that
            // failed, so record it (the same pass-1 deck runSolvePlan sent)
            // instead of leaving the previous solve's deck in place.
            set({
              lastSolve: {
                status: 'pass1-failed',
                pass1Deck: buildDeck({ ...inputs, measuredRails: undefined }),
                pass2Deck: null,
                pass2: null,
                opValues: {},
                opMethod: null,
                at: Date.now(),
              },
            })
            return null
          }
          throw err
        }
        const { op, netVoltages: opVoltages } = solved
        if (token !== openToken) return null

        // Geometry is available while the physical assessment is pending or
        // unavailable. It must never borrow the ideal bench's electrical values.
        const unavailableCritic: SolveResult = {
          ...solved, op: { values: {}, method: 'failed' }, netVoltages: new Map(),
          copper: copperResult(physicalInputs, { values: {}, method: 'failed' }, buildDeck(physicalInputs)),
        }
        const criticSolved = physicalInputs === inputs ? solved : unavailableCritic
        const canRefreshCritic = physicalInputs !== inputs && (op.method === undefined || op.method === 'direct') && !primaryLoadFailed

        set({
          measuredRails: solved.measuredRails,
          lastSolve: {
            status: 'solved',
            pass1Deck: solved.pass1Deck,
            pass2Deck: solved.pass2Deck ?? null,
            pass2: solved.pass2,
            opValues: op.values,
            opMethod: op.method ?? null,
            at: Date.now(),
          },
        })
        const railNotes: RailNote[] = solved.gatedOff.map(g => ({ ref: g.ref, kicadName: g.kicadName }))

        const copperOp = solved.copper ?? null
        const voltageRange = copperOp ? padVoltageRange(copperOp.padVoltages) : computeVoltageRange(opVoltages)
        const currentsByRef = applyOpCurrents(boardHooks, op.values, resolutions, circuit)
        const criticCurrents = deriveCriticCurrents(physicalInputs, criticSolved)
        const criticLedCurrents = mapOpResultToCurrents(criticSolved.op.values, buildLedSpiceNames(resolutions, circuit))
        const criticOp = buildCriticOpResult(circuit, criticSolved.netVoltages, criticLedCurrents, criticCurrents,
          physicalInputs.copperNetwork ? supplyEntries : undefined,
          criticSolved.copper,
        ) ?? null

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
          criticCurrents,
          copperOp,
          criticOp,
          criticPending: canRefreshCritic,
          coachNotes,
          railNotes,
          undrivenNets: solved.undrivenNets,
          // Honesty surface (F1): powerOn is now the sole committer for its own op,
          // so it carries ingestEvent's caveat logic — an op that converged only
          // via a fallback rung gets the persistent caveat (absent method ⇒ direct).
          opCaveat:
            op.method && op.method !== 'direct'
              ? { method: op.method, at: Date.now() }
              : null,
          deckDirty: false,
          simState: 'idle',
        })

        // Push onto the 3D board: floating voltage labels + copper voltage tint.
        applyOpToBoard(boardHooks, opVoltages, voltageRange, copperOp)

        // Re-run the critic with the fresh op result so the sim-dependent checks
        // (ampacity / thermal) now run with real node voltages + currents (Spec §7).
        get().runCriticAudit()
        if (canRefreshCritic) {
          const refreshCritic = async (): Promise<void> => {
            if (token !== openToken || !sameInstruments(instruments, get().instruments) || get().copperAware !== inputs.copperAware) return
            let physicalSolved = unavailableCritic
            criticSolveInFlight = true
            criticLoadFailed = false
            try {
              physicalSolved = await runSolvePlan(physicalInputs, solveEngine)
            } catch {
              // Keep geometry without electrical claims when the critic fails.
            } finally {
              try {
                const direct = !criticLoadFailed && (physicalSolved.op.method === undefined || physicalSolved.op.method === 'direct')
                if (!direct) {
                  // A fallback can leave native transient state unsafe for the
                  // next load (#163). Never restore onto that engine.
                  engineNeedsRestart = true
                  if (options.restartSimhost) {
                    try {
                      await options.restartSimhost()
                      engineNeedsRestart = false
                    } catch {
                      set(s => ({ logLines: [...s.logLines, { level: 'error', text: 'SimHost restart failed; the bench requires a fresh engine.' }] }))
                    }
                  }
                }
                if (token === openToken && !engineNeedsRestart) await solveEngine.loadCircuit(solved.deck)
                if (engineNeedsRestart) set({ deckDirty: true })
              } finally {
                criticSolveInFlight = false
                if (token === openToken) set({ criticPending: false })
              }
            }
            if (token !== openToken || !sameInstruments(instruments, get().instruments) || get().copperAware !== inputs.copperAware) return
            const physicalCurrents = deriveCriticCurrents(physicalInputs, physicalSolved)
            const ledCurrents = mapOpResultToCurrents(physicalSolved.op.values, buildLedSpiceNames(resolutions, circuit))
            set({
              criticCurrents: physicalCurrents,
              criticOp: buildCriticOpResult(circuit, physicalSolved.netVoltages, ledCurrents, physicalCurrents,
                supplyEntries, physicalSolved.copper) ?? null,
            })
            get().runCriticAudit()
          }
          if (reopInFlight) pendingCriticRefresh = refreshCritic
          else await refreshCritic()
        }
        return opVoltages
      } finally {
        // Release ingestEvent to commit ordinary (run/replay) ops again.
        releasePowerOnEngine()
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
      if (groundNetId === null) {
        // Nothing we can tie to 0 V (e.g. every net is auto-named): guide the
        // user to designate one instead of a silent no-op (Spec §12).
        set({ guidedBlock: 'no-ground' })
        return null
      }

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
      if (powerOnOpInFlight) {
        if (criticSolveInFlight && !runQueuedAfterCritic) {
          runQueuedAfterCritic = true
          const token = openToken
          void awaitEngineIdle().then(() => {
            runQueuedAfterCritic = false
            if (token === openToken && get().simState === 'idle') get().run()
          })
        }
        return
      }
      if (engineNeedsRestart) return
      const { circuit, instruments, groundNetId, simState, deckDirty } = get()
      if (!circuit) return
      if (groundNetId === null) {
        // Guided empty-state (Spec §12): no ground, show the card, not a dead button.
        set({ guidedBlock: 'no-ground' })
        return
      }
      // Guided empty-state: zero resolved (wired) sources (Spec §12).
      const hasSource = wiredInstruments(instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
      if (!hasSource) {
        set({ guidedBlock: 'no-source' })
        return
      }
      if (get().guidedBlock !== null) set({ guidedBlock: null })

      // Resume-from-pause with a clean deck: do NOT reload, just resume.
      if (simState === 'paused' && !deckDirty) {
        simClient.send({ type: 'resume' })
        set({ simState: 'running' })
        return
      }

      // Fresh start (or restart after a deck-dirtying edit): reload the deck +
      // reset ring buffers so the scope starts clean. The deck reuses the rails
      // the last powerOn sensed (tier 3) rather than re-sensing.
      const inputs = currentSolveInputs()
      if (!inputs) return
      const deckLines = buildDeck(inputs)
      resetRingBuffers(instruments)

      const tstepSeconds = computeTstep(instruments)
      const tstopSeconds = BENCH_WINDOW_SECONDS

      simClient.send({ type: 'loadCircuit', deckLines })
      set({ lastRunDeck: deckLines })
      sendWatch()
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
      if (powerOnOpInFlight) return
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

    dismissGuidedBlock() {
      set({ guidedBlock: null })
    },

    dismissConvergenceCard() {
      set({ convergenceCard: null })
    },

    minimizeFidelityBanner() {
      set({ fidelityMinimizedSig: fidelitySignature(fidelityBannerItems(get().resolutions)) })
    },

    // ── per-board setup file (issue #27) ─────────────────────────────────────────
    buildSidecarText() {
      const s = get()
      if (!s.circuit) return null
      const sidecar = buildSidecar({
        appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,
        board: { fileName: s.project.boardFileName, sha256: s.project.boardSha256 },
        nets: s.circuit.nets,
        groundNetId: s.groundNetId,
        instruments: s.instruments,
        leadPositions: s.leadPositions,
        stubOverrides: s.stubOverrides,
        pinMapOverrides: s.pinMapOverrides,
        railOverrides: s.railOverrides,
        userModels: s.userModels,
      })
      return serializeSidecar(sidecar)
    },

    enableAutosave() {
      const { sidecar } = get()
      if (!sidecar.path) return
      set({
        sidecar: {
          ...sidecar,
          autosave: true,
          // Replacing an unreadable, truncated or old-format file: keep the original.
          backupFirst: !overwriteIsSafe(sidecar.diskStatus ?? 'absent'),
          error: null,
        },
      })
    },

    dismissSidecarNote() {
      set(s => ({ sidecar: { ...s.sidecar, note: null } }))
    },

    markDeckDirty() {
      // Any deck-dirtying edit (setGround, setPinMap, override changes, …) can
      // shift the reference frame or topology the sensed rails were measured in,
      // so the op-measured rail cache + gated-off notes must not survive it.
      set({ deckDirty: true, measuredRails: null, railNotes: [], undrivenNets: [] })
    },

    // ── crash recovery (Spec §6.1) ─────────────────────────────────────────────
    noteCrash(willRespawn, detail) {
      set({
        crashNotice: {
          willRespawn,
          at: Date.now(),
          ...(detail ? { exitCode: detail.exitCode, reason: detail.reason } : {}),
        },
      })
    },

    replayAfterCrash() {
      engineNeedsRestart = false
      const { instruments, simState, paceFactor } = get()
      const inputs = currentSolveInputs()
      if (!inputs) return

      // Re-send the full deck. All instrument state (including live-altered supply
      // voltages) lives in the store, so the regenerated deck already reflects it
      // — nothing extra to re-apply (Spec §6.1).
      const replayDeck = buildDeck(inputs)
      simClient.send({ type: 'loadCircuit', deckLines: replayDeck })
      set({ lastRunDeck: replayDeck })

      // Re-establish the run state on the fresh process.
      if (simState === 'running') {
        // Restart the bounded transient from t=0 (the circuit settles again from
        // initial conditions — acceptable per Spec §7.5; scope ring buffers keep
        // their history). Re-apply the pace so the fresh process honours it.
        resetRingBuffers(instruments)
        sendWatch()
        simClient.send({ type: 'setPace', realtimeFactor: paceFactor })
        simClient.send({
          type: 'runTransient',
          tstepSeconds: computeTstep(instruments),
          tstopSeconds: BENCH_WINDOW_SECONDS,
        })
        set({ vectorNames: [], simTimeSeconds: 0 })
      } else if (simState === 'op') {
        simClient.send({ type: 'runOp' })
      } else if (simState === 'paused') {
        // The fresh SimHost holds the deck but no transient, so there is nothing
        // to resume: leaving the store 'paused' would make Run send a bare
        // `resume` that the new process ignores, and the bench would sit dead
        // while the store said 'running' (#75). Drop to 'idle' so Run takes the
        // fresh-start path (loadCircuit + runTransient), and say so in the crash
        // notice. The pause is not re-created on the new process: a halt queued
        // straight after runTransient races the ngspice background thread
        // (bg_halt before the thread is up is a no-op), so it would not hold.
        // Scope ring buffers keep the history the user was inspecting.
        set(s => ({
          simState: 'idle',
          crashNotice: {
            // Keep the exit code and reason noteCrash recorded (diagnostics, #26).
            ...s.crashNotice,
            willRespawn: s.crashNotice?.willRespawn ?? true,
            at: s.crashNotice?.at ?? Date.now(),
            pausedRunLost: true,
          },
        }))
      }
    },

    // ── Task 25: LLM-assist + user .lib import ───────────────────────────────

    async validateSubckt(subcktText, subcktName, nodeCount) {
      // Build a minimal probe deck: the pasted subckt + one dummy instance +
      // enough dummy bleeds/ground so ngspice can parse it without error.
      // We don't care about simulation convergence, only that ngspice PARSES
      // the subckt definition without emitting an error: only errors raised
      // while the deck loads count, never the ones from the op behind it (a
      // subckt with its own source can fail the dummy op and still be valid).
      // The dummy nodes
      // (_tst1, _tst2, ...) are tied to ground via 1G resistors so the deck has
      // a DC path and won't hit the "no DC path to ground" trap.
      //
      // ngSpice_Circ takes exactly one card per entry and never splits on
      // newlines, so the pasted block goes in one entry per line (issue #18;
      // SimHost.loadCircuit guards the same way).
      const dummyNodes = Array.from({ length: nodeCount }, (_, i) => `_tst${i + 1}`)
      const dummyNodeStr = dummyNodes.join(' ')
      const dummyRs = dummyNodes.map((n, i) => `r_chk_${i + 1} ${n} 0 1000meg`)

      const testDeck = [
        `* circsim subckt validation test for ${subcktName}`,
        ...subcktText.trim().split(/\r?\n/),
        `x_test ${dummyNodeStr} ${subcktName}`,
        ...dummyRs,
        `v_test _tst1 0 dc 0`,
        `.op`,
        `.end`,
      ]

      // Collect log lines during the load to detect errors.
      const errorLines: string[] = []
      // ngspice prints "Doing analysis at TEMP = ..." when the op starts, after
      // the deck has been parsed. Everything past that line belongs to the
      // dummy harness's op, not to the pasted model, so stop collecting there.
      let loadPhase = true

      const unsub = simClient.onEvent(event => {
        if (event.type !== 'log' || !loadPhase) return
        if (/Doing analysis at TEMP/i.test(event.text)) {
          loadPhase = false
        } else if (event.level === 'error') {
          errorLines.push(event.text)
        }
      })

      // The probe replaces the board deck in the live engine, and the op behind
      // it is not the board's: keep ingestEvent from painting it onto the board
      // or raising a convergence card for a dummy circuit.
      subcktProbeInFlight = true
      try {
        // A runOp right behind the load is the load-complete signal: SimHost
        // applies commands in order and always answers an op with an opResult,
        // even when the load failed (load errors arrive as log events before
        // it). Waiting on it, not a fixed timer, keeps a valid paste from
        // costing the whole timeout. The timeout only backstops a dead host.
        // The op's own log lines are ignored (see loadPhase above).
        const done = simClient.waitFor('opResult', 8000).catch(() => undefined)
        simClient.send({ type: 'loadCircuit', deckLines: testDeck })
        simClient.send({ type: 'runOp' })
        await done
      } finally {
        unsub()
        subcktProbeInFlight = false
        // The engine now holds the probe deck, not the board's.
        get().markDeckDirty()
      }

      if (errorLines.length > 0) {
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
        case 'log': {
          if (powerOnOpInFlight && event.level === 'error'
            && /unknown subckt|circuit not parsed|no circuit loaded|cannot load|error loading/i.test(event.text)) {
            if (criticSolveInFlight) criticLoadFailed = true
            else primaryLoadFailed = true
          }
          set(s => ({
            logLines: [...s.logLines, { level: event.level, text: event.text }].slice(-2000),
          }))
          // ngspice can drop or reject a part while the part still reads "ok" here
          // (issues #6, #7): promote those log lines to per-part status.
          const before = previousLogText
          previousLogText = event.text
          if (/instance line, ignored|DC 0 assumed|valid modelname/i.test(event.text)) {
            const { circuit, resolutions } = get()
            if (circuit) {
              const diag = ngspiceLogDiagnostic(event.text, before, circuit.parts.map(p => p.ref))
              if (diag) {
                const next = applyDeckDiagnostics(resolutions, [diag])
                if (next !== resolutions) {
                  set({ resolutions: next })
                  get().markDeckDirty()
                }
              }
            }
          }
          break
        }
        case 'opResult': {
          // powerOn is the sole committer for its own ops — skip the interim
          // pass-1 (family-default) result it is about to correct in pass 2 (FIX 2).
          if (powerOnOpInFlight || subcktProbeInFlight) break
          const { circuit, resolutions, instruments, groundNetId } = get()
          if (!circuit) break
          const opVoltages = mapOpResultToNetVoltages(event.values, circuit)
          const currentsByRef = applyOpCurrents(boardHooks, event.values, resolutions, circuit)
          // The deck only supplies element names for the current derivation (LED
          // sense lines, bench resistors), which do not depend on measured rails.
          const replayInputs = currentSolveInputs()
          const deck = replayInputs ? buildDeck(replayInputs) : []
          const op = { values: event.values, method: event.method }
          const copperOp = replayInputs ? copperResult(replayInputs, op, deck) ?? null : null
          const voltageRange = copperOp ? padVoltageRange(copperOp.padVoltages) : computeVoltageRange(opVoltages)
          const criticCurrents = replayInputs
            ? deriveCriticCurrents(replayInputs, { op, deck, copper: copperOp ?? undefined })
            : null
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
          const criticOp = copperOp
            ? buildCriticOpResult(circuit, opVoltages, currentsByRef, criticCurrents,
              buildSupplyEntries(instruments, get().leadPositions, groundNetId), copperOp) ?? null
            : get().criticOp
          set({ opVoltages, opVoltagesStale: false, voltageRange, currentsByRef, criticCurrents, copperOp, criticOp, coachNotes, opCaveat })
          // Keep the board in sync after a replayed/standalone op too.
          applyOpToBoard(boardHooks, opVoltages, voltageRange, copperOp)
          // Re-audit with the fresh op result (ampacity/thermal get real data).
          get().runCriticAudit()
          break
        }
        case 'vectors':
          set({ vectorNames: event.names })
          break
        case 'samples': {
          if (criticSolveInFlight) break
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
          if (subcktProbeInFlight || criticSolveInFlight) break
          set({
            simState: 'idle',
            convergenceCard: {
              plainLanguage:
                "The simulator couldn't find a stable solution for this circuit. " +
                'Common causes: a missing or wrong model, an unconnected net (a floating node ' +
                'with no DC path to ground), or component values that are far apart in scale.',
              retryLadderNote:
                'circsim already retried with a gentler solve (gmin stepping) and a ramped solve ' +
                '(source stepping) before reporting this.',
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
          if (criticSolveInFlight) break
          set({
            achievedRealtimeFactor: event.realtimeFactor,
            simTimeSeconds: event.simTimeSeconds,
            // A `status{running:false}` while we believe we're running means the
            // run ended on its own (SimHost does not report its pacing halts as
            // not running). Reflect it as paused, but
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

  // A probe added, removed or re-wired while the bench runs changes which nets
  // the scope needs as full series; tell SimHost (the watch is sticky there).
  store.subscribe((state, prev) => {
    if (state.instruments === prev.instruments) return
    if (state.simState === 'running' || state.simState === 'paused') sendWatch()
  })

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
// (net voltages: mapOpResultToNetVoltages lives in src/core/solve/plan.ts)

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
 * currentsByRef, or from the solve's branch currents when they were derived.
 * Terminal power and unknown-power refs come from the solve's current producer.
 * Physical copper is retained on failed solves to surface geometry gaps.
 *
 * Exported for unit testing.
 */
export function buildCriticOpResult(
  circuit: Circuit,
  opVoltages: Map<number, number> | null,
  currentsByRef: Map<string, number>,
  solvedCurrents?: SolvedCurrents | null,
  supplyEntries?: SupplyEntry[],
  copper?: CopperOp,
): OpResult | undefined {
  if ((!opVoltages || opVoltages.size === 0) && !copper) return undefined

  const netToNode = new Map<number, string>()
  for (const net of circuit.nets) netToNode.set(net.id, net.spiceNode)

  const nodeVoltages: Record<string, number> = {}
  for (const [netId, volts] of opVoltages ?? []) {
    const node = netToNode.get(netId)
    if (node !== undefined) nodeVoltages[node] = volts
  }

  // Branch currents of every part from the solve, when it was derived; else the
  // LED-only map (the critic then sees LED currents and nothing else).
  if (solvedCurrents) {
    return {
      nodeVoltages,
      partCurrents: solvedCurrents.partCurrents,
      padCurrents: solvedCurrents.padCurrents,
      unresolvedRefs: solvedCurrents.unresolvedRefs,
      partPower: solvedCurrents.partPower,
      unknownPowerRefs: solvedCurrents.unknownPowerRefs,
      copper,
      ...(supplyEntries ? { supplyEntries } : {}),
    }
  }

  const partCurrents: Record<string, number> = {}
  for (const [ref, amps] of currentsByRef) partCurrents[ref] = amps

  return {
    nodeVoltages,
    copper,
    partCurrents: Object.keys(partCurrents).length > 0 ? partCurrents : undefined,
    ...(supplyEntries ? { supplyEntries } : {}),
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
  copper: CopperOp | null = null,
): void {
  if (!hooks) return
  hooks.showOpAnnotations(voltages)
  if (range) hooks.applyNetVoltages(voltages, range.min, range.max)
  hooks.applyPadVoltages?.(copper, range)
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
 * Every part's branch currents from a solve, for the Board Critic. Never throws:
 * a derivation failure leaves the critic on the LED-only map rather than
 * breaking the solve that just landed.
 */
function deriveCriticCurrents(
  inputs: SolveInputs,
  solve: Pick<SolveResult, 'op' | 'deck' | 'copper'>,
): SolvedCurrents | null {
  try {
    return deriveSolvedCurrents(inputs, solve)
  } catch {
    return null
  }
}

const copperPadNodeCache = new WeakMap<CopperOp, Map<string, Map<string, string>>>()
function copperPadNodes(copper: CopperOp, circuit: Circuit): Map<string, Map<string, string>> {
  let nodes = copperPadNodeCache.get(copper)
  if (!nodes) {
    nodes = new Map()
    const parts = new Map(circuit.parts.map(part => [part.ref, part]))
    const nets = new Map(circuit.nets.map(net => [net.id, net.spiceNode]))
    for (const [ref, pads] of Object.entries(copper.padVoltages)) {
      const padNodes = new Map<string, string>()
      for (const pad of Object.keys(pads)) {
        const netId = parts.get(ref)?.padNet.get(pad)
        const node = copper.network.padNode(ref, pad) ?? (netId !== undefined ? nets.get(netId) : undefined)
        if (node) padNodes.set(pad, node.toLowerCase())
      }
      nodes.set(ref, padNodes)
    }
    copperPadNodeCache.set(copper, nodes)
  }
  return nodes
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
  const latestNodes = new Map<string, number>()

  // Live LED currents, lazily copied from the current map so LEDs absent from
  // this batch keep their last-known current. Stays null when the batch carries
  // no sense column — the common no-LED case pays nothing and the glow path
  // (store + scene) is left completely untouched.
  let ledCurrents: Map<string, number> | null = null

  // Unwatched vectors arrive as one newest value each (SimHost's display-rate
  // snapshot): the same two jobs as the newest point of a full column, nothing
  // to feed to a ring buffer.
  if (event.latest) {
    const { vectorNames, values } = event.latest
    for (let i = 0; i < vectorNames.length; i++) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      latestNodes.set(normalizeVectorKey(vectorNames[i]), v)
      const ledRef = mapVectorNameToLedRef(vectorNames[i])
      if (ledRef !== null) {
        ledCurrents ??= new Map(state.currentsByRef)
        ledCurrents.set(ledRef, Math.abs(v))
        continue
      }
      const netId = nodeToNet.get(vectorNames[i]) ?? nodeToNet.get(vectorNames[i].toLowerCase())
      if (netId !== undefined) liveVoltages.set(netId, v)
    }
  }

  for (let ci = 0; ci < event.vectorNames.length; ci++) {
    const vecName = event.vectorNames[ci]
    const column = event.columns[ci]
    if (!column) continue
    if (column.length > 0 && Number.isFinite(column[column.length - 1])) {
      latestNodes.set(normalizeVectorKey(vecName), column[column.length - 1])
    }

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
    const range = state.copperOp ? state.voltageRange : computeVoltageRange(liveVoltages)
    if (range) hooks.applyNetVoltages(liveVoltages, range.min, range.max)
    if (state.copperOp) {
      const padNodes = copperPadNodes(state.copperOp, circuit)
      const padVoltages = Object.fromEntries(Object.entries(state.copperOp.padVoltages).map(([ref, pads]) => {
        const values = { ...pads }
        for (const pad of Object.keys(pads)) {
          const node = padNodes.get(ref)?.get(pad)
          const volts = node ? latestNodes.get(node) : undefined
          if (volts !== undefined) values[pad] = volts
        }
        return [ref, values]
      }))
      // Keep the legend's numeric list as the operating-point snapshot. Scene
      // tint and labels follow display-rate samples using that same fixed scale.
      hooks.applyPadVoltages?.({ ...state.copperOp, padVoltages }, range)
    }
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
