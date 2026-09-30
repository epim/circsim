/**
 * core/critic/railGraph.ts
 *
 * The resistive graph of one net's copper, and its nodal solve. Shared by the
 * IR-drop and ampacity checks so both read the same solved currents (issue #45:
 * rate each segment against the current it carries) instead of each inventing
 * its own estimate.
 *
 * What goes into the graph (issue #10):
 *   - track segments, as resistors (trackResistanceOhms); a segment lying in a
 *     same-net pour is cut into pieces and bonded to the pour along its length,
 *     because that is what the pour does to a track under it;
 *   - vias, as a barrel resistor derived from drill, plating and board
 *     thickness, stitching every copper layer of the rail they span;
 *   - copper pours (zones), meshed as a grid of sheet-resistance cells a couple
 *     of millimetres wide, clipped to the outline and its holes. The zone
 *     outline stands in for the fill: no thermal-relief spokes, no clearance
 *     islands around other nets' pads and no keepouts are modelled, so a pour
 *     reads slightly better here than KiCad's fill will be;
 *   - pads, snapped onto the track endpoints, via barrels and pour cells they
 *     sit on.
 *
 * The same builder serves ground nets: the return current of every load is a
 * signed injection at the load's ground pad.
 *
 * Numerics: zero-resistance bonds are contracted (union-find) before the solve
 * so the matrix stays well conditioned, then a sparse conjugate gradient
 * (sparse.ts) solves it. Pure core; deterministic.
 */

import type { Pad, TrackSegment, Vec2, Via, Zone } from '../kicad/types'
import type { CriticContext } from './context'
import { dist, padWorldPos, segLengthMm, trackResistanceOhms } from './geom'
import { solveNodal } from './sparse'

// ─── constants ────────────────────────────────────────────────────────────────

/** Copper resistivity (ohm m), as in geom.ts. */
const RHO_CU = 1.68e-8
/** Assumed via barrel plating thickness (m). */
const VIA_PLATING_M = 20e-6
/** Drill (mm) assumed for a via that does not state one. */
const DEFAULT_VIA_DRILL_MM = 0.3
/** Resistance (ohm) of a bond between copper that is in contact. Contracted. */
const SHORT_OHMS = 1e-6
/** Coincidence grid (mm): endpoints within this snap to the same node. */
const SNAP_GRID_MM = 1e-3
/** Extra slack (mm) beyond a pad's half-size when snapping it onto copper. */
const PAD_SNAP_SLACK_MM = 0.1
/** Coarsest pour mesh: cells per zone before the pitch is stretched. */
const MAX_POUR_CELLS = 6000
/** A track in a pour is cut into at most this many pieces. */
const MAX_TRACK_PIECES = 400
/** Loads below this (A) are treated as no load. */
export const MIN_LOAD_A = 1e-9
/** Connector-ish refs, preferred as the rail's supply entry. */
const CONNECTOR_REF_RE = /^(J|P|CN|CON|X)\d+$/i

// ─── types ────────────────────────────────────────────────────────────────────

export type EdgeKind = 'track' | 'via' | 'pour' | 'short'

export interface GraphEdge {
  a: number
  b: number
  ohms: number
  kind: EdgeKind
  /** Physical copper length (mm); 0 for vias and bonds. */
  lengthMm: number
  /** Track width (mm); undefined off a track. */
  widthMm?: number
  /** The board track this piece belongs to (pieces of one track share it). */
  track?: TrackSegment
}

export interface RailPad {
  ref: string
  padNumber: string
  node: number
  pos: Vec2
  /** Copper nodes this pad snapped onto (empty: stranded pad). */
  contacts: number[]
}

export interface RailGraph {
  netId: number
  nodePos: Vec2[]
  nodeLayer: string[]
  edges: GraphEdge[]
  pads: RailPad[]
  /** Widest track touching each node; feeds the supply-entry heuristic. */
  nodeMaxTrackW: number[]
  /** The rail has at least one pour. */
  hasPour: boolean
  /** The rail has any copper at all (track, via or pour). */
  hasCopper: boolean
}

