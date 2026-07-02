/**
 * core/critic/checks/irDrop.ts
 *
 * IR-drop (rail-sag) audit (spec §5 item 4). For each power rail it builds a
 * resistive graph of the rail's copper — track segments as resistors
 * (trackResistanceOhms), vias as small fixed resistors, pads snapped onto the
 * copper they sit on — injects the operating-point part currents at the sink
 * pads, nodal-solves for the voltage field, and reports the worst source→sink
 * sag as a percentage of the rail's op-solved nominal voltage.
 *
 * Needs an operating-point sim (registry `needs:'op'`). Even when one is
 * present its `partCurrents` may be missing — then this check no-ops. Parts
 * whose current the sim did not solve are NOT counted as sinks (no invented
 * numbers); the assumption string says so.
 *
 * Supply-entry heuristic (the OpResult does not identify which pad the bench
 * supply is attached to — see buildCriticOpResult in the renderer store):
 *   1. a pad on the rail belonging to a connector-like ref (J1/P1/CN1/CON1/X1)
 *      — power usually enters a board on a connector;
 *   2. else the pad attached to the rail's widest incident track — supplies
 *      typically enter on the fattest copper;
 *   3. else the first pad in (ref, pad-number) order.
 *
 * Numerical robustness: zero-length segments are resistance-floored, sinks in
 * a disconnected subgraph are ignored (only the source's connected component
 * is solved), zero total current or a singular matrix yields no finding — the
 * check never throws. Pure core; deterministic (rails and parts iterated in
 * sorted order).
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { Pad, Vec2 } from '../../kicad/types'
import { classifyRails } from '../classify'
import { dist, padWorldPos, segLengthMm, trackResistanceOhms } from '../geom'

/**
 * Assumed resistance of one plated via (Ω). ~0.5 mΩ is typical for a 0.3 mm
 * drill with ~20 µm barrel plating on a 1.6 mm board — small, but kept nonzero
 * so long via chains still register in the solve.
 */
const VIA_RESISTANCE_OHMS = 0.5e-3
/** Near-zero contact resistance (Ω) attaching a pad to the copper under it. */
const PAD_CONTACT_OHMS = 1e-6
/** Resistance floor (Ω) so zero-length segments can't produce a 0 Ω edge. */
const MIN_EDGE_OHMS = 1e-9
/** Coincidence grid (mm): endpoints within this snap to the same node. */
const SNAP_GRID_MM = 1e-3
/** Extra slack (mm) beyond the pad's half-size when snapping pads to copper. */
const PAD_SNAP_SLACK_MM = 0.1
/** Rails whose total sunk current is below this (A) are not reported. */
const MIN_TOTAL_CURRENT_A = 1e-9
/** Rails whose |nominal| is below this (V) can't express a % sag → skipped. */
const MIN_NOMINAL_V = 0.05
/** Connector-ish refs, preferred as the rail's supply entry. */
const CONNECTOR_REF_RE = /^(J|P|CN|CON|X)\d+$/i

