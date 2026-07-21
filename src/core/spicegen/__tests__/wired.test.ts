import { describe, it, expect } from 'vitest'
import { isFullyWired, wiredInstruments, UNWIRED, type Instrument } from '../instruments'

const wiredSupply: Instrument = { kind: 'dc-supply', id: 's1', netId: 3, volts: 5, seriesOhms: 0.1 }
const unwiredSupply: Instrument = { kind: 'dc-supply', id: 's2', netId: UNWIRED, volts: 5, seriesOhms: 0.1 }

describe('isFullyWired', () => {
  it('single-net kinds: wired iff netId !== UNWIRED', () => {
    expect(isFullyWired(wiredSupply)).toBe(true)
    expect(isFullyWired(unwiredSupply)).toBe(false)
    expect(isFullyWired({ kind: 'ground-ref', netId: UNWIRED })).toBe(false)
    expect(isFullyWired({ kind: 'voltage-probe', id: 'p', netId: 7, color: '#6f6' })).toBe(true)
  })
  it('current-probe: wired iff ref non-empty', () => {
    expect(isFullyWired({ kind: 'current-probe', id: 'i', ref: 'D1', color: '#f6f' })).toBe(true)
    expect(isFullyWired({ kind: 'current-probe', id: 'i', ref: '', color: '#f6f' })).toBe(false)
  })
  it('pot rheostat needs A+W; divider needs Hi+W+Lo', () => {
    expect(isFullyWired({ kind: 'potentiometer', mode: 'rheostat', id: 'r', netA: 1, netW: 2, totalOhms: 10_000, wiperPct: 0.5 })).toBe(true)
    expect(isFullyWired({ kind: 'potentiometer', mode: 'rheostat', id: 'r', netA: 1, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })).toBe(false)
    expect(isFullyWired({ kind: 'potentiometer', mode: 'divider', id: 'd', netHi: 1, netW: 2, netLo: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })).toBe(false)
  })
  it('wiredInstruments filters', () => {
    expect(wiredInstruments([wiredSupply, unwiredSupply])).toEqual([wiredSupply])
  })
})
