/**
 * gen-sample-board.mjs - the third bundled sample board, "sensor-node".
 *
 * A 100 x 70 mm hobbyist-style board of about 95 parts, authored from scratch (no
 * third-party board content) in KiCad 10 syntax with `generateBoard` from
 * gen-synthetic-board.mjs:
 *
 *   - 5 V in on a header, reverse-protection Schottky and a TVS, an AMS1117-3.3
 *     regulator and its caps (power);
 *   - an ESP32-WROOM-32 module with reset and boot buttons, a programming header,
 *     strap pull-ups and bypass caps (microcontroller);
 *   - two 74HC164 shift registers driving 16 LEDs through 330 ohm resistors
 *     (LED strip, parts at 0 and 180 degrees on F.Cu);
 *   - an NTC divider buffered by an LM358 and a light threshold on an LM393
 *     (sensors);
 *   - a 2N7002 fan switch with a flyback diode and a 2N3904 strip switch
 *     (loads), an I2C header with pull-ups, status LEDs, test points;
 *   - bypass capacitors under four ICs on B.Cu, a B.Cu ground pour.
 *
 * The LED lanes are routed by hand-written geometry. Every other net is routed by a
 * small deterministic two-layer grid router (`route`, below) with 0.25 mm tracks,
 * 0.5 mm power tracks and 0.2 mm clearance; GND reaches the pour through a stub and a
 * via at every pad. The router is a build tool for this one file: circsim never
 * generates a board it grades, and nothing here runs at app time.
 *
 * Output is deterministic. `resources/sample/sensor-node.kicad_pcb` is checked
 * byte-for-byte against a regeneration by test/corpus/sample.corpus.test.ts, and
 * that suite proves with kicad-cli that KiCad loads it, puts every pad where this
 * script says and on the net it says, and finds zero unconnected items.
 *
 * CLI:
 *   node scripts/gen-sample-board.mjs --write     write resources/sample/sensor-node.kicad_pcb
 *   node scripts/gen-sample-board.mjs --out f     write to f
 *   node scripts/gen-sample-board.mjs --stats     print part, net, track and via counts
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateBoard, padWorld, rotateKicad } from './gen-synthetic-board.mjs'

export const SAMPLE_NAME = 'sensor-node'
export const SAMPLE_FILE = `resources/sample/${SAMPLE_NAME}.kicad_pcb`

// ---------------------------------------------------------------------------
// Footprint builders. Pad geometry follows the KiCad standard library; back-side
// parts get their pads mirrored in x, because KiCad stores pads pre-flipped.
// ---------------------------------------------------------------------------

function mirror(fp) {
  if (fp.side !== 'B') return fp
  return { ...fp, pads: fp.pads.map((p) => ({ ...p, x: -p.x })) }
}

function part(ref, value, lib, x, y, rot, side, pads) {
  return mirror({ ref, value, lib, at: { x, y, rot }, side, pads })
}

const two = (ref, value, lib, x, y, rot, side, half, w, h, na, nb) =>
  part(ref, value, lib, x, y, rot, side, [
    { num: '1', x: -half, y: 0, w, h, net: na },
    { num: '2', x: half, y: 0, w, h, net: nb }
  ])

const res = (ref, value, x, y, rot, side, na, nb) =>
  two(ref, value, 'Resistor_SMD:R_0603_1608Metric', x, y, rot, side, 0.825, 0.8, 0.95, na, nb)
const cap06 = (ref, value, x, y, rot, side, na, nb) =>
  two(ref, value, 'Capacitor_SMD:C_0603_1608Metric', x, y, rot, side, 0.775, 0.75, 0.9, na, nb)
const cap08 = (ref, value, x, y, rot, side, na, nb) =>
  two(ref, value, 'Capacitor_SMD:C_0805_2012Metric', x, y, rot, side, 0.95, 1.0, 1.45, na, nb)
/** LED_0603: pad 1 is the cathode, pad 2 the anode (KiCad convention). */
const led = (ref, value, x, y, rot, side, cathode, anode) =>
  two(ref, value, 'LED_SMD:LED_0603_1608Metric', x, y, rot, side, 0.8, 0.8, 0.95, cathode, anode)
/** D_SOD-123 and D_SMA: pad 1 is the cathode. */
const sod = (ref, value, x, y, rot, side, cathode, anode) =>
  two(ref, value, 'Diode_SMD:D_SOD-123', x, y, rot, side, 1.65, 0.9, 1.2, cathode, anode)
const sma = (ref, value, x, y, rot, side, cathode, anode) =>
  two(ref, value, 'Diode_SMD:D_SMA', x, y, rot, side, 2.0, 1.8, 2.3, cathode, anode)
const button = (ref, x, y, rot, na, nb) =>
  two(ref, 'SW_Push', 'Button_Switch_SMD:SW_SPST_PTS645', x, y, rot, 'F', 3.1, 1.8, 1.4, na, nb)
