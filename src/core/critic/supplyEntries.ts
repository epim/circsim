/**
 * core/critic/supplyEntries.ts
 *
 * Builds the critic's supply entries (OpResult.supplyEntries) from the bench:
 * each wired DC supply and the ground clip, with the copper position its lead was
 * clipped at when one is recorded (issue #47). Pure; the store passes its
 * instruments and lead-position map straight in.
 */

import type { Instrument } from '../spicegen/instruments'
import { UNWIRED } from '../spicegen/instruments'
import { GROUND_LEAD_KEY, leadKey } from '../persist/sidecar'
import type { SupplyEntry } from './types'

export function buildSupplyEntries(
  instruments: readonly Instrument[],
  leadPositions: ReadonlyMap<string, { x: number; y: number }>,
  groundNetId: number | null,
): SupplyEntry[] {
  const out: SupplyEntry[] = []
  const add = (netId: number, key: string): void => {
    const p = leadPositions.get(key)
    out.push(p ? { netId, pos: { x: p.x, y: p.y } } : { netId })
  }
  for (const inst of instruments) {
    if (inst.kind === 'dc-supply' && inst.netId !== UNWIRED) add(inst.netId, leadKey(inst.id, 'net'))
  }
  if (groundNetId !== null) add(groundNetId, GROUND_LEAD_KEY)
  return out
}
