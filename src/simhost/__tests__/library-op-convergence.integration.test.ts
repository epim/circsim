/**
 * src/simhost/__tests__/library-op-convergence.integration.test.ts
 *
 * Issue #19: the bundled NE555 and op-amp macromodels must find their operating
 * point directly, without ngspice's gmin stepping, source stepping or transient
 * fallback. The fallback is what lights the "check these voltages" caveat, and a
 * caveat that fires on the first-run sample board teaches users to ignore it.
 *
 * Each deck here is one the council measured falling back before the models were
 * smoothed (NE555 astable, monostable at idle and static bias; an LM358 follower),
 * plus the other common op-amp shapes (gain stages, comparator, Schmitt trigger)
 * and a regulator. Every one must report method 'direct' and must not print the
 * "singular matrix" warnings the old latch node produced. The shipped sample
 * boards go through the real pipeline and must open the same way.
 *
 * Also pins two behaviors that only matter if the model is wired this way: an
 * unpowered op-amp parks its output near 0 V instead of a thousand volts, and a
 * floating supply rail is not dragged to an absurd voltage by the supply-current
 * sources. And it runs the shipped 555 sample through a transient at the fine
 * solver steps a function generator picks, which a smooth latch memory aborted.
 *
 * Runs the REAL libngspice; skipped when resources/ngspice/<platform> is missing.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../core/kicad/board'
import { parseSchematicSimData } from '../../core/kicad/schematic'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import { extract, suggestGround } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { OpSolveMethod, SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const ROOT = process.cwd()
const MODELS = join(ROOT, 'resources', 'models')
const SAMPLES = join(ROOT, 'resources', 'sample')

function libLines(file: string): string[] {
  return haveNgspice ? readFileSync(join(MODELS, file), 'utf8').split(/\r?\n/) : []
}
const opampLib = libLines('opamp.lib')
const regLib = libLines('regulators.lib')
const t555Lib = libLines('timer555.lib')

interface OpRun {
  v: Record<string, number>
  method: OpSolveMethod | undefined
  /** ngspice log lines that name a solver difficulty (singular matrix, stepping). */
  trouble: string[]
}

/** One op through the real SimHost, reporting how it converged. */
async function runOp(deck: string[]): Promise<OpRun> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const v = await host.runOp()
    const opEv = events.find((e) => e.type === 'opResult') as
      | Extract<SimEvent, { type: 'opResult' }>
      | undefined
    const trouble = events
      .filter((e): e is Extract<SimEvent, { type: 'log' }> => e.type === 'log')
      .map((e) => e.text)
      .filter((t) => /singular matrix|gmin stepping|source stepping|transient op|no convergence/i.test(t))
    return { v, method: opEv?.method, trouble }
  } finally {
    await host.dispose()
  }
}

function expectDirect(r: OpRun, what: string): void {
  expect(r.method, `${what}: op method`).toBe('direct')
  expect(r.trouble, `${what}: solver trouble in the log`).toEqual([])
}