/**
 * Solve A·x = b by dense Gaussian elimination with partial pivoting. Returns
 * null (instead of throwing) when the matrix is singular (no usable pivot) or
 * the back-substituted solution is non-finite. Inputs are not mutated.
 * Exported for unit tests.
 */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  if (n === 0) return []
  // Augmented working copy [A | b].
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    }
    if (!(Math.abs(M[piv][col]) > 1e-15)) return null // singular (or NaN)
    if (piv !== col) {
      const t = M[piv]
      M[piv] = M[col]
      M[col] = t
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col]
      if (f === 0) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c]
    x[r] = s / M[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

interface Edge {
  a: number
  b: number
  ohms: number
  /** Physical copper length (mm); 0 for via / pad-contact edges. */
  lengthMm: number
  /** Track width (mm); undefined for via / pad-contact edges. */
  widthMm?: number
}

interface RailPad {
  ref: string
  padNumber: string
  node: number
  pos: Vec2
  /** Copper nodes this pad snapped onto (empty ⇒ stranded pad). */
  contacts: number[]
}

/** True if `pad` has copper on `layer` ("*.Cu" pads touch every copper layer). */
function padTouchesLayer(pad: Pad, layer: string): boolean {
  return pad.layers.some((l) => l === layer || l === '*.Cu' || l === '*')
}

export function checkIrDrop(ctx: CriticContext): Finding[] {
  const { board, circuit, opResult, opts } = ctx
  const partCurrents = opResult?.partCurrents
  if (!partCurrents) return []
  const nodeVoltages = opResult?.nodeVoltages ?? {}

  const { powerNetIds } = classifyRails(circuit, ctx)
  const findings: Finding[] = []

  for (const railId of [...powerNetIds].sort((a, b) => a - b)) {
    // Nominal rail voltage from the op solve (the sim treats the whole net as
    // one node, i.e. the voltage at the supply entry). Without it a % sag is
    // undefined — skip rather than invent a number.
    const net = circuit.nets.find((n) => n.id === railId)
    const nominal = net ? nodeVoltages[net.spiceNode] : undefined
    if (nominal === undefined || !Number.isFinite(nominal) || Math.abs(nominal) < MIN_NOMINAL_V) {
      continue
    }

    // ── nodes: (layer, snapped position) of track endpoints and via barrels ──
    const nodePos: Vec2[] = []
    const nodeLayer: string[] = []
    const nodeIdByKey = new Map<string, number>()
    const nodeOf = (layer: string, p: Vec2): number => {
      const key = `${layer}|${Math.round(p.x / SNAP_GRID_MM)}|${Math.round(p.y / SNAP_GRID_MM)}`
      let id = nodeIdByKey.get(key)
      if (id === undefined) {
        id = nodePos.length
        nodeIdByKey.set(key, id)
        nodePos.push(p)
        nodeLayer.push(layer)
      }
      return id
    }

    const edges: Edge[] = []
    /** Widest track touching each node — feeds the "largest copper entry" heuristic. */
    const nodeMaxTrackW: number[] = []
    const noteWidth = (node: number, w: number): void => {
      nodeMaxTrackW[node] = Math.max(nodeMaxTrackW[node] ?? 0, w)
    }

    // ── track segments → resistor edges ──────────────────────────────────────
    for (const t of board.tracks) {
      if (t.netId !== railId) continue
      const a = nodeOf(t.layer, t.start)
      const b = nodeOf(t.layer, t.end)
      noteWidth(a, t.widthMm)
      noteWidth(b, t.widthMm)
      if (a === b) continue // zero-length: endpoints share a node already
      const lengthMm = segLengthMm(t)
      const ohms = trackResistanceOhms(lengthMm, t.widthMm, opts.copperOz)
      if (!Number.isFinite(ohms)) continue // zero-width copper carries nothing
      edges.push({ a, b, ohms: Math.max(ohms, MIN_EDGE_OHMS), lengthMm, widthMm: t.widthMm })
    }

    // ── vias → fixed small resistors joining their copper layers ─────────────
    for (const via of board.vias) {
      if (via.netId !== railId) continue
      const cuLayers = via.layers.filter((l) => l.endsWith('.Cu') || l === '*.Cu')
      for (let i = 0; i + 1 < cuLayers.length; i++) {
        const a = nodeOf(cuLayers[i], via.at)
        const b = nodeOf(cuLayers[i + 1], via.at)
        if (a === b) continue
        edges.push({ a, b, ohms: VIA_RESISTANCE_OHMS, lengthMm: 0 })
      }
    }
    const copperNodeCount = nodePos.length

    // ── pads → contact edges onto nearby copper nodes ─────────────────────────
    // A pad gets its own node, joined by a near-zero resistance to every copper
    // node within its reach (half its larger dimension + slack) on a layer it
    // touches. Thru-hole pads ("*.Cu") thereby also stitch layers together.
    const railPads: RailPad[] = []
    for (const part of [...circuit.parts].sort((a, b) => a.ref.localeCompare(b.ref))) {
      const fp = ctx.refToFootprint.get(part.ref)
      if (!fp) continue
      for (const pad of fp.pads) {
        if (pad.netId !== railId) continue
        const pos = padWorldPos(fp, pad)
        const reach = Math.max(pad.size.w, pad.size.h) / 2 + PAD_SNAP_SLACK_MM
        const node = nodePos.length
        nodePos.push(pos)
        nodeLayer.push('(pad)')
        const contacts: number[] = []
        for (let n = 0; n < copperNodeCount; n++) {
          if (!padTouchesLayer(pad, nodeLayer[n])) continue
          if (dist(pos, nodePos[n]) <= reach) {
            edges.push({ a: node, b: n, ohms: PAD_CONTACT_OHMS, lengthMm: 0 })
            contacts.push(n)
          }
        }
        railPads.push({ ref: part.ref, padNumber: pad.number, node, pos, contacts })
      }
    }
    if (railPads.length === 0) continue

    // ── supply entry (see heuristic in the header comment) ────────────────────
    railPads.sort((a, b) => a.ref.localeCompare(b.ref) || a.padNumber.localeCompare(b.padNumber))
    let source = railPads.find((p) => CONNECTOR_REF_RE.test(p.ref) && p.contacts.length > 0)
    if (!source) {
      let bestW = 0
      for (const p of railPads) {
        const w = p.contacts.reduce((m, n) => Math.max(m, nodeMaxTrackW[n] ?? 0), 0)
        if (w > bestW) {
          bestW = w
          source = p
        }
      }
    }
    if (!source) source = railPads[0]

    // ── sinks: op-solved part currents, split across each part's rail pads ────
    // The source part is excluded (its current is the feed, not a load); parts
    // without a solved current are skipped rather than guessed.
    const padsByRef = new Map<string, RailPad[]>()
    for (const p of railPads) {
      if (p.ref === source.ref) continue
      const list = padsByRef.get(p.ref) ?? []
      list.push(p)
      padsByRef.set(p.ref, list)
    }
    const sinks: { pad: RailPad; amps: number }[] = []
    for (const [ref, pads] of padsByRef) {
      const amps = Math.abs(partCurrents[ref] ?? NaN)
      if (!Number.isFinite(amps) || amps <= 0) continue
      for (const pad of pads) sinks.push({ pad, amps: amps / pads.length })
    }
    if (sinks.length === 0) continue

    // ── connected component containing the source ─────────────────────────────
    const adj = new Map<number, { to: number; edge: Edge }[]>()
    const link = (from: number, to: number, edge: Edge): void => {
      let list = adj.get(from)
      if (!list) {
        list = []
        adj.set(from, list)
      }
      list.push({ to, edge })
    }
    for (const e of edges) {
      link(e.a, e.b, e)
      link(e.b, e.a, e)
    }
    const inComp = new Set<number>([source.node])
    const queue = [source.node]
    while (queue.length > 0) {
      const n = queue.pop()!
      for (const { to } of adj.get(n) ?? []) {
        if (!inComp.has(to)) {
          inComp.add(to)
          queue.push(to)
        }
      }
    }
    const reachableSinks = sinks.filter((s) => inComp.has(s.pad.node))
    const totalAmps = reachableSinks.reduce((sum, s) => sum + s.amps, 0)
    if (totalAmps < MIN_TOTAL_CURRENT_A) continue

    // ── nodal solve: source = reference (0 V), sinks draw their currents ──────
    const idx = new Map<number, number>()
    for (const n of [...inComp].sort((a, b) => a - b)) {
      if (n !== source.node) idx.set(n, idx.size)
    }
    const n = idx.size
    if (n === 0) continue
    const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
    const rhs = new Array<number>(n).fill(0)
    for (const e of edges) {
      if (!inComp.has(e.a) || !inComp.has(e.b)) continue
      const g = 1 / e.ohms
      const ia = idx.get(e.a)
      const ib = idx.get(e.b)
      if (ia !== undefined) G[ia][ia] += g
      if (ib !== undefined) G[ib][ib] += g
      if (ia !== undefined && ib !== undefined) {
        G[ia][ib] -= g
        G[ib][ia] -= g
      }
    }
    for (const s of reachableSinks) {
      const i = idx.get(s.pad.node)
      if (i !== undefined) rhs[i] -= s.amps
    }
    const v = solveLinear(G, rhs)
    if (v === null) continue // singular copper graph → degrade to silence

    // ── worst sag ─────────────────────────────────────────────────────────────
    let worst: { pad: RailPad; dropV: number } | undefined
    for (const s of reachableSinks) {
      const i = idx.get(s.pad.node)
      if (i === undefined) continue
      const dropV = Math.max(0, -v[i])
      if (!Number.isFinite(dropV)) continue
      if (!worst || dropV > worst.dropV) worst = { pad: s.pad, dropV }
    }
    if (!worst) continue

    const sagPct = (100 * worst.dropV) / Math.abs(nominal)
    if (sagPct <= opts.irDropWarnPct) continue
    const severity = sagPct > opts.irDropErrPct ? 'error' : 'warn'

    // ── path metrics for the headline: min-resistance route source → sink ─────
    const path = minResistancePath(adj, inComp, source.node, worst.pad.node)
    const pathLengthMm = path.reduce((sum, e) => sum + e.lengthMm, 0)
    const widths = path.map((e) => e.widthMm).filter((w): w is number => w !== undefined)
    const minWidthMm = widths.length > 0 ? Math.min(...widths) : undefined

    const netName = board.netById.get(railId)?.name ?? `net ${railId}`
    // Sag is toward 0 V: 5 V drops to 4.81 V, −12 V rises to −11.8 V.
    const sinkV = nominal >= 0 ? nominal - worst.dropV : nominal + worst.dropV
    const across =
      pathLengthMm > 0 && minWidthMm !== undefined
        ? ` across ${pathLengthMm.toFixed(0)} mm of ${minWidthMm} mm track`
        : ''

    findings.push({
      id: `ir-drop:${railId}`,
      check: 'ir-drop',
      severity,
      title: `"${netName}" rail sags to ${sinkV.toFixed(2)}V at ${worst.pad.ref} (${worst.dropV.toFixed(2)} V drop${across})`,
      detail:
        `Copper resistance on ${netName} drops about ${worst.dropV.toFixed(3)} V ` +
        `(${sagPct.toFixed(1)}% of the ${nominal.toFixed(2)} V rail) between the supply entry ` +
        `at ${source.ref} pad ${source.padNumber} and ${worst.pad.ref} pad ${worst.pad.padNumber}, ` +
        `with the rail carrying ~${totalAmps.toFixed(2)} A of op-point load` +
        (across ? ` — the worst path runs${across}.` : '.') +
        ` Sagging rails brown-out ICs and shift analog references.`,
      assumption:
        `${opts.copperOz} oz copper; vias ≈ ${(VIA_RESISTANCE_OHMS * 1000).toFixed(1)} mΩ each; ` +
        `supply entry inferred at ${source.ref} (connector/widest-copper heuristic); ` +
        `sink currents from the operating-point sim — parts without a solved current are not counted`,
      refs: [worst.pad.ref],
      netId: railId,
      location: worst.pad.pos,
      suggestion:
        'Widen or shorten the supply trace, add a copper pour or a second feed, or move the load closer to the supply entry.',
      metrics: {
        dropV: worst.dropV,
        sagPct,
        nominalV: nominal,
        sinkV,
        totalSinkA: totalAmps,
        pathLengthMm,
        ...(minWidthMm !== undefined ? { minTrackWidthMm: minWidthMm } : {}),
      },
    })
  }

  return findings
}

/**
 * Min-resistance route between two nodes (Dijkstra, O(V²) — rail graphs are
 * small). Returns the edges along the route, or [] when unreachable.
 */
function minResistancePath(
  adj: Map<number, { to: number; edge: Edge }[]>,
  inComp: Set<number>,
  from: number,
  to: number,
): Edge[] {
  const distOhms = new Map<number, number>()
  const prev = new Map<number, { node: number; edge: Edge }>()
  const done = new Set<number>()
  distOhms.set(from, 0)
  for (;;) {
    let cur: number | undefined
    let best = Infinity
    for (const [node, d] of distOhms) {
      if (!done.has(node) && d < best) {
        best = d
        cur = node
      }
    }
    if (cur === undefined) break
    if (cur === to) break
    done.add(cur)
    for (const { to: next, edge } of adj.get(cur) ?? []) {
      if (!inComp.has(next)) continue
      const cand = best + edge.ohms
      if (cand < (distOhms.get(next) ?? Infinity)) {
        distOhms.set(next, cand)
        prev.set(next, { node: cur, edge })
      }
    }
  }
  if (!distOhms.has(to)) return []
  const path: Edge[] = []
  let n = to
  while (n !== from) {
    const p = prev.get(n)
    if (!p) return []
    path.push(p.edge)
    n = p.node
  }
  return path.reverse()
}
