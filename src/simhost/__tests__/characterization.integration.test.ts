/**
 * src/simhost/__tests__/characterization.integration.test.ts
 *
 * Datasheet characterization gate for the bundled model library (issue #21).
 *
 * The rows live in resources/models/characterization.json, next to index.json.
 * Every row names an index.json entry, a bias circuit, one measured quantity,
 * the datasheet value (typical and/or min/max), a tolerance, and its source.
 * Each row is executed in the REAL libngspice (the same SimHost harness the
 * other integration suites use) and compared with the datasheet band. The
 * whole table is printed at the end so a reviewer can read it in one place.
 *
 * Run with `npm run test:characterization`. Also picked up by
 * `npm run test:integration` (the file name ends in .integration.test).
 *
 * knownFailing: a row whose measured value is outside the datasheet band
 * because of a known model defect carries `"knownFailing": "#N"` (the tracking
 * issue). Such a row is reported as KNOWN and does not fail the suite. The
 * moment the model is fixed the row measures inside the band, the test fails
 * with "remove knownFailing", so an expected failure can never rot into a
 * permanent excuse. An ngspice error log always fails a row, known or not.
 *
 * Row setups:
 *   - "deck":  raw SPICE lines. "{{model}}" is replaced by the entry's model
 *              name; the entry's whole library file is appended, exactly as the
 *              deck generator inlines it.
 *   - "logic": an xspice-digital entry driven through the REAL generateDeck
 *              (synthetic Circuit, logic-input / function-gen / dc-supply
 *              instruments), so the shipped family templates are what is
 *              measured, not a hand-rolled copy.
 *
 * Transient rows start from the UIC initial conditions by default (the same
 * way the live bench does). A row that needs a settled DC start (op-amp step
 * response) sets "uic": false so ngspice solves the operating point first.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { normalizeVectorKey, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS = join(process.cwd(), 'resources', 'models')

// --- data schema -------------------------------------------------------------

interface Band {
  typ?: number
  abs?: number
  rel?: number
  min?: number
  max?: number
}

type Measure =
  | { expr: string; at?: number }
  | { stat: 'period' | 'dutyPct'; node: string; threshold: number }
  | { stat: 'maxSlope'; node: string; from?: number; to?: number }
  | { stat: 'riseTime'; node: string; from: number }
  | {
      /**
       * Propagation delay: the first `edge` crossing of `threshold` on `node`
       * after `after`, minus the nearest crossing (either direction) of
       * `refThreshold` on `ref`. Signed.
       */
      stat: 'delay'
      node: string
      threshold: number
      ref: string
      refThreshold: number
      edge: 'rise' | 'fall'
      after: number
    }

interface DeckSetup {
  kind: 'deck'
  deck: string[]
}

interface LogicSetup {
  kind: 'logic'
  /** Supply volts on the VCC pin. */
  vcc: number
  /** Static input levels by template signal name; unlisted inputs are low. */
  inputs?: Record<string, 0 | 1>
  /** Square-wave clocks by template signal name, in Hz. */
  clocks?: Record<string, number>
  /** Resistive loads from an output signal to ground, in ohms. */
  loadsOhms?: Record<string, number>
}

interface Row {
  id: string
  entry: string
  quantity: string
  unit: string
  setup: DeckSetup | LogicSetup
  analysis: { type: 'op' } | { type: 'tran'; step: string; stop: string; uic?: boolean }
  measure: Measure
  expect: Band
  source: string
  knownFailing?: string
  note?: string
}

interface IndexEntry {
  id: string
  model: { type: string; file?: string; name: string }
  pinMaps?: Record<string, Record<string, string>>
  defaultPinMap?: Record<string, string>
}

interface LogicTemplate {
  inputs: string[]
  outputs: string[]
}

const rows: Row[] = haveNgspice
  ? (JSON.parse(readFileSync(join(MODELS, 'characterization.json'), 'utf8')).rows as Row[])
  : []
