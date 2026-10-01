#!/usr/bin/env node
/**
 * fit-model-cards.mjs: derive the bundled discrete-semiconductor .model cards
 * from datasheet operating points (issue #14, #41, #86).
 *
 * The cards in resources/models/bjt.lib, diodes.lib and led.lib are the OUTPUT of
 * this script. Its inputs (the DATASHEET table below) are datasheet figures: a
 * forward voltage at a stated current, hFE at a stated collector current, a
 * transition frequency, a stated capacitance at a stated bias. Nothing is read
 * from any third-party library card. The derivation is closed-form or a small
 * numeric solve, so the same inputs always give the same card, and
 * src/core/models/__tests__/library-derivation.test.ts fails if a .lib drifts
 * from this script.
 *
 * Every number that is NOT a datasheet figure is listed in ASSUMPTIONS and
 * repeated in the .lib header next to the card it affects. They are generic
 * device-class values (emission coefficient, reverse Early voltage, base
 * resistance), never taken from a named library card.
 *
 * Figures are transcribed from the datasheet families (onsemi, Diodes Inc,
 * Vishay, NXP, Central) and approximate typical-curve readings where a typical
 * is stated; they are not yet re-verified against vendor PDFs row by row, the
 * same caveat resources/models/characterization.json carries.
 *
 * Usage:
 *   node scripts/fit-model-cards.mjs          print every card
 *   import { deriveCards } from './fit-model-cards.mjs'
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

// --- physical constants (ngspice nominal temperature 27 C) ---------------------
const K_OVER_Q = 8.617333262e-5 // eV/K
const TNOM_K = 300.15
export const VT = K_OVER_Q * TNOM_K

// --- assumptions (not datasheet figures) ------------------------------------
export const ASSUMPTIONS = {
  capTypicalOverMax:
    'Datasheets list Cobo, Cibo and small-signal Cj as maxima only; the typical value used is 0.75 x the maximum.',
  capExponent:
    'No capacitance-versus-voltage curve is sampled: diode junction grading m=0.5 and potential vj=0.7 V (abrupt silicon junction), vj=0.5 V for Schottky; BJT junctions use the ngspice defaults vj=0.75 V, m=0.33.',
  vfTypicalOverMax:
    'Where only a maximum forward voltage is stated, the typical used is 0.9 x the maximum.',
  diodeEmission:
    'Emission coefficient n is a device-class value (1.8 small-signal, 1.9 rectifier, 1.05 Schottky, 1.5 TVS forward path); a second Vf point then fixes rs and is.',
  transitTime: 'Diode transit time tt is set equal to the stated trr (storage-limited recovery).',
  bjtResistances:
    'Base, collector and emitter resistance: rb=10, re=0.3 ohm for small-signal parts (2N2222A rb from the stated rb x Cc product); rc is half the slope of the two stated VCE(sat) maxima.',
  bjtReverse: 'Reverse beta br=3 and reverse Early voltage var=20 V are not on the datasheets.',
  bjtRecombination: 'Low-current recombination exponent ne=1.5.',
  bjtGainCurve:
    'The hFE window midpoint is the typical at the reference current; at the other two currents the typical is the reference value times the square root of the ratio of the guaranteed minima there (the typical curve falls about half as steeply, in log terms, as the guaranteed floor).',
  stageTemperature: 'Temperature exponent xtb=1.5 and eg=1.11 eV are silicon class values.'
}

// --- datasheet inputs --------------------------------------------------------

/**
 * Two-point diode fits. pts are [current A, Vf V]. Each entry names where its
 * figures come from.
 */
