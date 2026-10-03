/** Electrical fixtures use the production network in real ngspice, never a critic solver. */
import { buildCopperNetwork, emitCopperCards, type CopperOp } from '../../copper'
import type { BoardModel } from '../../kicad/types'
import type { Circuit } from '../../netlist/extract'
import type { SolveEngine } from '../../solve/types'
import { loadAndRunOp } from '../../solve/loadAndRunOp'
import { runCritic } from '../run'
import { buildContext } from '../context'
import { DEFAULT_CRITIC_OPTIONS, type CriticOptions, type OpResult } from '../types'

const SIMHOST = '../../../simhost/'
const ffi = await import(/* @vite-ignore */ SIMHOST + 'ngspiceFfi')
export const haveNativeCopper = ffi.ngspiceResourcesAvailable() as boolean

export async function nativeCopperOp(board: BoardModel, circuit: Circuit, op: OpResult, opts?: Partial<CriticOptions>): Promise<OpResult> {
  if (op.copper || (!op.padCurrents && !op.partCurrents)) return op
  const network = buildCopperNetwork(board, circuit, { ...opts, supplyEntries: op.supplyEntries })
  const deck = ['* native copper test fixture', ...emitCopperCards(network)]
  let index = 0
  for (const [netId, rail] of network.rails) {
    const name = circuit.nets.find((n) => n.id === netId)!.spiceNode
    const nominal = op.nodeVoltages[name] ?? 0
    if (!/^(0|gnd)$/i.test(name)) deck.push(`vfeed_${++index} ${name} 0 DC ${nominal}`)
    const sign = /gnd|ground|vss/i.test(circuit.nets.find((n) => n.id === netId)!.kicadName) || nominal < 0 ? -1 : 1
    const count = new Map<string, number>()
    for (const pad of rail.graph.pads) count.set(pad.ref, (count.get(pad.ref) ?? 0) + 1)
    for (const pad of rail.graph.pads) {
      if (pad.ref === rail.source?.ref) continue
      const amps = op.padCurrents ? op.padCurrents[pad.ref]?.[pad.padNumber] :
        op.partCurrents?.[pad.ref] !== undefined ? sign * Math.abs(op.partCurrents[pad.ref]) / count.get(pad.ref)! : undefined
      if (amps !== undefined) deck.push(`iload_${++index} ${network.padNode(pad.ref, pad.padNumber)} 0 DC ${amps}`)
    }
  }
  for (const node of network.nodes) if (node.name !== '0') deck.push(`rbleed_${++index} ${node.name} 0 1e12`)
  deck.push('.save all', '.end')
  const { createInProcessSolveEngine } = await import(/* @vite-ignore */ SIMHOST + 'solveEngine') as {
    createInProcessSolveEngine(opts?: { onEvent: (event: unknown) => void }): Promise<SolveEngine & { dispose(): Promise<void> }>
  }
  const engine = await createInProcessSolveEngine()
  try {
    const result = await loadAndRunOp(engine, deck)
    const nodeVoltages = { ...result.values, '0': 0 }
    const copper: CopperOp = {
      network, nodeVoltages, padCurrents: op.padCurrents ?? {}, padVoltages: {}, partPower: {},
      edgeCurrents: network.edges.map((e) => (nodeVoltages[network.nodes[e.a].name] - nodeVoltages[network.nodes[e.b].name]) / e.ohms),
    }
    return { ...op, copper }
  } finally { await engine.dispose() }
}

export async function nativeRunCritic(board: BoardModel, circuit: Circuit, op?: OpResult, opts?: Partial<CriticOptions>) {
  return runCritic(board, circuit, op ? await nativeCopperOp(board, circuit, op, opts) : undefined, opts)
}

export async function nativeBuildContext(board: BoardModel, circuit: Circuit, op: OpResult | undefined, opts: CriticOptions = DEFAULT_CRITIC_OPTIONS) {
  return buildContext(board, circuit, op ? await nativeCopperOp(board, circuit, op, opts) : undefined, opts)
}