const index: IndexEntry[] = haveNgspice
  ? (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')).entries as IndexEntry[])
  : []
const entryById = new Map(index.map((e) => [e.id, e]))

const fileCache = new Map<string, string>()
function readModelFile(name: string): string {
  let t = fileCache.get(name)
  if (t === undefined) {
    t = readFileSync(join(MODELS, name), 'utf8')
    fileCache.set(name, t)
  }
  return t
}

// --- band + expression helpers ----------------------------------------------

function bandRange(b: Band): [number, number] {
  if (b.min !== undefined || b.max !== undefined) {
    return [b.min ?? -Infinity, b.max ?? Infinity]
  }
  if (b.typ === undefined) throw new Error('band needs typ or min/max')
  if (b.abs !== undefined) return [b.typ - b.abs, b.typ + b.abs]
  if (b.rel !== undefined) {
    const d = Math.abs(b.typ) * b.rel
    return [b.typ - d, b.typ + d]
  }
  throw new Error('band with typ needs abs or rel')
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const a = Math.abs(n)
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return n.toExponential(4)
  return n.toPrecision(5)
}

/**
 * Evaluate an arithmetic expression over v(node) and i(source) tokens.
 * Only digits, operators, parentheses and abs( survive the substitution, so a
 * malformed data file cannot execute anything.
 */
function evalExpr(expr: string, lookup: (key: string) => number): number {
  const sub = expr
    .replace(/\bv\(([^)]+)\)/gi, (_m, n: string) => `(${lookup(n.trim().toLowerCase())})`)
    .replace(/\bi\(([^)]+)\)/gi, (_m, n: string) => `(${lookup(`i(${n.trim().toLowerCase()})`)})`)
    .replace(/\babs\(/g, 'Math.abs(')
  const stripped = sub.replace(/Math\.abs/g, '')
  if (!/^[0-9eE+\-*/().\sNaInfity]*$/.test(stripped)) {
    throw new Error(`unsafe characterization expression: ${expr}`)
  }
  // eslint-disable-next-line no-new-func
  const v = new Function(`return (${sub})`)() as number
  return v
}

// --- engine runners ----------------------------------------------------------

interface RunResult {
  errs: string[]
  op: Record<string, number>
  series: Record<string, number[]>
  t: number[]
}

function errorLogs(events: SimEvent[]): string[] {
  return (
    events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
      SimEvent,
      { type: 'log' }
    >[]
  ).map((e) => e.text)
}

async function runOp(deck: string[]): Promise<RunResult> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const op = await host.runOp()
    return { errs: errorLogs(events), op, series: {}, t: [] }
  } finally {
    await host.dispose()
  }
}

async function runTran(
  deck: string[],
  tstep: string,
  tstop: string,
  uic: boolean
): Promise<RunResult> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (host as any).engine
    await engine.command(`tran ${tstep} ${tstop}${uic ? ' uic' : ''}`, true)
    const series: Record<string, number[]> = {}
    let t: number[] = []
    const plot = engine.currentPlot()
    for (const name of engine.allVectors(plot)) {
      const d = engine.vectorData(name)
      if (d && d.length) {
        const key = normalizeVectorKey(name)
        series[key] = Array.from(d)
        if (key === 'time') t = Array.from(d)
      }
    }
    return { errs: errorLogs(events), op: {}, series, t }
  } finally {
    await host.dispose()
  }
}

// --- deck construction -------------------------------------------------------

function buildRawDeck(row: Row, entry: IndexEntry, setup: DeckSetup): string[] {
  const model = entry.model
  const lib = model.file ? readModelFile(model.file).split(/\r?\n/) : []
  const body = setup.deck.map((l) => l.replace(/\{\{model\}\}/g, model.name))
  const deck = [`* characterization ${row.id}`, ...body, ...lib]
  if (row.analysis.type === 'op') deck.push('.op')
  deck.push('.end')
  return deck
}

