import type { Circuit } from '../netlist/extract'
import type { CriticContext } from './context'
import { classifyCopperRails } from '../copper/classify'

/** Share inferred rails with the network and include explicitly driven physical nets. */
export function classifyRails(circuit: Circuit, ctx?: CriticContext): { powerNetIds: Set<number>; groundNetIds: Set<number> } {
  const rails = classifyCopperRails(circuit)
  const network = ctx?.opResult?.copper?.network
  for (const id of network?.powerNetIds ?? network?.rails.keys() ?? []) {
    if (!rails.groundNetIds.has(id)) rails.powerNetIds.add(id)
  }
  return rails
}
