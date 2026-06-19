/**
 * core/critic/classify.ts
 *
 * Shared rail classifier for the Board Critic. Decides which nets are power
 * rails and which are ground, so checks (decoupling, ampacity, …) all agree on
 * a single definition.
 *
 * Classification combines two signals:
 *   - NAME-BASED: reuse suggestSupplies/suggestGround (VCC, +5V, GND, VSS, …),
 *     including hierarchical forms like "/Power/+5V".
 *   - INFERRED: a net that ≥2 distinct bypass caps each bridge to a ground net
 *     is treated as a power rail — this catches real boards whose rails carry
 *     non-standard names (e.g. "/VBUS_C") but are clearly decoupled like a rail.
 *
 * Pure core: no electron/react/three imports. Deterministic — nets and parts
 * are iterated in sorted id / ref order so results never depend on Map order.
 */

import type { Circuit, Part } from '../netlist/extract'
import { suggestSupplies, suggestGround } from '../netlist/extract'
import type { CriticContext } from './context'
import { parseValue } from '../values/parseValue'

/** A bypass cap is small-signal: ≤ 1 µF. Bulk/electrolytics don't count. */
const BYPASS_MAX_FARAD = 1e-6
/** A net needs at least this many bridging bypass caps to be inferred as a rail. */
const MIN_INFER_CAPS = 2

/** True if `part` looks like a bypass cap (C-ref, ≤1µF or unparseable value). */
function isBypassCap(part: Part): boolean {
  if (!/^C/i.test(part.ref)) return false
  const farads = parseValue(part.value, 'C')
  // Unparseable values still count as candidates (per spec).
  return farads === undefined ? true : farads <= BYPASS_MAX_FARAD
}

/**
 * Classify the circuit's nets into power rails and ground.
 *
 * @returns sets of netIds. A net is never in both: ground wins, and the power
 *   set has the ground set subtracted from it.
 */
export function classifyRails(
  circuit: Circuit,
  _ctx: CriticContext,
): { powerNetIds: Set<number>; groundNetIds: Set<number> } {
  // ── ground: a net counts as ground if suggestGround returns it alone ─────────
  const groundNetIds = new Set<number>()
  for (const n of [...circuit.nets].sort((a, b) => a.id - b.id)) {
    if (suggestGround([n])) groundNetIds.add(n.id)
  }

  // ── name-based power rails ───────────────────────────────────────────────────
  const powerNetIds = new Set<number>(suggestSupplies(circuit.nets).map((n) => n.id))

  // ── inferred power rails: ≥2 distinct bypass caps bridging N → ground ────────
  // Per candidate net N (not ground), count distinct bypass caps that have one
  // pad on N and another pad on a ground net.
  const bridgeCapsByNet = new Map<number, Set<string>>()
  for (const part of [...circuit.parts].sort((a, b) => a.ref.localeCompare(b.ref))) {
    if (!isBypassCap(part)) continue
    const nets = new Set(part.padNet.values())
    const touchesGround = [...nets].some((n) => groundNetIds.has(n))
    if (!touchesGround) continue
    for (const N of nets) {
      if (groundNetIds.has(N)) continue
      let set = bridgeCapsByNet.get(N)
      if (!set) {
        set = new Set<string>()
        bridgeCapsByNet.set(N, set)
      }
      set.add(part.ref)
    }
  }
  for (const N of [...bridgeCapsByNet.keys()].sort((a, b) => a - b)) {
    if ((bridgeCapsByNet.get(N)?.size ?? 0) >= MIN_INFER_CAPS) powerNetIds.add(N)
  }

  // ── power minus ground (ground always wins) ──────────────────────────────────
  for (const g of groundNetIds) powerNetIds.delete(g)

  return { powerNetIds, groundNetIds }
}
