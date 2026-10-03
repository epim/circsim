/** Physical copper geometry, shared by the SPICE deck and Board Critic. */
import type { Pad, TrackSegment, Vec2, Via, Zone } from '../kicad/types'
import type { BoardModel } from '../kicad/types'
import type { Circuit } from '../netlist/extract'
import { copperOutlinesOverlap, dist, padCopperOutline, padWorldPos, segLengthMm, trackResistanceOhms } from './geometry'

export interface GraphContext { board: BoardModel; circuit: Circuit; opts: { copperOz: number; zoneMeshMm: number } }

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
/** Runs of a track shorter than this (mm) inside one pour cell are not given a node. */
const MIN_RUN_MM = 1e-6

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

/** Split at every polygon crossing so even a sub-cell clearance stays open. */
function lineInPours(a: Vec2, b: Vec2, pours: Lattice[]): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const stops = new Set([0, 1])
  for (const pour of pours) for (const ring of [pour.outer, ...pour.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % ring.length]
      const ex = q.x - p.x
      const ey = q.y - p.y
      const cross = dx * ey - dy * ex
      if (Math.abs(cross) < 1e-12) continue
      const u = ((p.x - a.x) * ey - (p.y - a.y) * ex) / cross
      const v = ((p.x - a.x) * dy - (p.y - a.y) * dx) / cross
      if (u > 0 && u < 1 && v >= 0 && v <= 1) stops.add(u)
    }
  }
  const ordered = [...stops].sort((x, y) => x - y)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i] - ordered[i - 1] < 1e-12) continue
    const u = (ordered[i] + ordered[i - 1]) / 2
    if (!pours.some(pour => inZone(pour, { x: a.x + dx * u, y: a.y + dy * u }))) return false
  }
  return true
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