interface Lattice {
  layer: string
  h: number
  x0: number
  y0: number
  nx: number
  ny: number
  /** Node id per cell, -1 where the cell centre is outside the pour. */
  ids: Int32Array
  outer: Vec2[]
  holes: Vec2[][]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// ─── geometry helpers ─────────────────────────────────────────────────────────

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const yi = ring[i].y
    const xj = ring[j].x
    const yj = ring[j].y
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inZone(lat: Lattice, p: Vec2): boolean {
  if (p.x < lat.minX || p.x > lat.maxX || p.y < lat.minY || p.y > lat.maxY) return false
  if (!pointInRing(p, lat.outer)) return false
  for (const hole of lat.holes) if (pointInRing(p, hole)) return false
  return true
}

/** True if `p`, or a point `reach` away along an axis, is inside the pour. */
function touchesZone(lat: Lattice, p: Vec2, reach: number): boolean {
  if (inZone(lat, p)) return true
  if (reach <= 0) return false
  return (
    inZone(lat, { x: p.x + reach, y: p.y }) ||
    inZone(lat, { x: p.x - reach, y: p.y }) ||
    inZone(lat, { x: p.x, y: p.y + reach }) ||
    inZone(lat, { x: p.x, y: p.y - reach })
  )
}

/** Stack position of a copper layer, for ordering a via's span. */
function copperOrder(layer: string): number {
  if (layer === 'F.Cu') return 0
  if (layer === 'B.Cu') return 1e6
  const m = layer.match(/^In(\d+)\.Cu$/)
  return m ? Number(m[1]) : 5e5
}

function isCopperLayer(layer: string): boolean {
  return layer.endsWith('.Cu') || layer === '*.Cu'
}

/** True if `pad` has copper on `layer` ("*.Cu" pads touch every copper layer). */
function padTouchesLayer(pad: Pad, layer: string): boolean {
  return pad.layers.some((l) => l === layer || l === '*.Cu' || l === '*')
}

/** Barrel resistance (ohm) of one plated via: rho L / (pi d t). */
export function viaResistanceOhms(via: Via, boardThicknessMm: number): number {
  const drill = via.drillMm > 0 ? via.drillMm : DEFAULT_VIA_DRILL_MM
  const length = (boardThicknessMm > 0 ? boardThicknessMm : 1.6) * 1e-3
  return (RHO_CU * length) / (Math.PI * drill * 1e-3 * VIA_PLATING_M)
}

// ─── graph construction ───────────────────────────────────────────────────────

export function buildRailGraph(ctx: CriticContext, netId: number): RailGraph {
  const { board, circuit, opts } = ctx
  const sheetOhms = trackResistanceOhms(1, 1, opts.copperOz) // rho / t, ohm per square

  const nodePos: Vec2[] = []
  const nodeLayer: string[] = []
  const nodeMaxTrackW: number[] = []
  const edges: GraphEdge[] = []

  const newNode = (layer: string, p: Vec2): number => {
    nodePos.push(p)
    nodeLayer.push(layer)
    return nodePos.length - 1
  }
  const nodeIdByKey = new Map<string, number>()
  const snapNodes: number[] = []
  const nodeOf = (layer: string, p: Vec2): number => {
    const key = `${layer}|${Math.round(p.x / SNAP_GRID_MM)}|${Math.round(p.y / SNAP_GRID_MM)}`
    let id = nodeIdByKey.get(key)
    if (id === undefined) {
      id = newNode(layer, p)
      nodeIdByKey.set(key, id)
      snapNodes.push(id)
    }
    return id
  }
  const noteWidth = (node: number, w: number): void => {
    nodeMaxTrackW[node] = Math.max(nodeMaxTrackW[node] ?? 0, w)
  }

  // ── pours: one lattice per zone on this net ───────────────────────────────
  const lattices: Lattice[] = []
  for (const zone of board.zones) {
    if (zone.netId !== netId) continue
    // A multi-layer zone is one independent fill per layer.
    for (const layer of zoneLayers(board, zone)) {
      const lat = buildLattice(zone, layer, opts.zoneMeshMm, newNode)
      if (lat) lattices.push(lat)
    }
  }
  for (const lat of lattices) {
    const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= lat.nx || j >= lat.ny ? -1 : lat.ids[j * lat.nx + i])
    for (let j = 0; j < lat.ny; j++) {
      for (let i = 0; i < lat.nx; i++) {
        const id = at(i, j)
        if (id < 0) continue
        for (const [di, dj] of [[1, 0], [0, 1]] as const) {
          const other = at(i + di, j + dj)
          if (other < 0) continue
          // The midpoint must be inside too, or the link would cross a slot.
          const mid = {
            x: (nodePos[id].x + nodePos[other].x) / 2,
            y: (nodePos[id].y + nodePos[other].y) / 2,
          }
          if (!inZone(lat, mid)) continue
          edges.push({ a: id, b: other, ohms: sheetOhms, kind: 'pour', lengthMm: lat.h })
        }
      }
    }
  }
  const latticesOn = (layer: string): Lattice[] => lattices.filter((l) => l.layer === layer)

