/**
 * core/solve/types.ts
 *
 * Types for the solve seam (issue #53): what a solve needs (SolveInputs), what
 * it produces (SolveResult), and the engine it runs on (SolveEngine). Pure TS;
 * the only outside type is the SimHost wire protocol's OpSolveMethod, which is
 * itself dependency-free.
 */

import type { BoardModel } from '../kicad/types'
import type { Resolution } from '../models/types'
import type { Circuit } from '../netlist/extract'
import type { Instrument } from '../spicegen/instruments'
import type { OpSolveMethod } from '../../simhost/protocol'

// ─── engine ───────────────────────────────────────────────────────────────────

/** A DC operating point, keyed like the protocol's opResult. */
export interface OpResult {
  /** Bare lowercase node names to volts; `i(<dev>)` keys to amps. */
  values: Record<string, number>
  /** How the op converged. Absent means unknown and is treated as direct. */
  method?: OpSolveMethod
}

/** A finite transient run, whole vectors over the run. */
export interface TranResult {
  /** The scale vector (seconds). */
  time: Float64Array
  /** Every saved vector except the scale, keyed like OpResult.values. */
  vectors: Record<string, Float64Array>
}

/**
 * The engine a solve runs on. Two implementations: the SimHost client the
 * renderer uses (createSimClientEngine in this folder) and the in-process
 * ngspice engine for tests and the CLI (src/simhost/solveEngine.ts).
 *
 * Calls are applied in call order: both implementations queue commands
 * serially, so a caller may issue runOp() before a loadCircuit() promise
 * settles and the op still runs on that deck. runSolvePlan relies on this to
 * issue a pass's load and op in one synchronous turn.
 */
export interface SolveEngine {
  loadCircuit(deckLines: string[]): Promise<void>
  runOp(): Promise<OpResult>
  /**
   * Transient from initial conditions (`uic`, as the live bench runs it) to
   * `tstop` seconds with a `tstep` step.
   */
  runTran(tstep: number, tstop: number): Promise<TranResult>
}

// ─── inputs ───────────────────────────────────────────────────────────────────

/** A user model's text, inlined into the deck under `__user_model__:<mpn>`. */
export interface UserModelText {
  mpn: string
  subcktText: string
}

/**
 * Everything the bench layers over the resolved board when it builds a deck.
 * All optional: a headless caller with no bench state passes nothing.
 */
export interface SolveOverrides {
  /** Deck title (the first comment line), e.g. the board file name. */
  title?: string
  /** Bundled model-library texts, file name to contents. */
  modelTexts?: Record<string, string>
  /** In-memory user models; they win over a bundled text on key collision. */
  userModels?: Iterable<UserModelText>
  /** Tier-2 manual rail overrides keyed by net kicadName (e.g. `/VGATED`). */
  railOverrides?: ReadonlyMap<string, number>
  /**
   * Tier-3 rails measured by an earlier solve (netId to volts), reused by a
   * transient or replay deck without re-sensing.
   */
  measuredRails?: ReadonlyMap<number, number> | null
}

/**
 * One snapshot of every deck input, built once by buildSolveInputs. Every deck
 * circsim loads is buildDeck(inputs) for some SolveInputs, so the live solve,
 * the transient run, crash replay, and a headless caller cannot drift apart.
 */
export interface SolveInputs {
  /**
   * The routed board. The ideal-net deck does not read it; it is carried so the
   * copper-aware deck (#20) builds from the same snapshot. null when there is
   * no board (a synthetic circuit in a test).
   */
  board: BoardModel | null
  circuit: Circuit
  resolutions: Resolution[]
  /** Wired instruments only: an unwired shelf instrument drives nothing. */
  instruments: Instrument[]
  groundNetId: number
  title?: string
  /** Bundled texts merged with user models, in deck-lookup order. */
  modelTexts: Record<string, string>
  /** Tier-2 rail overrides resolved to netId to volts. */
  railOverrides: Map<number, number>
  /**
   * Cached tier-3 rails (netId to volts). buildDeck seeds them; runSolvePlan
   * does not, because its pass 1 is always the family-default baseline.
   */
  measuredRails?: Map<number, number>
}

// ─── result ───────────────────────────────────────────────────────────────────

/** A digital chip whose VDD rail measured below the floor at the op. */
export interface GatedOffRail {
  ref: string
  netId: number
  kicadName: string
}

/**
 * A circuit net with no path to ground in the deck. The deck held it at 0 V
 * through a 1 GOhm bleed so the matrix stays solvable; nothing on the board
 * drives it, so 0 V is not a measurement and the real net floats (issue #43).
 */
export interface UndrivenNet {
  netId: number
  kicadName: string
  spiceNode: string
}

/** What a two-pass solve produced, and which deck produced it. */
export interface SolveResult {
  /** The op to commit: pass 2's when it ran and landed, else pass 1's. */
  op: OpResult
  /** `op` mapped onto net ids (ground nets read 0 V). */
  netVoltages: Map<number, number>
  /** The deck that produced `op`. */
  deck: string[]
  /** Pass 1: the family-default baseline deck. */
  pass1Deck: string[]
  /** Pass 2's deck when a measured rail changed the circuit; set even if pass 2 failed. */
  pass2Deck?: string[]
  /**
   * 'not-needed': no measured rail changed the deck, so one pass sufficed.
   * 'solved': pass 2 ran and its op is `op`. 'failed': pass 2 did not land and
   * `op` is pass 1's.
   */
  pass2: 'not-needed' | 'solved' | 'failed'
  /** Tier-3 rails sensed from pass 1, for a later transient deck to reuse. */
  measuredRails: Map<number, number>
  /** Chips whose VDD rail measured near 0 V; the family default was kept. */
  gatedOff: GatedOffRail[]
  /** Nets the deck that produced `op` bled to 0 V because nothing drives them. */
  undrivenNets: UndrivenNet[]
}