const OPAMP_CASES: Array<{ name: string; deck: string[]; node: string; want: number; tol: number }> = [
  {
    name: 'LM358 follower, 12 V rail, in=4.2',
    deck: ['vcc vcc 0 dc 12', 'vin in 0 dc 4.2', 'x1 in out out vcc 0 LM358'],
    node: 'out', want: 4.2, tol: 0.02,
  },
  {
    name: 'LM358 follower, 5 V rail, in=2',
    deck: ['vcc vcc 0 dc 5', 'vin in 0 dc 2', 'x1 in out out vcc 0 LM358'],
    node: 'out', want: 2, tol: 0.02,
  },
  {
    name: 'LM358 follower into 100 ohm',
    deck: ['vcc vcc 0 dc 12', 'vin in 0 dc 4', 'x1 in out out vcc 0 LM358', 'rl out 0 100'],
    node: 'out', want: 4, tol: 0.02,
  },
  {
    name: 'LM358 non-inverting gain of 2',
    deck: ['vcc vcc 0 dc 12', 'vin in 0 dc 1', 'x1 in fb out vcc 0 LM358', 'rf out fb 10k', 'rg fb 0 10k'],
    node: 'out', want: 2, tol: 0.02,
  },
  {
    name: 'LM358 inverting gain of -2 about a 6 V bias',
    deck: ['vcc vcc 0 dc 12', 'vb b 0 dc 6', 'vin in 0 dc 5', 'x1 b fb out vcc 0 LM358', 'r1 in fb 10k', 'rf fb out 20k'],
    node: 'out', want: 8, tol: 0.05,
  },
  {
    name: 'LM358 follower on a split supply',
    deck: ['vcc vcc 0 dc 12', 'vee vee 0 dc -12', 'vin in 0 dc -3', 'x1 in out out vcc vee LM358'],
    node: 'out', want: -3, tol: 0.02,
  },
  {
    name: 'LM358 as a comparator, output high (input saturated)',
    deck: ['vcc vcc 0 dc 12', 'vp p 0 dc 3', 'vn n 0 dc 2', 'x1 p n out vcc 0 LM358', 'rl out 0 10k'],
    node: 'out', want: 10.5, tol: 0.1,
  },
  {
    name: 'LM358 as a comparator, output low (input saturated)',
    deck: ['vcc vcc 0 dc 12', 'vp p 0 dc 1', 'vn n 0 dc 2', 'x1 p n out vcc 0 LM358', 'rl out 0 10k'],
    node: 'out', want: 0.01, tol: 0.02,
  },
  {
    name: 'LM393 with a 10k pull-up',
    deck: ['vcc vcc 0 dc 5', 'vp p 0 dc 3', 'vn n 0 dc 1', 'rpu vcc out 10k', 'x1 p n out vcc 0 LM393'],
    node: 'out', want: 5, tol: 0.05,
  },
]

describe.skipIf(!haveNgspice)('op-amp macromodel finds its operating point directly (issue #19)', () => {
  for (const c of OPAMP_CASES) {
    it(`${c.name}: method direct, out where it should be`, async () => {
      const r = await runOp(['* ' + c.name, ...c.deck, ...opampLib, '.end'])
      expectDirect(r, c.name)
      expect(Math.abs(r.v[c.node] - c.want), `${c.name}: v(${c.node})=${r.v[c.node]}`).toBeLessThan(c.tol)
    }, 60_000)
  }

  it('an unpowered op-amp parks its output near 0 V and still solves directly', async () => {
    const deck = ['* unpowered', 'vp p 0 dc 3', 'vn n 0 dc 2', 'x1 p n out 0 0 LM358', 'rl out 0 10k', ...opampLib, '.end']
    const r = await runOp(deck)
    expectDirect(r, 'unpowered LM358')
    expect(Math.abs(r.v['out'])).toBeLessThan(0.2)
  }, 60_000)

  it('a floating supply rail carries no draw: it is not dragged to an absurd voltage', async () => {
    // The rail is connected to nothing but the op-amp and the 1 Gohm bleed the
    // deck generator adds to every floating net. Without a rails-present gate the
    // quiescent current source alone would push this node to about -1e9 V.
    const deck = [
      '* floating rail', 'vin in 0 dc 1', 'x1 in out out rail 0 LM358', 'rl out 0 10k', 'r_float_1 rail 0 1e9',
      ...opampLib, '.end',
    ]
    const r = await runOp(deck)
    // The draw fades out as the rail falls (it balances the bleed at about -0.7 V).
    expect(Math.abs(r.v['rail'] ?? 0)).toBeLessThan(2)
  }, 60_000)
})

describe.skipIf(!haveNgspice)('NE555 finds its operating point directly (issue #19)', () => {
  const ctrlCap = 'cc ctrl 0 10n'

  it('astable (1k/10k/100n, 5 V): method direct, no singular-matrix warnings', async () => {
    const deck = [
      '* 555 astable', 'vcc vcc 0 dc 5', 'r1 vcc disch 1k', 'r2 disch thres 10k', 'c1 thres 0 100n', ctrlCap,
      'x1 0 thres out vcc ctrl thres disch vcc NE555', ...t555Lib, '.end',
    ]
    expectDirect(await runOp(deck), 'NE555 astable')
  }, 60_000)

  it('monostable at idle (trigger high, 10k/100n): method direct and the output idles low', async () => {
    const deck = [
      '* 555 monostable, idle', 'vcc vcc 0 dc 5', 'rtrig trig vcc 10k', 'r1 vcc thres 10k', 'c1 thres 0 100n', ctrlCap,
      'x1 0 trig out vcc ctrl thres thres vcc NE555', ...t555Lib, '.end',
    ]
    const r = await runOp(deck)
    expectDirect(r, 'NE555 monostable idle')
    expect(r.v['out']).toBeLessThan(0.5)
  }, 60_000)

  it('static bias (trigger and threshold at 1 V): method direct', async () => {
    const deck = [
      '* 555 static', 'vcc vcc 0 dc 5', 'x1 0 trig out vcc ctrl thres disch vcc NE555', 'vt trig 0 dc 1', 'vth thres 0 dc 1', ...t555Lib, '.end',
    ]
    expectDirect(await runOp(deck), 'NE555 static bias')
  }, 60_000)

  it('12 V astable: method direct', async () => {
    const deck = [
      '* 555 astable 12 V', 'vcc vcc 0 dc 12', 'r1 vcc disch 1k', 'r2 disch thres 10k', 'c1 thres 0 100n', ctrlCap,
      'x1 0 thres out vcc ctrl thres disch vcc NE555', ...t555Lib, '.end',
    ]
    expectDirect(await runOp(deck), 'NE555 astable 12 V')
  }, 60_000)
})