  /** Short a copper node to the pour cells around `p` on its layer. */
  const bondToPour = (node: number, layer: string, p: Vec2, reach: number): boolean => {
    let bonded = false
    for (const lat of latticesOn(layer)) {
      if (!touchesZone(lat, p, reach)) continue
      for (const target of latticeTargets(lat, p, reach)) {
        if (target !== node) edges.push({ a: node, b: target, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
        bonded = true
      }
    }
    return bonded
  }

  // ── track segments ────────────────────────────────────────────────────────
  const railLayers = new Set<string>()
  for (const lat of lattices) railLayers.add(lat.layer)
  let hasTrackOrVia = false
  for (const t of board.tracks) {
    if (t.netId !== netId) continue
    hasTrackOrVia = true
    railLayers.add(t.layer)
    const lats = latticesOn(t.layer)
    const a = nodeOf(t.layer, t.start)
    const b = nodeOf(t.layer, t.end)
    noteWidth(a, t.widthMm)
    noteWidth(b, t.widthMm)
    const lengthMm = segLengthMm(t)
    if (!Number.isFinite(trackResistanceOhms(lengthMm, t.widthMm, opts.copperOz))) continue // zero width

    const nearPour = lats.filter(
      (l) =>
        Math.max(t.start.x, t.end.x) >= l.minX &&
        Math.min(t.start.x, t.end.x) <= l.maxX &&
        Math.max(t.start.y, t.end.y) >= l.minY &&
        Math.min(t.start.y, t.end.y) <= l.maxY,
    )
    if (nearPour.length === 0 || t.kind !== 'segment') {
      if (nearPour.length > 0) {
        bondToPour(a, t.layer, t.start, t.widthMm / 2)
        bondToPour(b, t.layer, t.end, t.widthMm / 2)
      }
      if (a === b) continue // zero-length: endpoints share a node already
      edges.push({
        a,
        b,
        ohms: trackResistanceOhms(lengthMm, t.widthMm, opts.copperOz),
        kind: 'track',
        lengthMm,
        widthMm: t.widthMm,
        track: t,
      })
      continue
    }

    // A straight track lying in a same-net pour: cut it up and bond each cut
    // point that is inside the pour.
    const pitch = Math.min(...nearPour.map((l) => l.h))
    const pieces = Math.min(MAX_TRACK_PIECES, Math.max(1, Math.ceil(lengthMm / pitch)))
    let prev = a
    for (let k = 1; k <= pieces; k++) {
      const p =
        k === pieces
          ? t.end
          : {
              x: t.start.x + ((t.end.x - t.start.x) * k) / pieces,
              y: t.start.y + ((t.end.y - t.start.y) * k) / pieces,
            }
      const node = k === pieces ? b : nodeOf(t.layer, p)
      noteWidth(node, t.widthMm)
      if (node !== prev) {
        edges.push({
          a: prev,
          b: node,
          ohms: trackResistanceOhms(lengthMm / pieces, t.widthMm, opts.copperOz),
          kind: 'track',
          lengthMm: lengthMm / pieces,
          widthMm: t.widthMm,
          track: t,
        })
      }
      prev = node
    }
    // Bond from the endpoints and every cut point.
    bondToPour(a, t.layer, t.start, t.widthMm / 2)
    for (let k = 1; k <= pieces; k++) {
      const p =
        k === pieces
          ? t.end
          : {
              x: t.start.x + ((t.end.x - t.start.x) * k) / pieces,
              y: t.start.y + ((t.end.y - t.start.y) * k) / pieces,
            }
      bondToPour(k === pieces ? b : nodeOf(t.layer, p), t.layer, p, t.widthMm / 2)
    }
  }

  // ── vias ──────────────────────────────────────────────────────────────────
  const viaLayerSets: { via: Via; layers: string[] }[] = []
  for (const via of board.vias) {
    if (via.netId !== netId) continue
    hasTrackOrVia = true
    const own = via.layers.filter(isCopperLayer)
    for (const l of own) railLayers.add(l)
    viaLayerSets.push({ via, layers: own })
  }
  for (const { via, layers } of viaLayerSets) {
    if (layers.length < 2) continue
    const orders = layers.map(copperOrder)
    const lo = Math.min(...orders)
    const hi = Math.max(...orders)
    // The barrel touches every copper layer it spans; it conducts into those
    // this rail has copper on, plus the layers it names.
    const chain = [...new Set([...layers, ...[...railLayers].filter((l) => copperOrder(l) >= lo && copperOrder(l) <= hi)])]
      .filter((l) => l !== '*.Cu')
      .sort((x, y) => copperOrder(x) - copperOrder(y))
    if (chain.length < 2) continue
    const hopOhms = viaResistanceOhms(via, board.boardThicknessMm) / (chain.length - 1)
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = nodeOf(chain[i], via.at)
      const b = nodeOf(chain[i + 1], via.at)
      if (a !== b) edges.push({ a, b, ohms: hopOhms, kind: 'via', lengthMm: 0 })
    }
    for (const l of chain) {
      const n = nodeOf(l, via.at)
      bondToPour(n, l, via.at, via.sizeMm / 2)
    }
  }

  // ── pads ──────────────────────────────────────────────────────────────────
  // Spatial hash of the track/via nodes so pad snapping is not O(pads x nodes).
  const CELL = 4
  const hash = new Map<string, number[]>()
  const cellKey = (ix: number, iy: number): string => `${ix},${iy}`
  for (const n of snapNodes) {
    const k = cellKey(Math.floor(nodePos[n].x / CELL), Math.floor(nodePos[n].y / CELL))
    const list = hash.get(k)
    if (list) list.push(n)
    else hash.set(k, [n])
  }

  const pads: RailPad[] = []
  for (const part of [...circuit.parts].sort((x, y) => x.ref.localeCompare(y.ref))) {
    const fp = ctx.refToFootprint.get(part.ref)
    if (!fp) continue
    for (const pad of fp.pads) {
      if (pad.netId !== netId || pad.type === 'np_thru_hole') continue
      const pos = padWorldPos(fp, pad)
      const reach = Math.max(pad.size.w, pad.size.h) / 2 + PAD_SNAP_SLACK_MM
      const node = newNode('(pad)', pos)
      const contacts: number[] = []
      const x0 = Math.floor((pos.x - reach) / CELL)
      const x1 = Math.floor((pos.x + reach) / CELL)
      const y0 = Math.floor((pos.y - reach) / CELL)
      const y1 = Math.floor((pos.y + reach) / CELL)
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          for (const n of hash.get(cellKey(ix, iy)) ?? []) {
            if (!padTouchesLayer(pad, nodeLayer[n])) continue
            if (dist(pos, nodePos[n]) <= reach) {
              edges.push({ a: node, b: n, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
              contacts.push(n)
            }
          }
        }
      }
      for (const lat of lattices) {
        if (!padTouchesLayer(pad, lat.layer) || !touchesZone(lat, pos, reach)) continue
        for (const target of latticeTargets(lat, pos, reach)) {
          edges.push({ a: node, b: target, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
          contacts.push(target)
        }
      }
      pads.push({ ref: part.ref, padNumber: pad.number, node, pos, contacts })
    }
  }

  return {
    netId,
    nodePos,
    nodeLayer,
    edges,
    pads,
    nodeMaxTrackW,
    hasPour: lattices.length > 0,
    hasCopper: hasTrackOrVia || lattices.length > 0,
  }
}

/**
 * The copper layers a zone fills: its `(layer ...)`, or every layer of a
 * multi-layer `(layers ...)` list. `*.Cu` means every copper layer the board
 * uses; `F&B.Cu` is KiCad's older spelling for the two outer layers.
 */
function zoneLayers(board: CriticContext['board'], zone: Zone): string[] {
  const named = zone.layers && zone.layers.length > 0 ? zone.layers : zone.layer ? [zone.layer] : []
  const out = new Set<string>()
  for (const l of named) {
    if (l === 'F&B.Cu') {
      out.add('F.Cu')
      out.add('B.Cu')
    } else if (l === '*.Cu') {
      out.add('F.Cu')
      out.add('B.Cu')
      for (const t of board.tracks) out.add(t.layer)
      for (const v of board.vias) for (const vl of v.layers) if (isCopperLayer(vl) && vl !== '*.Cu') out.add(vl)
    } else if (isCopperLayer(l)) {
      out.add(l)
    }
  }
  return [...out]
}

/** Grid of sheet-resistance cells over a zone outline; null for a degenerate zone. */
function buildLattice(
  zone: Zone,
  layer: string,
  targetPitchMm: number,
  newNode: (layer: string, p: Vec2) => number,
): Lattice | null {
  const outer = zone.polygon[0]
  if (!outer || outer.length < 3) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of outer) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const w = maxX - minX
  const ht = maxY - minY
  if (!(w > 0) || !(ht > 0)) return null
  // At least three cells across the narrow side, coarsened to the cell budget.
  let h = Math.min(targetPitchMm > 0 ? targetPitchMm : 2, Math.min(w, ht) / 3)
  h = Math.max(h, Math.sqrt((w * ht) / MAX_POUR_CELLS))
  const nx = Math.max(1, Math.ceil(w / h))
  const ny = Math.max(1, Math.ceil(ht / h))
  const lat: Lattice = {
    layer,
    h,
    x0: minX,
    y0: minY,
    nx,
    ny,
    ids: new Int32Array(nx * ny).fill(-1),
    outer,
    holes: zone.polygon.slice(1).filter((r) => r.length >= 3),
    minX,
    minY,
    maxX,
    maxY,
  }
  let any = false
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = { x: minX + (i + 0.5) * h, y: minY + (j + 0.5) * h }
      if (!inZone(lat, c)) continue
      lat.ids[j * nx + i] = newNode(layer, c)
      any = true
    }
  }
  return any ? lat : null
}

