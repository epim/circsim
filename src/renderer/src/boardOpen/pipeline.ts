/**
 * renderer/boardOpen/pipeline.ts (issue #55)
 *
 * The board-open pipeline as plain functions: parse, extract (twice, once to
 * pick the ground), resolve, then the Board Critic audit. No store, no DOM, no
 * Electron, no Three: everything here is src/core plus structured-clone-safe
 * inputs and outputs, so the same code runs in a Worker (production) or inline
 * (tests, and the fallback when a Worker cannot start).
 *
 * The audit is a separate function because it dominates the cost on large
 * boards (the clearance check is quadratic in track count) and the UI wants the
 * board on screen before it runs.
 */

import { parseBoard } from '../../../core/kicad/board'
import { parseSchematicSimData, type SchematicSimData } from '../../../core/kicad/schematic'
import type { BoardModel } from '../../../core/kicad/types'
import { extract, suggestGround, suggestSupplies, type Circuit } from '../../../core/netlist/extract'
import { resolveAll, type BomData, type UserStubOverride } from '../../../core/models/resolve'
import type { LibraryEntry, PinMap, Resolution } from '../../../core/models/types'
import { parseBom, type BomParseResult } from '../../../core/bom/parseBom'
import { loadSidecar, type LoadOutcome } from '../../../core/persist/sidecar'
import { exportStaticOutputs, runCritic, type StaticOutputs } from '../../../core/critic/run'
import type { CriticReport } from '../../../core/critic/types'

/** The stages the UI reports while a board opens, in order. */
export type OpenStage = 'parsing' | 'extracting' | 'resolving' | 'auditing'

/** Display text for each stage; one source so the UI and tests agree. */
export const OPEN_STAGE_LABEL: Record<OpenStage, string> = {
  parsing: 'Parsing board',
  extracting: 'Extracting netlist',
  resolving: 'Resolving parts',
  auditing: 'Running Board Critic',
}

/** Everything the pipeline needs. Structured-clone safe. */
export interface OpenRequest {
  boardText: string
  schematicText?: string
  schematicFileName?: string
  bomText?: string
  /**
   * Text of the per-board setup file read beside the board (issue #27), when
   * there is one. The pipeline restores it between the ground probe and the
   * final extract, because it can name the ground and the model overrides the
   * resolution must see.
   */
  sidecarText?: string
  /**
   * The library resolveAll matches against: user-model entries first, then the
   * bundled library (see buildEffectiveLibrary). Passed in because the worker
   * has no access to the store.
   */
  library: LibraryEntry[]
}

/** The result of the stages that precede the audit. Structured-clone safe. */
export interface OpenedBoard {
  board: BoardModel
  circuit: Circuit
  groundNetId: number | null
  suggestedSupplyNetIds: number[]
  schematicSimData: SchematicSimData | null
  schematicFileName: string | null
  bom: BomData | null
  /** The BOM parse result (errors, unmatched rows), for the load notes. */
  bomParsed: BomParseResult | null
  /** What loadSidecar made of `sidecarText`; null when none was supplied. */
  restore: LoadOutcome | null
  resolutions: Resolution[]
}

export interface OpenFailure {
  message: string
  line?: number
  col?: number
}

export type OpenOutcome = { ok: true; opened: OpenedBoard } | { ok: false; error: OpenFailure }

/** A user-model shape reduced to what the effective library needs. */
export interface UserModelLibrarySource {
  mpn: string
  subcktName: string
  pinMap: PinMap
  provenance: LibraryEntry['provenance']
}

/**
 * User models become library entries ahead of the bundled library, so a user
 * model wins tier-3/4 matching. The deck generator reads the text through the
 * virtual path `__user_model__:<mpn>`.
 */
export function buildEffectiveLibrary(
  userModels: Iterable<UserModelLibrarySource>,
  library: LibraryEntry[],
): LibraryEntry[] {
  const entries: LibraryEntry[] = []
  for (const um of userModels) {
    entries.push({
      id: `user-model-${um.mpn}`,
      match: { mpn: [um.mpn] },
      model: {
        type: 'subckt',
        file: `__user_model__:${um.mpn}`,
        name: um.subcktName,
      },
      pinMaps: { '.*': um.pinMap },
      defaultPinMap: um.pinMap,
      provenance: um.provenance,
    })
  }
  return [...entries, ...library]
}

/**
 * Resolve every part, then apply the Model Doctor's pin-map overrides. resolveAll
 * does not take them (they correct a resolved model's terminal mapping, not which
 * model is chosen), so they are applied after, for every part the user re-mapped.
 * Shared by the board-open pipeline and the store's reResolve.
 */