describe.skipIf(!haveNgspice)('linear regulator finds its operating point directly', () => {
  for (const [name, vin, load] of [
    ['7805', 12, 5],
    ['7805', 6.5, 50],
    ['AMS1117-3.3', 4.2, 36],
    ['AMS1117-3.3', 4.2, 3.3],
  ] as const) {
    it(`${name} from ${vin} V into ${load} ohm: method direct`, async () => {
      const deck = ['* reg', `vin vin 0 dc ${vin}`, `x1 vin 0 vout ${name}`, `rl vout 0 ${load}`, ...regLib, '.end']
      expectDirect(await runOp(deck), `${name} ${vin} V ${load} ohm`)
    }, 60_000)
  }
})

// ─── the shipped sample boards, through the real pipeline ────────────────────

function loadModelTexts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(MODELS)) {
    if ((f.endsWith('.lib') || f.endsWith('.json')) && f !== 'characterization.json') {
      out[f] = readFileSync(join(MODELS, f), 'utf8')
    }
  }
  return out
}

function sampleDeck(sample: {
  board: string
  schematic?: string
  supplyNet: string
  volts: number
}): string[] {
  const board = parseBoard(readFileSync(join(SAMPLES, sample.board), 'utf8'))
  const schData = sample.schematic
    ? parseSchematicSimData(readFileSync(join(SAMPLES, sample.schematic), 'utf8'))
    : undefined
  const gnd = suggestGround(extract(board).nets)
  if (!gnd) throw new Error('no ground suggested')
  const circuit = extract(board, { groundNetId: gnd.id })
  const library = (
    JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }
  ).entries
  const resolutions = resolveAll(circuit, schData, undefined, library)
  const supply = circuit.nets.find((n) => n.kicadName === sample.supplyNet)
  if (!supply) throw new Error(`net ${sample.supplyNet} not found`)
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd.id },
    { kind: 'dc-supply', id: 'bench', netId: supply.id, volts: sample.volts, seriesOhms: 0.1 },
  ]
  return generateDeck({
    circuit, resolutions, instruments, groundNetId: gnd.id, title: 'sample', modelTexts: loadModelTexts(),
  })
}

describe.skipIf(!haveNgspice)('the shipped sample boards open without a solver fallback (issue #19)', () => {
  it('blinker-555 (the Open sample project board): method direct, no singular-matrix warnings', async () => {
    const r = await runOp(
      sampleDeck({ board: 'blinker-555.kicad_pcb', schematic: 'blinker-555.kicad_sch', supplyNet: 'VCC', volts: 5 }),
    )
    expectDirect(r, 'blinker-555 sample')
  }, 60_000)

  it('first-light: method direct', async () => {
    const r = await runOp(sampleDeck({ board: 'first-light.kicad_pcb', supplyNet: 'VIN', volts: 5 }))
    expectDirect(r, 'first-light sample')
  }, 60_000)
})

// ─── the shipped 555 sample through Run, at the steps the bench picks ─────────

/** One `tran <tstep> <tstop> uic` through the real SimHost, the bench's start. */
async function runTran(
  deck: string[],
  tstep: number,
  tstop: number,
): Promise<{ t: Float64Array; out: Float64Array; trouble: string[] }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    await host.loadCircuit(deck)
    const r = await host.runTran(tstep, tstop)
    const trouble = events
      .filter((e): e is Extract<SimEvent, { type: 'log' }> => e.type === 'log')
      .filter((e) => e.level === 'error' || /timestep too small|aborted/i.test(e.text))
      .map((e) => e.text)
    return { t: r.time, out: r.vectors['out'] ?? new Float64Array(0), trouble }
  } finally {
    await host.dispose()
  }
}

