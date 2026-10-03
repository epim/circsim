import type { BoardModel, Vec2 } from '../kicad/types'
import type { Circuit } from '../netlist/extract'
import type { OpSolveMethod } from '../../simhost/protocol'
import { classifyCopperRails } from './classify'
import { buildRailGraph, type GraphEdge, type RailGraph, type RailPad } from './graph'

export interface CopperOptions {
  copperOz?: number
  zoneMeshMm?: number
  groundNetId?: number
  /** Include supply-driven rails with nonstandard names. */
  netIds?: Iterable<number>
  supplyEntries?: readonly { netId: number; pos?: Vec2 }[]
}

export type EntryBasis =
  | { kind: 'lead'; pos: Vec2; snapMm: number }
  | { kind: 'guess'; why: 'no-supply' | 'no-position' }

export interface CopperNode { id: number; name: string; netId: number; pos: Vec2; layer: string }
export interface CopperEdge extends GraphEdge { netId: number; railEdge: number }
export interface CopperRail {
  graph: RailGraph
  nodeNames: string[]
  source?: RailPad
  entry: EntryBasis
}
export interface CopperPadConnection {
  ref: string
  padNumber: string
  netId: number
  hasCopper: boolean
  /** The entry itself is reachable even when a lead clips directly to a bare pad. */
  connectedToSource: boolean
  isSource: boolean
}
export interface CopperNetwork {
  copperOz: number
  zoneMeshMm: number
  nodes: CopperNode[]
  edges: CopperEdge[]
  rails: Map<number, CopperRail>
  /** Pads without copper contacts or outside their entry's connected component. */
  unreachedPads: CopperPadConnection[]
  padNode(ref: string, pad: string): string | undefined
  padConnection(ref: string, pad: string): CopperPadConnection | undefined
}