export const DIODES = {
  D1N4148: {
    n: 1.8,
    pts: [
      [5e-3, 0.67], // VF window 0.62 to 0.72 V at 5 mA (1N4448/1N4148 family), window midpoint
      [100e-3, 0.9] // VF 1.0 V max at 100 mA, typical 0.9 x max
    ],
    cjMaxPf: 4, // CT 4 pF max at VR=0 V, 1 MHz
    cjBiasV: 0,
    trrNs: 4, // trr 4 ns max (IF=10 mA, VR=6 V, RL=100 ohm)
    bv: 100,
    ibv: 100e-6, // V(BR) 100 V min at 100 uA
    eg: 1.11,
    xti: 3
  },
  D1N4001: {
    n: 1.9,
    pts: [
      [10e-3, 0.62], // typical forward characteristic, approximate curve reading
      [1, 0.93] // VF 0.93 V typical at 1 A (1.1 V max)
    ],
    cjTypPf: 15, // CT 15 pF typical at VR=4 V, 1 MHz
    cjBiasV: 4,
    trrNs: 2000, // trr about 2 us
    bv: 55, // VRRM 50 V guaranteed blocking; card breakdown sits 10 percent above it
    ibv: 10e-6,
    eg: 1.11,
    xti: 3
  },
  D1N5819: {
    n: 1.05,
    pts: [
      [1, 0.54], // VF 0.6 V max at 1 A, typical 0.9 x max
      [3, 0.81] // VF 0.9 V max at 3 A, typical 0.9 x max
    ],
    cjTypPf: 110, // CT about 110 pF typical at VR=4 V, 1 MHz
    cjBiasV: 4,
    trrNs: 0, // majority-carrier device: no minority storage
    bv: 44, // VRRM 40 V; breakdown 10 percent above
    ibv: 1e-3, // IR 1 mA max at rated VR, 25 C
    eg: 0.69,
    xti: 2,
    schottky: true
  }
}

/**
 * TVS: a two-branch subcircuit. The forward path is fitted to its own Vf points,
 * the reverse clamp is a blocking diode in series with a breakdown diode whose
 * series resistance carries the clamp slope, so neither path inherits the other.
 */
export const TVS = {
  DSMAJ24A: {
    n: 1.5,
    fwdPts: [
      [1, 1.0], // about 1 V at 1 A forward
      [25, 3.15] // VF 3.5 V max at 25 A, typical 0.9 x max
    ],
    vbr: 28.1, // VBR 26.7 to 29.5 V at 1 mA, midpoint
    ibv: 1e-3,
    vc: 38.9, // VC 38.9 V at IPP 10.3 A
    ipp: 10.3,
    cjPf: 280,
    blocker: { n: 1, is: 1e-12, rs: 0.01 } // series blocking diode of the reverse branch
  }
}

/**
 * LEDs: Vf at 20 mA is the middle of the documented class band. n and rs are
 * class values; blue and white use n=2.2 because ngspice stops converging to the
 * requested current once the internal junction voltage exceeds about 60 n*Vt
 * (is below about 1e-28 A), so a wide-gap die needs a larger n, which is also
 * closer to real InGaN diodes.
 */
export const LEDS = {
  LED_RED: { vf20: 1.9, n: 1.7, rs: 2.0, cjo: 30e-12, eg: 1.9 }, // band 1.8 to 2.0 V
  LED_GREEN: { vf20: 2.15, n: 1.8, rs: 3.0, cjo: 30e-12, eg: 2.1 }, // band 2.1 to 2.2 V
  LED_BLUE: { vf20: 3.1, n: 2.2, rs: 6.0, cjo: 20e-12, eg: 2.9 }, // band 3.0 to 3.2 V
  LED_WHITE: { vf20: 3.2, n: 2.2, rs: 7.0, cjo: 20e-12, eg: 3.0 } // band 3.0 to 3.4 V
}

/**
 * BJTs. hfe points are [Ic A, typical hFE]; the typical at the reference current
 * is the middle of the datasheet hFE window, the other two points scale it by the
 * ratio of the guaranteed minima at those currents. vbe is the typical Vbe at the
 * reference current. vce is the collector-emitter voltage of the hFE test.
 */