/** Build a generateDeck deck for an xspice-digital entry (the shipped path). */
function buildLogicDeck(row: Row, entry: IndexEntry, setup: LogicSetup): string[] {
  const file = entry.model.file as string
  const family = JSON.parse(readModelFile(file)) as {
    templates: Record<string, LogicTemplate>
  }
  const tpl = family.templates[entry.model.name]
  if (!tpl) throw new Error(`${row.id}: template ${entry.model.name} missing in ${file}`)
  const pinMap =
    entry.defaultPinMap ?? (entry.pinMaps ? Object.values(entry.pinMaps)[0] : undefined)
  if (!pinMap) throw new Error(`${row.id}: entry ${entry.id} has no pin map`)

  const nets: CircuitNet[] = []
  const netOf = new Map<string, number>()
  const ensureNet = (name: string, spiceNode: string): number => {
    let id = netOf.get(name)
    if (id === undefined) {
      id = nets.length + 1
      netOf.set(name, id)
      nets.push({ id, kicadName: name.toUpperCase(), spiceNode, padRefs: [] })
    }
    return id
  }
  const gndId = ensureNet('GND', '0')
  const vccId = ensureNet('VCC', 'vdd')

  const padNet = new Map<string, number>()
  const parts: Part[] = []
  const resolutions: Resolution[] = []
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gndId },
    { kind: 'dc-supply', id: 'vcc', netId: vccId, volts: setup.vcc, seriesOhms: 0.001 }
  ]

  const sigNames = new Set<string>([...tpl.inputs, ...tpl.outputs])
  let idc = 0
  for (const [pad, sig] of Object.entries(pinMap)) {
    if (sig === 'GND') padNet.set(pad, gndId)
    else if (sig === 'VCC') padNet.set(pad, vccId)
    else if (sigNames.has(sig)) padNet.set(pad, ensureNet(sig, sig.toLowerCase()))
  }
  for (const sig of tpl.inputs) {
    const netId = netOf.get(sig)
    if (netId === undefined) continue
    const clk = setup.clocks?.[sig]
    idc++
    if (clk !== undefined) {
      instruments.push({
        kind: 'function-gen',
        id: `clk${idc}`,
        netId,
        wave: 'square',
        freqHz: clk,
        amplitudeV: setup.vcc / 2,
        offsetV: setup.vcc / 2,
        outputOhms: 1
      })
    } else {
      instruments.push({
        kind: 'logic-input',
        id: `in${idc}`,
        netId,
        level: setup.inputs?.[sig] ?? 0,
        vHigh: setup.vcc
      })
    }
  }
  parts.push({
    ref: 'U1',
    value: entry.model.name,
    libId: `Logic:${entry.model.name}`,
    layer: 'F',
    padNet,
    properties: {}
  })
  resolutions.push({
    ref: 'U1',
    status: 'ok',
    tier: 3,
    warnings: [],
    model: { kind: 'xspice-digital', templateId: entry.model.name, pinMap }
  })
  let li = 0
  for (const [sig, ohms] of Object.entries(setup.loadsOhms ?? {})) {
    const netId = netOf.get(sig)
    if (netId === undefined) throw new Error(`${row.id}: load on unwired signal ${sig}`)
    li++
    parts.push({
      ref: `R${li}`,
      value: String(ohms),
      libId: 'R',
      layer: 'F',
      padNet: new Map([
        ['1', netId],
        ['2', gndId]
      ]),
      properties: {}
    })
    resolutions.push({
      ref: `R${li}`,
      status: 'ok',
      tier: 2,
      warnings: [],
      model: { kind: 'primitive', card: `r_load${li} ${sig.toLowerCase()} 0 ${ohms}` }
    })
  }
  const circuit: Circuit = { nets, parts, warnings: [] }
  return generateDeck({
    circuit,
    resolutions,
    instruments,
    groundNetId: gndId,
    title: `characterization ${row.id}`,
    modelTexts: { [file]: readModelFile(file) }
  })
}

// --- measurement -------------------------------------------------------------

function nearestIndex(t: number[], at: number): number {
  let best = 0
  let bestErr = Infinity
  for (let i = 0; i < t.length; i++) {
    const e = Math.abs(t[i] - at)
    if (e < bestErr) {
      bestErr = e
      best = i
    }
  }
  return best
}

function risingEdges(v: number[], t: number[], threshold: number): number[] {
  const edges: number[] = []
  for (let i = 1; i < v.length; i++) {
    if (v[i - 1] < threshold && v[i] >= threshold) {
      const f = (threshold - v[i - 1]) / (v[i] - v[i - 1])
      edges.push(t[i - 1] + f * (t[i] - t[i - 1]))
    }
  }
  return edges
}

