/**
 * Property tests for the KiCad S-expression parser (issue #67).
 *
 * The example tests in parse.test.ts pin 30-odd literal inputs. These generate
 * the input space instead: arbitrary nested lists of numbers, quoted strings
 * (any characters, including quotes, backslashes, newlines, parens) and bare
 * symbols, printed back to text with random whitespace, then parsed.
 *
 * Properties:
 *   1. parse(print(x)) equals x
 *   2. inserting extra whitespace or comments between tokens changes nothing
 *   3. parse only ever throws SexprError, with a 1-based line and column
 *   4. removing the final ')' of a printed list, or adding one, always throws
 */

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseSexpr, SexprError, type SExpr } from '../parse'

// --- generators --------------------------------------------------------------

const NUMERIC_LOOKING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A bare symbol the tokeniser keeps as a string: no specials, not number-shaped. */
const bareSymbol = fc
  .stringMatching(/^[A-Za-z_.:*#@][A-Za-z0-9_.:*#@+-]{0,11}$/)
  .filter((s) => !NUMERIC_LOOKING.test(s))

/** Any string, printed quoted. Includes quotes, backslashes, parens, newlines. */
const quotedString = fc.string({ unit: 'binary', maxLength: 24 })

/** Finite doubles that survive String(n) and the parser's numeric regex. */
const finiteNumber = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .filter((n) => !Object.is(n, -0))

type Atom = { kind: 'bare'; v: string } | { kind: 'str'; v: string } | { kind: 'num'; v: number }

const atomArb: fc.Arbitrary<Atom> = fc.oneof(
  bareSymbol.map((v) => ({ kind: 'bare' as const, v })),
  quotedString.map((v) => ({ kind: 'str' as const, v })),
  finiteNumber.map((v) => ({ kind: 'num' as const, v }))
)

type Tree = Atom | { kind: 'list'; items: Tree[] }

const treeArb: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree; list: Tree }>((tie) => ({
  tree: fc.oneof({ depthSize: 'small' }, atomArb, tie('list')),
  list: fc.record({
    kind: fc.constant('list' as const),
    items: fc.array(tie('tree'), { maxLength: 5 })
  })
})).tree

const wsArb = fc.constantFrom(' ', '\t', '\n', '\r\n', '  ', ' ; note\n')

function toValue(t: Tree): SExpr {
  if (t.kind === 'list') return t.items.map(toValue)
  return t.v
}

function escapeString(s: string): string {
  let out = ''
  for (const c of s) {
    if (c === '"') out += '\\"'
    else if (c === '\\') out += '\\\\'
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return out
}

/** Print with a separator drawn from `seps` between every pair of adjacent tokens. */
function printSpaced(t: Tree, seps: string[]): string {
  let n = 0
  const next = (): string => seps[n++ % seps.length]
  const go = (x: Tree): string => {
    if (x.kind === 'bare') return x.v
    if (x.kind === 'str') return `"${escapeString(x.v)}"`
    if (x.kind === 'num') return String(x.v)
    const parts = x.items.map(go)
    let out = '('
    parts.forEach((p, i) => {
      out += (i > 0 ? next() : '') + p
    })
    return out + ')'
  }
  return go(t)
}

// --- properties --------------------------------------------------------------

describe('parseSexpr properties', () => {
  it('parse(print(x)) equals x for arbitrary trees', () => {
    fc.assert(
      fc.property(treeArb, fc.array(wsArb, { minLength: 1, maxLength: 6 }), (tree, seps) => {
        const text = printSpaced(tree, seps.map((s) => (s.includes(';') ? '\n' : s)))
        expect(parseSexpr(text)).toEqual(toValue(tree))
      }),
      { numRuns: 400 }
    )
  })

  it('numbers round-trip exactly through String(n)', () => {
    fc.assert(
      fc.property(finiteNumber, (n) => {
        expect(parseSexpr(`(x ${String(n)})`)).toEqual(['x', n])
      }),
      { numRuns: 500 }
    )
  })

  it('any string round-trips through a quoted atom', () => {
    fc.assert(
      fc.property(quotedString, (s) => {
        expect(parseSexpr(`("${escapeString(s)}")`)).toEqual([s])
      }),
      { numRuns: 500 }
    )
  })

  it('a quoted number-shaped string stays a string, a bare one becomes a number', () => {
    fc.assert(
      fc.property(finiteNumber, (n) => {
        const s = String(n)
        expect(parseSexpr(`("${s}")`)).toEqual([s])
        expect(parseSexpr(`(${s})`)).toEqual([n])
      }),
      { numRuns: 300 }
    )
  })

  it('line comments and extra whitespace between tokens never change the result', () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        const plain = printSpaced(tree, [' '])
        const noisy = printSpaced(tree, [' ; comment (with parens) "and quotes"\n', '\t\r\n  '])
        expect(parseSexpr(noisy)).toEqual(parseSexpr(plain))
      }),
      { numRuns: 300 }
    )
  })

  it('never throws anything except SexprError, and error positions are 1-based', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (text) => {
        try {
          parseSexpr(text)
        } catch (e) {
          expect(e).toBeInstanceOf(SexprError)
          const err = e as SexprError
          expect(err.line).toBeGreaterThanOrEqual(1)
          expect(err.col).toBeGreaterThanOrEqual(1)
        }
      }),
      { numRuns: 800 }
    )
  })

  it('never throws a raw error on paren-heavy noise', () => {
    const noise = fc.array(fc.constantFrom('(', ')', '"', ' ', 'a', '1', '\\', '\n', ';'), {
      maxLength: 40
    })
    fc.assert(
      fc.property(noise, (chars) => {
        try {
          parseSexpr(chars.join(''))
        } catch (e) {
          expect(e).toBeInstanceOf(SexprError)
        }
      }),
      { numRuns: 1500 }
    )
  })

  it('dropping the closing paren of a printed list always throws SexprError', () => {
    const listArb = treeArb.filter((t) => t.kind === 'list')
    fc.assert(
      fc.property(listArb, (tree) => {
        const text = printSpaced(tree, [' '])
        expect(() => parseSexpr(text.slice(0, -1))).toThrow(SexprError)
      }),
      { numRuns: 300 }
    )
  })

  it('an extra closing paren after a complete expression always throws SexprError', () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        const text = printSpaced(tree, [' ']) + ')'
        expect(() => parseSexpr(text)).toThrow(SexprError)
      }),
      { numRuns: 300 }
    )
  })
})
