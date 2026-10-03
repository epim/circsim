import { describe, expect, it } from 'vitest'
import type { CopperNetwork } from '../index'
import { reduceCopperNetwork } from '../kron'

function network(count: number, terminals: number[], connections: [number, number, number][]): CopperNetwork {
  const nodes = Array.from({ length: count }, (_, id) => ({ id, name: `n${id}`, netId: 1, pos: { x: id, y: 0 }, layer: 'F.Cu' }))
  const edges = connections.map(([a, b, ohms], railEdge) => ({ a, b, ohms, netId: 1, railEdge, kind: 'track' as const, lengthMm: 1 }))
  const pads = terminals.map((node) => ({ ref: `P${node}`, padNumber: '1', node, pos: nodes[node].pos, contacts: [node] }))
  return { copperOz: 1, zoneMeshMm: 2, nodes, edges, unreachedPads: [],
    rails: new Map([[1, { nodeNames: nodes.map((node) => node.name), entry: { kind: 'guess', why: 'no-supply' }, graph: {
      netId: 1, nodePos: nodes.map((node) => node.pos), nodeLayer: nodes.map((node) => node.layer), edges, pads,
      nodeMaxTrackW: nodes.map(() => 1), hasCopper: true, hasPour: false,
    } }]]), padNode: () => undefined, padConnection: () => undefined,
  }
}

describe('Kron reduction', () => {
  it('sums series resistance and combines parallel paths without mutating the input', () => {
    const full = network(3, [0, 2], [[0, 1, 2], [1, 2, 3], [0, 2, 5]])
    const reduced = reduceCopperNetwork(full)
    expect(reduced.nodes.map((node) => node.name)).toEqual(['n0', 'n2'])
    expect(reduced.edges).toEqual([{ a: 0, b: 1, ohms: 2.5 }])
    expect(reduced.eliminatedNodes).toBe(1)
    expect(full.edges).toHaveLength(3)
  })

  it('converts a unit star into a three-ohm delta', () => {
    const reduced = reduceCopperNetwork(network(4, [1, 2, 3], [[0, 1, 1], [0, 2, 1], [0, 3, 1]]))
    expect(reduced.edges).toHaveLength(3)
    expect(reduced.edges.every((edge) => edge.ohms === 3)).toBe(true)
  })

  it('recovers eliminated voltages without inventing readings on disconnected mesh', () => {
    const reduced = reduceCopperNetwork(network(5, [0, 2, 4], [[0, 1, 2], [1, 2, 3]]))
    const values = reduced.recoverVoltages({ n0: 5, n2: 0, n4: 8 })
    expect(values).toMatchObject({ n0: 5, n2: 0, n4: 8 })
    expect(values.n1).toBeCloseTo(3, 12)
    expect(values.n3).toBeUndefined()
    expect(reduced.recoverVoltages({ n0: 5 })).toEqual({ n0: 5 })
  })

  it('keeps isolated terminals, removes dangling mesh and never connects separate islands', () => {
    const reduced = reduceCopperNetwork(network(7, [0, 2, 3, 5, 6], [[0, 1, 1], [1, 2, 1], [3, 4, 2], [4, 5, 2]]))
    expect(reduced.nodes.map((node) => node.name)).toEqual(['n0', 'n2', 'n3', 'n5', 'n6'])
    expect(reduced.edges).toEqual([{ a: 0, b: 1, ohms: 2 }, { a: 2, b: 3, ohms: 4 }])
    expect(reduceCopperNetwork(network(3, [0], [[0, 1, 1], [1, 2, 1]])).edges).toEqual([])
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid resistance %s', (resistance) => {
    expect(() => reduceCopperNetwork(network(2, [0, 1], [[0, 1, resistance]]))).toThrow(/finite positive resistance/)
  })
})