/** Pour cells a point at `p` bonds to: the ones within about a cell of it. */
function latticeTargets(lat: Lattice, p: Vec2, reach: number): number[] {
  const u = (p.x - lat.x0) / lat.h - 0.5
  const v = (p.y - lat.y0) / lat.h - 0.5
  const i0 = Math.floor(u)
  const j0 = Math.floor(v)
  const within = 0.8 * lat.h + Math.min(reach, lat.h)
  const cand: { id: number; d: number }[] = []
  for (let j = j0 - 1; j <= j0 + 2; j++) {
    for (let i = i0 - 1; i <= i0 + 2; i++) {
      if (i < 0 || j < 0 || i >= lat.nx || j >= lat.ny) continue
      const id = lat.ids[j * lat.nx + i]
      if (id < 0) continue
      const d = Math.hypot(lat.x0 + (i + 0.5) * lat.h - p.x, lat.y0 + (j + 0.5) * lat.h - p.y)
      cand.push({ id, d })
    }
  }
  if (cand.length === 0) return []
  const near = cand.filter((c) => c.d <= within)
  if (near.length > 0) return near.map((c) => c.id)
  cand.sort((a, b) => a.d - b.d)
  return cand[0].d <= 1.6 * lat.h + reach ? [cand[0].id] : []
}