export function buildRailGraph(ctx: GraphContext, netId: number): RailGraph {
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
  const circuitRefs = new Set(circuit.parts.map(part => part.ref))
  const padAnchors = board.footprints.filter(fp => circuitRefs.has(fp.ref)).flatMap(fp =>
    fp.pads.filter(pad => pad.netId === netId && pad.type !== 'np_thru_hole').map(pad => ({
      pad, pos: padWorldPos(fp, pad), reach: Math.max(pad.size.w, pad.size.h) / 2 + PAD_SNAP_SLACK_MM,
    })))
  const lattices: Lattice[] = []
  for (const zone of [...board.zones, ...(board.copperGraphics?.zones ?? [])]) {
    if (zone.netId !== netId) continue
    // A multi-layer zone is one independent fill per layer.
    for (const layer of zoneLayers(board, zone)) {
      const lat = buildLattice(zone, layer, opts.zoneMeshMm, newNode, padAnchors.filter(anchor => padTouchesLayer(anchor.pad, layer)))
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
  // Separate zone items can describe touching or overlapping pieces of one sheet.
  // Connect nearby cell centres only when the entire link is inside their union.
  for (let i = 0; i < lattices.length; i++) for (let j = i + 1; j < lattices.length; j++) {
    const a = lattices[i]
    const b = lattices[j]
    if (a.layer !== b.layer || a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue
    for (const node of a.ids) {
      if (node < 0) continue
      const pos = nodePos[node]
      const clipped = { x: Math.max(b.minX, Math.min(b.maxX, pos.x)), y: Math.max(b.minY, Math.min(b.maxY, pos.y)) }
      const other = latticeCellAt(b, clipped, 0)
      if (other < 0) continue
      const lengthMm = dist(pos, nodePos[other])
      if (lengthMm > a.h + b.h || !lineInPours(pos, nodePos[other], [a, b])) continue
      edges.push({ a: node, b: other, ohms: Math.max(SHORT_OHMS, sheetOhms * lengthMm / Math.min(a.h, b.h)), kind: 'pour', lengthMm })
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

  /** Short a copper node to the one pour cell that holds `p` on its layer. */
  const bondToPourCell = (node: number, layer: string, p: Vec2, reach: number): void => {
    for (const lat of latticesOn(layer)) {
      if (!touchesZone(lat, p, reach)) continue
      const target = latticeCellAt(lat, p, reach)
      if (target >= 0 && target !== node) edges.push({ a: node, b: target, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
    }
  }

  // ── track segments ────────────────────────────────────────────────────────
  const railLayers = new Set<string>()
  for (const lat of lattices) railLayers.add(lat.layer)
  const tracks = [...board.tracks, ...(board.copperGraphics?.tracks ?? [])].filter(t => t.netId === netId)
  const vias = board.vias.filter(via => via.netId === netId)
  for (const track of tracks) railLayers.add(track.layer)
  for (const via of vias) for (const layer of via.layers.filter(isCopperLayer)) railLayers.add(layer)

  // Track ends, via barrels and pads can touch the interior of another track.
  // Index contact centres, then split the track at each actual contact. Creating
  // a pad contact only after finding copper avoids inventing a route to bare pads.
  type Contact = { pos: Vec2; reach: number; layer: string; pad?: Pad }
  const contactHash = new Map<string, Contact[]>()
  const CONTACT_CELL = 4
  let maxContactReach = 0
  const addContact = (contact: Contact): void => {
    const key = `${Math.floor(contact.pos.x / CONTACT_CELL)},${Math.floor(contact.pos.y / CONTACT_CELL)}`
    const bucket = contactHash.get(key)
    if (bucket) bucket.push(contact)
    else contactHash.set(key, [contact])
    maxContactReach = Math.max(maxContactReach, contact.reach)
  }
  for (const track of tracks) for (const pos of [track.start, track.end]) {
    addContact({ pos, reach: track.widthMm / 2, layer: track.layer })
  }
  for (const via of vias) {
    const orders = via.layers.filter(isCopperLayer).map(copperOrder)
    const lo = Math.min(...orders)
    const hi = Math.max(...orders)
    for (const layer of railLayers) if (copperOrder(layer) >= lo && copperOrder(layer) <= hi) {
      addContact({ pos: via.at, reach: via.sizeMm / 2, layer })
    }
  }
  for (const fp of board.footprints) if (circuitRefs.has(fp.ref)) for (const pad of fp.pads) {
    if (pad.netId !== netId || pad.type === 'np_thru_hole') continue
    for (const layer of railLayers) if (padTouchesLayer(pad, layer)) {
      addContact({ pos: padWorldPos(fp, pad), reach: Math.max(pad.size.w, pad.size.h) / 2 + PAD_SNAP_SLACK_MM, layer, pad })
    }
  }
  const padTrackContacts = new Map<Pad, Set<number>>()
  const trackContacts = (track: TrackSegment): Map<number, number> => {
    const stops = new Map<number, number>()
    if (track.kind !== 'segment') return stops
    const dx = track.end.x - track.start.x
    const dy = track.end.y - track.start.y
    const length2 = dx * dx + dy * dy
    if (length2 === 0) return stops
    const reach = maxContactReach + track.widthMm / 2
    const x0 = Math.floor((Math.min(track.start.x, track.end.x) - reach) / CONTACT_CELL)
    const x1 = Math.floor((Math.max(track.start.x, track.end.x) + reach) / CONTACT_CELL)
    const y0 = Math.floor((Math.min(track.start.y, track.end.y) - reach) / CONTACT_CELL)
    const y1 = Math.floor((Math.max(track.start.y, track.end.y) + reach) / CONTACT_CELL)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      for (const contact of contactHash.get(`${x},${y}`) ?? []) {
        if (contact.layer !== track.layer) continue
        const u = Math.max(0, Math.min(1, ((contact.pos.x - track.start.x) * dx + (contact.pos.y - track.start.y) * dy) / length2))
        const pos = { x: track.start.x + dx * u, y: track.start.y + dy * u }
        if (dist(pos, contact.pos) > contact.reach + track.widthMm / 2) continue
        const node = nodeOf(track.layer, pos)
        stops.set(u, node)
        if (contact.pad) {
          let contacts = padTrackContacts.get(contact.pad)
          if (!contacts) padTrackContacts.set(contact.pad, contacts = new Set())
          contacts.add(node)
        } else {
          const other = nodeOf(track.layer, contact.pos)
          if (other !== node) edges.push({ a: node, b: other, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
        }
      }
    }
    return stops
  }
  let hasTrackOrVia = false
  for (const t of tracks) {
    hasTrackOrVia = true
    railLayers.add(t.layer)
    const lats = latticesOn(t.layer)
    const a = nodeOf(t.layer, t.start)
    const b = nodeOf(t.layer, t.end)
    noteWidth(a, t.widthMm)
    noteWidth(b, t.widthMm)
    const lengthMm = segLengthMm(t)
    if (!Number.isFinite(trackResistanceOhms(lengthMm, t.widthMm, opts.copperOz))) continue // zero width
    const contacts = trackContacts(t)

    const nearPour = lats.filter(
      (l) =>
        Math.max(t.start.x, t.end.x) >= l.minX &&
        Math.min(t.start.x, t.end.x) <= l.maxX &&
        Math.max(t.start.y, t.end.y) >= l.minY &&
        Math.min(t.start.y, t.end.y) <= l.maxY,
    )
    if (t.kind !== 'segment' || lengthMm < MIN_RUN_MM) {
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

    // A straight track lying in a same-net pour is the same copper as the pour
    // where they overlap, so it conducts in parallel with the cells it crosses.
    // Cut it wherever it crosses a cell boundary: each run inside one cell gets a
    // node at its midpoint, shorted to that one cell, and the runs are joined by
    // the track's own resistance between midpoints. Bonding a cut point to every
    // cell near it (as an earlier version did) shorted neighbouring runs together
    // through shared cells and collapsed the pour under the track to one node.
    const ts = new Set<number>([0, 1, ...contacts.keys()])
    for (const l of nearPour) {
      addCrossings(ts, t.start.x, t.end.x, l.x0, l.h)
      addCrossings(ts, t.start.y, t.end.y, l.y0, l.h)
    }
    const cuts = [...ts].sort((x, y) => x - y)
    const at = (u: number): Vec2 => ({
      x: t.start.x + (t.end.x - t.start.x) * u,
      y: t.start.y + (t.end.y - t.start.y) * u,
    })
    let prev = a
    let prevPos = t.start
    const addPiece = (to: number, toPos: Vec2): void => {
      const len = dist(prevPos, toPos)
      if (to !== prev && len > 0) {
        edges.push({
          a: prev,
          b: to,
          ohms: trackResistanceOhms(len, t.widthMm, opts.copperOz),
          kind: 'track',
          lengthMm: len,
          widthMm: t.widthMm,
          track: t,
        })
      }
      prev = to
      prevPos = toPos
    }
    for (let k = 0; k + 1 < cuts.length; k++) {
      // Tiny intervals need no pour midpoint, but their terminal contact must
      // still split the track rather than being connected only through a pour.
      if ((cuts[k + 1] - cuts[k]) * lengthMm >= MIN_RUN_MM && nearPour.length > 0) {
        const pm = at((cuts[k] + cuts[k + 1]) / 2)
        const node = nodeOf(t.layer, pm)
        noteWidth(node, t.widthMm)
        addPiece(node, pm)
        bondToPourCell(node, t.layer, pm, t.widthMm / 2)
      }
      const contact = contacts.get(cuts[k + 1])
      if (contact !== undefined) {
        noteWidth(contact, t.widthMm)
        addPiece(contact, at(cuts[k + 1]))
        bondToPourCell(contact, t.layer, at(cuts[k + 1]), t.widthMm / 2)
      }
    }
    addPiece(b, t.end)
    bondToPourCell(a, t.layer, t.start, t.widthMm / 2)
    bondToPourCell(b, t.layer, t.end, t.widthMm / 2)
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
  const padOutlines = new Map<RailPad, { pad: Pad; outline: Vec2[] }>()
  for (const part of [...circuit.parts].sort((x, y) => x.ref.localeCompare(y.ref))) {
    const fp = board.footprints.find((footprint) => footprint.ref === part.ref)
    if (!fp) continue
    for (const pad of fp.pads) {
      if (pad.netId !== netId || pad.type === 'np_thru_hole') continue
      const pos = padWorldPos(fp, pad)
      const reach = Math.max(pad.size.w, pad.size.h) / 2 + PAD_SNAP_SLACK_MM
      const node = newNode('(pad)', pos)
      const contacts: number[] = [...(padTrackContacts.get(pad) ?? [])]
      for (const contact of contacts) edges.push({ a: node, b: contact, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
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
      const railPad = { ref: part.ref, padNumber: pad.number, node, pos, contacts }
      const outline = padCopperOutline(pad, pos)
      for (const other of pads) {
        const geometry = padOutlines.get(other)!
        if (!pad.layers.some(layer => isCopperLayer(layer) &&
          (layer === '*.Cu' || layer === '*' || padTouchesLayer(geometry.pad, layer)))) continue
        const otherReach = Math.hypot(geometry.pad.size.w, geometry.pad.size.h) / 2
        if (dist(pos, other.pos) > Math.hypot(pad.size.w, pad.size.h) / 2 + otherReach) continue
        if (!copperOutlinesOverlap(outline, geometry.outline)) continue
        edges.push({ a: node, b: other.node, ohms: SHORT_OHMS, kind: 'short', lengthMm: 0 })
        contacts.push(other.node)
        other.contacts.push(node)
      }
      pads.push(railPad)
      padOutlines.set(railPad, { pad, outline })
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
function zoneLayers(board: GraphContext['board'], zone: Zone): string[] {
  const named = zone.layers && zone.layers.length > 0 ? zone.layers : zone.layer ? [zone.layer] : []
  const out = new Set<string>()
  for (const l of named) {
    if (l === 'F&B.Cu') {
      out.add('F.Cu')
      out.add('B.Cu')
    } else if (l === '*.Cu') {
      out.add('F.Cu')
      out.add('B.Cu')
      for (const t of [...board.tracks, ...(board.copperGraphics?.tracks ?? [])]) out.add(t.layer)
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
  anchors: { pos: Vec2; reach: number }[],
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
  const minimumPitch = Math.sqrt((w * ht) / MAX_POUR_CELLS)
  h = Math.max(h, minimumPitch)
  let nx = Math.max(1, Math.ceil(w / h))
  let ny = Math.max(1, Math.ceil(ht / h))
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
  // Refine only when an actual pad lies in copper but the coarse grid omitted
  // its local feature. Build the occupancy mask first to avoid orphan nodes.
  for (;;) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (inZone(lat, { x: minX + (i + 0.5) * h, y: minY + (j + 0.5) * h })) lat.ids[j * nx + i] = j * nx + i
    }
    const missesPad = anchors.some(anchor => inZone(lat, anchor.pos) && latticeTargets(lat, anchor.pos, anchor.reach).length === 0)
    if (!missesPad || h <= minimumPitch * (1 + 1e-12)) break
    h = Math.max(minimumPitch, h / 2)
    nx = Math.max(1, Math.ceil(w / h))
    ny = Math.max(1, Math.ceil(ht / h))
    Object.assign(lat, { h, nx, ny, ids: new Int32Array(nx * ny).fill(-1) })
  }
  let any = false
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (lat.ids[j * nx + i] < 0) continue
    lat.ids[j * nx + i] = newNode(layer, { x: minX + (i + 0.5) * h, y: minY + (j + 0.5) * h })
    any = true
  }
  return any ? lat : null
}

/** Add the parameters (0..1) at which a segment crosses the grid lines o + k h on one axis. */
function addCrossings(ts: Set<number>, s: number, e: number, o: number, h: number): void {
  const d = e - s
  if (Math.abs(d) < 1e-12) return
  const lo = Math.min(s, e)
  const hi = Math.max(s, e)
  for (let k = Math.floor((lo - o) / h) + 1; o + k * h < hi; k++) {
    const u = (o + k * h - s) / d
    if (u > 0 && u < 1) ts.add(u)
  }
}

/** The node of the nearest live cell to `p` within a cell or so, or -1. */
function nearestCell(lat: Lattice, p: Vec2, reach: number): number {
  const i0 = Math.floor((p.x - lat.x0) / lat.h)
  const j0 = Math.floor((p.y - lat.y0) / lat.h)
  let best = -1
  let bestD = Infinity
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      if (i < 0 || j < 0 || i >= lat.nx || j >= lat.ny) continue
      const id = lat.ids[j * lat.nx + i]
      if (id < 0) continue
      const d = Math.hypot(lat.x0 + (i + 0.5) * lat.h - p.x, lat.y0 + (j + 0.5) * lat.h - p.y)
      if (d < bestD) {
        bestD = d
        best = id
      }
    }
  }
  return bestD <= 1.6 * lat.h + reach ? best : -1
}

/** The one pour cell that holds `p` (the nearest live cell if its own is outside the pour), or -1. */
function latticeCellAt(lat: Lattice, p: Vec2, reach: number): number {
  const i = Math.min(lat.nx - 1, Math.max(0, Math.floor((p.x - lat.x0) / lat.h)))
  const j = Math.min(lat.ny - 1, Math.max(0, Math.floor((p.y - lat.y0) / lat.h)))
  const id = lat.ids[j * lat.nx + i]
  return id >= 0 ? id : nearestCell(lat, p, reach)
}

/**
 * Pour cells a conductor of radius `reach` centred at `p` physically overlaps:
 * those whose square the disc touches. With no reach that is the one cell
 * holding `p`. A conductor never shorts a cell it does not touch, so a point
 * contact cannot fuse the cells around it into one node.
 */
function latticeTargets(lat: Lattice, p: Vec2, reach: number): number[] {
  const r = Math.max(0, reach)
  const i0 = Math.max(0, Math.floor((p.x - r - lat.x0) / lat.h))
  const i1 = Math.min(lat.nx - 1, Math.floor((p.x + r - lat.x0) / lat.h))
  const j0 = Math.max(0, Math.floor((p.y - r - lat.y0) / lat.h))
  const j1 = Math.min(lat.ny - 1, Math.floor((p.y + r - lat.y0) / lat.h))
  const out: number[] = []
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const id = lat.ids[j * lat.nx + i]
      if (id < 0) continue
      const dx = Math.max(0, Math.abs(lat.x0 + (i + 0.5) * lat.h - p.x) - lat.h / 2)
      const dy = Math.max(0, Math.abs(lat.y0 + (j + 0.5) * lat.h - p.y) - lat.h / 2)
      if (dx * dx + dy * dy <= r * r + 1e-12) out.push(id)
    }
  }
  if (out.length > 0) return out
  const near = nearestCell(lat, p, r)
  return near >= 0 ? [near] : []
}