const testPoint = (ref, x, y, net) =>
  part(ref, 'TestPoint', 'TestPoint:TestPoint_Pad_D1.5mm', x, y, 0, 'F', [
    { num: '1', x: 0, y: 0, w: 1.5, h: 1.5, shape: 'circle', net }
  ])

/** 1xN pin header, pad 1 square, pitch 2.54 mm down the y axis (rot 90 lays it along x). */
function header(ref, x, y, rot, nets) {
  return part(
    ref,
    `Conn_01x0${nets.length}`,
    `Connector_PinHeader_2.54mm:PinHeader_1x0${nets.length}_P2.54mm_Vertical`,
    x, y, rot, 'F',
    nets.map((net, i) => ({
      num: String(i + 1), x: 0, y: i * 2.54, w: 1.7, h: 1.7, shape: i === 0 ? 'rect' : 'circle',
      type: 'thru_hole', drill: 1.0, net
    }))
  )
}

function sot23(ref, value, x, y, rot, n1, n2, n3) {
  return part(ref, value, 'Package_TO_SOT_SMD:SOT-23', x, y, rot, 'F', [
    { num: '1', x: -0.95, y: 1.0, w: 0.8, h: 0.9, net: n1 },
    { num: '2', x: 0.95, y: 1.0, w: 0.8, h: 0.9, net: n2 },
    { num: '3', x: 0, y: -1.0, w: 0.8, h: 0.9, net: n3 }
  ])
}

function sot223(ref, value, x, y, rot, n1, n2, n3, tab) {
  return part(ref, value, 'Package_TO_SOT_SMD:SOT-223', x, y, rot, 'F', [
    { num: '1', x: -2.3, y: 3.15, w: 1.5, h: 2.0, net: n1 },
    { num: '2', x: 0, y: 3.15, w: 1.5, h: 2.0, net: n2 },
    { num: '3', x: 2.3, y: 3.15, w: 1.5, h: 2.0, net: n3 },
    { num: '4', x: 0, y: -3.15, w: 3.4, h: 2.0, net: tab }
  ])
}

/** SOIC-n, pin 1 top left, counter-clockwise; `nets` maps pin number to net. */
function soic(ref, value, x, y, rot, count, nets) {
  const half = count / 2
  return part(
    ref, value, `Package_SO:SOIC-${count}_3.9x${count === 8 ? '4.9' : count === 14 ? '8.7' : '9.9'}mm_P1.27mm`,
    x, y, rot, 'F',
    Array.from({ length: count }, (_, i) => {
      const n = i + 1
      const left = n <= half
      return {
        num: String(n),
        x: left ? -2.475 : 2.475,
        y: (left ? n - 1 : count - n) * 1.27 - ((half - 1) * 1.27) / 2,
        w: 1.95, h: 0.6, net: nets[n]
      }
    })
  )
}

/** ESP32-WROOM-32 pad layout (module centre at the origin, antenna toward -y). */
function esp32(ref, x, y, nets) {
  const pads = []
  for (let k = 0; k < 15; k++) pads.push({ num: String(k + 1), x: -8.75, y: -5.26 + 1.27 * k, w: 1.5, h: 0.9 })
  for (let k = 0; k < 9; k++) pads.push({ num: String(16 + k), x: -5.08 + 1.27 * k, y: 12.0, w: 0.9, h: 1.5 })
  for (let k = 0; k < 14; k++) pads.push({ num: String(25 + k), x: 8.75, y: 12.52 - 1.27 * k, w: 1.5, h: 0.9 })
  pads.push({ num: '39', x: 0, y: 4.0, w: 3.9, h: 3.9 })
  return part(ref, 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32', x, y, 0, 'F', pads.map((p) => ({
    ...p,
    net: nets[p.num],
    // the schematic marks the unused module pins no-connect; KiCad writes that as a pintype suffix
    ...(nets[p.num] ? {} : { pintype: 'unspecified+no_connect' })
  })))
}

// ---------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------

const X0 = 100
const Y0 = 100
const BW = 100
const BH = 70

const POWER_NETS = new Set(['VIN_RAW', '+5V', '+3V3', 'FAN_NEG', 'STRIP_NEG'])