// ─── solve ────────────────────────────────────────────────────────────────────

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
  /** Node voltage relative to the source (V); NaN outside the source's component. */
  volts: Float64Array
  /** Edge current a to b (A); NaN outside the source's component, 0 for bonds. */
  edgeAmps: Float64Array
  /** Loads the solve injected (reachable, non-zero, not the source's part). */
  loads: RailLoad[]
  /** Loads the copper does not connect to the source. */
  stranded: RailLoad[]
  /** Sum of the current the rail's loads draw (power) or return (ground). */
  loadAmps: number
  /** Unresolved-current parts that touch this net. */
  unresolved: string[]
  /** Edge indices incident to each node (for path search). */
  adjacency: number[][]
}

const solutionCache = new WeakMap<CriticContext, Map<number, RailSolution | null>>()

/** Whether the op carries any branch currents at all. */
export function hasBranchCurrents(ctx: CriticContext): boolean {
  const op = ctx.opResult
  return !!op && (op.padCurrents !== undefined || op.partCurrents !== undefined)
}

/** The rail's solved copper graph, memoised per critic run; null when there is nothing to solve. */
export function solveRail(ctx: CriticContext, netId: number, isGround: boolean): RailSolution | null {
  let byNet = solutionCache.get(ctx)
  if (!byNet) {
    byNet = new Map()
    solutionCache.set(ctx, byNet)
  }
  if (byNet.has(netId)) return byNet.get(netId) ?? null
  const sol = computeRail(ctx, netId, isGround)
  byNet.set(netId, sol)
  return sol
}

