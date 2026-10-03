/**
 * core/kicad/board.ts
 *
 * Parses a .kicad_pcb S-expression file into a BoardModel.
 *
 * Supported features:
 * - KiCad 6/7 fp_text reference|value forms
 * - KiCad 8+ (property "Reference" ...) form
 * - Both F.SilkS and F.Silkscreen layer spellings
 * - Tolerant of unknown tokens at any nesting depth
 * - Defaults rotDeg to 0 when rotation is absent (avoids NaN bugs)
 *
 * spec §2, §8.2
 */

import { parseSexpr, findAll, find, atom, SExpr } from '../sexpr/parse'
import { stitchOutline, tessellateArc } from './outline'
import type {
  BoardModel,
  Footprint,
  Pad,
  TrackSegment,
  Via,
  Zone,
  BoardText,
  EdgePrimitive,
  Vec2,
} from './types'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Return a number from the SExpr tree, or the fallback. */
function numAtom(node: SExpr, index: number, fallback = 0): number {
  const v = atom(node, index)
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isNaN(n) ? fallback : n
  }
  return fallback
}

/** Return a string atom, or empty string. */
function strAtom(node: SExpr, index: number): string {
  const v = atom(node, index)
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

/**
 * Extract (at x y [rotDeg]) from a node's children.
 * Returns { x, y, rotDeg } where rotDeg defaults to 0 if absent.
 */
function parseAt(node: SExpr): { x: number; y: number; rotDeg: number } {
  const atNode = find(node, 'at')
  if (!atNode || !Array.isArray(atNode)) return { x: 0, y: 0, rotDeg: 0 }
  const x = numAtom(atNode, 1)
  const y = numAtom(atNode, 2)
  // Rotation is optional 4th token; if absent, default to 0 (not NaN)
  const rotRaw = atom(atNode, 3)
  const rotDeg =
    rotRaw === undefined
      ? 0
      : typeof rotRaw === 'number'
        ? rotRaw
        : Number.isNaN(Number(rotRaw))
          ? 0
          : Number(rotRaw)
  return { x, y, rotDeg }
}

/** Parse a (start x y) or (end x y) child node into Vec2. */
function parseVec2Child(node: SExpr, head: string): Vec2 {
  const child = find(node, head)
  if (!child || !Array.isArray(child)) return { x: 0, y: 0 }
  return { x: numAtom(child, 1), y: numAtom(child, 2) }
}

/** Return the string value of the layer child node. */
function parseLayer(node: SExpr): string {
  const layerNode = find(node, 'layer')
  if (!layerNode || !Array.isArray(layerNode)) return ''
  return strAtom(layerNode, 1)
}

/** Check if a layer string is a silkscreen layer (either KiCad 6/7 or KiCad 8 spelling). */
function isSilkscreen(layer: string): boolean {
  return layer === 'F.SilkS' || layer === 'F.Silkscreen' ||
         layer === 'B.SilkS' || layer === 'B.Silkscreen'
}

// ─── net parsing ──────────────────────────────────────────────────────────────

/**
 * Resolves `(net ...)` nodes to numeric net ids across BOTH KiCad formats:
 *
 *  - KiCad 6–9 (format 20211014 to 20241229): a top-level net table of `(net <id> "<name>")`, with
 *    references `(net <id> "<name>")` on pads and `(net <id>)` on tracks/vias.
 *    The numeric id is authoritative.
 *
 *  - KiCad 10 (format 20260206): the numeric id AND the top-level net
 *    table were both removed. EVERY reference is name-only — `(net "<name>")` —
 *    on pads, tracks, vias and zones.
 *
 * To keep the downstream pipeline (which keys connectivity on numeric net ids)
 * working unchanged, this index synthesizes a stable id for each distinct net
 * name encountered in the name-only format, in first-seen order. The same name always
 * resolves to the same id within one parse, which is all connectivity needs.
 *
 * `byId` is the BoardModel.netById map: it accumulates every net actually
 * referenced (legacy ids from the table, or synthesized name-only ids).
 */
class NetIndex {
  readonly byId = new Map<number, { id: number; name: string }>()
  private readonly byName = new Map<string, number>()
  private nextSyntheticId = 1

  /** Record a legacy net (explicit numeric id + name). */
  private registerLegacy(id: number, name: string): void {
    if (!this.byId.has(id)) this.byId.set(id, { id, name })
    if (name !== '' && !this.byName.has(name)) this.byName.set(name, id)
    // Keep synthesized ids from ever colliding with explicit ones.
    if (id >= this.nextSyntheticId) this.nextSyntheticId = id + 1
  }

  /** Resolve (or synthesize) the id for a name-only (KiCad 10) net reference. */
  private registerByName(name: string): number {
    const existing = this.byName.get(name)
    if (existing !== undefined) return existing
    const id = this.nextSyntheticId++
    this.byName.set(name, id)
    this.byId.set(id, { id, name })
    return id
  }

  /**
   * Register a top-level net-table entry (legacy files only; KiCad 10 files have no table).
   * `(net 0 "")` and empty names are skipped.
   */
  registerTableEntry(node: SExpr): void {
    if (!Array.isArray(node)) return
    const first = atom(node, 1)
    if (typeof first === 'number') {
      if (first === 0) return
      this.registerLegacy(first, strAtom(node, 2))
    } else if (typeof first === 'string' && first !== '') {
      // Unusual, but tolerate a name-only entry appearing at the table level.
      this.registerByName(first)
    }
  }

  /**
   * Resolve a `(net ...)` reference node (on a pad / track / via / zone) to a
   * net id, registering the net if it is not yet known. Returns `undefined` for
   * the empty net (`(net 0 …)` or `(net "")`) so callers treat it as unconnected.
   */
  resolve(node: SExpr): number | undefined {
    if (!Array.isArray(node)) return undefined
    const first = atom(node, 1)
    if (typeof first === 'number') {
      // Legacy reference: (net <id> ["name"]). Capture the name when present so a
      // net referenced only by pads (never in the table) still gets a name.
      if (first === 0) return undefined
      const name = strAtom(node, 2)
      this.registerLegacy(first, name)
      return first
    }
    if (typeof first === 'string') {
      // KiCad 10 reference: (net "<name>").
      if (first === '') return undefined
      return this.registerByName(first)
    }
    return undefined
  }
}

// ─── pad parsing ──────────────────────────────────────────────────────────────

function parsePad(padNode: SExpr, nets: NetIndex): Pad | null {
  if (!Array.isArray(padNode) || padNode[0] !== 'pad') return null

  const number = strAtom(padNode, 1)

  // type: smd | thru_hole | np_thru_hole
  const typeRaw = strAtom(padNode, 2)
  const type: Pad['type'] =
    typeRaw === 'smd' ? 'smd' :
    typeRaw === 'thru_hole' ? 'thru_hole' :
    typeRaw === 'np_thru_hole' ? 'np_thru_hole' : 'smd'

  // shape: circle | rect | oval | roundrect | custom
  const shapeRaw = strAtom(padNode, 3)
  const shape: Pad['shape'] =
    shapeRaw === 'circle' ? 'circle' :
    shapeRaw === 'rect' ? 'rect' :
    shapeRaw === 'oval' ? 'oval' :
    shapeRaw === 'roundrect' ? 'roundrect' : 'custom'

  const at = parseAt(padNode)

  // (size w h)
  const sizeNode = find(padNode, 'size')
  const size = sizeNode && Array.isArray(sizeNode)
    ? { w: numAtom(sizeNode, 1), h: numAtom(sizeNode, 2) }
    : { w: 0, h: 0 }

  // (layers "F.Cu" "F.Paste" ...)
  const layersNode = find(padNode, 'layers')
  const layers: string[] = []
  if (layersNode && Array.isArray(layersNode)) {
    for (let i = 1; i < layersNode.length; i++) {
      const l = layersNode[i]
      if (typeof l === 'string') layers.push(l)
    }
  }

  // (net N "NAME") legacy, or (net "NAME") name-only — resolved via the NetIndex.
  let netId: number | undefined
  const netNode = find(padNode, 'net')
  if (netNode) netId = nets.resolve(netNode)

  // (drill ...) — optional
  let drill: number | undefined
  const drillNode = find(padNode, 'drill')
  if (drillNode && Array.isArray(drillNode)) {
    drill = numAtom(drillNode, 1)
  }

  // (pinfunction "NAME") (pintype "unspecified+no_connect"): written by KiCad 8+
  // when the board was updated from a schematic. A `+no_connect` suffix on the
  // pin type is the schematic's no-connect flag (issue #49).
  const pinFunctionNode = find(padNode, 'pinfunction')
  const pinTypeNode = find(padNode, 'pintype')
  const pinFunction =
    pinFunctionNode && Array.isArray(pinFunctionNode) ? strAtom(pinFunctionNode, 1) : undefined
  const pinType = pinTypeNode && Array.isArray(pinTypeNode) ? strAtom(pinTypeNode, 1) : undefined

  const pad: Pad = { number, type, shape, at, size, drill, layers, netId }
  if (pinFunction !== undefined) pad.pinFunction = pinFunction
  if (pinType !== undefined) pad.pinType = pinType
  return pad
}

/**
 * True when the pad's schematic pin is flagged no-connect, i.e. the pin is
 * deliberately left open. KiCad writes this as a `+no_connect` suffix on the
 * pad's `(pintype ...)`, for example "unspecified+no_connect".
 */
export function isNoConnectPad(pad: Pad): boolean {
  return pad.pinType !== undefined && pad.pinType.split('+').includes('no_connect')
}

// ─── footprint parsing ────────────────────────────────────────────────────────

function parseFootprint(fpNode: SExpr, nets: NetIndex): Footprint | null {
  if (!Array.isArray(fpNode) || fpNode[0] !== 'footprint') return null

  const libId = strAtom(fpNode, 1)
  const layer = parseLayer(fpNode)
  const layerSide: 'F' | 'B' = layer.startsWith('B') ? 'B' : 'F'
  const at = parseAt(fpNode)

  // ref/value: try KiCad 6/7 fp_text form first, then KiCad 8 property form
  let ref = ''
  let value = ''

  // KiCad 6/7: (fp_text reference "R1" ...) / (fp_text value "10k" ...)
  for (const child of fpNode) {
    if (!Array.isArray(child) || child[0] !== 'fp_text') continue
    const kind = strAtom(child, 1)
    const text = strAtom(child, 2)
    if (kind === 'reference' && ref === '') ref = text
    if (kind === 'value' && value === '') value = text
  }

  // KiCad 8: (property "Reference" "R1" ...) / (property "Value" "10k" ...)
  for (const child of fpNode) {
    if (!Array.isArray(child) || child[0] !== 'property') continue
    const propName = strAtom(child, 1)
    const propValue = strAtom(child, 2)
    if ((propName === 'Reference' || propName === 'reference') && ref === '') {
      ref = propValue
    }
    if ((propName === 'Value' || propName === 'value') && value === '') {
      value = propValue
    }
  }

  // Pads
  const pads: Pad[] = []
  for (const child of fpNode) {
    const pad = parsePad(child, nets)
    if (pad) pads.push(pad)
  }

  // Properties (KiCad 8 property nodes other than Reference/Value)
  const properties: Record<string, string> = {}
  for (const child of fpNode) {
    if (!Array.isArray(child) || child[0] !== 'property') continue
    const propName = strAtom(child, 1)
    const propValue = strAtom(child, 2)
    if (propName && propName !== 'Reference' && propName !== 'Value') {
      properties[propName] = propValue
    }
  }

  // 3D model
  let model3d: Footprint['model3d']
  const modelNode = find(fpNode, 'model')
  if (modelNode && Array.isArray(modelNode)) {
    const path = strAtom(modelNode, 1)
    const offsetNode = find(modelNode, 'offset')
    const scaleNode = find(modelNode, 'scale')
    const rotateNode = find(modelNode, 'rotate')
    const parseXyz = (n: SExpr | undefined) => {
      if (!n || !Array.isArray(n)) return { x: 0, y: 0, z: 0 }
      const xyzNode = find(n, 'xyz')
      if (!xyzNode || !Array.isArray(xyzNode)) return { x: 0, y: 0, z: 0 }
      return { x: numAtom(xyzNode, 1), y: numAtom(xyzNode, 2), z: numAtom(xyzNode, 3) }
    }
    model3d = { path, offset: parseXyz(offsetNode), scale: parseXyz(scaleNode), rotate: parseXyz(rotateNode) }
  }

  // Courtyard bounds — parse F.CrtYd / B.CrtYd primitives added in Task 18.
  // We collect all endpoint coordinates from fp_line, fp_arc, fp_rect, fp_circle
  // on the courtyard layer and compute a bounding box.
  let courtyardBounds: Footprint['courtyardBounds']
  {
    const crtYdLayers = new Set(['F.CrtYd', 'B.CrtYd', 'F.Courtyard', 'B.Courtyard'])
    const crtPts: { x: number; y: number }[] = []

    for (const child of fpNode) {
      if (!Array.isArray(child)) continue
      const head = strAtom(child, 0)
      if (head !== 'fp_line' && head !== 'fp_arc' && head !== 'fp_rect' && head !== 'fp_circle') continue
      const childLayer = parseLayer(child)
      if (!crtYdLayers.has(childLayer)) continue

      // Collect start/end/mid points
      const startNode = find(child, 'start')
      const endNode = find(child, 'end')
      const midNode = find(child, 'mid')
      if (startNode && Array.isArray(startNode)) {
        crtPts.push({ x: numAtom(startNode, 1), y: numAtom(startNode, 2) })
      }
      if (endNode && Array.isArray(endNode)) {
        crtPts.push({ x: numAtom(endNode, 1), y: numAtom(endNode, 2) })
      }
      if (midNode && Array.isArray(midNode)) {
        crtPts.push({ x: numAtom(midNode, 1), y: numAtom(midNode, 2) })
      }
      // For fp_circle, also consider center ± radius
      if (head === 'fp_circle') {
        const centerNode = find(child, 'center')
        const cEnd = find(child, 'end') // end = a point on the circle edge
        if (centerNode && Array.isArray(centerNode) && cEnd && Array.isArray(cEnd)) {
          const cx2 = numAtom(centerNode, 1)
          const cy2 = numAtom(centerNode, 2)
          const ex = numAtom(cEnd, 1)
          const ey = numAtom(cEnd, 2)
          const r = Math.sqrt((ex - cx2) ** 2 + (ey - cy2) ** 2)
          crtPts.push({ x: cx2 - r, y: cy2 - r })
          crtPts.push({ x: cx2 + r, y: cy2 + r })
        }
      }
    }

    if (crtPts.length >= 2) {
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      for (const p of crtPts) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      const w = maxX - minX
      const h = maxY - minY
      if (w > 0 && h > 0) {
        courtyardBounds = { w, h }
      }
    }
  }

  return {
    ref,
    value,
    libId,
    layer: layerSide,
    at,
    pads,
    model3d,
    properties,
    courtyardBounds,
  }
}

// ─── track/arc segment parsing ────────────────────────────────────────────────

function parseSegment(node: SExpr, nets: NetIndex): TrackSegment | null {
  if (!Array.isArray(node)) return null

  const head = strAtom(node, 0)
  if (head === 'segment') {
    const start = parseVec2Child(node, 'start')
    const end = parseVec2Child(node, 'end')
    const widthNode = find(node, 'width')
    const widthMm = widthNode && Array.isArray(widthNode) ? numAtom(widthNode, 1) : 0
    const layer = parseLayer(node)
    const netNode = find(node, 'net')
    const netId = netNode ? (nets.resolve(netNode) ?? 0) : 0
    return { kind: 'segment', start, end, widthMm, layer, netId }
  }

  if (head === 'arc') {
    const start = parseVec2Child(node, 'start')
    const mid = parseVec2Child(node, 'mid')
    const end = parseVec2Child(node, 'end')
    const widthNode = find(node, 'width')
    const widthMm = widthNode && Array.isArray(widthNode) ? numAtom(widthNode, 1) : 0
    const layer = parseLayer(node)
    const netNode = find(node, 'net')
    const netId = netNode ? (nets.resolve(netNode) ?? 0) : 0
    return { kind: 'arc', start, mid, end, widthMm, layer, netId }
  }

  return null
}

// ─── via parsing ──────────────────────────────────────────────────────────────

function parseVia(node: SExpr, nets: NetIndex): Via | null {
  if (!Array.isArray(node) || node[0] !== 'via') return null

  const atNode = find(node, 'at')
  const at: Vec2 = atNode && Array.isArray(atNode)
    ? { x: numAtom(atNode, 1), y: numAtom(atNode, 2) }
    : { x: 0, y: 0 }

  const sizeNode = find(node, 'size')
  const sizeMm = sizeNode && Array.isArray(sizeNode) ? numAtom(sizeNode, 1) : 0

  const drillNode = find(node, 'drill')
  const drillMm = drillNode && Array.isArray(drillNode) ? numAtom(drillNode, 1) : 0

  const layersNode = find(node, 'layers')
  const layers: string[] = []
  if (layersNode && Array.isArray(layersNode)) {
    for (let i = 1; i < layersNode.length; i++) {
      const l = layersNode[i]
      if (typeof l === 'string') layers.push(l)
    }
  }

  const netNode = find(node, 'net')
  const netId = netNode ? nets.resolve(netNode) : undefined

  return { at, sizeMm, drillMm, layers, netId }
}

// ─── Edge.Cuts primitive parsing ──────────────────────────────────────────────

/** Maps a point from a primitive's own frame into board coordinates. */
type Place = (v: Vec2) => Vec2

const IDENTITY: Place = (v) => v

/**
 * KiCad footprint-local to board placement: rotate by the footprint angle
 * (KiCad sign convention, y down) then translate to the footprint origin. This
 * is the same transform `critic/geom.ts` applies to pad centers.
 */
function footprintPlace(at: { x: number; y: number; rotDeg: number }): Place {
  const rad = (at.rotDeg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return (v) => ({ x: at.x + v.x * c + v.y * s, y: at.y - v.x * s + v.y * c })
}

/** Graphic items that can live on Edge.Cuts but carry no outline geometry. */
const EDGE_NON_GEOMETRY = new Set([
  'gr_text', 'gr_text_box', 'fp_text', 'fp_text_box', 'property', 'dimension',
  'group', 'image', 'gr_bbox', 'fp_bbox',
])

/** Line primitives joining consecutive points of a polygon, closing the loop. */
function polyLines(pts: Vec2[]): EdgePrimitive[] {
  const out: EdgePrimitive[] = []
  for (let i = 0; i < pts.length; i++) {
    const start = pts[i]
    const end = pts[(i + 1) % pts.length]
    if (start.x === end.x && start.y === end.y) continue
    out.push({ kind: 'line', start, end })
  }
  return out
}

/** Read an `(xy x y)` point list from a `(pts ...)` child. */
function parsePts(node: SExpr): Vec2[] {
  const ptsNode = find(node, 'pts')
  const pts: Vec2[] = []
  if (!ptsNode || !Array.isArray(ptsNode)) return pts
  for (const pt of ptsNode) {
    if (!Array.isArray(pt) || pt[0] !== 'xy') continue
    pts.push({ x: numAtom(pt, 1), y: numAtom(pt, 2) })
  }
  return pts
}

/**
 * Turn one Edge.Cuts graphic into outline primitives, or null when the item is
 * not something the stitcher understands. Handles the board-level `gr_*` forms
 * and the footprint-level `fp_*` forms identically; `place` carries a
 * footprint's placement (identity for board-level items).
 *
 * gr_poly and fp_poly become closed loops of line primitives. A footprint
 * rectangle becomes four lines, because a rotated rectangle is no longer the
 * axis-aligned `rect` primitive.
 */
function parseEdgePrimitive(node: SExpr, place: Place = IDENTITY): EdgePrimitive[] | null {
  if (!Array.isArray(node)) return null
  const head = strAtom(node, 0).replace(/^fp_/, 'gr_')

  if (head === 'gr_line') {
    const start = place(parseVec2Child(node, 'start'))
    const end = place(parseVec2Child(node, 'end'))
    return [{ kind: 'line', start, end }]
  }

  if (head === 'gr_arc') {
    const start = place(parseVec2Child(node, 'start'))
    const mid = place(parseVec2Child(node, 'mid'))
    const end = place(parseVec2Child(node, 'end'))
    return [{ kind: 'arc', start, mid, end }]
  }

  if (head === 'gr_circle') {
    const centerNode = find(node, 'center')
    const endNode = find(node, 'end')  // radiusPoint in KiCad
    const center: Vec2 = centerNode && Array.isArray(centerNode)
      ? { x: numAtom(centerNode, 1), y: numAtom(centerNode, 2) }
      : { x: 0, y: 0 }
    const radiusPoint: Vec2 = endNode && Array.isArray(endNode)
      ? { x: numAtom(endNode, 1), y: numAtom(endNode, 2) }
      : { x: 0, y: 0 }
    return [{ kind: 'circle', center: place(center), radiusPoint: place(radiusPoint) }]
  }

  if (head === 'gr_rect') {
    const start = parseVec2Child(node, 'start')
    const end = parseVec2Child(node, 'end')
    if (place === IDENTITY) return [{ kind: 'rect', start, end }]
    return polyLines([
      place(start),
      place({ x: end.x, y: start.y }),
      place(end),
      place({ x: start.x, y: end.y }),
    ])
  }

  if (head === 'gr_poly') {
    const lines = polyLines(parsePts(node).map(place))
    return lines.length > 0 ? lines : null
  }

  return null
}

// ─── silkscreen parsing ───────────────────────────────────────────────────────

function parseBoardText(node: SExpr): BoardText | null {
  if (!Array.isArray(node) || node[0] !== 'gr_text') return null

  const text = strAtom(node, 1)
  const at = parseAt(node)
  const layer = parseLayer(node)

  return { text, at, layer }
}

// ─── zone parsing ─────────────────────────────────────────────────────────────

/** Copper polygon points, including KiCad's embedded three-point arcs. */
function parseCopperPolygonPts(node: SExpr): Vec2[] {
  const ptsNode = find(node, 'pts')
  if (!ptsNode || !Array.isArray(ptsNode)) return []
  const pts: Vec2[] = []
  for (const pt of ptsNode) {
    if (!Array.isArray(pt)) continue
    if (pt[0] === 'xy') pts.push({ x: numAtom(pt, 1), y: numAtom(pt, 2) })
    else if (pt[0] === 'arc') {
      const start = parseVec2Child(pt, 'start')
      const mid = parseVec2Child(pt, 'mid')
      const end = parseVec2Child(pt, 'end')
      pts.push(...tessellateArc(start, mid, end), end)
    }
  }
  return pts
}

function parseZone(node: SExpr, nets: NetIndex): Zone | null {
  if (!Array.isArray(node) || node[0] !== 'zone') return null

  const netNode = find(node, 'net')
  const netId = netNode ? nets.resolve(netNode) : undefined

  const layer = parseLayer(node)
  // A multi-layer zone has `(layers "F.Cu" "B.Cu" ...)` and no `(layer ...)`.
  const layersNode = find(node, 'layers')
  const layers: string[] = []
  if (layersNode && Array.isArray(layersNode)) {
    for (let i = 1; i < layersNode.length; i++) {
      const l = strAtom(layersNode, i)
      if (l) layers.push(l)
    }
  }

  // polygon pts
  const polygon: Vec2[][] = []
  const polyNodes = findAll(node, 'polygon')
  for (const polyNode of polyNodes) {
    const pts = parseCopperPolygonPts(polyNode)
    if (pts.length > 0) polygon.push(pts)
  }

  return layers.length > 0 ? { netId, layer, layers, polygon } : { netId, layer, polygon }
}

/** Board graphics carrying a net are real copper, including their stroke. */
function parseCopperGraphic(node: SExpr, nets: NetIndex): NonNullable<BoardModel['copperGraphics']> | null {
  if (!Array.isArray(node) || !['gr_rect', 'gr_poly', 'gr_circle', 'gr_line'].includes(strAtom(node, 0))) return null
  const layer = parseLayer(node)
  const netNode = find(node, 'net')
  if (!layer.endsWith('.Cu') || !netNode) return null
  const netId = nets.resolve(netNode)
  if (netId === undefined || netId === 0) return null
  const copperPts = node[0] === 'gr_poly' ? parseCopperPolygonPts(node) : null
  const primitives = copperPts ? polyLines(copperPts) : parseEdgePrimitive(node)
  if (!primitives) return null
  const stroke = find(node, 'stroke')
  const width = find(stroke ?? node, 'width')
  const widthMm = width ? numAtom(width, 1) : 0
  const fill = find(node, 'fill')
  const filled = fill && ['yes', 'solid'].includes(strAtom(fill, 1))
  const tracks: TrackSegment[] = []
  const zones: Zone[] = []
  const addLine = (start: Vec2, end: Vec2): void => {
    if (widthMm > 0) tracks.push({ kind: 'segment', start, end, widthMm, layer, netId })
  }
  let polygon: Vec2[] = []
  for (const primitive of primitives) {
    if (primitive.kind === 'line') {
      addLine(primitive.start, primitive.end)
      polygon.push(primitive.start)
    } else if (primitive.kind === 'rect') {
      polygon = [primitive.start, { x: primitive.end.x, y: primitive.start.y }, primitive.end, { x: primitive.start.x, y: primitive.end.y }]
      for (let i = 0; i < polygon.length; i++) addLine(polygon[i], polygon[(i + 1) % polygon.length])
    } else if (primitive.kind === 'circle') {
      const radius = Math.hypot(primitive.radiusPoint.x - primitive.center.x, primitive.radiusPoint.y - primitive.center.y)
      polygon = Array.from({ length: 64 }, (_, i) => ({
        x: primitive.center.x + radius * Math.cos(i * Math.PI / 32),
        y: primitive.center.y + radius * Math.sin(i * Math.PI / 32),
      }))
      for (let i = 0; i < polygon.length; i++) addLine(polygon[i], polygon[(i + 1) % polygon.length])
    }
  }
  if (filled && polygon.length >= 3) zones.push({ netId, layer, polygon: [polygon] })
  return tracks.length || zones.length ? { tracks, zones } : null
}

/** `(version ...)` of KiCad 6.0, the oldest board format circsim reads. */
const KICAD6_BOARD_VERSION = 20211014

// ─── main parse function ──────────────────────────────────────────────────────

/**
 * Parse a .kicad_pcb file text into a BoardModel.
 *
 * Tolerant of unknown tokens — never throws on unrecognized atoms.
 * Throws SexprError only if the file is structurally malformed.
 */
export function parseBoard(text: string): BoardModel {
  // A UTF-8 BOM (written by some Windows editors) would otherwise become part of
  // the root token and fail the root check with a misleading message.
  const root = parseSexpr(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  if (!Array.isArray(root) || root[0] !== 'kicad_pcb') {
    throw new Error('Not a valid .kicad_pcb file: root node must be kicad_pcb')
  }

  // KiCad 5 and older wrote footprints as (module ...) and used a different
  // graphics dialect. Parsing one yields a board with no footprints and no
  // error, so refuse it explicitly. Version 20211014 is KiCad 6.0.
  const versionNode = find(root, 'version')
  const fileVersion = versionNode && Array.isArray(versionNode) ? numAtom(versionNode, 1, 0) : 0
  const hasModules = root.some((c) => Array.isArray(c) && c[0] === 'module')
  const hasFootprints = root.some((c) => Array.isArray(c) && c[0] === 'footprint')
  if ((fileVersion > 0 && fileVersion < KICAD6_BOARD_VERSION) || (hasModules && !hasFootprints)) {
    throw new Error(
      'Unsupported board format: this file was written by KiCad 5 or older' +
        (fileVersion > 0 ? ` (file version ${fileVersion})` : '') +
        '. circsim reads KiCad 6 or newer: open the board in KiCad 6 or newer, save it, then open the saved file.',
    )
  }

  // --- nets ---
  // Register the legacy top-level net table FIRST (KiCad 6–9) so that tracks/
  // vias, which carry only `(net <id>)` with no name, resolve to their proper
  // names. KiCad 10 files have no table — the index synthesizes ids lazily
  // from the name-only references parsed below.
  const nets = new NetIndex()
  for (const child of root) {
    if (Array.isArray(child) && child[0] === 'net') nets.registerTableEntry(child)
  }

  // --- board thickness ---
  let boardThicknessMm = 1.6
  const generalNode = find(root, 'general')
  if (generalNode && Array.isArray(generalNode)) {
    const thicknessNode = find(generalNode, 'thickness')
    if (thicknessNode && Array.isArray(thicknessNode)) {
      boardThicknessMm = numAtom(thicknessNode, 1, 1.6)
    }
  }

  // --- footprints ---
  const footprints: Footprint[] = []
  for (const child of root) {
    const fp = parseFootprint(child, nets)
    if (fp) footprints.push(fp)
  }

  // --- tracks and arcs ---
  const tracks: TrackSegment[] = []
  for (const child of root) {
    if (!Array.isArray(child)) continue
    const head = strAtom(child, 0)
    if (head === 'segment' || head === 'arc') {
      const track = parseSegment(child, nets)
      if (track) tracks.push(track)
    }
  }

  // --- vias ---
  const vias: Via[] = []
  for (const child of root) {
    const via = parseVia(child, nets)
    if (via) vias.push(via)
  }

  // --- zones ---
  const zones: Zone[] = []
  for (const child of root) {
    const zone = parseZone(child, nets)
    if (zone) zones.push(zone)
  }

  const copperGraphics: NonNullable<BoardModel['copperGraphics']> = { tracks: [], zones: [] }
  for (const child of root) {
    const graphic = parseCopperGraphic(child, nets)
    if (!graphic) continue
    copperGraphics.tracks.push(...graphic.tracks)
    copperGraphics.zones.push(...graphic.zones)
  }

  // --- Edge.Cuts primitives ---
  // Board-level graphics (gr_*) and footprint graphics (fp_*) on Edge.Cuts both
  // contribute: a slot or cutout is often drawn inside a mechanical footprint,
  // and a board outline may be drawn with the polygon tool (gr_poly).
  const edgeCuts: EdgePrimitive[] = []
  const unsupportedEdge = new Map<string, number>()
  const collectEdge = (item: SExpr, place: Place): void => {
    if (!Array.isArray(item) || parseLayer(item) !== 'Edge.Cuts') return
    const head = strAtom(item, 0)
    if (EDGE_NON_GEOMETRY.has(head) || !/^(gr|fp)_/.test(head)) return
    const prims = parseEdgePrimitive(item, place)
    if (prims) edgeCuts.push(...prims)
    else unsupportedEdge.set(head, (unsupportedEdge.get(head) ?? 0) + 1)
  }
  for (const child of root) {
    if (!Array.isArray(child)) continue
    if (child[0] === 'footprint') {
      const place = footprintPlace(parseAt(child))
      for (const item of child) collectEdge(item, place)
    } else {
      collectEdge(child, IDENTITY)
    }
  }

  // --- silkscreen: gr_text on silk layers ---
  const silkscreen: BoardText[] = []
  for (const child of root) {
    if (!Array.isArray(child)) continue

    if (child[0] === 'gr_text') {
      const layer = parseLayer(child)
      if (isSilkscreen(layer)) {
        const bt = parseBoardText(child)
        if (bt) silkscreen.push(bt)
      }
    }
  }
  // Re-scan for fp_text silkscreen items (outside the footprint parsing above
  // which only extracts ref/value)
  for (const child of root) {
    if (!Array.isArray(child) || child[0] !== 'footprint') continue
    for (const fpChild of child) {
      if (!Array.isArray(fpChild) || fpChild[0] !== 'fp_text') continue
      const layer = parseLayer(fpChild)
      if (!isSilkscreen(layer)) continue
      const text = strAtom(fpChild, 2)
      const at = parseAt(fpChild)
      silkscreen.push({ text, at, layer })
    }
  }

  // --- outline (Task 4 — real stitching via stitchOutline) ---
  const outline = stitchOutline(edgeCuts)
  for (const [head, count] of unsupportedEdge) {
    outline.warnings.push(
      `outline: ${count} unsupported Edge.Cuts item(s) of type ${head} ignored. ` +
        'Redraw them with lines, arcs, circles, rectangles or polygons.',
    )
  }

  return {
    netById: nets.byId,
    footprints,
    tracks,
    vias,
    zones,
    edgeCuts,
    outline,
    silkscreen,
    boardThicknessMm,
    ...(copperGraphics.tracks.length || copperGraphics.zones.length ? { copperGraphics } : {}),
  }
}
