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
import { stitchOutline } from './outline'
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
 *  - KiCad 6–8 (legacy): a top-level net table of `(net <id> "<name>")`, with
 *    references `(net <id> "<name>")` on pads and `(net <id>)` on tracks/vias.
 *    The numeric id is authoritative.
 *
 *  - KiCad 9 / 2026 (version 20260206): the numeric id AND the top-level net
 *    table were both removed. EVERY reference is name-only — `(net "<name>")` —
 *    on pads, tracks, vias and zones.
 *
 * To keep the downstream pipeline (which keys connectivity on numeric net ids)
 * working unchanged, this index synthesizes a stable id for each distinct net
 * name encountered in the v9 format, in first-seen order. The same name always
 * resolves to the same id within one parse, which is all connectivity needs.
 *
 * `byId` is the BoardModel.netById map: it accumulates every net actually
 * referenced (legacy ids from the table, or synthesized v9 ids).
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

  /** Resolve (or synthesize) the id for a name-only (v9) net reference. */
  private registerByName(name: string): number {
    const existing = this.byName.get(name)
    if (existing !== undefined) return existing
    const id = this.nextSyntheticId++
    this.byName.set(name, id)
    this.byId.set(id, { id, name })
    return id
  }

  /**
   * Register a top-level net-table entry (legacy files only — v9 has no table).
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
      // KiCad 9 / 2026 reference: (net "<name>").
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

  // (net N "NAME") legacy, or (net "NAME") v9 — resolved via the NetIndex.
  let netId: number | undefined
  const netNode = find(padNode, 'net')
  if (netNode) netId = nets.resolve(netNode)

  // (drill ...) — optional
  let drill: number | undefined
  const drillNode = find(padNode, 'drill')
  if (drillNode && Array.isArray(drillNode)) {
    drill = numAtom(drillNode, 1)
  }

  return { number, type, shape, at, size, drill, layers, netId }
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

function parseEdgePrimitive(node: SExpr, _layer: string): EdgePrimitive | null {
  if (!Array.isArray(node)) return null
  const head = strAtom(node, 0)

  if (head === 'gr_line') {
    const start = parseVec2Child(node, 'start')
    const end = parseVec2Child(node, 'end')
    return { kind: 'line', start, end }
  }

  if (head === 'gr_arc') {
    const start = parseVec2Child(node, 'start')
    const mid = parseVec2Child(node, 'mid')
    const end = parseVec2Child(node, 'end')
    return { kind: 'arc', start, mid, end }
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
    return { kind: 'circle', center, radiusPoint }
  }

  if (head === 'gr_rect') {
    const start = parseVec2Child(node, 'start')
    const end = parseVec2Child(node, 'end')
    return { kind: 'rect', start, end }
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

function parseZone(node: SExpr, nets: NetIndex): Zone | null {
  if (!Array.isArray(node) || node[0] !== 'zone') return null

  const netNode = find(node, 'net')
  const netId = netNode ? nets.resolve(netNode) : undefined

  const layer = parseLayer(node)

  // polygon pts
  const polygon: Vec2[][] = []
  const polyNodes = findAll(node, 'polygon')
  for (const polyNode of polyNodes) {
    const ptsNode = find(polyNode, 'pts')
    if (!ptsNode || !Array.isArray(ptsNode)) continue
    const pts: Vec2[] = []
    for (const pt of ptsNode) {
      if (!Array.isArray(pt) || pt[0] !== 'xy') continue
      pts.push({ x: numAtom(pt, 1), y: numAtom(pt, 2) })
    }
    if (pts.length > 0) polygon.push(pts)
  }

  return { netId, layer, polygon }
}

// ─── main parse function ──────────────────────────────────────────────────────

/**
 * Parse a .kicad_pcb file text into a BoardModel.
 *
 * Tolerant of unknown tokens — never throws on unrecognized atoms.
 * Throws SexprError only if the file is structurally malformed.
 */
export function parseBoard(text: string): BoardModel {
  const root = parseSexpr(text)
  if (!Array.isArray(root) || root[0] !== 'kicad_pcb') {
    throw new Error('Not a valid .kicad_pcb file: root node must be kicad_pcb')
  }

  // --- nets ---
  // Register the legacy top-level net table FIRST (KiCad 6–8) so that tracks/
  // vias, which carry only `(net <id>)` with no name, resolve to their proper
  // names. KiCad 9/2026 files have no table — the index synthesizes ids lazily
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

  // --- Edge.Cuts primitives ---
  const edgeCuts: EdgePrimitive[] = []
  for (const child of root) {
    if (!Array.isArray(child)) continue
    const childLayer = parseLayer(child)
    if (childLayer === 'Edge.Cuts') {
      const prim = parseEdgePrimitive(child, childLayer)
      if (prim) edgeCuts.push(prim)
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
  }
}