function crossings(v: number[], t: number[], threshold: number, edge: 'rise' | 'fall' | 'any') {
  const out: number[] = []
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1] - threshold
    const b = v[i] - threshold
    const rise = a < 0 && b >= 0
    const fall = a > 0 && b <= 0
    if ((edge !== 'fall' && rise) || (edge !== 'rise' && fall)) {
      const f = a / (a - b)
      out.push(t[i - 1] + f * (t[i] - t[i - 1]))
    }
  }
  return out
}

function measure(row: Row, r: RunResult): number {
  const m = row.measure
  if ('expr' in m) {
    if (row.analysis.type === 'op') {
      return evalExpr(m.expr, (k) => {
        const x = r.op[k]
        if (x === undefined) throw new Error(`${row.id}: op has no vector ${k}`)
        return x
      })
    }
    const i = m.at === undefined ? r.t.length - 1 : nearestIndex(r.t, m.at)
    return evalExpr(m.expr, (k) => {
      const s = r.series[k]
      if (!s) throw new Error(`${row.id}: tran has no vector ${k}`)
      return s[i]
    })
  }
  const v = r.series[m.node.toLowerCase()]
  if (!v || r.t.length === 0) throw new Error(`${row.id}: tran has no vector ${m.node}`)
  if (m.stat === 'delay') {
    const ref = r.series[m.ref.toLowerCase()]
    if (!ref) throw new Error(`${row.id}: tran has no vector ${m.ref}`)
    const tOut = crossings(v, r.t, m.threshold, m.edge).find((x) => x > m.after)
    if (tOut === undefined) return NaN
    const tRef = crossings(ref, r.t, m.refThreshold, 'any')
    if (tRef.length === 0) return NaN
    // The reference crossing nearest the output edge; the sign is kept so a
    // zero-delay model (the Schmitt gates) can land a few picoseconds early.
    let nearest = tRef[0]
    for (const x of tRef) if (Math.abs(x - tOut) < Math.abs(nearest - tOut)) nearest = x
    return tOut - nearest
  }
  if (m.stat === 'period' || m.stat === 'dutyPct') {
    const edges = risingEdges(v, r.t, m.threshold)
    if (edges.length < 4) return NaN
    // Skip the first period: the start-up cycle includes the timing cap charging from zero.
    const first = edges[1]
    const last = edges[edges.length - 1]
    if (m.stat === 'period') return (last - first) / (edges.length - 2)
    let high = 0
    for (let i = 1; i < v.length; i++) {
      if (r.t[i] <= first || r.t[i - 1] >= last) continue
      if (v[i] >= m.threshold) high += r.t[i] - r.t[i - 1]
    }
    return (100 * high) / (last - first)
  }
  if (m.stat === 'maxSlope') {
    const from = m.from ?? -Infinity
    const to = m.to ?? Infinity
    let best = 0
    for (let i = 1; i < v.length; i++) {
      if (r.t[i - 1] < from || r.t[i] > to) continue
      const dt = r.t[i] - r.t[i - 1]
      if (dt <= 0) continue
      best = Math.max(best, Math.abs((v[i] - v[i - 1]) / dt))
    }
    return best
  }
  // riseTime: 10 to 90 percent of the swing between the value at `from` and the last sample.
  const rise = m as Extract<Measure, { stat: 'riseTime' }>
  const i0 = nearestIndex(r.t, rise.from)
  const v0 = v[i0]
  const v1 = v[v.length - 1]
  const lo = v0 + 0.1 * (v1 - v0)
  const hi = v0 + 0.9 * (v1 - v0)
  const cross = (level: number): number => {
    for (let i = i0 + 1; i < v.length; i++) {
      const a = v[i - 1] - level
      const b = v[i] - level
      if (a === 0 || a * b < 0) {
        const f = a / (a - b)
        return r.t[i - 1] + f * (r.t[i] - r.t[i - 1])
      }
    }
    return NaN
  }
  return cross(hi) - cross(lo)
}

// --- result table ------------------------------------------------------------

interface Outcome {
  id: string
  entry: string
  quantity: string
  unit: string
  measured: number
  lo: number
  hi: number
  status: 'PASS' | 'KNOWN' | 'FAIL'
  knownFailing?: string
}
const outcomes: Outcome[] = []

