/**
 * src/simhost/__tests__/library-ic.integration.test.ts
 *
 * Bundled IC + digital model library integration tests (Task 14b / Spec §8.5, §13).
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing.
 * Wired into `npm run test:integration`.
 *
 * Covers the Task 14b acceptance:
 *   - every op-amp / comparator / regulator / NE555 subckt loads in ngspice
 *     without error and biases sanely;
 *   - LM358 voltage-follower: op → out ≈ in;
 *   - NE555 astable: ONE transient → oscillation period within 20 % of the
 *     0.693*(R1+2R2)*C astable formula;
 *   - 74HC00 NAND truth table via ONE .tran stepping the four input states
 *     (00/01/10/11 → H/H/H/L). XSPICE digital primitives are event-driven, so
 *     the truth table is exercised with .tran (never .op). The deck is built by
 *     EXPANDING the actual resources/models/logic74hc.json template, so this
 *     test validates the shipped template data — not a hand-rolled copy.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { normalizeVectorKey, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS = join(process.cwd(), 'resources', 'models')

function libLines(file: string): string[] {
  return haveNgspice ? readFileSync(join(MODELS, file), 'utf8').split(/\r?\n/) : []
}
const opampLib = libLines('opamp.lib')
const regLib = libLines('regulators.lib')
const t555Lib = libLines('timer555.lib')
const mosfetLib = libLines('mosfet.lib')
const diodesLib = libLines('diodes.lib')
const powerIcLib = libLines('power-ic.lib')

interface IndexEntry {
  id: string
  model: { type: string; file?: string; name: string }
}
const index: IndexEntry[] = haveNgspice
  ? (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')).entries as IndexEntry[])
  : []

// ─── helpers ──────────────────────────────────────────────────────────────────

async function runOp(deck: string[]): Promise<{ errs: string[]; v: Record<string, number> }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const v = await host.runOp()
    const errs = (events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
      SimEvent,
      { type: 'log' }
    >[]).map((e) => e.text)
    return { errs, v }
  } finally {
    await host.dispose()
  }
}

/** Run a raw transient through the engine and return per-vector sample arrays. */
async function runTran(
  deck: string[],
  tstep: string,
  tstop: string
): Promise<{ errs: string[]; series: Record<string, number[]>; t: number[] }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (host as any).engine
    await engine.command(`tran ${tstep} ${tstop} uic`, true)
    const series: Record<string, number[]> = {}
    let t: number[] = []
    const plot = engine.currentPlot()
    for (const name of engine.allVectors(plot)) {
      const d = engine.vectorData(name)
      if (d && d.length) {
        // Normalize to bare lowercase node names: ngspice returns nodes that
        // begin with a digit (e.g. "1Y") wrapped as "V(1Y)"; strip the wrapper.
        const key = normalizeVectorKey(name)
        series[key] = Array.from(d)
        if (key === 'time') t = Array.from(d)
      }
    }
    const errs = (events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
      SimEvent,
      { type: 'log' }
    >[]).map((e) => e.text)
    return { errs, series, t }
  } finally {
    await host.dispose()
  }
}

function valueAt(series: number[], t: number[], at: number): number {
  let best = 0
  let bestErr = Infinity
  for (let i = 0; i < t.length; i++) {
    const e = Math.abs(t[i] - at)
    if (e < bestErr) {
      bestErr = e
      best = i
    }
  }
  return series[best]
}

// ─── XSPICE digital template expander (drives the shipped logic74hc.json) ──────

interface Logic74 {
  family: { vHighDefault: number; adc: { inLowFrac: number; inHighFrac: number }; schmittAdc: { inLowFrac: number; inHighFrac: number } }
  templates: Record<
    string,
    {
      schmitt?: boolean
      gates: Array<{ prim: string; in?: string[]; out?: string; data?: string; clk?: string; set?: string; reset?: string; q?: string; qbar?: string }>
      inputs: string[]
      outputs: string[]
      power: { vcc: string; gnd: string }
      delaysNs: number
    }
  >
}

/**
 * Expand a logic74hc.json template into a flat XSPICE deck fragment.
 * Mirrors the eventual spicegen expansion (Task 15): one adc_bridge per input
 * signal, the listed digital primitives on internal `d_<sig>` nodes, one
 * dac_bridge per output signal. Analog input/output node names equal the signal
 * names (e.g. "1a", "1y"); the caller drives inputs and probes outputs by those.
 */
