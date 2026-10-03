import type { Circuit } from '../netlist/extract'
import type { OpResult } from './types'

/** Derive dissipation only when every connected terminal has solved current and voltage. */
export function derivePartPower(circuit: Circuit, op: OpResult): Record<string, number> | undefined {
  if (op.copper) return Object.keys(op.copper.partPower).length > 0 ? op.copper.partPower : undefined
  if (!op.padCurrents) return undefined
  const powers: Record<string, number> = {}
  for (const part of circuit.parts) {
    if (op.unresolvedRefs?.includes(part.ref)) continue
    const currents = op.padCurrents[part.ref]
    if (!currents || part.padNet.size === 0) continue
    let watts = 0
    const potentials: number[] = []
    let complete = true
    for (const [pad, netId] of part.padNet) {
      const node = circuit.nets.find((n) => n.id === netId)?.spiceNode
      const volts = node === '0' ? 0 : node ? op.nodeVoltages[node] : undefined
      const amps = currents[pad]
      if (volts === undefined || amps === undefined || !Number.isFinite(volts) || !Number.isFinite(amps)) { complete = false; break }
      watts += volts * amps
      potentials.push(volts)
    }
    if (complete && Math.max(...potentials) - Math.min(...potentials) > 1e-6) powers[part.ref] = Math.max(0, watts)
  }
  return Object.keys(powers).length > 0 ? powers : undefined
}