function chooseSource(graph: RailGraph): RailPad | undefined {
  const pads = [...graph.pads].sort(
    (a, b) => a.ref.localeCompare(b.ref) || a.padNumber.localeCompare(b.padNumber, undefined, { numeric: true }),
  )
  const connected = pads.filter((p) => p.contacts.length > 0)
  const conn = connected.find((p) => CONNECTOR_REF_RE.test(p.ref))
  if (conn) return conn
  let best: RailPad | undefined
  let bestW = 0
  for (const p of connected) {
    const w = p.contacts.reduce((m, n) => Math.max(m, graph.nodeMaxTrackW[n] ?? 0), 0)
    if (w > bestW) {
      bestW = w
      best = p
    }
  }
  return best ?? connected[0]
}

/** The draw (A) a pad puts on its net, or undefined when the op has none for it. */
function padDraw(ctx: CriticContext, ref: string, padNumber: string, isGround: boolean, padsOnRail: number): number | undefined {
  const op = ctx.opResult
  if (!op) return undefined
  if (op.padCurrents) return op.padCurrents[ref]?.[padNumber]
  const amps = Math.abs(op.partCurrents?.[ref] ?? NaN)
  if (!Number.isFinite(amps)) return undefined
  return ((isGround ? -1 : 1) * amps) / Math.max(1, padsOnRail)
}

function computeRail(ctx: CriticContext, netId: number, isGround: boolean): RailSolution | null {
  if (!hasBranchCurrents(ctx)) return null
  const graph = buildRailGraph(ctx, netId)
  if (!graph.hasCopper || graph.pads.length === 0) return null
  const source = chooseSource(graph)
  if (!source) return null

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
  const padsByRef = new Map<string, RailPad[]>()
  for (const p of graph.pads) {
    const list = padsByRef.get(p.ref) ?? []
    list.push(p)
    padsByRef.set(p.ref, list)
  }
  const loads: RailLoad[] = []
  const stranded: RailLoad[] = []
  for (const [ref, pads] of padsByRef) {
    if (ref === source.ref) continue
    for (const pad of pads) {
      const amps = padDraw(ctx, ref, pad.padNumber, isGround, pads.length)
      if (amps === undefined || !Number.isFinite(amps) || Math.abs(amps) < MIN_LOAD_A) continue
      ;(inComp[pad.node] ? loads : stranded).push({ pad, amps })
    }
  }
  const sign = isGround ? -1 : 1
  const loadAmps = loads.reduce((s, l) => s + Math.max(0, sign * l.amps), 0)

  const railRefs = new Set(graph.pads.map((p) => p.ref))
  const unresolved = (ctx.opResult?.unresolvedRefs ?? []).filter((r) => railRefs.has(r)).sort()

  // Contract the bonds so the solve sees only real resistors.
  const parent = new Int32Array(nNodes)
  for (let k = 0; k < nNodes; k++) parent[k] = k
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const nx = parent[x]
      parent[x] = r
      x = nx
    }
    return r
  }
  const isBond = (e: GraphEdge): boolean => e.kind === 'short' || e.ohms < SHORT_OHMS
  for (const e of graph.edges) {
    if (!inComp[e.a] || !isBond(e)) continue
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const index = new Int32Array(nNodes).fill(-1)
  let n = 0
  for (let k = 0; k < nNodes; k++) {
    if (inComp[k] && find(k) === k) index[k] = n++
  }
  const volts = new Float64Array(nNodes).fill(Number.NaN)
  const edgeAmps = new Float64Array(graph.edges.length).fill(Number.NaN)

  const ea: number[] = []
  const eb: number[] = []
  const eg: number[] = []
  graph.edges.forEach((e) => {
    if (!inComp[e.a] || isBond(e)) return
    const a = index[find(e.a)]
    const b = index[find(e.b)]
    if (a === b) return
    ea.push(a)
    eb.push(b)
    eg.push(1 / e.ohms)
  })

  const inject = new Float64Array(n)
  for (const l of loads) inject[index[find(l.pad.node)]] -= l.amps

  let v: Float64Array | null
  if (loads.length === 0) v = new Float64Array(n)
  else {
    v = solveNodal(
      { n, a: Int32Array.from(ea), b: Int32Array.from(eb), g: Float64Array.from(eg) },
      index[find(source.node)],
      inject,
    )
  }
  if (v === null) return null

  for (let k = 0; k < nNodes; k++) if (inComp[k]) volts[k] = v[index[find(k)]]
  graph.edges.forEach((e, k) => {
    if (!inComp[e.a]) return
    edgeAmps[k] = isBond(e) ? 0 : (volts[e.a] - volts[e.b]) / e.ohms
  })

  return { netId, isGround, graph, source, volts, edgeAmps, loads, stranded, loadAmps, unresolved, adjacency }
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
