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
      if (e.model.file === 'opamp.lib' && name !== 'LM393') {
        deck = ['* op', 'vcc vcc 0 dc 12', 'vin in 0 dc 6', `x1 in out out vcc 0 ${name}`, ...lib, '.op', '.end']
      } else if (name === 'LM393') {
        deck = ['* cmp', 'vcc vcc 0 dc 5', 'rpu vcc out 10k', 'vp p 0 dc 3', 'vn n 0 dc 1', `x1 p n out vcc 0 ${name}`, ...lib, '.op', '.end']
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
})
