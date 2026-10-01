/**
 * syntheticBoard.ts
 *
 * Deterministic synthetic BoardModel generator for viewport scale tests (#57,
 * #58). It builds the BoardModel directly (no .kicad_pcb text round trip) so a
 * 1500-part, 20000-track board costs milliseconds to produce.
 *
 * Shape of the default "big" board (matches the council review's measurement
 * board for #57/#58):
 *   - 1500 footprints (passives, SOIC-8, SOT-23), every 5th on the back side,
 *     one silkscreen reference string per part plus one board title (1501 total)
 *   - about 700 nets, two of them power rails (GND, VCC) carrying most copper
 *   - 20000 track segments split across F.Cu and B.Cu
 *   - 456 vias
 *   - 300 zone islands (64-gons) alternating GND on B.Cu and VCC on F.Cu
 *
 * Not a real layout: tracks are short random segments, only the primitive
 * counts and the net-size skew matter for draw-call and picking costs.
 *
 * No Electron, React, or DOM imports; safe to run headless.
 */

import type { BoardModel, Footprint, Pad, TrackSegment, Via, Zone, BoardText } from '../../../../core/kicad/types'

export interface SyntheticBoardOptions {
  parts: number
  tracks: number
  vias: number
  signalNets: number
  /** Board width and height in mm. */
  widthMm: number
  heightMm: number
  seed: number
}

export const BIG_BOARD: SyntheticBoardOptions = {
  parts: 1500,
  tracks: 20000,
  vias: 456,
  signalNets: 700,
  widthMm: 220,
  heightMm: 160,
  seed: 1,
}

