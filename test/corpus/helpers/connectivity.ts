/**
 * test/corpus/helpers/connectivity.ts - circsim's pad-to-net map and its
 * comparison with KiCad's.
 */

import type { BoardModel } from '../../../src/core/kicad/types'
import { ambiguousRefPredicate, type OraclePad } from './kicadOracle'

const SEP = '\t'

/** circsim's pad -> net-name map, keyed "ref<TAB>pin"; ambiguous refs (duplicates) removed. */
export function circsimPadNets(board: BoardModel): Map<string, string> {
  const ambiguous = ambiguousRefPredicate(board.footprints.map((f) => f.ref))
  const map = new Map<string, string>()
  for (const fp of board.footprints) {
    if (ambiguous(fp.ref)) continue
    for (const pad of fp.pads) {
      if (pad.netId === undefined) continue
      const net = board.netById.get(pad.netId)
      if (net) map.set(`${fp.ref}${SEP}${pad.number}`, net.name)
    }
  }
  return map
}

/** KiCad's pad -> net-name map for the same board, ambiguous refs removed. */
export function oraclePadNets(board: BoardModel, oracle: Map<string, OraclePad>): Map<string, string> {
  const ambiguous = ambiguousRefPredicate(board.footprints.map((f) => f.ref))
  const map = new Map<string, string>()
  for (const [key, pad] of oracle) {
    if (!ambiguous(key.split(SEP)[0])) map.set(key, pad.net)
  }
  return map
}

export interface ConnectivityDiff {
  missingInMine: string[]
  extraInMine: string[]
  split: string[]
}

const label = (key: string): string => key.replace(SEP, ' pad ')

/**
 * Compare two pad -> net maps by connectivity, not by name. KiCad's exporters
 * legitimately rename nets (IPC-2581 writes GND_2 when an inner copper layer is
 * called GND), so the requirement is a bijection between circsim nets and KiCad
 * nets over the shared pads: two pads on one net in one tool are on one net in
 * the other. Lists are capped at 10 entries each.
 */
export function diffConnectivity(mine: Map<string, string>, oracle: Map<string, string>): ConnectivityDiff {
  const missingInMine: string[] = []
  const extraInMine: string[] = []
  const split: string[] = []
  const mineToOracle = new Map<string, string>()
  const oracleToMine = new Map<string, string>()
  for (const [key, net] of oracle) {
    const m = mine.get(key)
    if (m === undefined) {
      missingInMine.push(`${label(key)} (KiCad: ${net})`)
      continue
    }
    const prevOracle = mineToOracle.get(m)
    const prevMine = oracleToMine.get(net)
    if ((prevOracle !== undefined && prevOracle !== net) || (prevMine !== undefined && prevMine !== m)) {
      split.push(`${label(key)}: circsim ${m}, KiCad ${net}`)
    }
    if (prevOracle === undefined) mineToOracle.set(m, net)
    if (prevMine === undefined) oracleToMine.set(net, m)
  }
  for (const [key, net] of mine) {
    if (!oracle.has(key)) extraInMine.push(`${label(key)} (circsim: ${net})`)
  }
  return { missingInMine: missingInMine.slice(0, 10), extraInMine: extraInMine.slice(0, 10), split: split.slice(0, 10) }
}

export const NO_DIFF: ConnectivityDiff = { missingInMine: [], extraInMine: [], split: [] }
