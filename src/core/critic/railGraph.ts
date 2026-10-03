/** Read copper geometry and electrical results from the shared ngspice solve. */
import type { CriticContext } from './context'
import type { Vec2 } from '../kicad/types'
import type { GraphEdge, RailGraph, RailPad } from '../copper/graph'
export { buildRailGraph, viaResistanceOhms } from '../copper/graph'
export type { GraphEdge, RailGraph, RailPad } from '../copper/graph'
export const MIN_LOAD_A = 1e-9
export interface RailLoad {
  pad: RailPad
  /** Signed draw (A): current leaving the net into the part at this pad. */
  amps: number
}

export interface RailSolution {
  netId: number
  isGround: boolean
  graph: RailGraph
  /** Supply-entry pad (0 V reference; its part's pads are the feed, not loads). */
  source: RailPad
  /** How the entry pad was chosen: from the bench lead, or guessed (and why). */
  entry: EntryBasis
  /** Node voltage relative to the source (V); NaN outside the source's component. */
  volts: Float64Array
  /** Edge current a to b (A); NaN outside the source's component, 0 for bonds. */
  edgeAmps: Float64Array
  /** Solved current-carrying pads reachable from the source, excluding its part. */
  loads: RailLoad[]
  /** Loads the copper does not connect to the source. */
  stranded: RailLoad[]
  /**
   * Sign of a load's draw on this net (see loadSign): +1 on a positive rail,
   * -1 on a negative rail and on ground, where load current flows back in.
   */
  loadSign: 1 | -1
  /**
   * Sum of the current the rail's loads carry in the load direction: drawn from
   * a positive rail, returned into a negative rail or into ground.
   */
  loadAmps: number
  /** Unresolved-current parts that touch this net. */
  unresolved: string[]
  /** Edge indices incident to each node (for path search). */
  adjacency: number[][]
}

/** How a rail's supply entry pad was chosen. */
export type EntryBasis =
  | { kind: 'lead'; pos: Vec2; snapMm: number }
  | { kind: 'guess'; why: 'no-supply' | 'no-position' }

/** What a rail's solve came to: a solution, or null with the reason when current had nowhere to go. */
interface RailOutcome {
  sol: RailSolution | null
  /** Set when the rail carries current the solve could not place (never for a rail with nothing to assess). */
  gap?: string
}

const solutionCache = new WeakMap<CriticContext, Map<number, RailOutcome>>()

/** Whether the op carries any branch currents at all. */
export function hasBranchCurrents(ctx: CriticContext): boolean {
  const op = ctx.opResult
  return !!op && (op.padCurrents !== undefined || op.partCurrents !== undefined)
}

function outcomeOf(ctx: CriticContext, netId: number, isGround: boolean): RailOutcome {
  let byNet = solutionCache.get(ctx)
  if (!byNet) {
    byNet = new Map()
    solutionCache.set(ctx, byNet)
  }
  let out = byNet.get(netId)
  if (!out) {
    out = computeRail(ctx, netId, isGround)
    byNet.set(netId, out)
  }
  return out
}

/** Read a rail from the native operating point, memoised per critic run. */
export function solveRail(ctx: CriticContext, netId: number, isGround: boolean): RailSolution | null {
  return outcomeOf(ctx, netId, isGround).sol
}

/** Up to four loads as "REF.PAD", then a count of the rest. */
export function padList(pads: RailLoad[]): string {
  const shown = pads
    .slice(0, 4)
    .map((l) => `${l.pad.ref}.${l.pad.padNumber}`)
    .join(', ')
  return pads.length > 4 ? `${shown} and ${pads.length - 4} more` : shown
}

/**
 * What the solve could not place on this rail, as not-assessed notes: a rail it
 * could not solve at all while its pads carry current (no copper, no pad on
 * copper, or a solve that did not converge), pads the copper does not connect to
 * the supply entry, and parts whose current is unresolved. A rail that carries
 * no current yields none. Shared by the IR-drop and ampacity checks so neither
 * lists a rail as assessed when its loads were never solved.
 */
