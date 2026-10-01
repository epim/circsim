/**
 * src/cli/criticOp.ts
 *
 * Builds the Board Critic's OpResult from a solve, for the headless CLI (issue
 * #28). This is the renderer store's buildCriticOpResult plus its LED-current
 * mapping (mapOpResultToCurrents), which live in appStore.ts and cannot be
 * imported outside the renderer. TODO: move both into core/critic and have the
 * store and this file share them (the store is outside this task's lane).
 */

import type { OpResult as CriticOpResult } from '../core/critic/types'
import type { Resolution } from '../core/models/types'
import type { Circuit } from '../core/netlist/extract'
import { buildLedSpiceNames } from '../core/spicegen/generate'
import type { SolveResult } from '../core/solve'

/**
 * nodeVoltages is keyed by SPICE node name (the critic's IR-drop and thermal
 * math works in spice-node space); partCurrents carries each LED's ammeter
 * current by ref, the only per-part currents the op harvests today.
 */
export function buildCriticOpFromSolve(
  circuit: Circuit,
  resolutions: Resolution[],
  solved: SolveResult,
): CriticOpResult | undefined {
  if (solved.netVoltages.size === 0) return undefined

  const netToNode = new Map<number, string>()
  for (const net of circuit.nets) netToNode.set(net.id, net.spiceNode)
  const nodeVoltages: Record<string, number> = {}
  for (const [netId, volts] of solved.netVoltages) {
    const node = netToNode.get(netId)
    if (node !== undefined) nodeVoltages[node] = volts
  }

  const lower = new Map<string, number>()
  for (const [k, v] of Object.entries(solved.op.values)) lower.set(k.toLowerCase(), v)
  const partCurrents: Record<string, number> = {}
  for (const [ref, senseName] of buildLedSpiceNames(resolutions, circuit)) {
    const dev = senseName.toLowerCase()
    for (const key of [`i(${dev})`, `${dev}#branch`, `@${dev}[i]`, `i(@${dev})`]) {
      const v = lower.get(key)
      if (v !== undefined) {
        partCurrents[ref] = Math.abs(v)
        break
      }
    }
  }

  return {
    nodeVoltages,
    partCurrents: Object.keys(partCurrents).length > 0 ? partCurrents : undefined,
  }
}
