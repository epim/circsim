/**
 * core/critic/context.ts
 *
 * Shared, precomputed context handed to every Board Critic check. Built once per
 * `runCritic` call so checks don't each rebuild ref→footprint / ref→part maps.
 */

import type { BoardModel, Footprint } from '../kicad/types'
import type { Circuit, Part } from '../netlist/extract'
import type { CriticOptions, OpResult } from './types'

export interface CriticContext {
  board: BoardModel
  circuit: Circuit
  opResult?: OpResult
  opts: CriticOptions
  /** ref → footprint (geometry: pad offsets, courtyard, position). */
  refToFootprint: Map<string, Footprint>
  /** ref → circuit part (padNet map, value, properties). */
  refToPart: Map<string, Part>
}

export function buildContext(
  board: BoardModel,
  circuit: Circuit,
  opResult: OpResult | undefined,
  opts: CriticOptions,
): CriticContext {
  const refToFootprint = new Map<string, Footprint>()
  for (const fp of board.footprints) refToFootprint.set(fp.ref, fp)
  const refToPart = new Map<string, Part>()
  for (const p of circuit.parts) refToPart.set(p.ref, p)
  return { board, circuit, opResult, opts, refToFootprint, refToPart }
}