export function railGapNotes(ctx: CriticContext, netId: number, isGround: boolean, name: string): string[] {
  const { sol, gap } = outcomeOf(ctx, netId, isGround)
  const notes: string[] = []
  if (!sol) {
    if (gap) notes.push(`${name}: ${gap}`)
    return notes
  }
  if (sol.stranded.length > 0) {
    notes.push(`${name}: ${padList(sol.stranded)} carry current but no modelled copper reaches them from the supply entry`)
  }
  if (sol.unresolved.length > 0) {
    notes.push(`${name}: the solve could not resolve the current of ${sol.unresolved.join(', ')}`)
  }
  return notes
}

/**
 * The sign a load's draw has on this net: +1 on a positive rail (the load pulls
 * current out of the net), -1 on ground and on a rail the op solves below 0 V
 * (the load's current comes back out of the part into the net).
 */
function loadSign(ctx: CriticContext, netId: number, isGround: boolean): 1 | -1 {
  if (isGround) return -1
  const node = ctx.circuit.nets.find((n) => n.id === netId)?.spiceNode
  const v = node !== undefined ? ctx.opResult?.nodeVoltages[node] : undefined
  return v !== undefined && v < 0 ? -1 : 1
}

/**
 * The draw (A) a pad puts on its net, or undefined when the op has none for it.
 * A bare partCurrents magnitude carries no sign, so it is given the load
 * direction of the net (`sign`) and split across the part's pads on it.
 */
function padDraw(ctx: CriticContext, ref: string, padNumber: string, sign: 1 | -1, padsOnRail: number): number | undefined {
  const op = ctx.opResult
  if (!op) return undefined
  if (op.padCurrents) return op.padCurrents[ref]?.[padNumber]
  const amps = Math.abs(op.partCurrents?.[ref] ?? NaN)
  if (!Number.isFinite(amps)) return undefined
  return (sign * amps) / Math.max(1, padsOnRail)
}

