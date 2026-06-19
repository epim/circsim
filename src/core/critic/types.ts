/**
 * core/critic/types.ts
 *
 * Board Critic — a READ-ONLY adversarial pre-fab audit of a board the user
 * brought to circsim (parsed from their .kicad_pcb), never one circsim created.
 *
 * Findings are RISKS TO CHECK, not verdicts. Each carries the underlying numbers
 * and (where relevant) the key assumption behind them, so the critic never
 * over-claims — preserving circsim's trust-as-a-validator value.
 *
 * Spec: docs/superpowers/specs/2026-06-19-circsim-board-critic-design.md §3
 *
 * No imports from electron, react, or three.
 */

export type Severity = 'error' | 'warn' | 'info'

export type CheckId =
  | 'floating'
  | 'ir-drop'
  | 'ampacity'
  | 'decoupling'
  | 'thermal'
  | 'clearance'
  | 'loop-area'

export interface Finding {
  /** Stable id, e.g. "ir-drop:/5V" or "clearance:seg12-seg40". */
  id: string
  check: CheckId
  severity: Severity
  /** Short, plain language: "5V rail sags to 4.62 V at U3". */
  title: string
  /** The numbers + the why. */
  detail: string
  /** What the finding assumes, e.g. "1 oz copper; current from op-point sim". */
  assumption?: string
  /** Component refs involved (e.g. ["U3", "C7"]). */
  refs?: string[]
  /** Net this finding concerns, if any. */
  netId?: number
  /** Board-coordinate location (mm) for a 3D marker / camera fly-to. */
  location?: { x: number; y: number }
  /** Advice only — NEVER auto-applied (the critic is read-only). */
  suggestion?: string
  /** Raw numeric metrics for the UI / tests. */
  metrics?: Record<string, number>
}

export interface CriticReport {
  findings: Finding[]
  /** Which checks actually executed. */
  ranBy: CheckId[]
  /** Checks that were skipped (e.g. needed a simulation that wasn't provided). */
  skipped: { check: CheckId; reason: string }[]
  summary: { error: number; warn: number; info: number }
}

export interface CriticOptions {
  /** Copper weight in oz (thickness = oz × 34.8 µm). Default 1. */
  copperOz: number
  /** Minimum acceptable clearance in mm. Default 0.2. */
  minClearanceMm: number
  /** IR-drop warn / error thresholds as a percent of the rail's nominal. */
  irDropWarnPct: number
  irDropErrPct: number
  /** A bypass cap must sit within nearMm of an IC power pin; beyond farMm is an error. */
  decouplingNearMm: number
  decouplingFarMm: number
  /** Ambient temperature for thermal-rise reporting. Default 25 °C. */
  ambientC: number
}

export const DEFAULT_CRITIC_OPTIONS: CriticOptions = {
  copperOz: 1,
  minClearanceMm: 0.2,
  irDropWarnPct: 2,
  irDropErrPct: 5,
  decouplingNearMm: 5,
  decouplingFarMm: 15,
  ambientC: 25,
}

/**
 * Operating-point solution fed to the sim-dependent checks (IR-drop, ampacity,
 * thermal). Built from circsim's existing ngspice operating-point path. Absent ⇒
 * those checks fall back to estimates and say so, or are skipped.
 */
export interface OpResult {
  /** SPICE node name → DC voltage (V). */
  nodeVoltages: Record<string, number>
  /**
   * Current (A) flowing through a part, keyed by ref. Sign/branch detail is not
   * required by v1 checks — magnitude is what matters for ampacity/thermal.
   */
  partCurrents?: Record<string, number>
  /** Power (W) dissipated by a part, keyed by ref (P = Σ|V·I| across its pads). */
  partPower?: Record<string, number>
}
