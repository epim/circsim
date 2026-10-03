import type { Circuit } from '../netlist/extract'
import type { OpResult } from './types'

/** Derive dissipation only when every connected terminal has solved current and voltage. */
export function derivePartPower(circuit: Circuit, op: OpResult): Record<string, number> | undefined {
  if (op.copper) return Object.keys(op.copper.partPower).length > 0 ? op.copper.partPower : undefined
  if (!op.padCurrents) return undefined
  const powers: Record<string, number> = {}
  const netById = new Map(circuit.nets.map((n) => [n.id, n]))
  for (const part of circuit.parts) {
    if (op.unresolvedRefs?.includes(part.ref)) continue
    const currents = op.padCurrents[part.ref]
    if (!currents || part.padNet.size === 0) continue
    let watts = 0
    let complete = true
    for (const [pad, netId] of part.padNet) {
      const node = netById.get(netId)?.spiceNode
      const volts = node === '0' ? 0 : node ? op.nodeVoltages[node] : undefined
      const amps = currents[pad]
      if (volts === undefined || amps === undefined || !Number.isFinite(volts) || !Number.isFinite(amps)) { complete = false; break }
      watts += volts * amps
    }
    if (complete) powers[part.ref] = Math.max(0, watts)
  }
  return Object.keys(powers).length > 0 ? powers : undefined
}