function computeRail(ctx: CriticContext, netId: number, isGround: boolean): RailOutcome {
  if (!hasBranchCurrents(ctx)) return { sol: null }
  const native = ctx.opResult?.copper
  if (!native) return { sol: null, gap: 'requires a copper-aware ngspice operating point' }
  const rail = native.network.rails.get(netId)
  if (!rail) return { sol: null, gap: 'this net was not included in the copper-aware operating point' }
  const graph = rail.graph
  const sign = loadSign(ctx, netId, isGround)

  // Pads that put current on this rail, grouped by part. Current can only be
  // said to go unassessed when some other part's pad is there to supply it.
  const padsByRef = new Map<string, RailPad[]>()
  for (const p of graph.pads) {
    const list = padsByRef.get(p.ref) ?? []
    list.push(p)
    padsByRef.set(p.ref, list)
  }
  const carriers: RailLoad[] = []
  for (const [ref, pads] of padsByRef) {
    for (const pad of pads) {
      const amps = padDraw(ctx, ref, pad.padNumber, sign, pads.length)
      if (amps !== undefined && Number.isFinite(amps) && Math.abs(amps) >= MIN_LOAD_A) carriers.push({ pad, amps })
    }
  }
  const unsolved = (why: string): RailOutcome =>
    carriers.length > 0 && padsByRef.size >= 2
      ? { sol: null, gap: `${padList(carriers)} carry current but ${why}` }
      : { sol: null }

  if (!graph.hasCopper) return unsolved('the board has no copper on this net to solve')
  if (graph.pads.length === 0) return { sol: null }
  const chosen = rail.source && rail.source.contacts.length > 0 ? { source: rail.source, entry: rail.entry } : undefined
  if (!chosen) return unsolved('no modelled copper touches any pad on the rail')

  const { source, entry } = chosen
  const nNodes = graph.nodePos.length
  const adjacency: number[][] = Array.from({ length: nNodes }, () => [])
  graph.edges.forEach((e, k) => {
    adjacency[e.a].push(k)
    adjacency[e.b].push(k)
  })

  // Connected component of the source.
  const inComp = new Uint8Array(nNodes)
  inComp[source.node] = 1
  const stack = [source.node]
  while (stack.length > 0) {
    const n = stack.pop() as number
    for (const k of adjacency[n]) {
      const e = graph.edges[k]
      const to = e.a === n ? e.b : e.a
      if (!inComp[to]) {
        inComp[to] = 1
        stack.push(to)
      }
    }
  }

  // Loads: every pad of a part other than the source's, with a known draw.
  const loads: RailLoad[] = []
  const stranded: RailLoad[] = []
  for (const [ref, pads] of padsByRef) {
    if (ref === source.ref) continue
    for (const pad of pads) {
      const amps = padDraw(ctx, ref, pad.padNumber, sign, pads.length)
      if (amps === undefined || !Number.isFinite(amps) || Math.abs(amps) < MIN_LOAD_A) continue
      ;(inComp[pad.node] ? loads : stranded).push({ pad, amps })
    }
  }
  const loadAmps = loads.reduce((s, l) => s + Math.max(0, sign * l.amps), 0)

  const railRefs = new Set(graph.pads.map((p) => p.ref))
  const unresolved = (ctx.opResult?.unresolvedRefs ?? []).filter((r) => railRefs.has(r)).sort()

  const reference = native.nodeVoltages[rail.nodeNames[source.node].toLowerCase()]
  if (reference === undefined || !Number.isFinite(reference)) return unsolved('the native operating point has no supply-entry voltage')
  const volts = new Float64Array(nNodes).fill(NaN)
  for (let i = 0; i < nNodes; i++) {
    const value = native.nodeVoltages[rail.nodeNames[i].toLowerCase()]
    if (inComp[i] && value !== undefined && reference !== undefined) volts[i] = value - reference
  }
  const edgeAmps = new Float64Array(graph.edges.length).fill(NaN)
  const segmentCurrents = new Map<number, number>()
  native.network.edges.forEach((edge, i) => {
    if (edge.netId === netId) segmentCurrents.set(edge.railEdge, native.edgeCurrents[i])
  })
  graph.edges.forEach((e, i) => {
    if (inComp[e.a]) edgeAmps[i] = e.kind === 'short' ? 0 : segmentCurrents.get(i) ?? NaN
  })

  return {
    sol: { netId, isGround, graph, source, entry, volts, edgeAmps, loads, stranded, loadSign: sign, loadAmps, unresolved, adjacency },
  }
}

// ─── path search ──────────────────────────────────────────────────────────────

/**
 * Min-resistance route from the source to `to` (Dijkstra with a binary heap),
 * as the edges along it; [] when unreachable.
 */
export function minResistancePath(sol: RailSolution, to: number): GraphEdge[] {
  const { graph, adjacency } = sol
  const from = sol.source.node
  const n = graph.nodePos.length
  const d = new Float64Array(n).fill(Infinity)
  const prevEdge = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  d[from] = 0
  const heap: [number, number][] = [[0, from]]
  const push = (item: [number, number]): void => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop() as [number, number]
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  while (heap.length > 0) {
    const [dist0, cur] = pop()
    if (done[cur]) continue
    done[cur] = 1
    if (cur === to) break
    for (const k of adjacency[cur]) {
      const e = graph.edges[k]
      const next = e.a === cur ? e.b : e.a
      const cand = dist0 + e.ohms
      if (cand < d[next]) {
        d[next] = cand
        prevEdge[next] = k
        push([cand, next])
      }
    }
  }
  if (!done[to]) return []
  const path: GraphEdge[] = []
  let at = to
  while (at !== from) {
    const k = prevEdge[at]
    if (k < 0) return []
    const e = graph.edges[k]
    path.push(e)
    at = e.a === at ? e.b : e.a
  }
  return path.reverse()
}