/** Power and ground copper, with contact bonds contracted before SPICE emission. */
export function buildCopperNetwork(board: BoardModel, circuit: Circuit, opts: CopperOptions = {}): CopperNetwork {
  const copperOz = opts.copperOz ?? 1
  const zoneMeshMm = opts.zoneMeshMm ?? 2
  if (!(copperOz > 0) || !Number.isFinite(copperOz) || !(zoneMeshMm > 0) || !Number.isFinite(zoneMeshMm)) {
    throw new Error('Copper weight and pour mesh pitch must be finite and positive')
  }
  const classified = classifyCopperRails(circuit)
  const netIds = new Set([...classified.powerNetIds, ...classified.groundNetIds, ...(opts.netIds ?? [])])
  if (opts.groundNetId !== undefined) netIds.add(opts.groundNetId)
  const nodes: CopperNode[] = []
  const edges: CopperEdge[] = []
  const rails = new Map<number, CopperRail>()
  const pads = new Map<string, string>()
  const connections = new Map<string, CopperPadConnection>()
  const unreachedPads: CopperPadConnection[] = []
  const netById = new Map(circuit.nets.map((n) => [n.id, n]))
  const occupied = new Set(circuit.nets.map((n) => n.spiceNode))
  for (const netId of [...netIds].sort((a, b) => a - b)) {
    const net = netById.get(netId)
    if (!net) continue
    const graph = buildRailGraph({ board, circuit, opts: { copperOz, zoneMeshMm } }, netId)
    const parent = graph.nodePos.map((_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
      return i
    }
    for (const e of graph.edges) if (e.kind === 'short') parent[find(e.b)] = find(e.a)
    const attached = opts.supplyEntries?.find((e) => e.netId === netId)
    const connected = [...graph.pads].sort((a, b) => a.ref.localeCompare(b.ref) || a.padNumber.localeCompare(b.padNumber))
    const candidates = connected.filter((p) => p.contacts.length > 0)
    const available = candidates.length > 0 ? candidates : connected
    const pos = attached?.pos
    let source: RailPad | undefined = available.find((p) => /^(J|P|CN|CON|X)\d+$/i.test(p.ref)) ?? available[0]
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      source = connected.reduce<RailPad | undefined>((best, p) =>
        !best || Math.hypot(p.pos.x - pos.x, p.pos.y - pos.y) < Math.hypot(best.pos.x - pos.x, best.pos.y - pos.y) ? p : best, undefined)
    } else if (!source || !/^(J|P|CN|CON|X)\d+$/i.test(source.ref)) {
      source = [...available].sort((a, b) =>
        Math.max(0, ...b.contacts.map((n) => graph.nodeMaxTrackW[n] ?? 0)) -
        Math.max(0, ...a.contacts.map((n) => graph.nodeMaxTrackW[n] ?? 0)))[0]
    }
    const entry: EntryBasis = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && source
      ? { kind: 'lead', pos: { ...pos }, snapMm: Math.hypot(source.pos.x - pos.x, source.pos.y - pos.y) }
      : { kind: 'guess', why: attached ? 'no-position' : 'no-supply' }
    const anchor = source?.node ?? 0
    const neighbors: number[][] = graph.nodePos.map(() => [])
    for (const edge of graph.edges) {
      neighbors[edge.a].push(edge.b)
      neighbors[edge.b].push(edge.a)
    }
    const reached = new Set<number>()
    const pending = source ? [source.node] : []
    while (pending.length > 0) {
      const node = pending.pop()!
      if (reached.has(node)) continue
      reached.add(node)
      pending.push(...neighbors[node].filter((n) => !reached.has(n)))
    }
    const rootToId = new Map<number, number>()
    const nodeNames = graph.nodePos.map((p, i) => {
      const root = find(i)
      let id = rootToId.get(root)
      if (id === undefined) {
        id = nodes.length
        rootToId.set(root, id)
        const alias = /^(0|gnd)$/i.test(net.spiceNode) ? '0' : net.spiceNode
        let name = root === find(anchor) ? alias : `cu_${netId}_${root}`
        if (root !== find(anchor)) {
          while (occupied.has(name)) name += '_'
          occupied.add(name)
        }
        nodes.push({ id, name, netId, pos: p, layer: graph.nodeLayer[i] })
      }
      return nodes[id].name
    })
    graph.edges.forEach((e, railEdge) => {
      const a = rootToId.get(find(e.a))!
      const b = rootToId.get(find(e.b))!
      if (a !== b && e.kind !== 'short') edges.push({ ...e, a, b, netId, railEdge })
    })
    for (const p of graph.pads) {
      const key = padKey(p.ref, p.padNumber)
      pads.set(key, nodeNames[p.node])
      const connection: CopperPadConnection = {
        ref: p.ref, padNumber: p.padNumber, netId, hasCopper: p.contacts.length > 0,
        connectedToSource: reached.has(p.node), isSource: p === source,
      }
      connections.set(key, connection)
      if (!connection.hasCopper || !connection.connectedToSource) unreachedPads.push(connection)
    }
    rails.set(netId, { graph, nodeNames, source, entry })
  }
  return {
    copperOz, zoneMeshMm, nodes, edges, rails, unreachedPads,
    padNode: (ref, pad) => pads.get(padKey(ref, pad)),
    padConnection: (ref, pad) => connections.get(padKey(ref, pad)),
  }
}

export function emitCopperCards(network: CopperNetwork): string[] {
  return network.edges.map((e, i) => `r_copper_${i + 1} ${network.nodes[e.a].name} ${network.nodes[e.b].name} ${e.ohms.toPrecision(12)}`)
}

function padKey(ref: string, pad: string): string { return `${ref}\0${pad}` }

/** Stable terminal meter names, independent of device family and subcircuit internals. */
export function padSenseName(ref: string, pad: string): string {
  const encode = (s: string): string => [...s.toLowerCase()].map((c) => /[a-z0-9]/.test(c) ? c : `_${c.codePointAt(0)!.toString(16)}_`).join('')
  return `vpad_${encode(ref)}_${encode(pad)}`
}

export interface CopperOp {
  network: CopperNetwork
  /** Geometry remains available on failed solves; voltages and currents do not. */
  method?: OpSolveMethod
  unreachedPads: CopperPadConnection[]
  nodeVoltages: Record<string, number>
  padVoltages: Record<string, Record<string, number>>
  padCurrents: Record<string, Record<string, number>>
  edgeCurrents: number[]
  partPower: Record<string, number>
}
