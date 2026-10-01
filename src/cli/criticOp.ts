/**
 * src/cli/criticOp.ts
 *
 * Builds the Board Critic's OpResult from a solve, for the headless CLI (issue
 * #28). This mirrors the renderer store's buildCriticOpResult (appStore.ts),
 * which cannot be imported outside the renderer: node voltages by spice node,
 * and every part's branch currents from deriveSolvedCurrents (#9, #45) so the
 * copper checks (ir-drop, ampacity) run. When the derivation throws, the LED
 * ammeter currents are used instead, as the store does. TODO: move
 * buildCriticOpResult into core/critic and share it (the store is outside this
 * task's lane).
 */

import type { OpResult as CriticOpResult } from '../core/critic/types'
import { deriveSolvedCurrents } from '../core/critic/solvedCurrents'
import type { Resolution } from '../core/models/types'
import type { Circuit } from '../core/netlist/extract'
import { buildLedSpiceNames } from '../core/spicegen/generate'
import type { SolveResult } from '../core/solve'

/**
 * nodeVoltages is keyed by SPICE node name (the critic's IR-drop and thermal
 * math works in spice-node space); partCurrents/padCurrents/unresolvedRefs come
 * from the solve's branch currents.
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

  try {
    const currents = deriveSolvedCurrents({ circuit, resolutions }, solved)
    return {
      nodeVoltages,
      partCurrents: currents.partCurrents,
      padCurrents: currents.padCurrents,
      unresolvedRefs: currents.unresolvedRefs,
    }
  } catch {
    // A derivation failure leaves the critic on LED currents only, as the store does.
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
