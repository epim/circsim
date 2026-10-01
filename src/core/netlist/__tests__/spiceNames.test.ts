import { describe, it, expect } from 'vitest'
import { buildSpiceNames } from '../spiceNames'

function nets(...names: string[]): Map<number, { id: number; name: string }> {
  const m = new Map<number, { id: number; name: string }>()
  names.forEach((name, i) => m.set(i + 1, { id: i + 1, name }))
  return m
}

function expectUnique(result: Map<number, string>): void {
  const values = Array.from(result.values())
  expect(new Set(values).size).toBe(values.length)
}

describe('buildSpiceNames collision handling (issue #52)', () => {
  it('suffix-reuse shape: +5V, -5V, -5V_2 all get distinct nodes', () => {
    const result = buildSpiceNames(nets('+5V', '-5V', '-5V_2'))
    expect(result.get(1)).toBe('_5v')
    expect(result.get(2)).toBe('_5v_2')
    expect(result.get(3)).not.toBe('_5v_2')
    expectUnique(result)
  })

  it('generated name taken by an earlier net is skipped', () => {
    // "-5V_2" sorts first and owns "_5v_2"; the later "_5v" collision must skip it.
    const result = buildSpiceNames(nets('-5V_2', '+5V', '-5V'))
    expect(result.get(1)).toBe('_5v_2')
    expect(result.get(2)).toBe('_5v')
    expect(result.get(3)).toBe('_5v_3')
    expectUnique(result)
  })

  it('a net literally named 0 does not collide with the ground node', () => {
    const result = buildSpiceNames(nets('GND', '0'), 1)
    expect(result.get(1)).toBe('0')
    expect(result.get(2)).not.toBe('0')
    expectUnique(result)
  })

  it('long collision chains stay unique and deterministic', () => {
    const names = ['A-B', 'A_B', 'a b', 'A.B', 'A_B_2', 'a_b_3', 'A_B_4']
    const a = buildSpiceNames(nets(...names))
    const b = buildSpiceNames(nets(...names))
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()))
    expect(a.size).toBe(names.length)
    expectUnique(a)
  })

  it('two-net collision keeps the documented _2 suffix', () => {
    const result = buildSpiceNames(nets('A-B', 'A_B'))
    expect(result.get(1)).toBe('a_b')
    expect(result.get(2)).toBe('a_b_2')
  })
})
