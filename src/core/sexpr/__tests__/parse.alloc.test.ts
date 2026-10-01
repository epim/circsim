/**
 * Allocation and equivalence tests for the S-expression parser (issue #60).
 *
 * The parser used to tokenise the whole file into an array of token objects and
 * build the full tree afterwards, costing about 30x the file size in heap on a
 * pour-heavy board, half of it transient token garbage and half of it subtrees
 * (filled_polygon point lists) the board reader never looks at.
 *
 * Covered here:
 *   - the single-pass parser agrees with the old tokeniser-based parser
 *     (kept as __tests__/referenceParse.ts) on values and on error positions;
 *   - skipHeads drops the named subtrees without building them, still checks
 *     that they are balanced, and reports the same error as a full parse;
 *   - on a generated 17 MB board the parser allocates much less than the
 *     reference, and the retained tree with skipHeads is a small multiple of
 *     the file size.
 */

import * as fc from 'fast-check'
import v8 from 'node:v8'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

import { parseSexpr, SexprError, type SExpr } from '../parse'
import { largeBoardText } from './largeBoard'
import { parseSexprReference } from './referenceParse'

// --- helpers -------------------------------------------------------------------

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

function heapUsed(): number {
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

/** Heap growth, in bytes, immediately after running fn and while its result is live. */
function immediateHeapDelta<T>(fn: () => T): { delta: number; result: T } {
  const base = heapUsed()
  const result = fn()
  return { delta: process.memoryUsage().heapUsed - base, result }
}

/** Heap still held by fn's result after a full collection, in bytes. */
function retainedHeap<T>(fn: () => T): { retained: number; result: T } {
  const base = heapUsed()
  const result = fn()
  return { retained: heapUsed() - base, result }
}

function errorOf(fn: () => unknown): { name: string; line: number; col: number } | null {
  try {
    fn()
  } catch (e) {
    const err = e as SexprError
    return { name: err.name, line: err.line, col: err.col }
  }
  return null
}

function countHeads(node: SExpr, head: string): number {
  if (!Array.isArray(node)) return 0
  let n = node[0] === head ? 1 : 0
  for (const child of node) n += countHeads(child, head)
  return n
}

// --- skipHeads -----------------------------------------------------------------

describe('parseSexpr - skipHeads', () => {
  const text = `(board
    (net 1 "A")
    (zone (net 1)
      (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 2 0) (xy 2 2) (xy 0 2)))
      (filled_polygon (layer "B.Cu") (pts (xy 5 5))))
    (segment (start 0 0) (end 1 1)))`

  it('returns a skipped list as just its head, in place', () => {
    const tree = parseSexpr(text, { skipHeads: ['filled_polygon'] }) as SExpr[]
    const zone = tree[2] as SExpr[]
    expect(zone).toEqual([
      'zone',
      ['net', 1],
      ['polygon', ['pts', ['xy', 0, 0], ['xy', 1, 0], ['xy', 1, 1]]],
      ['filled_polygon'],
      ['filled_polygon']
    ])
  })

  it('leaves everything outside the skipped subtrees equal to a full parse', () => {
    const full = parseSexpr(text) as SExpr[]
    const skipped = parseSexpr(text, { skipHeads: ['filled_polygon'] }) as SExpr[]
    expect(skipped[1]).toEqual(full[1])
    expect(skipped[3]).toEqual(full[3])
    expect(countHeads(skipped, 'xy')).toBe(3)
  })

  it('does nothing when no listed head occurs, or the list is empty', () => {
    expect(parseSexpr(text, { skipHeads: ['absent'] })).toEqual(parseSexpr(text))
    expect(parseSexpr(text, { skipHeads: [] })).toEqual(parseSexpr(text))
  })

  it('only matches a list head, never a plain atom of the same name', () => {
    const t = '(a filled_polygon (b filled_polygon) "filled_polygon")'
    expect(parseSexpr(t, { skipHeads: ['filled_polygon'] })).toEqual(parseSexpr(t))
  })

  it('applies to the root list too', () => {
    const t = '(filled_polygon (pts 1 2))'
    expect(parseSexpr(t, { skipHeads: ['filled_polygon'] })).toEqual(['filled_polygon'])
  })

  it('steps over parens, quotes and comments inside the skipped subtree', () => {
    const t = '(r (skipme "a ) b" (x ; ) comment\n 1) "q\\"(" y;z) (keep 2))'
    expect(parseSexpr(t, { skipHeads: ['skipme'] })).toEqual(['r', ['skipme'], ['keep', 2]])
  })

  it('still rejects an unbalanced skipped subtree, with the full-parse error', () => {
    const t = '(a\n  (keep 1)\n  (skipme (x 1)\n    (y 2)\n'
    const full = errorOf(() => parseSexpr(t))
    expect(full).not.toBeNull()
    expect(errorOf(() => parseSexpr(t, { skipHeads: ['skipme'] }))).toEqual(full)
  })

  it('still rejects a stray close paren after a skipped subtree', () => {
    const t = '(a (skipme 1)))'
    const full = errorOf(() => parseSexpr(t))
    expect(full).not.toBeNull()
    expect(errorOf(() => parseSexpr(t, { skipHeads: ['skipme'] }))).toEqual(full)
  })
})

// --- differential: single pass versus the reference tokeniser -------------------

describe('parseSexpr - agrees with the reference parser', () => {
  const pieces = ['(', ')', ' ', '\n', '\t', '\r', ';c\n', '"', '\\', 'a', 'b1', '-', '.', '1', '2.5e3', '0x1', '+7', 'F.Cu', '(x 1)', '"s\\n\\"q"']
  const noise = fc.array(fc.constantFrom(...pieces), { maxLength: 40 }).map((p) => p.join(''))

  it('returns equal trees or errors at equal positions on arbitrary token soup', () => {
    fc.assert(
      fc.property(noise, (t) => {
        const ref = errorOf(() => parseSexprReference(t))
        const got = errorOf(() => parseSexpr(t))
        expect(got).toEqual(ref)
        if (ref === null) expect(parseSexpr(t)).toEqual(parseSexprReference(t))
      }),
      { numRuns: 3000 }
    )
  })

  it('agrees on a generated board', () => {
    const t = largeBoardText({ segments: 300, zonePoints: 50, footprints: 20 })
    expect(parseSexpr(t)).toEqual(parseSexprReference(t))
  })

  it('skipHeads on arbitrary soup equals a full parse with those subtrees stubbed', () => {
    // Every list headed by the bare atom x shrinks to (x).
    const stub = (n: SExpr): SExpr => {
      if (!Array.isArray(n)) return n
      return n[0] === 'x' ? ['x'] : n.map(stub)
    }
    fc.assert(
      fc.property(noise, (t) => {
        const ref = errorOf(() => parseSexpr(t))
        const got = errorOf(() => parseSexpr(t, { skipHeads: ['x'] }))
        expect(got).toEqual(ref)
        if (ref === null) {
          expect(parseSexpr(t, { skipHeads: ['x'] })).toEqual(stub(parseSexpr(t)))
        }
      }),
      { numRuns: 2000 }
    )
  })
})

// --- allocation on a large board ------------------------------------------------

describe('parseSexpr - allocation on a 17 MB board', () => {
  // Generated, never committed. Segment-heavy with four big filled zones.
  const text = largeBoardText({ segments: 100_000, zonePoints: 20_000 })
  const bytes = Buffer.byteLength(text)

  it('fixture is about 17 MB', () => {
    expect(bytes).toBeGreaterThan(15 * 1024 * 1024)
  })

  it('allocates well under half of what the tokeniser-based parser did', () => {
    // Best of three, to ride out GC timing: the minimum is the least-collected run.
    const best = (fn: () => unknown): number => {
      let m = Infinity
      for (let i = 0; i < 3; i++) m = Math.min(m, immediateHeapDelta(fn).delta)
      return m
    }
    const before = best(() => parseSexprReference(text))
    const after = best(() => parseSexpr(text))
    expect(after).toBeLessThan(before * 0.4)
  })

  it('retains a small multiple of the file size once filled_polygon is skipped', () => {
    const { retained, result } = retainedHeap(() => parseSexpr(text, { skipHeads: ['filled_polygon'] }))
    expect(countHeads(result, 'filled_polygon')).toBe(4)
    expect(countHeads(result, 'xy')).toBe(4 * 20_000)
    // The full tree used to be about 16x the file size; it is about 4.7x now.
    expect(retained).toBeLessThan(bytes * 6)
  })

  it('builds a smaller full tree than the reference, without any skipping', () => {
    const before = retainedHeap(() => parseSexprReference(text)).retained
    const after = retainedHeap(() => parseSexpr(text)).retained
    expect(after).toBeLessThan(before * 0.5)
  })
})
