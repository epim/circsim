/**
 * Fidelity claims and their gates (issue #68).
 *
 * website/docs/concepts/fidelity.md promises numbers. Each promise is held by
 * a gate: a datasheet row in resources/models/characterization.json (run in
 * real ngspice by characterization.integration.test.ts) or a named test file.
 * These tests keep the page and the gates in step without ngspice:
 *
 *   1. Every backticked row id or test file in the page's "Where each claim is
 *      checked" section exists, and no cited row is a silent knownFailing
 *      unless the page says it is (the two #136 flip-flop rows).
 *   2. The tolerance each row enforces is no looser than the figure the page
 *      states, so loosening a band in the JSON fails here and forces the page
 *      to be softened in the same change.
 *   3. No deck the generator emits carries a temperature card, which is what
 *      the page's "fixed 27 C" sentence rests on.
 *   4. The trace resistance figure on the page is the one the critic computes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { trackResistanceOhms } from '../../core/critic/geom'

const ROOT = join(__dirname, '../../..')
const PAGE = readFileSync(join(ROOT, 'website/docs/concepts/fidelity.md'), 'utf8').replace(/\r\n/g, '\n')

interface Band {
  typ?: number
  abs?: number
  rel?: number
  min?: number
  max?: number
}
interface Row {
  id: string
  expect: Band
  knownFailing?: string
}
const rows = (
  JSON.parse(readFileSync(join(ROOT, 'resources/models/characterization.json'), 'utf8')) as {
    rows: Row[]
  }
).rows
const rowById = new Map(rows.map((r) => [r.id, r]))

function section(): string {
  const start = PAGE.indexOf('## Where each claim is checked')
  const end = PAGE.indexOf('\n## ', start + 1)
  expect(start).toBeGreaterThan(-1)
  return PAGE.slice(start, end)
}

function citedTokens(): string[] {
  return [...section().matchAll(/`([^`]+)`/g)].map((m) => m[1])
}

function allTestFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'golden') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) allTestFiles(p, out)
    else if (/\.test\.tsx?$/.test(name)) out.push(name)
  }
  return out
}

/** Half width of a band as a fraction of typ (rel bands) or absolute (abs, min/max). */
function halfWidth(b: Band): { abs: number; rel: number } {
  if (b.min !== undefined || b.max !== undefined) {
    const half = ((b.max ?? Infinity) - (b.min ?? -Infinity)) / 2
    const mid = ((b.max ?? 0) + (b.min ?? 0)) / 2
    return { abs: half, rel: mid === 0 ? Infinity : half / Math.abs(mid) }
  }
  const typ = b.typ as number
  if (b.abs !== undefined) return { abs: b.abs, rel: b.abs / Math.abs(typ) }
  return { abs: (b.rel as number) * Math.abs(typ), rel: b.rel as number }
}

describe('fidelity page cites real gates', () => {
  const tokens = citedTokens()
  const files = new Set(allTestFiles(join(ROOT, 'src')))

  it('cites at least the gates the issue names', () => {
    for (const id of [
      'timer-ne555-period-5v',
      'timer-ne555-duty',
      'logic-74hc00-tpd-rise',
      'opamp-lm358-supply-series-drop',
      'reg-ams1117-3v3-liion-90ma',
      'led-red-vf-10ma'
    ]) {
      expect(tokens, id).toContain(id)
    }
  })

  it('every cited token is a characterization row or an existing test file', () => {
    for (const t of tokens) {
      if (/\.test\.tsx?$/.test(t)) {
        expect(files.has(t), `${t} is not a test file under src/`).toBe(true)
      } else if (t.includes('/') || t.startsWith('npm run ')) {
        continue
      } else {
        expect(rowById.has(t), `${t} is not a characterization row`).toBe(true)
      }
    }
  })

  it('only the #136 flip-flop rows are cited while known failing', () => {
    const failing = tokens.filter((t) => rowById.get(t)?.knownFailing).sort()
    expect(failing).toEqual(['logic-74hc164-tpd-clk-q0', 'logic-74hc74-tpd-clk-q'])
    for (const id of failing) expect(rowById.get(id)?.knownFailing).toBe('#136')
    expect(PAGE).toContain('#136')
  })
})

