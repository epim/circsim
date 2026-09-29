#!/usr/bin/env node
/**
 * gen-synthetic-board.mjs - deterministic synthetic KiCad boards.
 *
 * Writes .kicad_pcb text in the syntax dialect of KiCad 6, 7, 8, 9 or 10, from a
 * small declarative spec (nets, footprints with pads, tracks, vias, zones, board
 * outline). Its purpose is test coverage the real-board corpus cannot give:
 *
 *   - layout the critic's copper checks depend on and no committed board has:
 *     rotated footprints (30, 45, 90, 270 degrees), parts on B.Cu, B.Cu tracks,
 *     vias, copper zones (#48);
 *   - one fixture per KiCad file-format generation (20211014, 20221018,
 *     20240108, 20241229, 20260206), so the "KiCad 6 to 10" claim is tested on
 *     the syntax each version writes (#63);
 *   - lantern-shaped connectivity (LM339 quad comparator, CD4000 logic on a
 *     gated rail, stranded LED nets) so the M8/M10/M11 real-board invariants run
 *     in CI without the maintainer's private board (#23).
 *
 * Every board is authored here from scratch (no third-party board content), so
 * the files may be committed. Geometry truth is KiCad's own convention, verified
 * against `kicad-cli pcb export ipc2581` by the corpus suite: a footprint's pad
 * at file-local (x, y) sits at
 *     fp.at + ( x cos(r) + y sin(r), -x sin(r) + y cos(r) )
 * with r the footprint angle in degrees and y pointing down the board. The same
 * formula holds for back-side footprints (KiCad stores their pads pre-flipped).
 *
 * Output is deterministic (ids come from a counter), so the committed fixtures
 * can be checked byte-for-byte against a regeneration.
 *
 * CLI:
 *   node scripts/gen-synthetic-board.mjs --preset routed-rotated --kicad 10 --out board.kicad_pcb
 *   node scripts/gen-synthetic-board.mjs --write-fixtures     regenerate fixtures/synthetic/*
 *   node scripts/gen-synthetic-board.mjs --list
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORMAT_VERSIONS = { 6: 20211014, 7: 20221018, 8: 20240108, 9: 20241229, 10: 20260206 }

// ---------------------------------------------------------------------------
// Geometry (KiCad convention)
// ---------------------------------------------------------------------------

/** Rotate a local point by a KiCad footprint angle (degrees, y-down board). */
export function rotateKicad(pt, rotDeg) {
  const r = (rotDeg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: pt.x * c + pt.y * s, y: -pt.x * s + pt.y * c }
}

