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
import { resolveAll, type BomData } from '../../../core/models/resolve'
import type { LibraryEntry, PinMap, Resolution } from '../../../core/models/types'
import { parseBom } from '../../../core/bom/parseBom'
import { runCritic } from '../../../core/critic/run'
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
  if (req.bomText) bom = parseBom(req.bomText).rows

  // Extract once (no ground) to run the ground heuristic, then re-extract WITH
  // the designated ground so circuit.nets[].spiceNode is "0" for ground
  // (generateDeck relies on this, Spec 8.8).
  onStage?.('extracting')
  const probe = extract(board)
  const gnd = suggestGround(probe.nets)
  const supplies = suggestSupplies(probe.nets)
  const groundNetId = gnd?.id ?? null
  const circuit = groundNetId !== null ? extract(board, { groundNetId }) : probe

  // A fresh open has no stub or pin-map overrides, so resolveAll alone is the
  // whole resolution.
  onStage?.('resolving')
  const resolutions = resolveAll(
    circuit,
    schematicSimData ?? undefined,
    bom ?? undefined,
    req.library.length > 0 ? req.library : undefined,
    undefined,
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
      resolutions,
    },
  }
}

/**
 * The no-simulation audit a fresh open runs (floating, clearance, decoupling,
 * loop area; the op-dependent checks are reported as skipped). Read-only.
 */
export function auditOpenedBoard(opened: Pick<OpenedBoard, 'board' | 'circuit'>): CriticReport {
  return runCritic(opened.board, opened.circuit, undefined)
}