describe('gate tolerances are no looser than the page states', () => {
  const rel = (ids: string[], max: number): [string[], 'rel', number] => [ids, 'rel', max]
  const abs = (ids: string[], max: number): [string[], 'abs', number] => [ids, 'abs', max]

  const hc = ['00', '04', '08', '32', '86'].flatMap((n) => [
    `logic-74hc${n}-tpd-rise`,
    `logic-74hc${n}-tpd-fall`
  ])

  const gates: [string[], 'rel' | 'abs', number][] = [
    // "within 3 percent" and "within 2 percentage points"
    rel(['timer-ne555-period-5v', 'timer-ne555-period-12v'], 0.03),
    abs(['timer-ne555-duty'], 2),
    // "within 25 percent" (74HC) and "within 10 percent" (CD4011)
    rel(hc, 0.25),
    rel(['logic-cd4011-tpd-rise', 'logic-cd4011-tpd-fall'], 0.1),
    // "no propagation delay": within 2 ns (74HC14) and 5 ns (CD40106)
    abs(['logic-74hc14-tpd-rise', 'logic-74hc14-tpd-fall'], 2e-9),
    abs(['logic-cd40106-tpd-rise', 'logic-cd40106-tpd-fall'], 5e-9),
    // "within 5 percent" and "within 10 percent"
    rel(['opamp-lm358-slew', 'opamp-tl072-slew', 'opamp-lm358-risetime'], 0.05),
    rel(['opamp-lm358-comparator-crossing'], 0.1),
    // "14 to 20 mV"
    abs(['opamp-lm358-vol'], 0.003),
    // "within 2 percent"
    rel(
      [
        'opamp-lm358-icc-sourcing-40ma',
        'timer-ne555-icc-loaded',
        'logic-74hc00-icc-loaded',
        'logic-74hc14-icc-loaded',
        'logic-cd4011-icc-loaded',
        'logic-cd40106-icc-loaded'
      ],
      0.02
    ),
    rel(['opamp-lm358-supply-series-drop'], 0.03),
    // "within 0.1 V" for the 78xx, "within 0.05 V" for the AMS1117 and the Li-ion case
    abs(
      [
        'reg-7805-dropout-100ma',
        'reg-7805-dropout-1a',
        'reg-7812-dropout-100ma',
        'reg-7812-dropout-1a',
        'reg-7833-dropout-100ma',
        'reg-7833-dropout-1a'
      ],
      0.1
    ),
    abs(
      [
        'reg-ams1117-3v3-dropout-100ma',
        'reg-ams1117-3v3-dropout-1a',
        'reg-ams1117-5v0-dropout-100ma',
        'reg-ams1117-5v0-dropout-1a',
        'reg-ams1117-3v3-liion-90ma'
      ],
      0.05
    ),
    // "within 0.05 V" for the LED typicals at 10 mA
    abs(['led-red-vf-10ma', 'led-green-vf-10ma', 'led-blue-vf-10ma', 'led-white-vf-10ma'], 0.05)
  ]

  for (const [ids, kind, max] of gates) {
    for (const id of ids) {
      it(`${id} holds ${kind} <= ${max}`, () => {
        const row = rowById.get(id)
        expect(row, `${id} missing from characterization.json`).toBeDefined()
        const w = halfWidth((row as Row).expect)
        expect(w[kind]).toBeLessThanOrEqual(max * (1 + 1e-9))
      })
    }
  }
})

describe('the fixed 27 C statement', () => {
  it('no whole-deck golden carries a temperature card, option or sweep', () => {
    const dir = join(ROOT, 'src/core/spicegen/__tests__/golden')
    const decks = readdirSync(dir).filter((f) => f.startsWith('deck-'))
    expect(decks.length).toBeGreaterThan(0)
    for (const f of decks) {
      const text = readFileSync(join(dir, f), 'utf8')
      expect(text, f).not.toMatch(/^\s*\.temp\b/im)
      expect(text, f).not.toMatch(/\b(temp|tnom)\s*=/i)
      expect(text, f).not.toMatch(/^\s*\.step\b[^\n]*\btemp\b/im)
    }
  })

  it('the page states 27 C', () => {
    expect(PAGE).toContain('fixed 27 °C')
  })
})

describe('the trace resistance figure', () => {
  it('a 5 cm, 0.25 mm trace on 1 oz copper is about 0.1 ohm, as the page says', () => {
    expect(PAGE).toContain('5 cm, 0.25 mm trace on 1 oz copper is about 0.1 Ω')
    expect(trackResistanceOhms(50, 0.25, 1)).toBeCloseTo(0.1, 1)
  })
})