function build() {
  const fps = []
  const tracks = []
  const nets = new Set(['GND'])
  const add = (fp) => fps.push(fp)

  // ---- power ----
  add(header('J1', 104, 104, 0, ['VIN_RAW', 'GND']))
  add(sma('D2', 'SMAJ24A', 112, 104.5, 0, 'F', 'VIN_RAW', 'GND'))
  add(sma('D1', 'SS14', 112, 110, 180, 'F', '+5V', 'VIN_RAW'))
  add(cap08('C1', '10u', 119, 104.5, 90, 'F', '+5V', 'GND'))
  add(cap06('C2', '100n', 123, 104.5, 90, 'F', '+5V', 'GND'))
  add(sot223('U1', 'AMS1117-3.3', 119, 112, 0, 'GND', '+3V3', '+5V', '+3V3'))
  add(cap08('C3', '22u', 126, 109, 90, 'F', '+3V3', 'GND'))
  add(cap06('C4', '100n', 126, 114, 90, 'F', '+3V3', 'GND'))
  add(res('R1', '330', 106, 114, 0, 'F', '+3V3', 'PWR_LED_A'))
  add(led('D3', 'LED', 111, 114, 0, 'F', 'GND', 'PWR_LED_A'))
  add(testPoint('TP1', 104, 119, '+5V'))
  add(testPoint('TP2', 108, 119, '+3V3'))
  add(testPoint('TP3', 112, 119, 'GND'))

  // ---- microcontroller ----
  add(esp32('U2', 139, 137, {
    1: 'GND', 2: '+3V3', 3: 'EN', 6: 'TEMP_ADC', 7: 'LIGHT_ADC', 10: 'FAN_G_IN', 11: 'STRIP_G_IN',
    15: 'GND', 24: 'LED_STATUS2', 23: 'LED_STATUS1', 25: 'IO0', 30: 'SR_CLK', 33: 'SDA', 34: 'RXD', 35: 'TXD',
    36: 'SCL', 37: 'SR_DATA', 38: 'GND', 39: 'GND'
  }))
  add(cap08('C5', '10u', 133, 118, 0, 'F', '+3V3', 'GND'))
  add(cap06('C6', '100n', 137, 118, 0, 'F', '+3V3', 'GND'))
  add(cap06('C7', '100n', 141, 118, 0, 'F', '+3V3', 'GND'))
  add(res('R2', '10k', 128, 120, 90, 'F', '+3V3', 'EN'))
  add(cap06('C8', '1u', 125, 120, 90, 'F', 'EN', 'GND'))
  add(res('R3', '10k', 150, 120, 90, 'F', '+3V3', 'IO0'))
  add(button('SW1', 131, 107, 0, 'EN', 'GND'))
  add(button('SW2', 143, 107, 0, 'IO0', 'GND'))
  add(header('J2', 150, 102.5, 0, ['GND', '+3V3', 'TXD', 'RXD', 'EN']))

  // ---- LED strip: two 74HC164, 16 LEDs ----
  const sr = (ref, y, qNets, aNet, bNet, clkNet) =>
    soic(ref, '74HC164', 176, y, 0, 14, {
      1: aNet, 2: bNet, 3: qNets[0], 4: qNets[1], 5: qNets[2], 6: qNets[3], 7: 'GND',
      8: clkNet, 9: '+3V3', 10: qNets[4], 11: qNets[5], 12: qNets[6], 13: qNets[7], 14: '+3V3'
    })
  const q = (i) => `Q${i}`
  add(sr('U5', 113, [1, 2, 3, 4, 5, 6, 7, 8].map(q), 'SR_DATA', 'SR_DATA', 'SR_CLK'))
  add(sr('U6', 150, [9, 10, 11, 12, 13, 14, 15, 16].map(q), 'Q8', 'Q8', 'SR_CLK'))
  add(cap06('C9', '100n', 168, 106, 0, 'F', '+3V3', 'GND'))
  add(cap06('C10', '100n', 168, 143, 0, 'F', '+3V3', 'GND'))

  // LED lanes: pin -> R -> LED along y of the pin. Left side pins 3..6 are
  // channels (qNets 0..3), right side pins 10..13 are channels 4..7. Lanes
  // alternate between a near column (A) and a far column (B), so a far lane
  // passes between the near column's parts.
  const lane = (srFp, channel, pinNum, dir, col, ledIdx) => {
    const pad = srFp.pads.find((p) => p.num === pinNum)
    const w = padWorld(srFp, pad)
    const rx = w.x + dir * (col === 'A' ? 4.0 : 12.0)
    const lx = w.x + dir * (col === 'A' ? 8.0 : 16.0)
    const idx = ledIdx
    // pad 1 is on the -x side: it faces the shift register on a right-going lane, the LED on a left-going one
    const rr = dir < 0
      ? res(`R${10 + idx}`, '330', rx, w.y, 0, 'F', `LA${channel}`, q(channel))
      : res(`R${10 + idx}`, '330', rx, w.y, 0, 'F', q(channel), `LA${channel}`)
    // Left-going lane: the LED anode (pad 2) faces the resistor at rot 0; right-going needs 180.
    const dd = led(`D${10 + idx}`, 'LED', lx, w.y, dir < 0 ? 0 : 180, 'F', 'GND', `LA${channel}`)
    add(rr)
    add(dd)
    const rNear = padWorld(rr, rr.pads[dir < 0 ? 1 : 0])
    const rFar = padWorld(rr, rr.pads[dir < 0 ? 0 : 1])
    const dAnode = padWorld(dd, dd.pads[1])
    tracks.push({ net: q(channel), layer: 'F.Cu', width: 0.25, pts: [[w.x, w.y], [rNear.x, rNear.y]] })
    tracks.push({ net: `LA${channel}`, layer: 'F.Cu', width: 0.25, pts: [[rFar.x, rFar.y], [dAnode.x, dAnode.y]] })
  }
  for (const [srRef, base] of [['U5', 1], ['U6', 9]]) {
    const srFp = fps.find((f) => f.ref === srRef)
    // left: pins 3,4,5,6 -> channels base..base+3; columns A,B,A,B
    ;['3', '4', '5', '6'].forEach((pin, i) => lane(srFp, base + i, pin, -1, i % 2 === 0 ? 'A' : 'B', base + i - 1))
    // right: pins 10..13 -> channels base+4..base+7
    ;['10', '11', '12', '13'].forEach((pin, i) => lane(srFp, base + 4 + i, pin, +1, i % 2 === 0 ? 'A' : 'B', base + 3 + i))
  }

  // ---- status LEDs ----
  add(res('R48', '1k', 155, 160, 0, 'F', 'LED_STATUS1', 'S1_A'))
  add(led('D6', 'LED', 160, 160, 0, 'F', 'GND', 'S1_A'))
  add(res('R49', '1k', 155, 164, 0, 'F', 'LED_STATUS2', 'S2_A'))
  add(led('D7', 'LED', 160, 164, 0, 'F', 'GND', 'S2_A'))

  // ---- sensors (left, below the power block) ----
  // U3 LM358 buffers the NTC divider. Pins: 1 OUT1, 2 IN1-, 3 IN1+, 4 V-, 5 IN2+, 6 IN2-, 7 OUT2, 8 V+.
  add(soic('U3', 'LM358', 112, 132, 0, 8, {
    1: 'TEMP_OUT', 2: 'TEMP_OUT', 3: 'NTC_SENSE', 4: 'GND', 5: 'GND', 6: 'U3_NC', 7: 'U3_NC', 8: '+3V3'
  }))
  add(cap06('C13', '100n', 119, 128, 90, 'F', '+3V3', 'GND'))
  add(res('R30', '10k', 104, 128, 90, 'F', '+3V3', 'NTC_SENSE'))
  add(res('RT1', '10k', 104, 135, 90, 'F', 'NTC_SENSE', 'GND'))
  add(cap06('C11', '100n', 108, 138, 0, 'F', 'NTC_SENSE', 'GND'))
  add(res('R31', '1k', 120, 136, 0, 'F', 'TEMP_OUT', 'TEMP_ADC'))
  add(cap06('C12', '10n', 124, 140, 90, 'F', 'TEMP_ADC', 'GND'))

  // U4 LM393 compares a photoresistor divider with a threshold divider.
  add(soic('U4', 'LM393', 112, 152, 0, 8, {
    1: 'LIGHT_ADC', 2: 'LIGHT_REF', 3: 'LDR_SENSE', 4: 'GND', 5: 'GND', 6: 'U4_NC', 7: 'U4_NC', 8: '+3V3'
  }))
  add(cap06('C14', '100n', 119, 148, 90, 'F', '+3V3', 'GND'))
  add(res('R32', '10k', 104, 148, 90, 'F', '+3V3', 'LDR_SENSE'))
  add(res('R33', '10k', 104, 155, 90, 'F', 'LDR_SENSE', 'GND'))
  add(res('R34', '47k', 104, 162, 90, 'F', '+3V3', 'LIGHT_REF'))
  add(res('R35', '47k', 108, 162, 90, 'F', 'LIGHT_REF', 'GND'))
  add(res('R36', '10k', 120, 156, 0, 'F', '+3V3', 'LIGHT_ADC'))
  add(res('R37', '1M', 120, 160, 0, 'F', 'LIGHT_ADC', 'LDR_SENSE'))

  // ---- loads ----
  add(sot23('Q1', '2N7002', 160, 130, 0, 'FAN_G', 'GND', 'FAN_NEG'))
  add(res('R42', '220', 155, 130, 90, 'F', 'FAN_G_IN', 'FAN_G'))
  add(res('R43', '100k', 155, 134, 90, 'F', 'FAN_G', 'GND'))
  add(sod('D4', '1N4148W', 166, 130, 0, 'F', '+5V', 'FAN_NEG'))
  add(header('J3', 180, 132, 0, ['+5V', 'FAN_NEG']))
  add(sot23('Q2', '2N3904', 160, 140, 0, 'GND', 'STRIP_B', 'STRIP_NEG'))
  add(res('R44', '1k', 155, 141, 90, 'F', 'STRIP_G_IN', 'STRIP_B'))
  add(res('R45', '10k', 155, 145, 90, 'F', 'STRIP_B', 'GND'))
  add(header('J4', 190, 132, 0, ['+5V', 'STRIP_NEG']))

  // ---- I2C header ----
  add(header('J5', 140, 164, 90, ['+3V3', 'SDA', 'SCL', 'GND']))
  add(res('R46', '4.7k', 130, 165, 0, 'F', '+3V3', 'SDA'))
  add(res('R47', '4.7k', 130, 168, 0, 'F', '+3V3', 'SCL'))

  // ---- bypass caps on B.Cu, under four ICs ----
  add(cap06('C15', '100n', 112, 134, 0, 'B', '+3V3', 'GND'))
  add(cap06('C16', '100n', 112, 154, 0, 'B', '+3V3', 'GND'))
  add(cap06('C17', '100n', 176, 109, 0, 'B', '+3V3', 'GND'))
  add(cap06('C18', '100n', 176, 146, 0, 'B', '+3V3', 'GND'))

  for (const f of fps) for (const p of f.pads) if (p.net) nets.add(p.net)
  return { fps, tracks, nets: [...nets] }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const G = 0.25 // grid pitch
const CLEAR = 0.2
const VIA_SIZE = 0.8
const VIA_DRILL = 0.4
const EDGE = 0.7
const WIDTH = { sig: 0.25, pwr: 0.5 }
/** Blocking classes: 0 = signal track, 1 = power track, 2 = via. Value = clearance + half the width. */
const CLASS_D = [CLEAR + WIDTH.sig / 2, CLEAR + WIDTH.pwr / 2, CLEAR + VIA_SIZE / 2]

class Heap {
  constructor() {
    this.k = []
    this.v = []
  }
  get size() {
    return this.k.length
  }
  push(key, val) {
    const k = this.k
    const v = this.v
    let i = k.length
    k.push(key)
    v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= k[i]) break
      ;[k[p], k[i]] = [k[i], k[p]]
      ;[v[p], v[i]] = [v[i], v[p]]
      i = p
    }
  }
  pop() {
    const k = this.k
    const v = this.v
    const top = v[0]
    const lk = k.pop()
    const lv = v.pop()
    if (k.length > 0) {
      k[0] = lk
      v[0] = lv
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < k.length && k[l] < k[m]) m = l
        if (r < k.length && k[r] < k[m]) m = r
        if (m === i) break
        ;[k[m], k[i]] = [k[i], k[m]]
        ;[v[m], v[i]] = [v[i], v[m]]
        i = m
      }
    }
    return top
  }
}