/** Mid-size board: about 300 parts and 4000 tracks. */
export const MID_BOARD: SyntheticBoardOptions = {
  parts: 300,
  tracks: 4000,
  vias: 90,
  signalNets: 150,
  widthMm: 100,
  heightMm: 80,
  seed: 2,
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Regular polygon (hole) around a center, in KiCad coordinates. */
function ngon(cx: number, cy: number, r: number, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

export function makeSyntheticBoard(opts: SyntheticBoardOptions = BIG_BOARD): BoardModel {
  const rnd = mulberry32(opts.seed)
  const { widthMm: W, heightMm: H } = opts

  // ── nets ──
  const netById = new Map<number, { id: number; name: string }>()
  netById.set(0, { id: 0, name: '' })
  const GND = 1
  const VCC = 2
  netById.set(GND, { id: GND, name: 'GND' })
  netById.set(VCC, { id: VCC, name: 'VCC' })
  for (let i = 0; i < opts.signalNets; i++) {
    netById.set(3 + i, { id: 3 + i, name: `N${i}` })
  }
  const pickSignal = () => 3 + Math.floor(rnd() * opts.signalNets)
  /** Power rails carry a large share of the copper, like a real board. */
  const pickTrackNet = () => {
    const r = rnd()
    if (r < 0.3) return GND
    if (r < 0.55) return VCC
    return pickSignal()
  }

  // ── footprints on a grid ──
  const cols = Math.ceil(Math.sqrt((opts.parts * W) / H))
  const rows = Math.ceil(opts.parts / cols)
  const dx = (W - 10) / cols
  const dy = (H - 10) / rows
  const footprints: Footprint[] = []
  const silkscreen: BoardText[] = []

  for (let i = 0; i < opts.parts; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = 5 + dx * (col + 0.5)
    const y = 5 + dy * (row + 0.5)
    const back = i % 5 === 4
    const side: 'F' | 'B' = back ? 'B' : 'F'
    const rotDeg = (i % 4) * 90
    const cuLayer = back ? 'B.Cu' : 'F.Cu'
    const padLayers = [cuLayer, back ? 'B.Paste' : 'F.Paste', back ? 'B.Mask' : 'F.Mask']

    let libId: string
    let ref: string
    const pads: Pad[] = []
    const kind = i % 50
    if (kind === 0) {
      libId = 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'
      ref = `U${i}`
      for (let p = 0; p < 8; p++) {
        const left = p < 4
        pads.push({
          number: String(p + 1), type: 'smd', shape: 'roundrect',
          at: { x: left ? -2.7 : 2.7, y: (left ? p - 1.5 : 5.5 - p) * 1.27, rotDeg },
          size: { w: 1.5, h: 0.6 }, layers: padLayers,
          netId: p === 3 ? GND : p === 7 ? VCC : pickSignal(),
        })
      }
    } else if (kind === 1) {
      libId = 'Package_TO_SOT_SMD:SOT-23'
      ref = `Q${i}`
      pads.push(
        { number: '1', type: 'smd', shape: 'rect', at: { x: -0.95, y: 1, rotDeg }, size: { w: 0.8, h: 0.9 }, layers: padLayers, netId: pickSignal() },
        { number: '2', type: 'smd', shape: 'rect', at: { x: 0.95, y: 1, rotDeg }, size: { w: 0.8, h: 0.9 }, layers: padLayers, netId: pickSignal() },
        { number: '3', type: 'smd', shape: 'rect', at: { x: 0, y: -1, rotDeg }, size: { w: 0.8, h: 0.9 }, layers: padLayers, netId: GND },
      )
    } else {
      libId = i % 2 === 0 ? 'Resistor_SMD:R_0603_1608Metric' : 'Capacitor_SMD:C_0603_1608Metric'
      ref = (i % 2 === 0 ? 'R' : 'C') + i
      pads.push(
        { number: '1', type: 'smd', shape: 'roundrect', at: { x: -0.8, y: 0, rotDeg }, size: { w: 0.9, h: 0.95 }, layers: padLayers, netId: pickSignal() },
        { number: '2', type: 'smd', shape: 'roundrect', at: { x: 0.8, y: 0, rotDeg }, size: { w: 0.9, h: 0.95 }, layers: padLayers, netId: rnd() < 0.5 ? GND : rnd() < 0.5 ? VCC : pickSignal() },
      )
    }

    footprints.push({
      ref, value: kind === 0 ? 'IC' : kind === 1 ? '2N7002' : '10k', libId, layer: side,
      at: { x, y, rotDeg }, pads, properties: {},
    })
    silkscreen.push({ text: ref, at: { x, y: y - 2.2, rotDeg: 0 }, layer: back ? 'B.SilkS' : 'F.SilkS' })
  }
  silkscreen.push({ text: 'SYNTHETIC', at: { x: W / 2, y: H - 2, rotDeg: 0 }, layer: 'F.SilkS' })

  // ── tracks ──
  const tracks: TrackSegment[] = []
  for (let i = 0; i < opts.tracks; i++) {
    const sx = 3 + rnd() * (W - 6)
    const sy = 3 + rnd() * (H - 6)
    const ang = rnd() * Math.PI * 2
    const len = 0.5 + rnd() * 4.5
    tracks.push({
      kind: 'segment',
      start: { x: sx, y: sy },
      end: { x: Math.min(W - 1, Math.max(1, sx + Math.cos(ang) * len)), y: Math.min(H - 1, Math.max(1, sy + Math.sin(ang) * len)) },
      widthMm: 0.15 + rnd() * 0.25,
      layer: rnd() < 0.55 ? 'F.Cu' : 'B.Cu',
      netId: pickTrackNet(),
    })
  }

  // ── vias ──
  const vias: Via[] = []
  for (let i = 0; i < opts.vias; i++) {
    vias.push({
      at: { x: 3 + rnd() * (W - 6), y: 3 + rnd() * (H - 6) },
      sizeMm: 0.8, drillMm: 0.4, layers: ['F.Cu', 'B.Cu'],
      netId: i % 3 === 0 ? GND : pickSignal(),
    })
  }

  // ── zones with many holes ──
  // Many separate filled islands alternating between the rails. No holes: the
  // hole path of the zone triangulator is a separate concern from draw-call and
  // picking scale.
  const zones: Zone[] = []
  const islandsPerRail = Math.min(150, Math.floor(opts.parts / 10))
  const islandRows = Math.max(1, Math.ceil((islandsPerRail * 2) / 20))
  for (let k = 0; k < islandsPerRail * 2; k++) {
    const gx = k % 20
    const gy = Math.floor(k / 20)
    const cx = 6 + ((W - 12) / 20) * (gx + 0.5)
    const cy = 6 + ((H - 12) / islandRows) * (gy + 0.5)
    zones.push({
      netId: k % 2 === 0 ? GND : VCC,
      layer: k % 2 === 0 ? 'B.Cu' : 'F.Cu',
      polygon: [ngon(cx, cy, 2.5, 64)],
    })
  }

  return {
    netById,
    footprints,
    tracks,
    vias,
    zones,
    edgeCuts: [],
    outline: {
      outer: [[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]],
      holes: [],
      warnings: [],
    },
    silkscreen,
    boardThicknessMm: 1.6,
  }
}
