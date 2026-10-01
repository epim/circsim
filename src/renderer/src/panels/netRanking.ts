/**
 * renderer/panels/netRanking.ts (issue #72)
 *
 * Ranking and filtering for the Ground & Power pickers. The supply picker used
 * to list every named net in board order and the "Change..." ground quick-picks
 * were `slice(0, 4)` of that same order; on a board with a few hundred nets the
 * net a novice wants (the power rail, an AGND) was buried.
 *
 * Supply order: the open-time `suggestSupplies` ranking first (name evidence,
 * then pad degree), then every other net by pad degree. Ground order: nets
 * whose leaf name reads as a ground first, then the rest, each by pad degree.
 * Ties break on a natural name sort so the order is deterministic.
 */

import { suggestSupplies, type CircuitNet } from '../../../core/netlist/extract'

/** Rows a picker renders before asking the user to type a filter. */
export const MAX_PICKER_ROWS = 50

/** Last path segment of a hierarchical net name ("/Power/AGND" -> "AGND"). */
function leaf(name: string): string {
  const parts = name.split('/').filter(p => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : name
}

const GROUND_LIKE = /gnd|ground|^vss|^0v$/i

function byDegreeThenName(a: CircuitNet, b: CircuitNet): number {
  const d = b.padRefs.length - a.padRefs.length
  if (d !== 0) return d
  return a.kicadName.localeCompare(b.kicadName, undefined, { numeric: true, sensitivity: 'base' })
}

/** Nets a user may pick: named, and not SPICE node 0. */
function pickable(nets: readonly CircuitNet[]): CircuitNet[] {
  return nets.filter(n => n.id !== 0 && n.kicadName !== '')
}

/**
 * Supply-picker order. `groundNetId` is excluded (a supply there would drive
 * SPICE node 0).
 */
export function rankSupplyCandidates(
  nets: readonly CircuitNet[],
  groundNetId: number | null,
): CircuitNet[] {
  const candidates = pickable(nets).filter(n => n.id !== groundNetId)
  const suggested = suggestSupplies([...candidates])
  const suggestedIds = new Set(suggested.map(n => n.id))
  const rest = candidates.filter(n => !suggestedIds.has(n.id)).sort(byDegreeThenName)
  return [...suggested, ...rest]
}

/** Ground quick-pick order; `currentGroundId` is excluded. */
export function rankGroundCandidates(
  nets: readonly CircuitNet[],
  currentGroundId: number | null,
): CircuitNet[] {
  const candidates = pickable(nets).filter(n => n.id !== currentGroundId)
  const groundLike = candidates.filter(n => GROUND_LIKE.test(leaf(n.kicadName)))
  const rest = candidates.filter(n => !GROUND_LIKE.test(leaf(n.kicadName)))
  return [...groundLike.sort(byDegreeThenName), ...rest.sort(byDegreeThenName)]
}

/** Case-insensitive substring filter on the net name; a blank query keeps all. */
export function filterNets(nets: readonly CircuitNet[], query: string): CircuitNet[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...nets]
  return nets.filter(n => n.kicadName.toLowerCase().includes(q))
}