export const BJTS = {
  Q2N2222: {
    type: 'NPN',
    vce: 10,
    refIndex: 1,
    hfe: [
      [0.1e-3, 141], // min 50 at 0.1 mA vs 100 at 150 mA: ratio 0.5, typical follows sqrt(ratio)
      [150e-3, 200], // window 100 to 300 at 150 mA, 10 V
      [500e-3, 126] // min 40 at 500 mA vs 100 at 150 mA: ratio 0.4, typical follows sqrt(ratio)
    ],
    vbe: 0.9, // VBE(sat) window 0.6 to 1.2 V at 150 mA / 15 mA, midpoint
    hoeUmho: 20, // 5 to 35 umho at 1 mA, 10 V, midpoint
    hoeIc: 1e-3,
    hoeVce: 10,
    fTMhz: 300,
    fTIc: 20e-3,
    fTVce: 20,
    coboPf: 8, // max at VCB=10 V
    coboV: 10,
    ciboPf: 25, // max at VEB=0.5 V
    ciboV: 0.5,
    tsNs: 225, // storage time, Ic=150 mA, IB1=IB2=15 mA
    tsIc: 150e-3,
    tsIb: 15e-3,
    rbCcPs: 150, // rb' x Cc 150 ps max
    rc: 1.0, // VCE(sat) 0.3 V at 150 mA and 1.0 V at 500 mA: 2 ohm max slope, half
    re: 0.3
  },
  Q2N3904: {
    type: 'NPN',
    vce: 1,
    refIndex: 1,
    hfe: [
      [0.1e-3, 126], // min 40 at 0.1 mA vs 100 at 10 mA: ratio 0.4, typical follows sqrt(ratio)
      [10e-3, 200], // window 100 to 300 at 10 mA, 1 V
      [100e-3, 110] // min 30 at 100 mA vs 100 at 10 mA: ratio 0.3, typical follows sqrt(ratio)
    ],
    vbe: 0.75, // VBE(sat) window 0.65 to 0.85 V at 10 mA / 1 mA, midpoint
    hoeUmho: 20.5, // 1 to 40 umho at 1 mA, 10 V, midpoint
    hoeIc: 1e-3,
    hoeVce: 10,
    fTMhz: 300,
    fTIc: 10e-3,
    fTVce: 20,
    coboPf: 4, // max at VCB=5 V
    coboV: 5,
    ciboPf: 8, // max at VEB=0.5 V
    ciboV: 0.5,
    tsNs: 200, // storage time, Ic=10 mA, IB1=IB2=1 mA
    tsIc: 10e-3,
    tsIb: 1e-3,
    rb: 10,
    rc: 1.2, // VCE(sat) 0.2 V at 10 mA and 0.3 V at 50 mA: 2.5 ohm max slope, half
    re: 0.3
  },
  QBC547: {
    type: 'NPN',
    vce: 5,
    refIndex: 1,
    hfe: [
      [10e-6, 150], // BC547B typical at 10 uA
      [2e-3, 290], // BC547B typical at 2 mA, 5 V (window 200 to 450)
      [100e-3, 180] // typical curve reading at 100 mA
    ],
    vbe: 0.66, // VBE(on) typical at 2 mA, 5 V
    hoeUmho: 30, // typical at 2 mA, 5 V
    hoeIc: 2e-3,
    hoeVce: 5,
    fTMhz: 300, // typical at 10 mA, 5 V
    fTIc: 10e-3,
    fTVce: 5,
    cobTypPf: 1.5, // typical at VCB=10 V
    coboV: 10,
    cibTypPf: 11, // typical at VEB=0.5 V
    ciboV: 0.5,
    tsNs: 280, // typical storage time, Ic=10 mA, IB1=IB2=0.5 mA
    tsIc: 10e-3,
    tsIb: 0.5e-3,
    rb: 10,
    rc: 1.0,
    re: 0.3
  },
  Q2N3906: {
    type: 'PNP',
    vce: 1,
    refIndex: 1,
    hfe: [
      [0.1e-3, 155], // min 60 at 0.1 mA vs 100 at 10 mA: ratio 0.6, typical follows sqrt(ratio)
      [10e-3, 200], // window 100 to 300 at 10 mA, 1 V
      [100e-3, 110] // min 30 at 100 mA vs 100 at 10 mA: ratio 0.3, typical follows sqrt(ratio)
    ],
    vbe: 0.75, // VBE(sat) window 0.65 to 0.85 V at 10 mA / 1 mA, midpoint
    hoeUmho: 20.5, // 1 to 40 umho at 1 mA, 10 V, midpoint
    hoeIc: 1e-3,
    hoeVce: 10,
    fTMhz: 250,
    fTIc: 10e-3,
    fTVce: 20,
    coboPf: 4.5, // max at VCB=5 V
    coboV: 5,
    ciboPf: 10, // max at VEB=0.5 V
    ciboV: 0.5,
    tsNs: 225, // storage time, Ic=10 mA, IB1=IB2=1 mA
    tsIc: 10e-3,
    tsIb: 1e-3,
    rb: 10,
    rc: 1.9, // VCE(sat) 0.25 V at 10 mA and 0.4 V at 50 mA: 3.75 ohm max slope, half
    re: 0.3
  },
  QBC557: {
    type: 'PNP',
    vce: 5,
    refIndex: 1,
    hfe: [
      [10e-6, 100], // BC557B typical at 10 uA
      [2e-3, 290], // BC557B typical at 2 mA, 5 V (window 200 to 450)
      [100e-3, 140] // typical curve reading at 100 mA
    ],
    vbe: 0.65, // VBE(on) typical at 2 mA, 5 V
    hoeUmho: 30,
    hoeIc: 2e-3,
    hoeVce: 5,
    fTMhz: 150,
    fTIc: 10e-3,
    fTVce: 5,
    cobTypPf: 4.5, // typical at VCB=10 V
    coboV: 10,
    cibTypPf: 11, // typical at VEB=0.5 V
    ciboV: 0.5,
    tsNs: 300, // typical storage time, Ic=10 mA, IB1=IB2=0.5 mA
    tsIc: 10e-3,
    tsIb: 0.5e-3,
    rb: 10,
    rc: 1.5,
    re: 0.3
  }
}