async function execute(row: Row): Promise<RunResult> {
  const entry = entryById.get(row.entry)
  if (!entry) throw new Error(`${row.id}: unknown index entry ${row.entry}`)
  const deck =
    row.setup.kind === 'deck'
      ? buildRawDeck(row, entry, row.setup)
      : buildLogicDeck(row, entry, row.setup)
  return row.analysis.type === 'op'
    ? runOp(deck)
    : runTran(deck, row.analysis.step, row.analysis.stop, row.analysis.uic ?? true)
}

// --- tests -------------------------------------------------------------------

describe.skipIf(!haveNgspice)('characterization matrix: schema and coverage', () => {
  it('every row is well formed and names a real index entry', () => {
    const ids = new Set<string>()
    for (const row of rows) {
      expect(ids.has(row.id), `duplicate row id ${row.id}`).toBe(false)
      ids.add(row.id)
      expect(entryById.has(row.entry), `${row.id}: unknown entry ${row.entry}`).toBe(true)
      expect(row.source.length, `${row.id}: source required`).toBeGreaterThan(10)
      expect(row.unit.length, `${row.id}: unit required`).toBeGreaterThan(0)
      expect(() => bandRange(row.expect), `${row.id}: band`).not.toThrow()
      if (row.knownFailing !== undefined) {
        expect(row.knownFailing, `${row.id}: knownFailing must be "#N"`).toMatch(/^#\d+$/)
      }
    }
  })

  it('every non-open index entry has at least one row', () => {
    const covered = new Set(rows.map((r) => r.entry))
    const missing = index
      .filter((e) => e.model.type !== 'documented-open')
      .filter((e) => !covered.has(e.id))
      .map((e) => e.id)
    expect(missing, `entries without a characterization row: ${missing.join(', ')}`).toEqual([])
  })

  it('zeners are measured in reverse breakdown, not only forward', () => {
    for (const id of ['zener-5v1', 'zener-3v0', 'tvs-smaj24a']) {
      const reverse = rows.filter(
        (r) => r.entry === id && r.setup.kind === 'deck' && r.setup.deck.some((l) => /^i1 a 0/.test(l))
      )
      expect(reverse.length, `${id} needs a reverse-bias row`).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(!haveNgspice)('characterization matrix: datasheet rows in real ngspice', () => {
  for (const row of rows) {
    it(`${row.entry} ${row.quantity} [${row.id}]`, async () => {
      const r = await execute(row)
      expect(r.errs, `${row.id}: ngspice error log`).toEqual([])
      const measured = measure(row, r)
      const [lo, hi] = bandRange(row.expect)
      const inBand = Number.isFinite(measured) && measured >= lo && measured <= hi
      const status: Outcome['status'] = inBand ? 'PASS' : row.knownFailing ? 'KNOWN' : 'FAIL'
      outcomes.push({
        id: row.id,
        entry: row.entry,
        quantity: row.quantity,
        unit: row.unit,
        measured,
        lo,
        hi,
        status,
        knownFailing: row.knownFailing
      })
      if (inBand && row.knownFailing) {
        throw new Error(
          `${row.id} now measures ${fmt(measured)} ${row.unit} inside [${fmt(lo)}, ${fmt(hi)}]: ` +
            `remove knownFailing ${row.knownFailing}`
        )
      }
      if (!inBand && !row.knownFailing) {
        throw new Error(
          `${row.id}: ${row.quantity} measured ${fmt(measured)} ${row.unit}, ` +
            `datasheet band [${fmt(lo)}, ${fmt(hi)}] (${row.source})`
        )
      }
    }, 90_000)
  }

  afterAll(() => {
    if (outcomes.length === 0) return
    const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
    const lines = outcomes.map(
      (o) =>
        `${pad(o.status, 5)} ${pad(o.id, 34)} ${pad(fmt(o.measured) + ' ' + o.unit, 18)} ` +
        `band [${fmt(o.lo)}, ${fmt(o.hi)}]${o.knownFailing ? ' known ' + o.knownFailing : ''}`
    )
    const count = (s: Outcome['status']): number => outcomes.filter((o) => o.status === s).length
    // eslint-disable-next-line no-console
    console.log(
      `\n=== characterization: ${count('PASS')} pass, ${count('KNOWN')} known-failing, ` +
        `${count('FAIL')} fail of ${outcomes.length} rows ===\n${lines.join('\n')}\n`
    )
  })
})