function expandTemplate(tpl: Logic74, partName: string, vHigh: number): string[] {
  const t = tpl.templates[partName]
  if (!t) throw new Error(`template ${partName} not found`)
  const lines: string[] = []
  const dnode = (sig: string): string => `d_${sig.toLowerCase()}`
  const adc = t.schmitt ? tpl.family.schmittAdc : tpl.family.adc
  const inLow = (adc.inLowFrac * vHigh).toFixed(4)
  const inHigh = (adc.inHighFrac * vHigh).toFixed(4)
  const rd = `${t.delaysNs}n`

  // Schmitt triggers: self-referential hysteresis B-source (mirrors production
  // expandXspiceDigital). State is held in the output node voltage — no
  // adc_bridge/dac_bridge, no UNKNOWN in-band level. Analog node names equal the
  // signal names (e.g. "1a" input, "1y" output), driven/probed by the caller.
  if (t.schmitt) {
    const mid = (vHigh / 2).toFixed(4)
    let sgi = 0
    for (const g of t.gates) {
      sgi++
      const inN = (g.in as string[])[0].toLowerCase()
      const outN = (g.out as string).toLowerCase()
      lines.push(
        `b_${partName.toLowerCase()}_${sgi} ${outN} 0 V = ` +
          `(v(${inN}) > (v(${outN}) > ${mid} ? ${inHigh} : ${inLow})) ? 0 : ${vHigh.toFixed(4)}`,
      )
    }
    return lines
  }

  // one adc_bridge per input signal (analog signal node -> digital d_<sig>)
  lines.push(`.model adcm74 adc_bridge(in_low=${inLow} in_high=${inHigh})`)
  lines.push(`.model dacm74 dac_bridge(out_low=0 out_high=${vHigh.toFixed(4)})`)
  for (const sig of t.inputs) {
    lines.push(`abr_${sig.toLowerCase()} [${sig.toLowerCase()}] [${dnode(sig)}] adcm74`)
  }
  // gates
  let gi = 0
  for (const g of t.gates) {
    gi++
    const inst = `a_${partName.toLowerCase()}_${gi}`
    if (g.prim === 'd_dff') {
      const set = g.set && t.inputs.includes(g.set) ? dnode(g.set) : `${inst}_nset`
      const reset = g.reset && t.inputs.includes(g.reset) ? dnode(g.reset) : `${inst}_nrst`
      const data = dnode(g.data as string)
      const clk = dnode(g.clk as string)
      lines.push(`.model ${inst}_m d_dff(clk_delay=${rd} set_delay=${rd} reset_delay=${rd} rise_delay=${rd} fall_delay=${rd})`)
      lines.push(`${inst} ${data} ${clk} ${set} ${reset} ${dnode(g.q as string)} ${dnode(g.qbar as string)} ${inst}_m`)
    } else if (g.in && g.in.length === 1) {
      // unary (inverter/buffer)
      lines.push(`.model ${inst}_m ${g.prim}(rise_delay=${rd} fall_delay=${rd})`)
      lines.push(`${inst} ${dnode(g.in[0])} ${dnode(g.out as string)} ${inst}_m`)
    } else {
      // multi-input gate: bracket vector form
      const ins = (g.in as string[]).map(dnode).join(' ')
      lines.push(`.model ${inst}_m ${g.prim}(rise_delay=${rd} fall_delay=${rd})`)
      lines.push(`${inst} [${ins}] ${dnode(g.out as string)} ${inst}_m`)
    }
  }
  // one dac_bridge per output signal (digital d_<sig> -> analog signal node)
  for (const sig of t.outputs) {
    lines.push(`abr_out_${sig.toLowerCase()} [${dnode(sig)}] [${sig.toLowerCase()}] dacm74`)
  }
  return lines
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!haveNgspice)('Task 14b — IC + digital library in real ngspice', () => {
  it('every subckt entry (op-amp/comparator/regulator/555) loads without error', async () => {
    const subcktEntries = index.filter((e) => e.model.type === 'subckt')
    expect(subcktEntries.length).toBeGreaterThanOrEqual(8)

    const loaded: string[] = []
    const failures: string[] = []
    for (const e of subcktEntries) {
      const lib =
        e.model.file === 'opamp.lib'
          ? opampLib
          : e.model.file === 'regulators.lib'
            ? regLib
            : e.model.file === 'mosfet.lib'
              ? mosfetLib
              : e.model.file === 'power-ic.lib'
                ? powerIcLib
                : t555Lib
      // A minimal bias deck per class. All subckts get rails + a probe load.
      let deck: string[]
      const name = e.model.name
      if (e.model.file === 'opamp.lib' && name !== 'LM393' && name !== 'LM339_QUAD') {
        deck = ['* op', 'vcc vcc 0 dc 12', 'vin in 0 dc 6', `x1 in out out vcc 0 ${name}`, ...lib, '.op', '.end']
      } else if (name === 'LM393') {
        deck = ['* cmp', 'vcc vcc 0 dc 5', 'rpu vcc out 10k', 'vp p 0 dc 3', 'vn n 0 dc 1', `x1 p n out vcc 0 ${name}`, ...lib, '.op', '.end']
      } else if (name === 'LM339_QUAD') {
        // 14-terminal quad wrapper: drive all four units the same way as LM393.
        deck = ['* quad cmp', 'vcc vcc 0 dc 5', 'vp p 0 dc 3', 'vn n 0 dc 1', 'rpu1 vcc out1 10k', 'rpu2 vcc out2 10k', 'rpu3 vcc out3 10k', 'rpu4 vcc out4 10k', `x1 p n out1 p n out2 p n out3 p n out4 vcc 0 ${name}`, ...lib, '.op', '.end']
      } else if (e.model.file === 'regulators.lib') {
        deck = ['* reg', 'vin vin 0 dc 15', `x1 vin 0 vout ${name}`, 'rl vout 0 200', ...lib, '.op', '.end']
      } else if (e.model.file === 'mosfet.lib') {
        // Dual FET (terminals d1 g1 s1 d2 g2 s2): both gates high, both channels
        // pull their drains low through the load resistors.
        deck = ['* dualfet', 'vd d 0 dc 5', 'vg g 0 dc 5', 'rd1 d drn1 100', 'rd2 d drn2 100', `x1 drn1 g 0 drn2 g 0 ${name}`, ...lib, '.op', '.end']
      } else if (name === 'BQ7791502') {
        deck = ['* bq77915 stub', 'vdd vdd 0 dc 12', 'x1 vdd 0 chg dsg BQ7791502', ...lib, '.op', '.end']
      } else if (name === 'LTC4020') {
        deck = ['* ltc4020 stub', 'vin vin 0 dc 12', 'x1 vin intvcc tg1 bg1 tg2 bg2 0 LTC4020', ...lib, '.op', '.end']
      } else if (name === 'AL8860') {
        deck = ['* al8860 stub', 'vin vin 0 dc 12', 'rs vin set 0.2', 'rled set sw 5', 'x1 vin set sw ctrl 0 AL8860', ...lib, '.op', '.end']
      } else {
        // NE555 static bias (op just needs to load; oscillation is the tran test)
        deck = ['* 555', 'vcc vcc 0 dc 5', `x1 0 trig out vcc ctrl thres disch vcc NE555`, 'vt trig 0 dc 1', 'vth thres 0 dc 1', ...lib, '.op', '.end']
      }
      const r = await runOp(deck)
      if (r.errs.length > 0) failures.push(`${e.id} (${name}): [${r.errs.join(' | ')}]`)
      else loaded.push(`${e.id} (${name})`)
    }
    // eslint-disable-next-line no-console
    console.log(`\n=== Task14b subckts: ${loaded.length} loaded ===\n${loaded.join('\n')}` + (failures.length ? `\n--- FAIL ---\n${failures.join('\n')}` : '') + '\n')
    expect(failures, failures.join('\n')).toEqual([])
  }, 120_000)

  it('LM358 voltage-follower: out ≈ in (op)', async () => {
    const deck = [
      '* LM358 unity-gain follower',
      'vcc vcc 0 dc 12',
      'vin in 0 dc 4.20',
      'x1 in out out vcc 0 LM358',
      ...opampLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[LM358 follower] in=4.20 out=${r.v['out']?.toFixed(4)}V (err=${(Math.abs(r.v['out'] - 4.2)).toFixed(4)}V)\n`)
    expect(r.errs).toEqual([])
    expect(r.v['out']).toBeCloseTo(4.2, 1)
  }, 60_000)

  it('LM339_QUAD: all four comparator units decide independently in one op (M11)', async () => {
    // One quad instance, 5 V rail, 10k pull-ups on every output. Units 1 and 3
    // see in+ (3V) > in- (1V) → open-collector transistor OFF → the pull-up
    // releases the output to ~5 V. Units 2 and 4 see in+ (1V) < in- (3V) →
    // the output is pulled to vee (Vol(sat) well under 0.3 V through the 40 Ω
    // behavioral pulldown). Distinct per-unit decisions prove all four LM393
    // cells inside the wrapper are independent (not aliased to unit 1).
    const deck = [
      '* LM339_QUAD — units 1&3 released high, units 2&4 pulled low',
      'vcc vcc 0 dc 5',
      'vhi hi 0 dc 3',
      'vlo lo 0 dc 1',
      'rpu1 vcc out1 10k',
      'rpu2 vcc out2 10k',
      'rpu3 vcc out3 10k',
      'rpu4 vcc out4 10k',
      'x1 hi lo out1 lo hi out2 hi lo out3 lo hi out4 vcc 0 LM339_QUAD',
      ...opampLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(
      `\n[LM339_QUAD] out1=${r.v['out1']?.toFixed(4)}V out2=${r.v['out2']?.toFixed(4)}V ` +
        `out3=${r.v['out3']?.toFixed(4)}V out4=${r.v['out4']?.toFixed(4)}V (expect ~5, <0.3, ~5, <0.3)\n`
    )
    expect(r.errs).toEqual([])
    expect(r.v['out1']).toBeGreaterThan(4.5)
    expect(r.v['out3']).toBeGreaterThan(4.5)
    expect(r.v['out2']).toBeLessThan(0.3)
    expect(r.v['out4']).toBeLessThan(0.3)
  }, 60_000)

  it('TL431 shunt reference: cathode-ref tied + 1k pullup from 5V regulates near 2.495V', async () => {
    const deck = [
      '* TL431 two-terminal reference (cathode tied to ref)',
      'vcc vcc 0 dc 5',
      'rpu vcc k 1k',
      'x1 k 0 k TL431',
      ...regLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[TL431 shunt ref] k=${r.v['k']?.toFixed(4)}V (target 2.495V)\n`)
    expect(r.errs).toEqual([])
    expect(r.v['k']).toBeCloseTo(2.495, 2)
  }, 60_000)

  it('NCE6005AS back-to-back pair with both gates high conducts ~1A with a small drop', async () => {
    // Battery-protection wiring: d1=PACK side, s1=s2=COM (common source), d2=OUT
    // tied to 0. With both gates driven well above the common source, the loop
    // current is set by rl and the pair drop is ~2*Rds(on)*I ≈ 64 mV.
    const deck = [
      '* NCE6005AS back-to-back battery-protection pair, both channels on',
      'vbat vbat 0 dc 5',
      'vg g 0 dc 5',
      'rl vbat pack 4.9',
      'x1 pack g com 0 g com NCE6005AS',
      ...mosfetLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const drop = r.v['pack']
    const amps = (5 - drop) / 4.9
    // eslint-disable-next-line no-console
    console.log(`\n[NCE6005AS pair] I=${amps.toFixed(3)}A drop=${(drop * 1e3).toFixed(1)}mV (expect ~64mV @ 1A)\n`)
    expect(r.errs).toEqual([])
    expect(amps).toBeGreaterThan(0.95)
    expect(amps).toBeLessThan(1.05)
    // Small on-state drop: well below a body-diode drop, above a dead short.
    expect(drop).toBeGreaterThan(0.02)
    expect(drop).toBeLessThan(0.15)
  }, 60_000)

  it('BQ7791502 stub drives a real NCE6005AS back-to-back pair: 12V battery loop conducts 1A', async () => {
    // THE battery-loop closure test: 12V stack powers the protector (vdd=vbat,
    // vss=0); its NORMAL-mode CHG/DSG drivers (held at v(vdd)=12V) gate the
    // dual-FET back-to-back pair (d1=PACK side, common source, d2=ground/OUT).
    // With Vgs ≈ 12V ≫ vth both channels are hard on; the loop current is set
    // by rl and the pair drop is ~2*Rds(on)*I ≈ 64 mV.
    const deck = [
      '* BQ7791502 NORMAL-mode stub gating the NCE6005AS protection pair',
      'vbat vbat 0 dc 12',
      'xprot vbat 0 chg dsg BQ7791502',
      'rl vbat pack 11.9',
      'x1 pack dsg com 0 chg com NCE6005AS',
      ...powerIcLib,
      ...mosfetLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const drop = r.v['pack']
    const amps = (12 - drop) / 11.9
    // eslint-disable-next-line no-console
    console.log(
      `\n[BQ7791502 + NCE6005AS] I=${amps.toFixed(3)}A drop=${(drop * 1e3).toFixed(1)}mV ` +
        `chg=${r.v['chg']?.toFixed(2)}V dsg=${r.v['dsg']?.toFixed(2)}V (expect ~1A, ~64mV, 12V gates)\n`
    )
    expect(r.errs).toEqual([])
    // Both gate drivers sit at v(vdd) = 12V (NORMAL mode, both FETs enabled).
    expect(r.v['chg']).toBeGreaterThan(11.5)
    expect(r.v['dsg']).toBeGreaterThan(11.5)
    expect(amps).toBeGreaterThan(0.95)
    expect(amps).toBeLessThan(1.05)
    // Small on-state drop: well below a body-diode drop, above a dead short.
    expect(drop).toBeGreaterThan(0.02)
    expect(drop).toBeLessThan(0.15)
  }, 60_000)

  it('LTC4020 idle/off stub: INTVCC ≈ 5V from a 12V vin, all four gate pins pulled low', async () => {
    const deck = [
      '* LTC4020 idle/off stub: behavioral INTVCC LDO + gate pulldowns',
      'vin vin 0 dc 12',
      'x1 vin intvcc tg1 bg1 tg2 bg2 0 LTC4020',
      'rl intvcc 0 1k',
      ...powerIcLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(
      `\n[LTC4020 stub] intvcc=${r.v['intvcc']?.toFixed(4)}V gates=[${['tg1', 'bg1', 'tg2', 'bg2']
        .map((g) => r.v[g]?.toExponential(2))
        .join(', ')}] (expect ~5V, all ~0)\n`
    )
    expect(r.errs).toEqual([])
    expect(r.v['intvcc']).toBeCloseTo(5, 1)
    for (const g of ['tg1', 'bg1', 'tg2', 'bg2']) {
      expect(Math.abs(r.v[g]), `gate ${g} must be held low`).toBeLessThan(0.01)
    }
  }, 60_000)

  it('AL8860 DC-averaged sink: 0.2Ω sense → 0.5A ± 15% through the LED path with ctrl open', async () => {
    // Real-application wiring, inductor-less for the DC-averaged model:
    // vin → Rs(0.2Ω) → set → LED-ish load → sw; the behavioral sink sw→gnd
    // servos v(vin)-v(set) to the 100 mV datasheet mean sense voltage, so
    // I ≈ 100mV / 0.2Ω = 0.5 A. ctrl is left open (internal pull-up = on).
    const deck = [
      '* AL8860 DC-averaged constant-current sink, ctrl open (full brightness)',
      'vin vin 0 dc 12',
      'rs vin set 0.2',
      'rled set sw 5',
      'x1 vin set sw ctrl 0 AL8860',
      ...powerIcLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const amps = (12 - r.v['set']) / 0.2
    // eslint-disable-next-line no-console
    console.log(
      `\n[AL8860 on] I=${amps.toFixed(4)}A sense=${((12 - r.v['set']) * 1e3).toFixed(1)}mV ` +
        `v(sw)=${r.v['sw']?.toFixed(3)}V (expect 0.5A ± 15%, ~100mV)\n`
    )
    expect(r.errs).toEqual([])
    expect(amps).toBeGreaterThan(0.5 * 0.85)
    expect(amps).toBeLessThan(0.5 * 1.15)
    // The LED-ish load actually carries the current (drop = I * 5Ω).
    expect(r.v['set'] - r.v['sw']).toBeGreaterThan(2)
  }, 60_000)

  it('AL8860 DC-averaged sink: ctrl at mid-scale (1.25V) dims to ~50% (0.25A ± 15%)', async () => {
    // Regression for the adversarial-review finding: an earlier form of the
    // model multiplied the dim factor into the 3 A current CAP instead of the
    // 100 mV sense TARGET — the servo then compensated and mid-scale dimming
    // silently returned full current. Datasheet analog dimming is linear in
    // v(ctrl)/2.5, so ctrl = 1.25 V must halve the regulation target
    // (50 mV / 0.2 Ω ≈ 0.25 A). This deck fails against the cap-scaled form
    // (which measured ~0.5 A here) and passes against the target-scaled form.
    const deck = [
      '* AL8860 DC-averaged constant-current sink, ctrl mid-scale (50% dim)',
      'vin vin 0 dc 12',
      'rs vin set 0.2',
      'rled set sw 5',
      'x1 vin set sw ctrl 0 AL8860',
      'vc ctrl 0 dc 1.25',
      ...powerIcLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const amps = (12 - r.v['set']) / 0.2
    // eslint-disable-next-line no-console
    console.log(
      `\n[AL8860 mid-dim] I=${amps.toFixed(4)}A sense=${((12 - r.v['set']) * 1e3).toFixed(1)}mV ` +
        `(expect 0.25A ± 15%)\n`
    )
    expect(r.errs).toEqual([])
    expect(amps).toBeGreaterThan(0.25 * 0.85)
    expect(amps).toBeLessThan(0.25 * 1.15)
  }, 60_000)

  it('AL8860 DC-averaged sink: ctrl grounded (< 0.2V) turns the sink off (< 1 mA)', async () => {
    const deck = [
      '* AL8860 DC-averaged constant-current sink, ctrl low (off)',
      'vin vin 0 dc 12',
      'rs vin set 0.2',
      'rled set sw 5',
      'x1 vin set sw ctrl 0 AL8860',
      'vc ctrl 0 dc 0',
      ...powerIcLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const amps = (12 - r.v['set']) / 0.2
    // eslint-disable-next-line no-console
    console.log(`\n[AL8860 off] I=${(amps * 1e6).toFixed(3)}uA (expect < 1mA)\n`)
    expect(r.errs).toEqual([])
    expect(Math.abs(amps)).toBeLessThan(1e-3)
  }, 60_000)

  it('SS54 Schottky: forward drop ~0.5-0.6V at 5A', async () => {
    const deck = [
      '* SS54 forward drop at the 5A datasheet test current',
      'i1 0 a dc 5',
      'd1 a 0 DSS54',
      ...diodesLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[SS54] Vf@5A=${r.v['a']?.toFixed(4)}V (datasheet typ ~0.55V)\n`)
    expect(r.errs).toEqual([])
    expect(r.v['a']).toBeGreaterThan(0.45)
    expect(r.v['a']).toBeLessThan(0.65)
  }, 60_000)

  it('SMAJ24A TVS: reverse clamp ~38.9V at the 10.3A datasheet surge current', async () => {
    // Reverse-drive the TVS: 10.3 A forced into the cathode with the anode
    // grounded → the diode operates in breakdown and v(k) is the clamp voltage.
    // Datasheet: Vc=38.9V max @ Ipp=10.3A (10/1000us). Assert ±10%.
    const deck = [
      '* SMAJ24A reverse clamp at the 10.3A datasheet surge current',
      'i1 0 k dc 10.3',
      'd1 0 k DSMAJ24A',
      ...diodesLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[SMAJ24A] Vclamp@10.3A=${r.v['k']?.toFixed(4)}V (datasheet 38.9V max)\n`)
    expect(r.errs).toEqual([])
    expect(r.v['k']).toBeGreaterThan(38.9 * 0.9)
    expect(r.v['k']).toBeLessThan(38.9 * 1.1)
  }, 60_000)

  it('MAO3401 P-FET high-side switch: gate low turns it on hard (drop < 100mV at ~1A)', async () => {
    // High-side P-channel switch: source at 5V, gate pulled to 0.5V
    // (Vgs = -4.5V, well past vto=-1.1), drain feeding a 5-ohm load to ground.
    // With Rds(on) ~ tens of milliohms the load carries close to 1A and the
    // source→drain drop stays below 100mV.
    const deck = [
      '* MAO3401 high-side switch, gate low (on)',
      'vcc vcc 0 dc 5',
      'vg g 0 dc 0.5',
      'm1 drn g vcc vcc MAO3401',
      'rl drn 0 5',
      ...mosfetLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const amps = r.v['drn'] / 5
    const drop = 5 - r.v['drn']
    // eslint-disable-next-line no-console
    console.log(`\n[MAO3401 on] I=${amps.toFixed(3)}A drop=${(drop * 1e3).toFixed(1)}mV (expect ~1A, <100mV)\n`)
    expect(r.errs).toEqual([])
    // Current flows source→drain into the load: close to the 1A full-on value.
    expect(amps).toBeGreaterThan(0.95)
    expect(amps).toBeLessThan(1.05)
    expect(drop).toBeGreaterThan(0)
    expect(drop).toBeLessThan(0.1)
  }, 60_000)

  it('MAO3401 P-FET high-side switch: gate high (Vgs=0) turns it off (load current ~0)', async () => {
    // Gate tied to the 5V source rail → Vgs=0, channel off; the body diode
    // (drain→source for a P-FET) is reverse-biased in this topology, so the
    // load sees essentially no current and the drain sits near ground.
    const deck = [
      '* MAO3401 high-side switch, gate high (off)',
      'vcc vcc 0 dc 5',
      'm1 drn vcc vcc vcc MAO3401',
      'rl drn 0 5',
      ...mosfetLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    const amps = r.v['drn'] / 5
    // eslint-disable-next-line no-console
    console.log(`\n[MAO3401 off] I=${(amps * 1e6).toFixed(3)}uA v(drn)=${r.v['drn']?.toExponential(3)}V (expect ~0)\n`)
    expect(r.errs).toEqual([])
    expect(Math.abs(amps)).toBeLessThan(1e-3)
  }, 60_000)

  it('MAO3401 P-FET switching transient completes without "timestep too small"', async () => {
    // The dedicated MAO3401 card exists because the MPMOS_GEN generic aborted a
    // real-board transient with "TRAN: Timestep too small". Drive the gate of a
    // high-side switch with a pulse (on/off at 10kHz-ish) for 100us and assert
    // the transient produces data instead of aborting.
    const deck = [
      '* MAO3401 high-side switch, pulsed gate transient',
      'vcc vcc 0 dc 5',
      'vg g 0 dc 5 pulse(5 0.5 5u 1u 1u 40u 100u)',
      'm1 drn g vcc vcc MAO3401',
      'rl drn 0 5',
      'cl drn 0 1n',
      ...mosfetLib,
      '.end'
    ]
    const r = await runTran(deck, '50n', '100u')
    const drn = r.series['drn'] ?? []
    const vOn = Math.max(...drn)
    const vOff = Math.min(...drn)
    // eslint-disable-next-line no-console
    console.log(
      `\n[MAO3401 tran] rows=${r.t.length} v(drn) min=${vOff.toFixed(3)}V max=${vOn.toFixed(3)}V errs=[${r.errs.join('|')}]\n`
    )
    expect(r.errs.join('|')).not.toMatch(/timestep too small/i)
    expect(r.errs).toEqual([])
    expect(r.t.length).toBeGreaterThan(0)
    // Sanity: the load node actually swings (switch turns on and off).
    expect(vOn).toBeGreaterThan(4.5)
    expect(vOff).toBeLessThan(0.5)
  }, 90_000)

  it('NCE4012S body diode conducts when the gate is low and the source sits above the drain', async () => {
    // Gate tied to source (channel off); 1A forced into the source with the
    // drain grounded → the VDMOS body diode (source→drain) carries the current
    // at a diode-like drop.
    const deck = [
      '* NCE4012S body-diode conduction (gate low, source above drain)',
      'i1 0 s dc 1',
      'm1 0 s s s MNCE4012S',
      ...mosfetLib,
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[NCE4012S body diode] Vsd@1A=${r.v['s']?.toFixed(4)}V (expect diode-like 0.4-1.2V)\n`)
    expect(r.errs).toEqual([])
    expect(r.v['s']).toBeGreaterThan(0.4)
    expect(r.v['s']).toBeLessThan(1.2)
  }, 60_000)

  it('NE555 astable: period within 20% of 0.693*(R1+2R2)*C', async () => {
    const R1 = 1e3
    const R2 = 10e3
    const C = 100e-9
    const expected = 0.693 * (R1 + 2 * R2) * C
    const deck = [
      '* NE555 astable: R1 vcc->disch, R2 disch->thres(=trig), C thres->gnd',
      'vcc vcc 0 dc 5',
      'r1 vcc disch 1k',
      'r2 disch thres 10k',
      'c1 thres 0 100n ic=0',
      'cc ctrl 0 10n',
      'x1 0 thres out vcc ctrl thres disch vcc NE555',
      ...t555Lib,
      '.end'
    ]
    const r = await runTran(deck, '1u', '10m')
    const out = r.series['out'] ?? []
    const edges: number[] = []
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 2.5 && out[i] >= 2.5) edges.push(r.t[i])
    let measured = NaN
    if (edges.length >= 3) {
      const periods: number[] = []
      for (let i = 2; i < edges.length; i++) periods.push(edges[i] - edges[i - 1])
      measured = periods.reduce((a, b) => a + b, 0) / periods.length
    }
    const relErr = Math.abs(measured - expected) / expected
    // eslint-disable-next-line no-console
    console.log(
      `\n[NE555] rising edges=${edges.length} measured period=${(measured * 1e3).toFixed(3)} ms ` +
        `expected=${(expected * 1e3).toFixed(3)} ms relErr=${(relErr * 100).toFixed(1)} %\n`
    )
    expect(r.errs).toEqual([])
    expect(edges.length).toBeGreaterThanOrEqual(3)
    expect(relErr).toBeLessThan(0.2)
  }, 90_000)

  it('74HC00 NAND truth table via ONE .tran stepping 00/01/10/11', async () => {
    const logic = JSON.parse(readFileSync(join(MODELS, 'logic74hc.json'), 'utf8')) as Logic74
    const vHigh = 5
    // Step the inputs of gate-1 (signals 1A, 1B) through the four states, each
    // held for 1 us. Hold all other inputs low. Probe output 1Y mid-state.
    // 1A: low for [0,2us), high for [2us,4us)   -> A pattern 0,0,1,1
    // 1B: low,high,low,high                      -> B pattern 0,1,0,1
    const expand = expandTemplate(logic, '74HC00', vHigh)
    const deck = [
      '* 74HC00 NAND truth table — one transient, four states',
      // 1A: 0 (0-2us) then 5 (2-4us)
      'v1a 1a 0 dc 0 pwl(0 0 1.999u 0 2u 5 4u 5)',
      // 1B: toggles every 1us: 0,5,0,5
      'v1b 1b 0 dc 0 pwl(0 0 0.999u 0 1u 5 1.999u 5 2u 0 2.999u 0 3u 5 4u 5)',
      // tie the other inputs low so their gates/bridges have a defined level
      'v2a 2a 0 dc 0',
      'v2b 2b 0 dc 0',
      'v3a 3a 0 dc 0',
      'v3b 3b 0 dc 0',
      'v4a 4a 0 dc 0',
      'v4b 4b 0 dc 0',
      ...expand,
      '.end'
    ]
    const r = await runTran(deck, '20n', '4u')
    const y = r.series['1y'] ?? []
    const t = r.t
    // sample each state mid-window (0.7, 1.7, 2.7, 3.7 us) — well past tpd
    const states = [
      { a: 0, b: 0, at: 0.7e-6 },
      { a: 0, b: 1, at: 1.7e-6 },
      { a: 1, b: 0, at: 2.7e-6 },
      { a: 1, b: 1, at: 3.7e-6 }
    ]
    const rows: string[] = []
    const measured: number[] = []
    for (const s of states) {
      const v = valueAt(y, t, s.at)
      const hi = v > vHigh / 2
      measured.push(hi ? 1 : 0)
      rows.push(`A=${s.a} B=${s.b} -> 1Y=${v.toFixed(3)}V (${hi ? 'H' : 'L'})`)
    }
    // NAND truth table: only 1&1 -> 0; all else -> 1
    const expectedTT = [1, 1, 1, 0]
    // eslint-disable-next-line no-console
    console.log(`\n[74HC00 NAND]\n${rows.join('\n')}\nexpected H/H/H/L -> [1,1,1,0]  measured=[${measured.join(',')}]  errs=[${r.errs.join('|')}]\n`)
    expect(r.errs).toEqual([])
    expect(measured).toEqual(expectedTT)
  }, 90_000)

  // ── Milestone 5c: CD4000-series family (logic4000.json, fixed 12 V swing) ────

  it('CD4011 NAND truth table via ONE .tran at the 12 V family swing (out high ≈ 12 V)', async () => {
    const logic = JSON.parse(readFileSync(join(MODELS, 'logic4000.json'), 'utf8')) as Logic74
    const vHigh = logic.family.vHighDefault // 12 V family constant
    const expand = expandTemplate(logic, 'CD4011', vHigh)
    const deck = [
      '* CD4011 NAND truth table — one transient, four states, 12 V swing',
      // 1A: 0 (0-2us) then 12 (2-4us)
      'v1a 1a 0 dc 0 pwl(0 0 1.999u 0 2u 12 4u 12)',
      // 1B: toggles every 1us: 0,12,0,12
      'v1b 1b 0 dc 0 pwl(0 0 0.999u 0 1u 12 1.999u 12 2u 0 2.999u 0 3u 12 4u 12)',
      // tie the other inputs low so their gates/bridges have a defined level
      'v2a 2a 0 dc 0',
      'v2b 2b 0 dc 0',
      'v3a 3a 0 dc 0',
      'v3b 3b 0 dc 0',
      'v4a 4a 0 dc 0',
      'v4b 4b 0 dc 0',
      ...expand,
      '.end'
    ]
    const r = await runTran(deck, '20n', '4u')
    const y = r.series['1y'] ?? []
    const t = r.t
    const states = [
      { a: 0, b: 0, at: 0.7e-6 },
      { a: 0, b: 1, at: 1.7e-6 },
      { a: 1, b: 0, at: 2.7e-6 },
      { a: 1, b: 1, at: 3.7e-6 }
    ]
    const rows: string[] = []
    const measured: number[] = []
    for (const s of states) {
      const v = valueAt(y, t, s.at)
      measured.push(v > vHigh / 2 ? 1 : 0)
      rows.push(`A=${s.a} B=${s.b} -> 1Y=${v.toFixed(3)}V (${v > vHigh / 2 ? 'H' : 'L'})`)
    }
    // eslint-disable-next-line no-console
    console.log(`\n[CD4011 NAND @12V]\n${rows.join('\n')}\nexpected H/H/H/L -> [1,1,1,0]  measured=[${measured.join(',')}]  errs=[${r.errs.join('|')}]\n`)
    expect(r.errs).toEqual([])
    expect(measured).toEqual([1, 1, 1, 0])
    // The HIGH level is the documented fixed 12 V family swing (not 5 V).
    const vHighState = valueAt(y, t, 0.7e-6)
    expect(vHighState).toBeGreaterThan(11)
    const vLowState = valueAt(y, t, 3.7e-6)
    expect(vLowState).toBeLessThan(1)
  }, 90_000)

  it('CD40106 Schmitt band: TRUE hysteresis in sim (in-band output holds the prior rail, not a mid-rail level)', async () => {
    // The self-referential B-source holds state in the output node voltage, so
    // inside the 4.8–7.2 V band the output depends on WHICH DIRECTION the input
    // is moving: on the rising leg (coming from below V_T-) it is still HIGH; on
    // the falling leg (coming from above V_T+) it is still LOW. Sampling the SAME
    // in-band input voltage (6.0 V) on each leg yields opposite rails — that
    // difference IS the hysteresis loop (pre-fix both legs read ~6 V mid-rail).
    const logic = JSON.parse(readFileSync(join(MODELS, 'logic4000.json'), 'utf8')) as Logic74
    const vHigh = logic.family.vHighDefault // 12 V family constant
    const expand = expandTemplate(logic, 'CD40106', vHigh)
    const expandText = expand.join('\n')
    // New expansion: hysteresis B-source, no adc/dac bridges.
    expect(expandText).toContain('b_cd40106_1 1y 0 V =')
    expect(expandText).toContain('(v(1y) > 6.0000 ? 7.2000 : 4.8000)')
    expect(expandText).not.toContain('adc_bridge')
    expect(expandText).not.toContain('dac_bridge')

    // One slow triangle 0 -> 12 -> 0 V over 2 ms on input 1A (the B-source is
    // zero-delay, so the ramp is quasi-static). Other inputs tied low.
    const deck = [
      '* CD40106 Schmitt hysteresis — slow triangle in, sample both directions',
      'v1a 1a 0 dc 0 pwl(0 0 1m 12 2m 0)',
      'v2a 2a 0 dc 0',
      'v3a 3a 0 dc 0',
      'v4a 4a 0 dc 0',
      'v5a 5a 0 dc 0',
      'v6a 6a 0 dc 0',
      ...expand,
      '.end'
    ]
    const r = await runTran(deck, '2u', '2m')
    const y = r.series['1y'] ?? []
    const t = r.t
    // Rising leg: vin = 12*t/1m. Falling leg: vin = 12*(2m-t)/1m.
    const samples = [
      { label: 'vin=3.0V rising', at: 0.25e-3, kind: 'H' },   // below the band -> 12 V
      { label: 'vin=4.2V rising', at: 0.35e-3, kind: 'H' },   // still below V_T+ -> held 12 V
      { label: 'vin=6.0V rising', at: 0.50e-3, kind: 'H' },   // IN BAND, rose from low -> held HIGH
      { label: 'vin=7.8V rising', at: 0.65e-3, kind: 'L' },   // above V_T+=7.2 -> flipped 0 V
      { label: 'vin=9.0V rising', at: 0.75e-3, kind: 'L' },
      { label: 'vin=6.0V falling', at: 1.50e-3, kind: 'L' },  // IN BAND, fell from high -> held LOW
      { label: 'vin=3.0V falling', at: 1.75e-3, kind: 'H' }   // below V_T-=4.8 -> flipped 12 V
    ] as const
    const rows: string[] = []
    const measured: string[] = []
    for (const s of samples) {
      const v = valueAt(y, t, s.at)
      const kind = v > 11 ? 'H' : v < 1 ? 'L' : '?'
      measured.push(kind)
      rows.push(`${s.label} -> 1Y=${v.toFixed(3)}V (${kind}, expect ${s.kind})`)
    }
    // The crux: same in-band input (6.0 V), opposite outputs on the two legs.
    const vRising6 = valueAt(y, t, 0.50e-3)
    const vFalling6 = valueAt(y, t, 1.50e-3)
    // eslint-disable-next-line no-console
    console.log(
      `\n[CD40106 hysteresis @12V]\n${rows.join('\n')}\n` +
        `in-band 6.0V: rising=${vRising6.toFixed(3)}V falling=${vFalling6.toFixed(3)}V ` +
        `(hysteresis Δ=${Math.abs(vRising6 - vFalling6).toFixed(3)}V)\nerrs=[${r.errs.join('|')}]\n`
    )
    expect(r.errs).toEqual([])
    // The two thresholds are distinct AND the in-band output holds the prior rail.
    expect(measured).toEqual(samples.map((s) => s.kind))
    // Explicit hysteresis-loop assertion: same input, output HIGH rising / LOW falling.
    expect(vRising6).toBeGreaterThan(11)
    expect(vFalling6).toBeLessThan(1)
  }, 90_000)

  it('.options noopalter: mixed-signal DCOP with an RC astable (no DC fixpoint) yields a defined op', async () => {
    // Review follow-up: generateDeck emits `.options noopalter` whenever a
    // digital part was expanded — because an inverter wired as an RC astable
    // (exactly the lantern board's CD40106 blink oscillator: 1Y→R→1A, C on 1A)
    // has NO consistent DC event fixpoint, and ngspice's default mixed-mode
    // DCOP alternation wedges ("Convergence problems at node (d_…)") and
    // returns an EMPTY op. With noopalter the DCOP is a single event pass and
    // the op is defined. This pins the option's behavior in real ngspice so
    // the generator's reliance on it can't silently rot.
    const deck = [
      '* RC-astable inverter DCOP under noopalter',
      '.model adcx adc_bridge(in_low=4.8 in_high=7.2)',
      '.model dacx dac_bridge(out_low=0 out_high=12)',
      '.model invx d_inverter(rise_delay=80n fall_delay=80n)',
      'abr [in] [d_in] adcx',
      'ainv d_in d_out invx',
      'adac [d_out] [out] dacx',
      'r1 out in 470k',
      'c1 in 0 680n',
      '.options noopalter',
      '.op',
      '.end'
    ]
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(
      `\n[noopalter DCOP] v(out)=${r.v['out']?.toFixed(3)} v(in)=${r.v['in']?.toFixed(3)} ` +
        `errs=[${r.errs.join('|')}]\n`
    )
    expect(r.errs).toEqual([])
    // The op must be DEFINED (non-empty result with the output node present).
    // Without noopalter this deck produces convergence warnings and an empty
    // op result. The single event pass leaves out at a rail (or mid-rail
    // UNKNOWN) — any finite value is acceptable; existence is the contract.
    expect(Object.keys(r.v).length).toBeGreaterThan(0)
    expect(Number.isFinite(r.v['out'])).toBe(true)
    expect(Number.isFinite(r.v['in'])).toBe(true)
  }, 60_000)
})

// ─── Milestone M10: supply-derived digital vHigh in real ngspice ──────────────

describe.skipIf(!haveNgspice)('M10 — supply-derived digital vHigh (CD40106 RC astable at VDD=5 V)', () => {
  /**
   * A CD40106 RC astable (1Y→R→1A, C on 1A) built through generateDeck with a
   * 5 V dc-supply DIRECTLY on the chip's VDD pad net. Pre-M10 the CD4000 family
   * constant drove the dac_bridge at a fixed 12 V regardless of the board rail;
   * with the supply-derived vHigh the output must swing ~0..5 V.
   */
  function buildAstableDeck(): string[] {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VDD', spiceNode: 'vdd', padRefs: [] },
      { id: 2, kicadName: 'OSC', spiceNode: 'osc', padRefs: [] },
      { id: 3, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
      { id: 4, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const parts: Part[] = [
      {
        ref: 'U1', value: 'CD40106', libId: 'Logic:CD40106', layer: 'F',
        padNet: new Map([['1', 2], ['2', 3], ['7', 4], ['14', 1]]),
        properties: {},
      },
      { ref: 'R1', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 3], ['2', 2]]), properties: {} },
      { ref: 'C1', value: '10n', libId: 'C', layer: 'F', padNet: new Map([['1', 2], ['2', 4]]), properties: {} },
    ]
    const circuit: Circuit = { nets, parts, warnings: [] }
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: {
          kind: 'xspice-digital', templateId: 'CD40106',
          pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' },
        },
      },
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 out osc 10000' } },
      { ref: 'C1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'c_c1 osc 0 1e-08' } },
    ]
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 4 },
      { kind: 'dc-supply', id: 'bench', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]
    return generateDeck({
      circuit, resolutions, instruments,
      groundNetId: 4,
      title: 'm10-cd40106-astable-5v',
      modelTexts: { 'logic4000.json': readFileSync(join(MODELS, 'logic4000.json'), 'utf8') },
    })
  }

  it('the generated deck carries the 5 V-derived Schmitt hysteresis B-source (thresholds/rail scale off the bench supply)', () => {
    const deck = buildAstableDeck()
    const text = deck.join('\n')
    // 1A (input) is on node `osc`, 1Y (output) on node `out`. The self-referential
    // Schmitt B-source carries the 5 V-derived thresholds: mid=2.5, V_T+=3.0 (60%),
    // V_T-=2.0 (40%), rail=5.0 — not the 12 V family default.
    expect(text).toContain(
      'b_u1_1 out 0 V = (v(osc) > (v(out) > 2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000',
    )
    // The abandoned adc/dac path and the 12 V default are gone.
    expect(text).not.toContain('adc_bridge')
    expect(text).not.toContain('dac_bridge')
    expect(text).not.toContain('12.0000')
    expect(text).toContain('* U1 vhigh: 5 (dc-supply on VDD net; family default 12)')
  })

  it('the astable self-oscillates rail-to-rail on the derived 5 V rail (not a 2.5 V mid-rail stall, not the 12 V family constant)', async () => {
    // MEASURED BEHAVIOR (real ngspice-46): the self-referential Schmitt B-source
    // has TRUE hysteresis (state held in the output node voltage), so this
    // 1Y→R→1A / C-on-1A RC astable actually OSCILLATES. Both the swing rails and
    // the thresholds scale off the 5 V bench supply (M10):
    //   peak   ≈ 5.0 V (rail from the bench supply; pre-M10: 12 V)
    //   trough ≈ 0.0 V (the other rail; pre-fix this stalled at 2.5 V mid-rail)
    const deck = buildAstableDeck()
    const r = await runTran(deck, '1u', '5m')
    const out = r.series['out'] ?? []
    expect(r.errs).toEqual([])
    expect(out.length).toBeGreaterThan(0)
    const peak = Math.max(...out)
    const trough = Math.min(...out)
    // Count rising edges through mid-rail (2.5 V) — oscillation evidence, same
    // detection as the NE555 astable test above.
    const edgeT: number[] = []
    for (let i = 1; i < out.length; i++) if (out[i - 1] < 2.5 && out[i] >= 2.5) edgeT.push(r.t[i])
    // eslint-disable-next-line no-console
    console.log(
      `\n[M10 CD40106 astable @5V] peak=${peak.toFixed(3)}V trough=${trough.toFixed(3)}V ` +
        `risingEdges=${edgeT.length} rows=${r.t.length} errs=[${r.errs.join('|')}]\n`
    )
    // THE milestone assertion: the output rides the real 5 V bench rail, not the
    // 12 V family constant (pre-M10 this peak measured 12 V).
    expect(peak).toBeGreaterThan(4.5)
    // It genuinely oscillates rail-to-rail — the trough reaches ~0 V, NOT the
    // pre-fix 2.5 V mid-rail park.
    expect(trough).toBeLessThan(0.5)
    // Multiple mid-rail crossings prove sustained oscillation (not a single edge).
    expect(edgeT.length).toBeGreaterThanOrEqual(2)
  }, 90_000)
})
