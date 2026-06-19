/**
 * src/simhost/__tests__/ngspiceFfi.senddata.test.ts
 *
 * Unit test for the SendData per-timepoint row decode (decodeVecvaluesallRow).
 *
 * REGRESSION GUARD for the silent-data-loss footgun: the decode used to wrap the
 * whole per-timepoint vecvaluesall loop in ONE try/catch, so a single exotic vector
 * entry that threw during decode (e.g. a device-internal current from
 * `.save @d1[i]`) discarded the ENTIRE timepoint — node voltages and working
 * currents included. The loop is now resilient PER ENTRY: a failing entry is
 * skipped and the remaining vectors still make it into the row.
 *
 * These tests drive the pure decoder with an injected fake `decode` so we can
 * deterministically force one entry to throw — no live libngspice required.
 */

import { describe, expect, it } from 'vitest'

import { decodeVecvaluesallRow } from '../ngspiceFfi'

interface FakeVec {
  name: string
  creal: number
  is_scale: boolean
  /** When true, decoding THIS entry's vecvalues struct throws. */
  throws?: boolean
}

/**
 * Build a fake koffi.decode over a list of vectors. The decoder calls decode in a
 * strict pattern per entry: first decode(vecsa, i*stride, 'pvecvalues') then
 * decode(ptr, 'vecvalues'). We track the running entry index from the sequence of
 * "first" (numeric-offset) calls — robust regardless of the real POINTER_SIZE.
 * The first call returns a sentinel pointer carrying the entry; the second returns
 * the decoded struct, or throws if the entry is marked.
 */
function makeDecode(vecs: FakeVec[]) {
  let nextIndex = 0
  return (ptr: unknown, offsetOrType: number | string): unknown => {
    if (typeof offsetOrType === 'number') {
      // First decode of an entry: vecsa + i*POINTER_SIZE → pvecvalues.
      const entry = vecs[nextIndex++]
      if (!entry) return null
      return { __entry: entry }
    }
    // Second decode: pvecvalues → vecvalues struct.
    const entry = (ptr as { __entry: FakeVec }).__entry
    if (entry.throws) throw new Error(`decode blew up on ${entry.name}`)
    return { name: entry.name, creal: entry.creal, is_scale: entry.is_scale }
  }
}

describe('decodeVecvaluesallRow — per-entry decode resilience', () => {
  it('decodes a normal row with every vector present (happy path)', () => {
    const vecs: FakeVec[] = [
      { name: 'time', creal: 1e-6, is_scale: true },
      { name: 'vcc', creal: 5, is_scale: false },
      { name: 'a', creal: 1.9, is_scale: false },
      { name: 'v1#branch', creal: -0.0093, is_scale: false }
    ]
    const { row, scaleName } = decodeVecvaluesallRow(vecs.length, {}, makeDecode(vecs))
    expect(scaleName).toBe('time')
    expect(row).toEqual({ time: 1e-6, vcc: 5, a: 1.9, 'v1#branch': -0.0093 })
  })

  it('skips ONE throwing entry but still streams the rest of the row', () => {
    // "@d1[i]" decode throws; vcc / a / time must still survive.
    const vecs: FakeVec[] = [
      { name: 'time', creal: 1e-6, is_scale: true },
      { name: 'vcc', creal: 5, is_scale: false },
      { name: '@d1[i]', creal: NaN, is_scale: false, throws: true },
      { name: 'a', creal: 1.9, is_scale: false }
    ]
    const { row, scaleName } = decodeVecvaluesallRow(vecs.length, {}, makeDecode(vecs))

    // The scale and the surviving node voltages are present...
    expect(scaleName).toBe('time')
    expect(row.time).toBe(1e-6)
    expect(row.vcc).toBe(5)
    expect(row.a).toBe(1.9)
    // ...and the offending vector is simply absent (downstream maps it to NaN).
    expect('@d1[i]' in row).toBe(false)
    // The row is NOT empty — the timepoint survived (the whole point of the fix).
    expect(Object.keys(row).length).toBe(3)
  })

  it('a throwing entry in the FIRST slot still lets later vectors through', () => {
    const vecs: FakeVec[] = [
      { name: '@d1[i]', creal: NaN, is_scale: false, throws: true },
      { name: 'time', creal: 2e-6, is_scale: true },
      { name: 'vcc', creal: 5, is_scale: false }
    ]
    const { row, scaleName } = decodeVecvaluesallRow(vecs.length, {}, makeDecode(vecs))
    expect(scaleName).toBe('time')
    expect(row.time).toBe(2e-6)
    expect(row.vcc).toBe(5)
    expect('@d1[i]' in row).toBe(false)
  })
})