// --- helpers -----------------------------------------------------------------

/** Junction capacitance scale: Cj(V) = cj0 / (1 + V/vj)^m, so cj0 = Cj(V) * (1+V/vj)^m. */
function cj0From(cjAtBias, bias, vj, m) {
  return cjAtBias * Math.pow(1 + bias / vj, m)
}

const VJ_SI = 0.7
const VJ_SCHOTTKY = 0.5
const M_ABRUPT = 0.5
const VJ_BJT = 0.75
const M_BJT = 0.33

/** Fit (is, rs) of a diode with fixed n from two (I, Vf) points. */
export function fitDiodeTwoPoint(n, [[i1, v1], [i2, v2]]) {
  const nvt = n * VT
  const rs = (v2 - v1 - nvt * Math.log(i2 / i1)) / (i2 - i1)
  const is = i1 / Math.exp((v1 - i1 * rs) / nvt)
  return { is, rs }
}

/** Vf of a diode card at current i (series resistance included). */
export function diodeVf(is, n, rs, i) {
  return n * VT * Math.log(i / is + 1) + i * rs
}

/** Fit is of an LED (fixed n, rs) so that Vf(20 mA) = vf20. */
export function fitLedIs(vf20, n, rs) {
  const i = 20e-3
  return i / (Math.exp((vf20 - i * rs) / (n * VT)) - 1)
}

/**
 * Reverse-clamp branch of a TVS: blocking diode (fixed) in series with a
 * breakdown diode (nbv=1). Total reverse voltage at I is
 *   V(I) = Vblock(I) + bv + Vt*ln(I/ibv) + I*rs
 * so the two datasheet points VBR at ibv and VC at Ipp fix bv and rs.
 */
export function fitTvsClamp(vbr, vc, ipp, ibv, blocker) {
  const vb = (i) => diodeVf(blocker.is, blocker.n, blocker.rs, i)
  const rs = (vc - vbr - (vb(ipp) - vb(ibv)) - VT * Math.log(ipp / ibv)) / (ipp - ibv)
  const bv = vbr - vb(ibv) - ibv * rs
  return { bv, rs }
}

