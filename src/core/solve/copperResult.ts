import { padSenseName, type CopperOp } from '../copper'
import { reduceCopperNetwork } from '../copper/kron'
import type { SolveInputs, OpResult } from './types'

/** Read the final native operating point. No second electrical solver or injected loads. */
export function copperResult(inputs: SolveInputs, op: OpResult, deck: readonly string[]): CopperOp | undefined {
  const network = inputs.copperNetwork
  if (!inputs.copperAware || !network) return undefined
  const solved = op.method !== 'failed'
  const nativeVoltages = solved ? { ...op.values, '0': 0 } : { '0': 0 }
  const nodeVoltages: Record<string, number> = solved && deck.includes('* copper mesh Kron-reduced onto pad terminals')
    ? reduceCopperNetwork(network).recoverVoltages(nativeVoltages) : nativeVoltages
  const padVoltages: CopperOp['padVoltages'] = {}
  const padCurrents: CopperOp['padCurrents'] = {}
  const partPower: Record<string, number> = {}
  const meters = new Set(deck.map((line) => line.split(/\s+/)[0].toLowerCase()))
  const resolutionByRef = new Map(inputs.resolutions.map((r) => [r.ref, r]))
  const netById = new Map(inputs.circuit.nets.map((n) => [n.id, n]))
  for (const part of inputs.circuit.parts) {
    const res = resolutionByRef.get(part.ref)
    if (!res?.model) {
      // Omitted parts have no deck element and cannot carry modeled current.
      if (solved) {
        padCurrents[part.ref] = Object.fromEntries([...part.padNet.keys()].map((p) => [p, 0]))
        partPower[part.ref] = 0
      }
      continue
    }
    if (res.model.kind === 'stub') continue
    const volts: Record<string, number> = {}
    const currents: Record<string, number> = {}
    const modeledPads = res.model.kind === 'primitive' ? [...part.padNet.keys()] : Object.keys(res.model.pinMap)
    for (const pad of modeledPads) {
      const netId = part.padNet.get(pad)
      if (netId === undefined) continue
      const node = network.padNode(part.ref, pad) ?? netById.get(netId)?.spiceNode
      const sense = padSenseName(part.ref, pad)
      const v = solved && node ? nodeVoltages[node.toLowerCase()] : undefined
      const i = solved && meters.has(sense) ? op.values[`i(${sense})`] : undefined
      if (v !== undefined && Number.isFinite(v)) volts[pad] = v
      if (i !== undefined && Number.isFinite(i)) currents[pad] = i
    }
    padVoltages[part.ref] = volts
    padCurrents[part.ref] = currents
    const connected = modeledPads.every((pad) => network.padConnection(part.ref, pad)?.connectedToSource !== false)
    const potentials = Object.values(volts)
    const energized = potentials.length > 1 && Math.max(...potentials) - Math.min(...potentials) > 1e-6
    // A connected idle part has known zero power. Stranded, equipotential
    // terminals remain unknown; an energized IC may have other floating inputs
    // without losing the dissipation measured at its powered terminals.
    if ((connected || energized) && Object.keys(currents).length > 0 && Object.keys(currents).every((p) => volts[p] !== undefined)
      && modeledPads.filter((p) => part.padNet.has(p)).every((p) => currents[p] !== undefined)) {
      // Signed terminal power counts output energy delivered by an IC once.
      partPower[part.ref] = Math.max(0, Object.keys(currents).reduce((sum, p) => sum + volts[p] * currents[p], 0))
    }
  }
  const edgeCurrents = network.edges.map((e) => {
    const a = nodeVoltages[network.nodes[e.a].name.toLowerCase()]
    const b = nodeVoltages[network.nodes[e.b].name.toLowerCase()]
    return a !== undefined && b !== undefined ? (a - b) / e.ohms : NaN
  })
  return { network, method: op.method, unreachedPads: network.unreachedPads, nodeVoltages, padVoltages, padCurrents, edgeCurrents, partPower }
}