export function resolveWithOverrides(
  circuit: Circuit,
  schematicSimData: SchematicSimData | null,
  bom: BomData | null,
  library: LibraryEntry[],
  stubOverrides: Map<string, UserStubOverride>,
  pinMapOverrides: Map<string, PinMap>,
): Resolution[] {
  const resolved = resolveAll(
    circuit,
    schematicSimData ?? undefined,
    bom ?? undefined,
    library.length > 0 ? library : undefined,
    stubOverrides.size > 0 ? stubOverrides : undefined,
  )
  if (pinMapOverrides.size === 0) return resolved
  return resolved.map(r => {
    const override = pinMapOverrides.get(r.ref)
    if (override && r.model && 'pinMap' in r.model) {
      return { ...r, model: { ...r.model, pinMap: override } }
    }
    return r
  })
}

/**
 * Parse, extract and resolve. A board that does not parse is a value, not a
 * throw, so it crosses a worker boundary intact (an Error would lose its line
 * and column). Anything else that throws is a bug and propagates.
 *
 * `onStage` fires as each stage begins.
 */
export function openBoardPipeline(
  req: OpenRequest,
  onStage?: (stage: OpenStage) => void,
): OpenOutcome {
  onStage?.('parsing')
  let board: BoardModel
  try {
    board = parseBoard(req.boardText)
  } catch (err) {
    const e = err as { message?: string; line?: number; col?: number }
    return { ok: false, error: { message: e.message ?? String(err), line: e.line, col: e.col } }
  }

  // Optional schematic. A bad one must not block the board.
  let schematicSimData: SchematicSimData | null = null
  let schematicFileName: string | null = null
  if (req.schematicText) {
    try {
      schematicSimData = parseSchematicSimData(req.schematicText)
      schematicFileName = req.schematicFileName ?? null
    } catch {
      schematicSimData = null
    }
  }

  let bom: BomData | null = null
  let bomParsed: BomParseResult | null = null
  if (req.bomText) {
    bomParsed = parseBom(req.bomText)
    bom = bomParsed.rows
  }

  // Extract once (no ground) to run the ground heuristic, then re-extract WITH
  // the designated ground so circuit.nets[].spiceNode is "0" for ground
  // (generateDeck relies on this, Spec 8.8).
  onStage?.('extracting')
  const probe = extract(board)
  const gnd = suggestGround(probe.nets)
  const supplies = suggestSupplies(probe.nets)

  // Per-board setup file (issue #27): restore ground, bench, overrides and user
  // models saved beside the board. loadSidecar never throws and never blocks the
  // open: a v0, truncated, damaged or newer file yields whatever could be
  // restored plus notes on the rest.
  const restore =
    typeof req.sidecarText === 'string'
      ? loadSidecar(req.sidecarText, {
          nets: probe.nets,
          partRefs: new Set(probe.parts.map(p => p.ref)),
        })
      : null
  const plan = restore?.plan ?? null

  const groundNetId = plan?.ground ? plan.ground.netId : (gnd?.id ?? null)
  const circuit = groundNetId !== null ? extract(board, { groundNetId }) : probe

  // The restored overrides and user models are part of the resolution: user
  // models go ahead of the library (they win tier-3/4 matching), stub and
  // pin-map overrides apply as they do in the store's reResolve.
  onStage?.('resolving')
  const library =
    plan && plan.userModels.size > 0 ? buildEffectiveLibrary(plan.userModels.values(), req.library) : req.library
  const resolutions = resolveWithOverrides(
    circuit,
    schematicSimData,
    bom,
    library,
    plan?.stubOverrides ?? new Map(),
    plan?.pinMapOverrides ?? new Map(),
  )

  return {
    ok: true,
    opened: {
      board,
      circuit,
      groundNetId,
      suggestedSupplyNetIds: supplies.map(s => s.id),
      schematicSimData,
      schematicFileName,
      bom,
      bomParsed,
      restore,
      resolutions,
    },
  }
}

/** The audit report plus the no-sim check outputs it memoised (see exportStaticOutputs). */
export interface OpenAudit {
  report: CriticReport
  staticOutputs: StaticOutputs | null
}

/**
 * The no-simulation audit a fresh open runs (floating, clearance, decoupling,
 * loop area; the op-dependent checks are reported as skipped). Read-only.
 *
 * Also returns the memoised no-sim outputs: when this runs in the Worker, the
 * main thread primes its own critic cache with them, so the re-audit that
 * follows an operating point does not pay for the clearance check again on the
 * UI thread (issue #97 gating).
 */
export function auditOpened(opened: Pick<OpenedBoard, 'board' | 'circuit'>): OpenAudit {
  const report = runCritic(opened.board, opened.circuit, undefined)
  return { report, staticOutputs: exportStaticOutputs(opened.circuit) }
}

/** The audit report alone. */
export function auditOpenedBoard(opened: Pick<OpenedBoard, 'board' | 'circuit'>): CriticReport {
  return auditOpened(opened).report
}
