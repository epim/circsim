import type { CopperNetwork, CopperNode } from './index'

export interface KronEdge { a: number; b: number; ohms: number }
export interface KronNetwork {
  nodes: CopperNode[]
  edges: KronEdge[]
  eliminatedNodes: number
  /** Recover internal resistor-node potentials from the solved pad terminals. */
  recoverVoltages(values: Record<string, number>): Record<string, number>
}

const reductions = new WeakMap<CopperNetwork, KronNetwork>()

/**
 * Schur complement of a passive resistor network onto its pad terminals.
 * Eliminating a node replaces its star by pair conductances gi*gj/sum(g).
 * Positive conductance additions avoid subtracting nearly equal diagonals.
 * Disconnected components stay disconnected, including bare pad terminals.
 */
export function reduceCopperNetwork(network: CopperNetwork): KronNetwork {
  const cached = reductions.get(network)
  if (cached) return cached
  const terminalNames = new Set([...network.rails.values()].flatMap((rail) =>
    rail.graph.pads.map((pad) => rail.nodeNames[pad.node])))
  const terminals = new Set(network.nodes.filter((node) => terminalNames.has(node.name)).map((node) => node.id))
  const neighbors = network.nodes.map(() => new Map<number, number>())
  const add = (a: number, b: number, conductance: number): void => {
    if (!(conductance > 0) || !Number.isFinite(conductance)) throw new Error('Copper reduction requires finite positive conductances')
    const combined = (neighbors[a].get(b) ?? 0) + conductance
    if (!Number.isFinite(combined)) throw new Error('Copper reduction conductance overflow')
    neighbors[a].set(b, combined)
    neighbors[b].set(a, combined)
  }
  for (const edge of network.edges) {
    if (!(edge.ohms > 0) || !Number.isFinite(edge.ohms)) throw new Error('Copper reduction requires finite positive resistance')
    if (edge.a !== edge.b) add(edge.a, edge.b, 1 / edge.ohms)
  }

  // Minimum-degree order limits fill in the pour mesh. Stale heap entries are
  // discarded by version, so updating a neighbor never scans the whole graph.
  type Candidate = { node: number; degree: number; version: number }
  const heap: Candidate[] = []
  const versions = new Uint32Array(network.nodes.length)
  const removed = new Set<number>()
  const recovery: { node: string; neighbors: { name: string; weight: number }[] }[] = []
  const before = (a: Candidate, b: Candidate): boolean => a.degree < b.degree || (a.degree === b.degree && a.node < b.node)
  const push = (node: number): void => {
    if (terminals.has(node) || removed.has(node)) return
    const entry = { node, degree: neighbors[node].size, version: ++versions[node] }
    let i = heap.length
    heap.push(entry)
    while (i > 0) {
      const parent = (i - 1) >>> 1
      if (!before(entry, heap[parent])) break
      heap[i] = heap[parent]
      i = parent
    }
    heap[i] = entry
  }
  const pop = (): Candidate => {
    const first = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      let i = 0
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1
        if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++
        if (!before(heap[child], last)) break
        heap[i] = heap[child]
        i = child
      }
      heap[i] = last
    }
    return first
  }
  for (const node of network.nodes) push(node.id)
  while (heap.length > 0) {
    const candidate = pop()
    const node = candidate.node
    if (removed.has(node) || candidate.version !== versions[node]) continue
    const star = [...neighbors[node]]
    const total = star.reduce((sum, [, g]) => sum + g, 0)
    if (!Number.isFinite(total)) throw new Error('Copper reduction conductance overflow')
    recovery.push({ node: network.nodes[node].name.toLowerCase(), neighbors: star.map(([id, g]) => ({
      name: network.nodes[id].name.toLowerCase(), weight: g / total,
    })) })
    for (let i = 0; i < star.length; i++) {
      const [a, ga] = star[i]
      for (let j = i + 1; j < star.length; j++) {
        const [b, gb] = star[j]
        add(a, b, ga * (gb / total))
      }
      neighbors[a].delete(node)
    }
    neighbors[node].clear()
    removed.add(node)
    for (const [neighbor] of star) push(neighbor)
  }

  const retained = network.nodes.filter((node) => terminals.has(node.id))
  const ids = new Map(retained.map((node, id) => [node.id, id]))
  const nodes = retained.map((node, id) => ({ ...node, id }))
  const edges: KronEdge[] = []
  for (const node of retained) for (const [neighbor, conductance] of [...neighbors[node.id]].sort(([a], [b]) => a - b)) {
    if (node.id < neighbor) edges.push({ a: ids.get(node.id)!, b: ids.get(neighbor)!, ohms: 1 / conductance })
  }
  const reduced: KronNetwork = { nodes, edges, eliminatedNodes: network.nodes.length - nodes.length,
    recoverVoltages(values) {
      const result = { ...values }
      for (let i = recovery.length - 1; i >= 0; i--) {
        const step = recovery[i]
        if (result[step.node] !== undefined || step.neighbors.length === 0) continue
        if (!step.neighbors.every(neighbor => Number.isFinite(result[neighbor.name]))) continue
        result[step.node] = step.neighbors.reduce((sum, neighbor) => sum + neighbor.weight * result[neighbor.name], 0)
      }
      return result
    },
  }
  reductions.set(network, reduced)
  return reduced
}
