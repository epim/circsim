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

/**
 * A check returns its findings, or — when it ran but a missing precondition
 * kept it from actually assessing (e.g. loop-area with no ground copper to
 * measure against) — an object carrying `notAssessed`. The runner surfaces
 * that reason in `skipped` so the panel never presents "no findings" as
 * "checked and clean". Checks that always assess just return `Finding[]`.
 */
export type CheckOutput = Finding[] | { findings: Finding[]; notAssessed?: string }

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
  /**
   * Loop-area heuristic thresholds (mm²) for clock/high-speed nets: estimated
   * signal↔return loop area above warn is worth checking; above err it very
   * likely radiates / picks up EMI. Defaults 100 / 500 mm² — order-of-magnitude
   * EMC rules of thumb (≲100 mm² is the commonly cited "keep it under" figure
   * for fast edges), deliberately loose because the v1 estimate is coarse.
   */
  loopAreaWarnMm2: number
  loopAreaErrMm2: number
  /**
   * Target cell pitch (mm) for meshing a copper pour into the IR-drop graph.
   * The mesh coarsens on its own when a pour would exceed a few thousand
   * cells. Default 2 mm.
   */
  zoneMeshMm: number
}

export const DEFAULT_CRITIC_OPTIONS: CriticOptions = {
  copperOz: 1,
  minClearanceMm: 0.2,
  irDropWarnPct: 2,
  irDropErrPct: 5,
  decouplingNearMm: 5,
  decouplingFarMm: 15,
  ambientC: 25,
  loopAreaWarnMm2: 100,
  loopAreaErrMm2: 500,
  zoneMeshMm: 2,
}

/**
 * Where a bench supply (or the ground clip) enters a net, from the lead's copper
 * position. The copper checks use it as the source of the rail solve instead of
 * guessing the entry pad (issue #47).
 */
export interface SupplyEntry {
  /** Board net the lead is attached to. */
  netId: number
  /**
   * Where the lead was clipped, KiCad board coordinates in mm. Absent when the
   * supply is attached but no position was recorded (a v0 setup file, a clip made
   * without a pick point): the check then guesses and says so.
   */
  pos?: { x: number; y: number }
}

/**
 * Operating-point solution fed to the sim-dependent checks (IR-drop, ampacity,
 * thermal). Built from circsim's existing ngspice operating-point path. Absent ⇒
 * those checks are skipped; a check whose own input is missing (e.g. thermal
 * without `partPower`) reports `notAssessed` instead of running silently.
 */
export interface OpResult {
  /** The physical electrical solve, required for copper IR-drop and ampacity. */
  copper?: import('../copper').CopperOp
  /** SPICE node name → DC voltage (V). */
  nodeVoltages: Record<string, number>
  /**
   * Current (A) flowing through a part, keyed by ref. Sign/branch detail is not
   * required by v1 checks — magnitude is what matters for ampacity/thermal.
   */
  partCurrents?: Record<string, number>
  /**
   * Signed current (A) drawn from the pad's net into the part, keyed by ref then
   * pad number. A load on a positive rail reads positive and its ground pad
   * negative (the current comes back out into the ground net). On a negative
   * rail the current runs the other way, from ground through the load into the
   * rail: the load's rail pad reads negative and its ground pad positive. Built
   * from the solve by deriveSolvedCurrents. When absent, the copper checks fall
   * back to `partCurrents` magnitudes in the load direction of each net: drawn
   * from a positive rail, returned into a negative rail and into ground.
   */
  padCurrents?: Record<string, Record<string, number>>
  /**
   * Parts that can carry current but whose pad currents the solve could not
   * resolve (two unmeasured parts share every net they touch). The copper
   * checks name them in their not-assessed line instead of treating them as
   * zero-current.
   */
  unresolvedRefs?: string[]
  /**
   * Bench supply entries (and the ground clip), one per attached lead. The
   * IR-drop and ampacity solves enter a rail at the pad nearest the lead's
   * position. A rail with no entry, or an entry without a position, falls back to
   * the connector/widest-copper heuristic and the finding says it guessed. When
   * several entries name one net the first is used.
   */
  supplyEntries?: SupplyEntry[]
  /** Absorbed power (W), the signed sum of terminal voltage times current. */
  partPower?: Record<string, number>
}