// --- BJT DC model (forward active, ngspice Gummel-Poon) -----------------------

function bjtCurrents(p, vbe, vce) {
  const cbe = p.is * (Math.exp(vbe / VT) - 1)
  const cben = p.ise * (Math.exp(vbe / (p.ne * VT)) - 1)
  const vbc = vbe - vce
  const q1 = 1 / (1 - vbc / p.vaf - vbe / p.var)
  const q2 = cbe / p.ikf
  const qb = (q1 / 2) * (1 + Math.sqrt(1 + 4 * q2))
  const ic = cbe / qb
  const ib = cbe / p.bf + cben
  return { ic, ib }
}

/** Solve vbe for a target Ic by bisection. */
function vbeForIc(p, ic, vce) {
  let lo = 0.2
  let hi = 1.2
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi)
    if (bjtCurrents(p, mid, vce).ic < ic) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

function hfeAt(p, ic, vce) {
  const vbe = vbeForIc(p, ic, vce)
  const { ib } = bjtCurrents(p, vbe, vce)
  return { hfe: ic / ib, vbe }
}

/** Plain Nelder-Mead minimiser. */
function nelderMead(f, x0, step, iters = 4000) {
  const n = x0.length
  let pts = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const x = x0.slice()
    x[i] += step
    pts.push(x)
  }
  let vals = pts.map(f)
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b])
    pts = order.map((i) => pts[i])
    vals = order.map((i) => vals[i])
    if (Math.abs(vals[n] - vals[0]) < 1e-14) break
    const cen = new Array(n).fill(0)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += pts[i][j] / n
    const along = (t) => cen.map((c, j) => c + t * (pts[n][j] - c))
    const xr = along(-1)
    const fr = f(xr)
    if (fr < vals[0]) {
      const xe = along(-2)
      const fe = f(xe)
      if (fe < fr) {
        pts[n] = xe
        vals[n] = fe
      } else {
        pts[n] = xr
        vals[n] = fr
      }
    } else if (fr < vals[n - 1]) {
      pts[n] = xr
      vals[n] = fr
    } else {
      const xc = along(fr < vals[n] ? -0.5 : 0.5)
      const fc = f(xc)
      if (fc < Math.min(fr, vals[n])) {
        pts[n] = xc
        vals[n] = fc
      } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((x, j) => pts[0][j] + 0.5 * (x - pts[0][j]))
          vals[i] = f(pts[i])
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals))
  return pts[best]
}

/** ngspice forward-bias depletion capacitance (fc = 0.5, linearised above fc*vj). */
function cjForward(cj0, vj, m, vf, fc = 0.5) {
  if (vf < fc * vj) return cj0 / Math.pow(1 - vf / vj, m)
  const f1 = Math.pow(1 - fc, -(1 + m))
  return cj0 * f1 * (1 - fc * (1 + m) + (m * vf) / vj)
}

/**
 * Storage-time calibration for ngspice 46. Measured once with a transient probe
 * (switch from saturation with IB1 = IB2 and Ic/IB1 = 10, time from base turn-off
 * until Vce has risen by 10 percent of the supply swing, which is how the
 * datasheets define ts): the simulated interval is TS_SLOPE x tr + TS_OFFSET for
 * the cards this script emits (tr 100 to 310 ns). The drive dependence is scaled
 * by the textbook ln((IB1+IB2)/(Ic/hFE+IB2)) term relative to its value at that
 * reference drive, so the card reproduces the stated datasheet ts in ngspice.
 */
const TS_SLOPE = 1.7
const TS_OFFSET = 34e-9
const TS_LN_REF = Math.log(2 / 1.05)