/**
 * The deck with every `.save` line replaced by one `.save` of the given
 * vectors, so a long transient keeps only what the caller reads in ngspice's
 * memory (the scale vector is always kept). Numerics are unaffected.
 */
function saveOnly(deck: string[], vectors: string[]): string[] {
  const at = deck.findIndex((l) => /^\.save\s/i.test(l))
  if (at < 0) throw new Error('deck has no .save line to replace')
  const rest = deck.filter((l) => !/^\.save\s/i.test(l))
  // Keep the .save where the first one was (before .end), now one line.
  const insertAt = deck.slice(0, at).filter((l) => !/^\.save\s/i.test(l)).length
  rest.splice(insertAt, 0, `.save ${vectors.join(' ')}`)
  return rest
}

describe.skipIf(!haveNgspice)('the shipped blinker-555 sample runs at fine solver steps (review of PR #118)', () => {
  // A function generator above 500 Hz sets the step below 10 us. With a smooth
  // regenerative latch memory the sample aborted with "Timestep too small ...
  // trouble with node x_u1.q" at its first THRES crossing (0.626 s, 2 us steps)
  // or its second (1.347 s, 5 us steps): THRES creeps through the comparator
  // band at about 3 V/s, the latch branch folded, and Newton could not step past
  // the fold. Each run covers the crossing that failed.
  //
  // The test reads only the scale and `out`, so the deck saves only `out`. The
  // generated deck says `.save all` plus a branch current per device, which at
  // 280k points (5 us over 1.4 s) is 25 vectors of doubles that ngspice grows
  // point by point. On the macOS CI runners that run aborted with ngspice's
  // "Error: memory required (Id Bytes)" / "cannot recover and awaits to be reset
  // or detached" (the %Id is an unexpanded MSVC size_t format, so the byte count
  // is not printed), and the same file's 2 us run before it had already left
  // about 290 MB resident in the worker (measured on Windows: RSS 87 MB before
  // the first run, 289 MB after its dispose, 466 MB at the end of the second).
  // Windows and Linux ride that out; macOS does not. One saved vector is about
  // 1/25 of that, and the step, the stop time and the edge assertions are unchanged.
  const deck = haveNgspice
    ? saveOnly(
        sampleDeck({ board: 'blinker-555.kicad_pcb', schematic: 'blinker-555.kicad_sch', supplyNet: 'VCC', volts: 5 }),
        ['out'],
      )
    : []
  // From a discharged 10 uF: high for ln(3)*(10k+47k)*10u = 0.626 s, then low for
  // ln(2)*47k*10u = 0.326 s and high for ln(2)*57k*10u = 0.395 s.
  const nominal = [
    { at: 0.626, rising: false },
    { at: 0.952, rising: true },
    { at: 1.347, rising: false },
  ]
  for (const [tstep, tstop, label] of [
    [2e-6, 0.7, '2 us'],
    [5e-6, 1.4, '5 us'],
  ] as const) {
    it(`${label} steps: runs through the THRES crossings, edges on the RC timing`, async () => {
      const r = await runTran(deck, tstep, tstop)
      expect(r.trouble, `${label}: solver trouble`).toEqual([])
      expect(r.t[r.t.length - 1], `${label}: ran to the end`).toBeGreaterThan(tstop * 0.999)
      const edges: Array<{ at: number; rising: boolean }> = []
      for (let i = 1; i < r.out.length; i++) {
        // Skip the power-on rise; count each crossing of half the rail once.
        if (r.t[i] > 1e-3 && r.out[i - 1] < 2.5 !== r.out[i] < 2.5) edges.push({ at: r.t[i], rising: r.out[i] >= 2.5 })
      }
      const want = nominal.filter((e) => e.at < tstop)
      expect(edges.map((e) => e.rising), `${label}: edge directions`).toEqual(want.map((e) => e.rising))
      edges.forEach((e, i) => {
        expect(Math.abs(e.at - want[i].at) / want[i].at, `${label}: edge ${i} at ${e.at.toFixed(4)} s`).toBeLessThan(0.02)
      })
    }, 240_000)
  }
})
