import { padSenseName, type CopperOp } from '../copper'
import type { SolveInputs, OpResult } from './types'

/** Read the final native operating point. No second electrical solver or injected loads. */
export function copperResult(inputs: SolveInputs, op: OpResult, deck: readonly string[]): CopperOp | undefined {
  const network = inputs.copperNetwork
  if (!inputs.copperAware || !network || op.method === 'failed') return undefined
  const nodeVoltages = { ...op.values, '0': 0 }
  const padVoltages: CopperOp['padVoltages'] = {}
  const padCurrents: CopperOp['padCurrents'] = {}
  const partPower: Record<string, number> = {}
  const meters = new Set(deck.map((line) => line.split(/\s+/)[0].toLowerCase()))
  for (const part of inputs.circuit.parts) {
    const res = inputs.resolutions.find((r) => r.ref === part.ref)
    if (!res?.model || res.model.kind === 'stub') continue
    const volts: Record<string, number> = {}
    const currents: Record<string, number> = {}
    const modeledPads = res.model.kind === 'primitive' ? [...part.padNet.keys()] : Object.keys(res.model.pinMap)
    for (const pad of modeledPads) {
      const netId = part.padNet.get(pad)
      if (netId === undefined) continue
      const node = network.padNode(part.ref, pad) ?? inputs.circuit.nets.find((n) => n.id === netId)?.spiceNode
      const sense = padSenseName(part.ref, pad)
      const v = node === '0' ? 0 : node ? op.values[node.toLowerCase()] : undefined
      const i = meters.has(sense) ? op.values[`i(${sense})`] : undefined
      if (v !== undefined && Number.isFinite(v)) volts[pad] = v
      if (i !== undefined && Number.isFinite(i)) currents[pad] = i
    }
    padVoltages[part.ref] = volts
    padCurrents[part.ref] = currents
    const potentials = Object.values(volts)
    const energized = potentials.length > 1 && Math.max(...potentials) - Math.min(...potentials) > 1e-6
    if (energized && Object.keys(currents).length > 0 && Object.keys(currents).every((p) => volts[p] !== undefined)
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
  return { network, nodeVoltages, padVoltages, padCurrents, edgeCurrents, partPower }
}