function rectDist(px, py, r) {
  const dx = Math.max(Math.abs(px - r.cx) - r.hw, 0)
  const dy = Math.max(Math.abs(py - r.cy) - r.hh, 0)
  return Math.hypot(dx, dy)
}

function segDist(px, py, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

/** Axis-aligned world rectangle of a pad (rotations of 0, 90, 180, 270 only). */
function padRect(fp, pad) {
  const c = padWorld(fp, pad)
  const rot = (((fp.at.rot ?? 0) % 360) + 360) % 360
  if (rot % 90 !== 0) throw new Error(`${fp.ref}: the sample router handles right-angle rotations only`)
  const swap = rot === 90 || rot === 270
  return { cx: c.x, cy: c.y, hw: (swap ? pad.h : pad.w) / 2, hh: (swap ? pad.w : pad.h) / 2 }
}

export function route(design) {
  const stubbed = new Set()
  const { fps, nets: netNames } = design
  const nx = Math.round(BW / G) + 1
  const ny = Math.round(BH / G) + 1
  const nCells = nx * ny
  const netIdx = new Map(netNames.map((n, i) => [n, i + 1]))
  // owner[class][layer]: 0 free, n net, -1 blocked for everyone
  const owner = CLASS_D.map(() => [new Int16Array(nCells), new Int16Array(nCells)])
  const cx = (i) => X0 + i * G
  const cy = (j) => Y0 + j * G
  const cellOf = (x, y) => [Math.round((x - X0) / G), Math.round((y - Y0) / G)]

  function markShape(layer, net, shape, edgeDist) {
    // shape bbox expanded by the largest class distance
    const dMax = CLASS_D[2] + 0.01
    const [i0, j0] = cellOf(shape.minx - dMax, shape.miny - dMax)
    const [i1, j1] = cellOf(shape.maxx + dMax, shape.maxy + dMax)
    for (let j = Math.max(0, j0); j <= Math.min(ny - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) {
        const d = edgeDist(cx(i), cy(j))
        for (let k = 0; k < CLASS_D.length; k++) {
          if (d < CLASS_D[k] - 1e-9) {
            const arr = owner[k][layer]
            const c = j * nx + i
            if (arr[c] === 0) arr[c] = net
            else if (arr[c] !== net) arr[c] = -1
          }
        }
      }
    }
  }

  // board edge keep-out
  for (let layer = 0; layer < 2; layer++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = cx(i)
        const y = cy(j)
        if (x - X0 < EDGE || X0 + BW - x < EDGE || y - Y0 < EDGE || Y0 + BH - y < EDGE) {
          for (let k = 0; k < CLASS_D.length; k++) owner[k][layer][j * nx + i] = -1
        }
      }
    }
  }

  const addPadObstacle = (fp, pad) => {
    const r = padRect(fp, pad)
    const net = pad.net ? netIdx.get(pad.net) : -1
    const shape = { minx: r.cx - r.hw, maxx: r.cx + r.hw, miny: r.cy - r.hh, maxy: r.cy + r.hh }
    const layers = pad.type === 'thru_hole' ? [0, 1] : [fp.side === 'B' ? 1 : 0]
    for (const layer of layers) markShape(layer, net, shape, (x, y) => rectDist(x, y, r))
  }
  const addTrackObstacle = (t) => {
    const layer = t.layer === 'B.Cu' ? 1 : 0
    const net = netIdx.get(t.net)
    for (let s = 0; s + 1 < t.pts.length; s++) {
      const a = { x: t.pts[s][0], y: t.pts[s][1] }
      const b = { x: t.pts[s + 1][0], y: t.pts[s + 1][1] }
      const shape = {
        minx: Math.min(a.x, b.x) - t.width / 2, maxx: Math.max(a.x, b.x) + t.width / 2,
        miny: Math.min(a.y, b.y) - t.width / 2, maxy: Math.max(a.y, b.y) + t.width / 2
      }
      markShape(layer, net, shape, (x, y) => segDist(x, y, a, b) - t.width / 2)
    }
  }
  const addViaObstacle = (v) => {
    const net = netIdx.get(v.net)
    const shape = { minx: v.x - VIA_SIZE / 2, maxx: v.x + VIA_SIZE / 2, miny: v.y - VIA_SIZE / 2, maxy: v.y + VIA_SIZE / 2 }
    for (let layer = 0; layer < 2; layer++) {
      markShape(layer, net, shape, (x, y) => Math.hypot(x - v.x, y - v.y) - VIA_SIZE / 2)
    }
  }

  for (const fp of fps) for (const pad of fp.pads) addPadObstacle(fp, pad)
  for (const t of design.tracks) addTrackObstacle(t)

  const outTracks = [...design.tracks]
  const outVias = []

  // pads by net
  const padsByNet = new Map()
  for (const fp of fps) {
    for (const pad of fp.pads) {
      if (!pad.net) continue
      const list = padsByNet.get(pad.net) ?? []
      list.push({ fp, pad, ref: `${fp.ref}.${pad.num}` })
      padsByNet.set(pad.net, list)
    }
  }
  // Nets that already carry hand-routed copper: their pads on those tracks are done.
  const preRouted = new Set(design.tracks.map((t) => t.net))

  const layerOfPad = (p) => (p.fp.side === 'B' ? 1 : 0)
  const padLayers = (p) => (p.pad.type === 'thru_hole' ? [0, 1] : [layerOfPad(p)])
  const padCells = (p, cls) => {
    const r = padRect(p.fp, p.pad)
    const net = netIdx.get(p.pad.net)
    const out = []
    const [i0, j0] = cellOf(r.cx - r.hw, r.cy - r.hh)
    const [i1, j1] = cellOf(r.cx + r.hw, r.cy + r.hh)
    for (const layer of padLayers(p)) {
      for (let j = j0 - 1; j <= j1 + 1; j++) {
        for (let i = i0 - 1; i <= i1 + 1; i++) {
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue
          if (rectDist(cx(i), cy(j), r) > 0.0001) continue
          const o = owner[cls][layer][j * nx + i]
          if (o === 0 || o === net) out.push({ i, j, layer })
        }
      }
    }
    // keep only the cells nearest the pad centre first
    out.sort((a, b) => Math.hypot(cx(a.i) - r.cx, cy(a.j) - r.cy) - Math.hypot(cx(b.i) - r.cx, cy(b.j) - r.cy))
    return out
  }

  /**
   * Dijkstra over (cell, layer, dir). `sources` and `goals` are {i, j, layer}.
   * `goalTest(i, j, layer)` overrides the goal set (used for GND stubs).
   */
  function search(net, cls, sources, goalKeys, goalTest) {
    const states = nCells * 2 * 5
    const cost = new Float64Array(states).fill(Infinity)
    const prev = new Int32Array(states).fill(-1)
    const heap = new Heap()
    const sid = (i, j, layer, dir) => ((layer * nCells + j * nx + i) * 5 + dir)
    for (const s of sources) {
      const id = sid(s.i, s.j, s.layer, 4)
      cost[id] = 0
      heap.push(0, id)
    }
    const passable = (c, layer) => {
      const o = owner[cls][layer][c]
      return o === 0 || o === net
    }
    const viaOk = (c) => {
      for (let layer = 0; layer < 2; layer++) {
        const o = owner[2][layer][c]
        if (o !== 0 && o !== net) return false
      }
      return true
    }
    const DI = [1, -1, 0, 0]
    const DJ = [0, 0, 1, -1]
    while (heap.size > 0) {
      const id = heap.pop()
      const dir = id % 5
      const rest = (id - dir) / 5
      const layer = rest >= nCells ? 1 : 0
      const c = rest - layer * nCells
      const j = Math.floor(c / nx)
      const i = c - j * nx
      const here = cost[id]
      if (goalTest ? goalTest(i, j, layer) : goalKeys.has(layer * nCells + c)) {
        // reconstruct
        const path = []
        let cur = id
        while (cur !== -1) {
          const d = cur % 5
          const r = (cur - d) / 5
          const l = r >= nCells ? 1 : 0
          const cc = r - l * nCells
          const jj = Math.floor(cc / nx)
          path.push({ i: cc - jj * nx, j: jj, layer: l })
          cur = prev[cur]
        }
        return path.reverse()
      }
      for (let d = 0; d < 4; d++) {
        const ni = i + DI[d]
        const nj = j + DJ[d]
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        const nc = nj * nx + ni
        if (!passable(nc, layer)) continue
        const step = 1 + (dir !== 4 && dir !== d ? 2 : 0)
        const nid = sid(ni, nj, layer, d)
        if (here + step < cost[nid]) {
          cost[nid] = here + step
          prev[nid] = id
          heap.push(here + step, nid)
        }
      }
      // via
      if (viaOk(c) && passable(c, 1 - layer)) {
        const nid = sid(i, j, 1 - layer, 4)
        const step = 14
        if (here + step < cost[nid]) {
          cost[nid] = here + step
          prev[nid] = id
          heap.push(here + step, nid)
        }
      }
    }
    return null
  }

  /** Emit a cell path as tracks and vias; returns the vertex cells it created. */
  function emit(netName, wcls, path, startPad, endPad) {
    const width = wcls === 1 ? WIDTH.pwr : WIDTH.sig
    const verts = []
    let run = []
    let runLayer = path[0].layer
    const flush = () => {
      if (run.length >= 2) {
        const pts = []
        for (let s = 0; s < run.length; s++) {
          const prv = run[s - 1]
          const cur = run[s]
          const nxt = run[s + 1]
          const keep =
            s === 0 || s === run.length - 1 ||
            (cur.i - prv.i !== nxt.i - cur.i || cur.j - prv.j !== nxt.j - cur.j) ||
            s % 8 === 0
          if (keep) {
            pts.push([cx(cur.i), cy(cur.j)])
            verts.push({ i: cur.i, j: cur.j, layer: runLayer })
          }
        }
        outTracks.push({ net: netName, layer: runLayer === 1 ? 'B.Cu' : 'F.Cu', width, pts })
      }
      run = []
    }
    for (let s = 0; s < path.length; s++) {
      const p = path[s]
      if (p.layer !== runLayer) {
        flush()
        runLayer = p.layer
        const prevCell = path[s - 1]
        outVias.push({ net: netName, x: cx(prevCell.i), y: cy(prevCell.j), size: VIA_SIZE, drill: VIA_DRILL })
        verts.push({ i: prevCell.i, j: prevCell.j, layer: 0 }, { i: prevCell.i, j: prevCell.j, layer: 1 })
        run = [prevCell]
      }
      run.push(p)
    }
    flush()
    // stubs from pad centres to the path ends
    const stub = (pad, cell) => {
      if (!pad) return
      const r = padRect(pad.fp, pad.pad)
      const layer = pad.pad.type === 'thru_hole' ? cell.layer : layerOfPad(pad)
      const a = [r.cx, r.cy]
      const b = [cx(cell.i), cy(cell.j)]
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) {
        outTracks.push({ net: netName, layer: layer === 1 ? 'B.Cu' : 'F.Cu', width, pts: [a, b] })
      }
    }
    stub(startPad, path[0])
    stub(endPad, path[path.length - 1])
    return verts
  }

  const registered = { tracks: outTracks.length, vias: 0 }
  const registerNew = () => {
    for (; registered.tracks < outTracks.length; registered.tracks++) addTrackObstacle(outTracks[registered.tracks])
    for (; registered.vias < outVias.length; registered.vias++) addViaObstacle(outVias[registered.vias])
  }

  const order = [...padsByNet.keys()].filter((n) => n !== 'GND')
  const span = (n) => {
    const ps = padsByNet.get(n).map((p) => padWorld(p.fp, p.pad))
    const xs = ps.map((p) => p.x)
    const ys = ps.map((p) => p.y)
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)
  }
  order.sort((a, b) => {
    const pa = POWER_NETS.has(a) ? 0 : 1
    const pb = POWER_NETS.has(b) ? 0 : 1
    return pa - pb || span(a) - span(b) || a.localeCompare(b)
  })

  const failures = []
  for (const netName of order) {
    const pads = padsByNet.get(netName)
    if (pads.length < 2) continue
    const net = netIdx.get(netName)
    const wcls = POWER_NETS.has(netName) ? 1 : 0
    if (preRouted.has(netName)) {
      // hand routed lanes: only the pads not on a lane track remain
      const done = pads.filter((p) => {
        const c = padWorld(p.fp, p.pad)
        return design.tracks.some(
          (t) => t.net === netName && t.pts.some(([x, y]) => Math.hypot(x - c.x, y - c.y) < 1e-6)
        )
      })
      if (done.length === pads.length) continue
    }
    const isDone = (p) => {
      const c = padWorld(p.fp, p.pad)
      return outTracks.some(
        (t) => t.net === netName && t.pts.some(([x, y]) => Math.hypot(x - c.x, y - c.y) < 1e-6)
      )
    }
    const connected = []
    const remaining = []
    for (const p of pads) (isDone(p) && preRouted.has(netName) ? connected : remaining).push(p)
    let treeVerts = []
    if (connected.length === 0) {
      connected.push(remaining.shift())
    }
    for (const p of connected) {
      for (const c of padCells(p, wcls).slice(0, 4)) treeVerts.push(c)
    }
    // every vertex of this net's existing tracks joins the tree
    while (remaining.length > 0) {
      const goalPadCells = new Map()
      for (const p of remaining) for (const c of padCells(p, wcls).slice(0, 4)) goalPadCells.set(c.layer * nCells + c.j * nx + c.i, p)
      if (goalPadCells.size === 0) {
        failures.push(`${netName}: pad ${remaining[0].ref} has no free cell`)
        break
      }
      const path = search(net, wcls, treeVerts, new Set(goalPadCells.keys()))
      if (!path) {
        failures.push(`${netName}: no route to ${remaining.map((p) => p.ref).join(', ')}`)
        break
      }
      const last = path[path.length - 1]
      const endPad = goalPadCells.get(last.layer * nCells + last.j * nx + last.i)
      const first = path[0]
      // is the first cell a pad terminal of a connected pad? then stub from that pad
      const startPad = connected.find((p) => padCells(p, wcls).slice(0, 4).some((c) => c.i === first.i && c.j === first.j && c.layer === first.layer))
      const verts = emit(netName, wcls, path, startPad && !startPadHasStub(startPad) ? startPad : undefined, endPad)
      if (startPad) stubbed.add(startPad.ref)
      stubbed.add(endPad.ref)
      treeVerts = treeVerts.concat(verts, [{ i: last.i, j: last.j, layer: last.layer }])
      connected.push(endPad)
      remaining.splice(remaining.indexOf(endPad), 1)
      registerNew()
    }
  }
  function startPadHasStub(p) {
    return stubbed.has(p.ref)
  }

  // GND: a stub and a via (front-side pads) to the B.Cu pour.
  const gndNet = netIdx.get('GND')
  for (const p of padsByNet.get('GND') ?? []) {
    const r = padRect(p.fp, p.pad)
    const frontSide = p.pad.type === 'thru_hole' || p.fp.side !== 'B'
    const src = padCells(p, 0).filter((c) => (frontSide ? c.layer === 0 : c.layer === 1)).slice(0, 4)
    const goalTest = (i, j, layer) => {
      if (Math.hypot(cx(i) - r.cx, cy(j) - r.cy) < 1.0 + Math.max(r.hw, r.hh) * 0.5) return false
      if (frontSide) {
        if (layer !== 0) return false
        const c = j * nx + i
        const o = owner[2][0][c]
        const o2 = owner[2][1][c]
        return (o === 0 || o === gndNet) && (o2 === 0 || o2 === gndNet)
      }
      return layer === 1
    }
    const path = search(gndNet, 0, src, null, goalTest)
    if (!path) {
      failures.push(`GND: no stub for ${p.ref}`)
      continue
    }
    emit('GND', 0, path, p, undefined)
    const end = path[path.length - 1]
    if (frontSide) {
      outVias.push({ net: 'GND', x: cx(end.i), y: cy(end.j), size: VIA_SIZE, drill: VIA_DRILL })
    }
    registerNew()
  }

  if (failures.length > 0) throw new Error(`routing failed:\n  ${failures.join('\n  ')}`)
  return { tracks: outTracks, vias: outVias }
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function sampleBoardSpec() {
  const design = build()
  const routed = route(design)
  const nets = design.nets
  return {
    kicad: 10,
    nets,
    outline: { x0: X0, y0: Y0, x1: X0 + BW, y1: Y0 + BH },
    footprints: design.fps,
    tracks: routed.tracks,
    vias: routed.vias,
    zones: [
      {
        net: 'GND',
        layer: 'B.Cu',
        outline: [[X0 + 0.5, Y0 + 0.5], [X0 + BW - 0.5, Y0 + 0.5], [X0 + BW - 0.5, Y0 + BH - 0.5], [X0 + 0.5, Y0 + BH - 0.5]]
      }
    ]
  }
}

export function generateSampleBoard() {
  return generateBoard(sampleBoardSpec())
}

void rotateKicad

function main() {
  const args = process.argv.slice(2)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (args.includes('--stats')) {
    const s = sampleBoardSpec()
    console.log(`parts ${s.footprints.length}, nets ${s.nets.length}, tracks ${s.tracks.length}, vias ${s.vias.length}`)
    return
  }
  const text = generateSampleBoard()
  const outIdx = args.indexOf('--out')
  if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], text)
  else if (args.includes('--write')) {
    fs.writeFileSync(path.join(root, SAMPLE_FILE), text)
    console.log(`wrote ${SAMPLE_FILE}`)
  } else process.stdout.write(text)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