export function fitBjt(d) {
  const vaf = d.hoeIc / (d.hoeUmho * 1e-6) - d.hoeVce
  const vr = 20
  const ne = 1.5
  const br = 3
  const rb = d.rb ?? d.rbCcPs / (d.coboPf * 0.75)
  const re = d.re
  const rc = d.rc
  const refI = d.hfe[d.refIndex][0]

  const build = (x) => ({
    is: Math.exp(x[0]),
    bf: Math.exp(x[1]),
    ikf: Math.exp(x[2]),
    ise: Math.exp(x[3]),
    ne,
    vaf,
    var: vr
  })
  // Residuals: three hFE points (log ratio) and Vbe at the reference current.
  const cost = (x) => {
    const p = build(x)
    let s = 0
    for (const [ic, target] of d.hfe) {
      const { hfe } = hfeAt(p, ic, d.vce)
      s += Math.pow(Math.log(hfe / target), 2)
    }
    const { vbe, } = hfeAt(p, refI, d.vce)
    const ibRef = bjtCurrents(p, vbe, d.vce).ib
    const vbeExt = vbe + ibRef * rb + (refI + ibRef) * re
    s += Math.pow((vbeExt - d.vbe) / 0.01, 2)
    return s
  }
  // Start: is from Vbe, bf near the reference hFE, knee near the highest current.
  const x0 = [
    Math.log(refI / Math.exp(d.vbe / VT)),
    Math.log(d.hfe[d.refIndex][1] * 1.2),
    Math.log(d.hfe[d.hfe.length - 1][0]),
    Math.log(1e-14)
  ]
  let x = nelderMead(cost, x0, 0.5)
  for (let r = 0; r < 6; r++) x = nelderMead(cost, x, 0.2)
  const p = build(x)

  // Capacitances (vje = vjc = 0.7 V, mje = mjc = 0.5).
  const cobo = d.cobTypPf ?? d.coboPf * 0.75
  const cibo = d.cibTypPf ?? d.ciboPf * 0.75
  const cjc = cj0From(cobo * 1e-12, d.coboV, VJ_BJT, M_BJT)
  const cje = cj0From(cibo * 1e-12, d.ciboV, VJ_BJT, M_BJT)

  // Forward transit time from fT = 1/(2 pi (tf + (Cje+Cjc)/gm + (rc+re) Cjc)).
  const tau = 1 / (2 * Math.PI * d.fTMhz * 1e6)
  const gm = d.fTIc / VT
  const vbeFt = vbeForIc(p, d.fTIc, d.fTVce)
  const cjeFwd = cjForward(cje, VJ_BJT, M_BJT, vbeFt)
  const cjcAtVce = cjc / Math.pow(1 + d.fTVce / VJ_BJT, M_BJT)
  const tf = tau - (cjeFwd + cjcAtVce) / gm - (rc + re) * cjcAtVce

  // Reverse transit time from storage time under IB1 = IB2 drive.
  const hfeTs = hfeAt(p, d.tsIc, d.vce).hfe
  const lnTerm = Math.log((2 * d.tsIb) / (d.tsIc / hfeTs + d.tsIb))
  const tr = (d.tsNs * 1e-9 - TS_OFFSET) / ((TS_SLOPE * lnTerm) / TS_LN_REF)

  return {
    type: d.type,
    is: p.is,
    bf: p.bf,
    vaf,
    ikf: p.ikf,
    ise: p.ise,
    ne,
    br,
    var: vr,
    rb,
    rc,
    re,
    cje,
    vje: VJ_BJT,
    mje: M_BJT,
    tf: Math.max(tf, 10e-12),
    cjc,
    vjc: VJ_BJT,
    mjc: M_BJT,
    tr,
    xtb: 1.5,
    eg: 1.11,
    _tfRaw: tf
  }
}

// --- card assembly -----------------------------------------------------------