/** World position of a pad of a footprint spec (fp.at = {x, y, rot}). */
export function padWorld(fp, pad) {
  const d = rotateKicad(pad, fp.at.rot ?? 0)
  return { x: fp.at.x + d.x, y: fp.at.y + d.y }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function num(n) {
  const v = Math.round(n * 1e6) / 1e6
  return Object.is(v, -0) ? '0' : String(v)
}

function q(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Deterministic uuid stream: the same spec always yields the same text. */
function makeIds() {
  let n = 0
  return () => {
    n++
    const h = (n * 2654435761 >>> 0).toString(16).padStart(8, '0')
    const t = n.toString(16).padStart(12, '0')
    return `${h}-5a17-4c0d-8e00-${t}`
  }
}

const LAYERS_OLD = [
  [0, 'F.Cu', 'signal'], [31, 'B.Cu', 'signal'], [32, 'B.Adhes', 'user', 'B.Adhesive'], [33, 'F.Adhes', 'user', 'F.Adhesive'],
  [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'], [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'],
  [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'], [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'],
  [42, 'Eco1.User', 'user', 'User.Eco1'], [43, 'Eco2.User', 'user', 'User.Eco2'], [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'],
  [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'], [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user']
]
const LAYERS_NEW = [
  [0, 'F.Cu', 'signal'], [2, 'B.Cu', 'signal'], [9, 'F.Adhes', 'user', 'F.Adhesive'], [11, 'B.Adhes', 'user', 'B.Adhesive'],
  [13, 'F.Paste', 'user'], [15, 'B.Paste', 'user'], [5, 'F.SilkS', 'user', 'F.Silkscreen'], [7, 'B.SilkS', 'user', 'B.Silkscreen'],
  [1, 'F.Mask', 'user'], [3, 'B.Mask', 'user'], [17, 'Dwgs.User', 'user', 'User.Drawings'], [19, 'Cmts.User', 'user', 'User.Comments'],
  [21, 'Eco1.User', 'user', 'User.Eco1'], [23, 'Eco2.User', 'user', 'User.Eco2'], [25, 'Edge.Cuts', 'user'], [27, 'Margin', 'user'],
  [31, 'F.CrtYd', 'user', 'F.Courtyard'], [29, 'B.CrtYd', 'user', 'B.Courtyard'], [35, 'F.Fab', 'user'], [33, 'B.Fab', 'user']
]

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

/**
 * Generate .kicad_pcb text.
 *
 * spec = {
 *   kicad: 6 | 7 | 8 | 9 | 10,
 *   nets: string[],                        // net names (index + 1 is the legacy id)
 *   outline: { x0, y0, x1, y1 },           // Edge.Cuts rectangle (omit for none)
 *   footprints: [{ ref, value, lib, at: {x, y, rot}, side: 'F'|'B', pads: [{
 *       num, x, y, w, h, shape?, type?: 'smd'|'thru_hole', drill?, net? }] }],
 *   tracks: [{ net, layer, width, pts: [[x, y], ...] }],   // polyline, one segment per hop
 *   vias: [{ net, x, y, size?, drill? }],
 *   zones: [{ net, layer, outline: [[x, y], ...] }]
 * }
 */
export function generateBoard(spec) {
  const kicad = spec.kicad
  if (!(kicad in FORMAT_VERSIONS)) throw new Error(`unsupported KiCad major ${kicad}`)
  const version = FORMAT_VERSIONS[kicad]
  const nextId = makeIds()
  const legacyNets = kicad <= 9 // numeric net table present up to and including 9
  const uuidLegacyTstamp = kicad <= 7 // (tstamp X) up to 7, (uuid "X") from 8
  const netId = (name) => spec.nets.indexOf(name) + 1

  const idNode = () => (uuidLegacyTstamp ? `(tstamp ${nextId()})` : `(uuid ${q(nextId())})`)
  const netRef = (name) => {
    if (name === undefined || name === null || name === '') return ''
    if (!spec.nets.includes(name)) throw new Error(`unknown net ${name}`)
    return legacyNets ? `(net ${netId(name)} ${q(name)})` : `(net ${q(name)})`
  }
  const netRefShort = (name) => (legacyNets ? `(net ${netId(name)})` : `(net ${q(name)})`)
  const stroke = (w) => (kicad >= 7 ? `(stroke (width ${num(w)}) (type solid))` : `(width ${num(w)})`)

  const out = []
  // ---- header ----
  if (kicad <= 7) out.push(`(kicad_pcb (version ${version}) (generator pcbnew)`)
  else out.push(`(kicad_pcb (version ${version}) (generator ${q('pcbnew')}) (generator_version ${q(`${kicad}.0`)})`)
  out.push('  (general')
  out.push('    (thickness 1.6)')
  out.push('  )')
  out.push('  (paper "A4")')
  out.push('  (layers')
  for (const [n, name, type, alias] of kicad >= 9 ? LAYERS_NEW : LAYERS_OLD) {
    out.push(`    (${n} ${q(name)} ${type}${alias ? ' ' + q(alias) : ''})`)
  }
  out.push('  )')
  out.push('  (setup')
  out.push('    (pad_to_mask_clearance 0)')
  out.push('  )')
  // ---- net table (KiCad 6 to 9) ----
  if (legacyNets) {
    out.push('  (net 0 "")')
    spec.nets.forEach((name, i) => out.push(`  (net ${i + 1} ${q(name)})`))
  }

  // ---- footprints ----
  for (const fp of spec.footprints) {
    const back = fp.side === 'B'
    const cu = back ? 'B.Cu' : 'F.Cu'
    const silk = back ? 'B.SilkS' : 'F.SilkS'
    const fab = back ? 'B.Fab' : 'F.Fab'
    const rot = fp.at.rot ?? 0
    const atText = rot ? `(at ${num(fp.at.x)} ${num(fp.at.y)} ${num(rot)})` : `(at ${num(fp.at.x)} ${num(fp.at.y)})`
    const thru = fp.pads.some((p) => p.type === 'thru_hole')
    out.push(`  (footprint ${q(fp.lib)} (layer ${q(cu)})`)
    out.push(`    ${kicad === 6 ? '(tedit 5F000000) ' : ''}${idNode()}`)
    out.push(`    ${atText}`)
    const eff = '(effects (font (size 1 1) (thickness 0.15)))'
    if (kicad <= 7) {
      out.push(`    (fp_text reference ${q(fp.ref)} (at 0 -2 ${num(rot)}) (layer ${q(silk)}) ${eff} ${idNode()})`)
      out.push(`    (fp_text value ${q(fp.value)} (at 0 2 ${num(rot)}) (layer ${q(fab)}) ${eff} ${idNode()})`)
    } else {
      out.push(`    (property "Reference" ${q(fp.ref)} (at 0 -2 ${num(rot)}) (layer ${q(silk)}) ${idNode()} ${eff})`)
      out.push(`    (property "Value" ${q(fp.value)} (at 0 2 ${num(rot)}) (layer ${q(fab)}) ${idNode()} ${eff})`)
      out.push(`    (property "Datasheet" "" (at 0 0 ${num(rot)}) (layer ${q(fab)}) (hide yes) ${idNode()} ${eff})`)
    }
    out.push(`    (attr ${thru ? 'through_hole' : 'smd'})`)
    for (const p of fp.pads) {
      const isThru = p.type === 'thru_hole'
      const shape = p.shape ?? (isThru ? 'circle' : 'rect')
      const layers = isThru
        ? kicad === 6 ? '*.Cu *.Mask' : '"*.Cu" "*.Mask"'
        : back ? '"B.Cu" "B.Paste" "B.Mask"' : '"F.Cu" "F.Paste" "F.Mask"'
      // KiCad writes a pad angle that already includes the footprint angle.
      const padAt = rot ? `(at ${num(p.x)} ${num(p.y)} ${num(rot)})` : `(at ${num(p.x)} ${num(p.y)})`
      const drill = isThru ? ` (drill ${num(p.drill ?? 0.8)})` : ''
      out.push(
        `    (pad ${q(p.num)} ${isThru ? 'thru_hole' : 'smd'} ${shape} ${padAt} (size ${num(p.w)} ${num(p.h)})${drill} (layers ${layers}) ${netRef(p.net)} ${idNode()})`
      )
    }
    out.push('  )')
  }

  // ---- edge cuts ----
  if (spec.outline) {
    const { x0, y0, x1, y1 } = spec.outline
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    for (let i = 0; i < 4; i++) {
      const [a, b] = [corners[i], corners[(i + 1) % 4]]
      out.push(
        `  (gr_line (start ${num(a[0])} ${num(a[1])}) (end ${num(b[0])} ${num(b[1])}) ${stroke(0.1)} (layer "Edge.Cuts") ${idNode()})`
      )
    }
  }

  // ---- tracks ----
  for (const t of spec.tracks ?? []) {
    for (let i = 0; i + 1 < t.pts.length; i++) {
      const [a, b] = [t.pts[i], t.pts[i + 1]]
      out.push(
        `  (segment (start ${num(a[0])} ${num(a[1])}) (end ${num(b[0])} ${num(b[1])}) (width ${num(t.width)}) (layer ${q(t.layer)}) ${netRefShort(t.net)} ${idNode()})`
      )
    }
  }

  // ---- vias ----
  for (const v of spec.vias ?? []) {
    out.push(
      `  (via (at ${num(v.x)} ${num(v.y)}) (size ${num(v.size ?? 0.8)}) (drill ${num(v.drill ?? 0.4)}) (layers "F.Cu" "B.Cu") ${netRefShort(v.net)} ${idNode()})`
    )
  }

  // ---- zones ----
  for (const z of spec.zones ?? []) {
    const pts = z.outline.map(([x, y]) => `(xy ${num(x)} ${num(y)})`).join(' ')
    const netPart = legacyNets ? `(net ${netId(z.net)}) (net_name ${q(z.net)})` : `(net ${q(z.net)})`
    out.push(`  (zone ${netPart} (layer ${q(z.layer)}) ${idNode()} (hatch edge 0.5)`)
    out.push('    (connect_pads (clearance 0.3))')
    out.push('    (min_thickness 0.25)')
    out.push('    (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3))')
    out.push(`    (polygon (pts ${pts}))`)
    out.push(`    (filled_polygon (layer ${q(z.layer)}) (pts ${pts}))`)
    out.push('  )')
  }

  out.push(')')
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Preset boards
// ---------------------------------------------------------------------------

const SMD_R = { w: 1.0, h: 1.3 }

function twoPad(ref, value, lib, x, y, rot, side, netA, netB, half = 1.0) {
  return {
    ref, value, lib, at: { x, y, rot }, side,
    pads: [
      { num: '1', x: -half, y: 0, ...SMD_R, net: netA },
      { num: '2', x: half, y: 0, ...SMD_R, net: netB }
    ]
  }
}

/**
 * dialect-probe: the smallest board that touches every syntax the parser reads
 * (numeric or name-only nets, fp_text vs property references, tstamp vs uuid,
 * a rotated F.Cu part, a rotated B.Cu part, a segment, a via, a zone, an outline).
 * One per KiCad format generation.
 */
export function dialectProbe(kicad) {
  const fps = [
    twoPad('R1', '10k', 'Resistor_SMD:R_0805_2012Metric', 110, 110, 90, 'F', 'VIN', 'MID'),
    twoPad('R2', '10k', 'Resistor_SMD:R_0805_2012Metric', 120, 110, 0, 'F', 'MID', 'GND'),
    twoPad('C1', '100n', 'Capacitor_SMD:C_0805_2012Metric', 115, 120, 45, 'B', 'MID', 'GND')
  ]
  const r1p2 = padWorld(fps[0], fps[0].pads[1])
  const r2p1 = padWorld(fps[1], fps[1].pads[0])
  return {
    kicad,
    nets: ['VIN', 'MID', 'GND'],
    outline: { x0: 100, y0: 100, x1: 130, y1: 130 },
    footprints: fps,
    tracks: [{ net: 'MID', layer: 'F.Cu', width: 0.25, pts: [[r1p2.x, r1p2.y], [r2p1.x, r2p1.y]] }],
    vias: [{ net: 'GND', x: 124, y: 115 }],
    zones: [{ net: 'GND', layer: 'B.Cu', outline: [[102, 102], [128, 102], [128, 128], [102, 128]] }]
  }
}

/**
 * routed-rotated: a small fully routed board with parts at 30, 45, 90 and 270
 * degrees on F.Cu, parts on B.Cu (one rotated), tracks on both copper layers,
 * vias, a B.Cu ground pour and an F.Cu supply pour. Every pad with a net has
 * same-net copper exactly under its KiCad-true centre.
 */
export function routedRotated(kicad = 10) {
  const nets = ['VIN', 'N1', 'N2', 'GND', 'SIG']
  const j1 = {
    ref: 'J1', value: 'Conn_01x02', lib: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    at: { x: 105, y: 105, rot: 0 }, side: 'F',
    pads: [
      { num: '1', x: 0, y: 0, w: 1.7, h: 1.7, type: 'thru_hole', drill: 1.0, net: 'VIN' },
      { num: '2', x: 0, y: 2.54, w: 1.7, h: 1.7, type: 'thru_hole', drill: 1.0, net: 'GND' }
    ]
  }
  const r1 = twoPad('R1', '10k', 'Resistor_SMD:R_0805_2012Metric', 115, 105, 90, 'F', 'VIN', 'N1')
  const r2 = twoPad('R2', '4.7k', 'Resistor_SMD:R_0805_2012Metric', 125, 105, 30, 'F', 'N1', 'N2')
  const r3 = twoPad('R3', '1k', 'Resistor_SMD:R_0805_2012Metric', 135, 105, 45, 'F', 'N2', 'GND')
  const c2 = twoPad('C2', '100n', 'Capacitor_SMD:C_0805_2012Metric', 125, 115, 270, 'F', 'VIN', 'GND')
  const c1 = twoPad('C1', '100n', 'Capacitor_SMD:C_0805_2012Metric', 115, 120, 90, 'B', 'N1', 'GND')
  const r4 = twoPad('R4', '2.2k', 'Resistor_SMD:R_0805_2012Metric', 125, 122, 0, 'B', 'SIG', 'GND')
  const d1 = twoPad('D1', 'LED', 'LED_SMD:LED_0805_2012Metric', 135, 120, 135, 'B', 'SIG', 'GND')
  const fps = [j1, r1, r2, r3, c2, c1, r4, d1]
  const P = (fp, i) => {
    const w = padWorld(fp, fp.pads[i])
    return [w.x, w.y]
  }
  // The N1 via sits ON the R1-R2 track, 30 percent of the way along it.
  const n1a = P(r1, 1)
  const n1b = P(r2, 0)
  const n1Via = [n1a[0] + 0.3 * (n1b[0] - n1a[0]), n1a[1] + 0.3 * (n1b[1] - n1a[1])]
  const tracks = [
    // Top-copper chain: VIN -> R1 -> R2 -> R3 -> GND via.
    { net: 'VIN', layer: 'F.Cu', width: 0.4, pts: [P(j1, 0), P(r1, 0)] },
    { net: 'N1', layer: 'F.Cu', width: 0.25, pts: [P(r1, 1), P(r2, 0)] },
    { net: 'N2', layer: 'F.Cu', width: 0.25, pts: [P(r2, 1), P(r3, 0)] },
    { net: 'GND', layer: 'F.Cu', width: 0.4, pts: [P(r3, 1), [P(r3, 1)[0] + 2, P(r3, 1)[1]]] },
    // VIN feed down to the top decoupling cap C2.
    { net: 'VIN', layer: 'F.Cu', width: 0.4, pts: [P(r1, 0), [P(r1, 0)[0], P(c2, 0)[1]], P(c2, 0)] },
    // Bottom copper: N1 via -> C1, SIG between R4 and D1.
    { net: 'N1', layer: 'B.Cu', width: 0.25, pts: [n1Via, [n1Via[0], P(c1, 0)[1]], P(c1, 0)] },
    { net: 'SIG', layer: 'B.Cu', width: 0.25, pts: [P(r4, 0), [P(r4, 0)[0], 124], [P(d1, 0)[0], 124], P(d1, 0)] }
  ]
  const vias = [
    { net: 'GND', x: P(r3, 1)[0] + 2, y: P(r3, 1)[1] },
    { net: 'N1', x: n1Via[0], y: n1Via[1] },
    { net: 'GND', x: P(c2, 1)[0], y: P(c2, 1)[1] + 2 }
  ]
  // c2's GND pad reaches the pour through a short top-copper stub and a via.
  tracks.push({ net: 'GND', layer: 'F.Cu', width: 0.4, pts: [P(c2, 1), [P(c2, 1)[0], P(c2, 1)[1] + 2]] })
  return {
    kicad,
    nets,
    outline: { x0: 100, y0: 98, x1: 145, y1: 128 },
    footprints: fps,
    tracks,
    vias,
    zones: [
      { net: 'GND', layer: 'B.Cu', outline: [[101, 99], [144, 99], [144, 127], [101, 127]] },
      { net: 'VIN', layer: 'F.Cu', outline: [[112, 110], [118, 110], [118, 118], [112, 118]] }
    ]
  }
}

/**
 * lantern-shape: connectivity modelled on the maintainer's private led_lantern
 * board, no copper. It reproduces the structures behind the M8, M10 and M11
 * fixes so their regression tests run in CI:
 *   - U5 LM339 (quad comparator, 14 pins wired, outputs 13 and 14 to R38/R39),
 *   - U7 CD40106 and U8 CD4011 whose VDD (pad 14) rides /VGATED while the bench
 *     supply belongs on /PACK+,
 *   - two LED nets (/LED1_K, /LED1_DRIVE) that are genuinely stranded (only a
 *     resistor and an off-board header) and must be bled,
 *   - /LED3_K and /LED4_K that look stranded but hang off comparator outputs
 *     through R38/R39 and must NOT be bled.
 */
export function lanternShape(kicad = 10) {
  const nets = [
    'GND', '/PACK+', '/VGATED', '/OSC', '/LOGIC', '/LED1_K', '/LED1_DRIVE', '/LED3_K', '/LED4_K',
    '/GAUGE_C1', '/GAUGE_C2', '/GAUGE_C3', '/GAUGE_C4', '/SENSE', '/REF'
  ]
  const soic = (ref, value, x, y, netsByPad, count = 14) => ({
    ref, value, lib: `Package_SO:SOIC-${count}_3.9x8.7mm_P1.27mm`, at: { x, y, rot: 0 }, side: 'F',
    pads: Array.from({ length: count }, (_, i) => {
      const n = i + 1
      const half = count / 2
      const left = n <= half
      return {
        num: String(n),
        x: left ? -2.7 : 2.7,
        y: (left ? n - 1 : count - n) * 1.27 - ((half - 1) * 1.27) / 2,
        w: 1.5, h: 0.6, net: netsByPad[n]
      }
    })
  })
  const header = (ref, x, y, netA, netB) => ({
    ref, value: 'Conn_01x02', lib: 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
    at: { x, y, rot: 0 }, side: 'F',
    pads: [
      { num: '1', x: 0, y: 0, w: 1.7, h: 1.7, type: 'thru_hole', drill: 1.0, net: netA },
      { num: '2', x: 0, y: 2.54, w: 1.7, h: 1.7, type: 'thru_hole', drill: 1.0, net: netB }
    ]
  })
  const fps = [
    header('J1', 100, 100, '/PACK+', 'GND'),
    header('J2', 100, 110, '/LED3_K', '/LED4_K'),
    header('J3', 100, 120, '/LED1_DRIVE', '/LED1_K'),
    // U5 LM339: 1=OUT2 2=OUT1 3=VCC 4=IN1- 5=IN1+ 6=IN2- 7=IN2+ 8=IN3- 9=IN3+ 10=IN4- 11=IN4+ 12=GND 13=OUT4 14=OUT3
    soic('U5', 'LM339', 120, 105, {
      1: '/GAUGE_C2', 2: '/GAUGE_C1', 3: '/PACK+', 4: '/SENSE', 5: '/REF', 6: '/SENSE', 7: '/REF',
      8: '/SENSE', 9: '/REF', 10: '/SENSE', 11: '/REF', 12: 'GND', 13: '/GAUGE_C4', 14: '/GAUGE_C3'
    }),
    // U7 CD40106: pin 1 in, pin 2 out (Schmitt oscillator with R5/C5), VDD 14 on /VGATED, VSS 7.
    soic('U7', 'CD40106', 140, 105, { 1: '/OSC', 2: '/OSC_OUT_UNUSED', 7: 'GND', 14: '/VGATED' }),
    // U8 CD4011: NAND A on pins 1, 2 -> 3.
    soic('U8', 'CD4011', 160, 105, { 1: '/OSC', 2: '/OSC', 3: '/LOGIC', 7: 'GND', 14: '/VGATED' }),
    twoPad('R5', '100k', 'Resistor_SMD:R_0805_2012Metric', 140, 90, 0, 'F', '/OSC', '/LOGIC'),
    twoPad('C5', '10n', 'Capacitor_SMD:C_0805_2012Metric', 145, 90, 0, 'F', '/OSC', 'GND'),
    twoPad('R6', '10k', 'Resistor_SMD:R_0805_2012Metric', 150, 90, 0, 'F', '/PACK+', '/SENSE'),
    twoPad('R7', '10k', 'Resistor_SMD:R_0805_2012Metric', 155, 90, 0, 'F', '/SENSE', 'GND'),
    twoPad('R8', '10k', 'Resistor_SMD:R_0805_2012Metric', 160, 90, 0, 'F', '/PACK+', '/REF'),
    twoPad('R9', '4.7k', 'Resistor_SMD:R_0805_2012Metric', 165, 90, 0, 'F', '/REF', 'GND'),
    twoPad('R10', '1', 'Resistor_SMD:R_0805_2012Metric', 170, 90, 0, 'F', '/PACK+', '/VGATED'),
    twoPad('R36', '2.2k', 'Resistor_SMD:R_0805_2012Metric', 105, 130, 0, 'F', '/LED1_K', '/LED1_DRIVE'),
    twoPad('R38', '2.2k', 'Resistor_SMD:R_0805_2012Metric', 105, 135, 0, 'F', '/LED3_K', '/GAUGE_C3'),
    twoPad('R39', '2.2k', 'Resistor_SMD:R_0805_2012Metric', 105, 140, 0, 'F', '/LED4_K', '/GAUGE_C4'),
    twoPad('R40', '10k', 'Resistor_SMD:R_0805_2012Metric', 110, 135, 0, 'F', '/GAUGE_C1', '/PACK+'),
    twoPad('R41', '10k', 'Resistor_SMD:R_0805_2012Metric', 110, 140, 0, 'F', '/GAUGE_C2', '/PACK+'),
    twoPad('R42', '10k', 'Resistor_SMD:R_0805_2012Metric', 115, 135, 0, 'F', '/LOGIC', 'GND'),
    twoPad('C1', '100n', 'Capacitor_SMD:C_0805_2012Metric', 120, 120, 0, 'F', '/PACK+', 'GND'),
    twoPad('C2', '100n', 'Capacitor_SMD:C_0805_2012Metric', 140, 120, 0, 'F', '/VGATED', 'GND'),
    twoPad('C3', '100n', 'Capacitor_SMD:C_0805_2012Metric', 160, 120, 0, 'F', '/VGATED', 'GND')
  ]
  return { kicad, nets: [...nets, '/OSC_OUT_UNUSED'], outline: { x0: 95, y0: 85, x1: 180, y1: 145 }, footprints: fps, tracks: [], vias: [], zones: [] }
}

export const PRESETS = {
  'dialect-probe': (kicad) => dialectProbe(kicad),
  'routed-rotated': (kicad) => routedRotated(kicad),
  'lantern-shape': (kicad) => lanternShape(kicad)
}

/** Committed fixtures: [relative path under fixtures/synthetic, preset, kicad major]. */
export const FIXTURES = [
  ['dialect-probe-kicad6.kicad_pcb', 'dialect-probe', 6],
  ['dialect-probe-kicad7.kicad_pcb', 'dialect-probe', 7],
  ['dialect-probe-kicad8.kicad_pcb', 'dialect-probe', 8],
  ['dialect-probe-kicad9.kicad_pcb', 'dialect-probe', 9],
  ['dialect-probe-kicad10.kicad_pcb', 'dialect-probe', 10],
  ['routed-rotated-kicad10.kicad_pcb', 'routed-rotated', 10]
]

export function generatePreset(preset, kicad) {
  const make = PRESETS[preset]
  if (!make) throw new Error(`unknown preset ${preset} (have: ${Object.keys(PRESETS).join(', ')})`)
  return generateBoard(make(kicad))
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  const arg = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (args.includes('--list')) {
    console.log(`presets: ${Object.keys(PRESETS).join(', ')}`)
    console.log(`kicad majors: ${Object.keys(FORMAT_VERSIONS).join(', ')}`)
    return
  }
  if (args.includes('--write-fixtures')) {
    const dir = path.join(root, 'fixtures', 'synthetic')
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, preset, kicad] of FIXTURES) {
      fs.writeFileSync(path.join(dir, file), generatePreset(preset, kicad))
      console.log(`wrote fixtures/synthetic/${file}`)
    }
    return
  }
  const preset = arg('--preset') ?? 'routed-rotated'
  const kicad = Number(arg('--kicad') ?? 10)
  const text = generatePreset(preset, kicad)
  const outPath = arg('--out')
  if (outPath) fs.writeFileSync(outPath, text)
  else process.stdout.write(text)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
