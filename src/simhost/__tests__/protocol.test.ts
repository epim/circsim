/**
 * src/simhost/__tests__/protocol.test.ts
 *
 * Pure unit tests for the opResult key normalization rules (Spec §6.1).
 * No engine / FFI involved — runs everywhere.
 */

import { describe, expect, it } from 'vitest'

import { isScaleVectorName, normalizeVectorKey } from '../protocol'

describe('normalizeVectorKey (Spec §6.1)', () => {
  it('lowercases bare node names', () => {
    expect(normalizeVectorKey('OUT')).toBe('out')
    expect(normalizeVectorKey('VIN')).toBe('vin')
    expect(normalizeVectorKey('out')).toBe('out')
  })

  it('strips v(...) voltage wrapper', () => {
    expect(normalizeVectorKey('v(out)')).toBe('out')
    expect(normalizeVectorKey('V(OUT)')).toBe('out')
    expect(normalizeVectorKey('V(node_3)')).toBe('node_3')
  })

  it('maps source branch currents to i(<dev>)', () => {
    expect(normalizeVectorKey('v1#branch')).toBe('i(v1)')
    expect(normalizeVectorKey('V1#branch')).toBe('i(v1)')
    expect(normalizeVectorKey('vpsu_1#branch')).toBe('i(vpsu_1)')
  })

  it('maps multi-terminal xspice branch currents to i(<dev>)', () => {
    // dac_bridge etc. expose "abr_out#branch_1_0" style names.
    expect(normalizeVectorKey('abr_out#branch_1_0')).toBe('i(abr_out)')
  })

  it('maps device-internal @dev[i] current to i(<dev>)', () => {
    expect(normalizeVectorKey('@r_r1[i]')).toBe('i(r_r1)')
    expect(normalizeVectorKey('@Q_Q3[i]')).toBe('i(q_q3)')
  })
})

describe('isScaleVectorName', () => {
  it('flags time/frequency/sweep scale vectors', () => {
    expect(isScaleVectorName('time')).toBe(true)
    expect(isScaleVectorName('TIME')).toBe(true)
    expect(isScaleVectorName('frequency')).toBe(true)
    expect(isScaleVectorName('sweep')).toBe(true)
  })

  it('does not flag ordinary node names', () => {
    expect(isScaleVectorName('out')).toBe(false)
    expect(isScaleVectorName('vin')).toBe(false)
  })
})