export function deriveDiodes() {
  const out = {}
  for (const [name, d] of Object.entries(DIODES)) {
    const { is, rs } = fitDiodeTwoPoint(d.n, d.pts)
    const vj = d.schottky ? VJ_SCHOTTKY : VJ_SI
    const cjo =
      (d.cjMaxPf !== undefined ? d.cjMaxPf * 0.75 : d.cjTypPf) * 1e-12
    const params = {
      is,
      rs,
      n: d.n,
      cjo: cj0From(cjo, d.cjBiasV, vj, M_ABRUPT),
      vj,
      m: M_ABRUPT,
      bv: d.bv,
      ibv: d.ibv,
      eg: d.eg,
      xti: d.xti
    }
    if (d.trrNs > 0) params.tt = d.trrNs * 1e-9
    out[name] = { type: 'D', params }
  }
  for (const [name, t] of Object.entries(TVS)) {
    const fwd = fitDiodeTwoPoint(t.n, t.fwdPts)
    const clamp = fitTvsClamp(t.vbr, t.vc, t.ipp, t.ibv, t.blocker)
    out[name + '_F'] = {
      type: 'D',
      params: {
        is: fwd.is,
        rs: fwd.rs,
        n: t.n,
        cjo: t.cjPf * 1e-12,
        vj: VJ_SI,
        m: M_ABRUPT,
        eg: 1.11
      }
    }
    out[name + '_B'] = {
      type: 'D',
      params: { is: t.blocker.is, rs: t.blocker.rs, n: t.blocker.n, bv: 100 }
    }
    out[name + '_Z'] = {
      type: 'D',
      params: { is: 1e-12, rs: clamp.rs, n: 1, bv: clamp.bv, ibv: t.ibv }
    }
  }
  return out
}

export function deriveLeds() {
  const out = {}
  for (const [name, l] of Object.entries(LEDS)) {
    out[name] = {
      type: 'D',
      params: {
        is: fitLedIs(l.vf20, l.n, l.rs),
        rs: l.rs,
        n: l.n,
        cjo: l.cjo,
        vj: 0.75,
        m: 0.333,
        bv: 5,
        ibv: 100e-6,
        eg: l.eg,
        xti: 3
      }
    }
  }
  return out
}

export function deriveBjts() {
  const out = {}
  for (const [name, d] of Object.entries(BJTS)) {
    const f = fitBjt(d)
    const { type } = f
    const params = { ...f }
    delete params.type
    delete params._tfRaw
    out[name] = { type, params }
  }
  return out
}

export function deriveCards() {
  return { ...deriveBjts(), ...deriveDiodes(), ...deriveLeds() }
}

// --- text formatting ---------------------------------------------------------

/** Format to three significant figures with a SPICE engineering suffix. */
export function fmtSpice(x) {
  if (x === 0) return '0'
  const table = [
    [1e-15, 'f'],
    [1e-12, 'p'],
    [1e-9, 'n'],
    [1e-6, 'u'],
    [1e-3, 'm'],
    [1, ''],
    [1e3, 'k']
  ]
  const a = Math.abs(x)
  if (a >= 0.1 && a < 1000) return String(Number(x.toPrecision(3)))
  let pick = table[0]
  for (const t of table) if (a >= t[0] * 0.9995) pick = t
  if (a < 1e-15 || a >= 1e6) return Number(x.toPrecision(3)).toExponential().replace('e+', 'e')
  const scaled = Number((x / pick[0]).toPrecision(3))
  return `${scaled}${pick[1]}`
}

export function cardText(name, card) {
  const parts = Object.entries(card.params).map(([k, v]) => `${k}=${fmtSpice(v)}`)
  const lines = []
  let cur = `.model ${name} ${card.type}(`
  let first = true
  for (const p of parts) {
    if ((cur + ' ' + p).length > 78 && !first) {
      lines.push(cur)
      cur = '+ '
    }
    cur += (cur.endsWith('(') || cur === '+ ' ? '' : ' ') + p
    first = false
  }
  lines.push(cur + ')')
  return lines.join('\n')
}

// --- CLI ---------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const cards = deriveCards()
  for (const [name, card] of Object.entries(cards)) {
    console.log(cardText(name, card))
    console.log('')
  }
  for (const [name, d] of Object.entries(BJTS)) {
    const f = fitBjt(d)
    console.log(`* ${name}: raw tf = ${(f._tfRaw * 1e12).toFixed(1)} ps`)
  }
}
