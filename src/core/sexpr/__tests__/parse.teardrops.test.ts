/**
 * KiCad writer defect: teardrops `filter_ratio` written without its open paren (#22).
 *
 * KiCad 9.0.x wrote `(curved_edges no)filter_ratio 0.9)` for every teardrops
 * block. KiCad's own reader accepts it (each keyword handler consumes its own
 * closing paren), so a board saved that way opens fine in KiCad. The RoyalBlue54L
 * Feather demo ships like this: 349 footprints, one bad paren each. Read strictly,
 * every such block closes one list too early and the file ends in 349 stray ')'.
 */

import { describe, it, expect } from 'vitest'
import { parseSexpr, find, type SExpr } from '../parse'

const BAD =
  '(pad "1" smd (teardrops (best_length_ratio 0.5) (curved_edges no)filter_ratio 0.9) (enabled yes) (allow_two_segments yes))) (uuid "x")'
const GOOD =
  '(pad "1" smd (teardrops (best_length_ratio 0.5) (curved_edges no) (filter_ratio 0.9) (enabled yes) (allow_two_segments yes))) (uuid "x")'

describe('parseSexpr - teardrops filter_ratio written without its open paren', () => {
  it('parses to the same tree as the correctly written block', () => {
    // Wrapped in a footprint so a premature close shows up as a stray ')'.
    const wrap = (s: string): string => `(footprint "F" ${s})`
    expect(parseSexpr(wrap(BAD))).toEqual(parseSexpr(wrap(GOOD)))
  })

  it('keeps the siblings after filter_ratio inside teardrops, and the pad intact', () => {
    const tree = parseSexpr(`(footprint "F" ${BAD})`) as SExpr[]
    const pad = find(tree, 'pad') as SExpr[]
    const td = find(pad, 'teardrops') as SExpr[]
    expect(find(td, 'filter_ratio')).toEqual(['filter_ratio', 0.9])
    expect(find(td, 'enabled')).toEqual(['enabled', 'yes'])
    expect(find(td, 'allow_two_segments')).toEqual(['allow_two_segments', 'yes'])
    expect(find(tree, 'uuid')).toEqual(['uuid', 'x'])
  })

  it('reports each repair through onRepair with its line and the construct name', () => {
    const repairs: { message: string; line: number }[] = []
    parseSexpr(`(footprint "F"\n${BAD}\n)`, { onRepair: (message, line) => repairs.push({ message, line }) })
    expect(repairs).toHaveLength(1)
    expect(repairs[0].line).toBe(2)
    expect(repairs[0].message).toContain('filter_ratio')
    expect(repairs[0].message).toContain('teardrops')
  })

  it('does not repair other bare atoms: a stray close paren is still a structural error', () => {
    expect(() => parseSexpr('(a (b 1)c 2) )')).toThrow(/Unexpected '\)'/)
    // filter_ratio outside teardrops is not the known defect
    expect(parseSexpr('(a (b 1) filter_ratio 0.9)')).toEqual(['a', ['b', 1], 'filter_ratio', 0.9])
  })

  it('leaves a correctly written teardrops block untouched and reports nothing', () => {
    const repairs: string[] = []
    const tree = parseSexpr(`(footprint "F" ${GOOD})`, { onRepair: (m) => repairs.push(m) })
    expect(repairs).toEqual([])
    const td = find(find(tree, 'pad') as SExpr[], 'teardrops') as SExpr[]
    expect(find(td, 'filter_ratio')).toEqual(['filter_ratio', 0.9])
  })
})
