import { describe, it, expect } from 'vitest'
import { UNWIRED, type Instrument } from '../../../../core/spicegen/instruments'
import {
  jacksFor, defaultBenchInstrument, applyTerminal, clearTerminal, potModeSwitch, resolveDrop,
  computeLeads, JACK_COLORS, GROUND_INST_ID, type JackDef,
} from '../leads'

describe('defaultBenchInstrument', () => {
  it('creates unwired records with the rack defaults', () => {
    expect(defaultBenchInstrument('dc-supply', 's1', '#6f6')).toEqual(
      { kind: 'dc-supply', id: 's1', netId: UNWIRED, volts: 5, seriesOhms: 0.1 })
    expect(defaultBenchInstrument('function-gen', 'f1', '#6f6')).toEqual(
      { kind: 'function-gen', id: 'f1', netId: UNWIRED, wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50 })
    expect(defaultBenchInstrument('logic-input', 'l1', '#6f6')).toEqual(
      { kind: 'logic-input', id: 'l1', netId: UNWIRED, level: 0, vHigh: 3.3 })
    expect(defaultBenchInstrument('voltage-probe', 'v1', '#6f6')).toEqual(
      { kind: 'voltage-probe', id: 'v1', netId: UNWIRED, color: '#6f6' })
    expect(defaultBenchInstrument('current-probe', 'c1', '#f6f')).toEqual(
      { kind: 'current-probe', id: 'c1', ref: '', color: '#f6f' })
    expect(defaultBenchInstrument('potentiometer', 'p1', '#6f6')).toEqual(
      { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: UNWIRED, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })
  })
})

describe('jacksFor', () => {
  it('single-net kinds expose one net jack with the kind color', () => {
    const jacks = jacksFor(defaultBenchInstrument('dc-supply', 's1', '#6f6'), 's1')
    expect(jacks).toHaveLength(1)
    expect(jacks[0]).toMatchObject({
      key: 's1:net', instId: 's1', terminal: 'net', accepts: 'net',
      color: JACK_COLORS['dc-supply'], target: null,
    })
  })
  it('a wired jack carries its target', () => {
    const inst: Instrument = { kind: 'voltage-probe', id: 'v1', netId: 9, color: '#6f6' }
    expect(jacksFor(inst, 'v1')[0].target).toEqual({ kind: 'net', netId: 9 })
    expect(jacksFor(inst, 'v1')[0].color).toBe('#6f6') // probes use their own color
  })
  it('pot rheostat: A+W; divider: A+W+Lo', () => {
    const rheo = defaultBenchInstrument('potentiometer', 'p1', '#6f6')
    expect(jacksFor(rheo, 'p1').map(j => j.terminal)).toEqual(['A', 'W'])
    const div: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: 1, netW: UNWIRED, netLo: 2, totalOhms: 10_000, wiperPct: 0.5 }
    const jacks = jacksFor(div, 'p1')
    expect(jacks.map(j => j.terminal)).toEqual(['A', 'W', 'Lo'])
    expect(jacks[0].target).toEqual({ kind: 'net', netId: 1 })   // A ↔ netHi in divider mode
    expect(jacks[1].target).toBeNull()
    expect(jacks[2].color).toBe(JACK_COLORS.potLo)
  })
  it('current-probe: one clamp jack accepting a component', () => {
    const jacks = jacksFor(defaultBenchInstrument('current-probe', 'c1', '#f6f'), 'c1')
    expect(jacks[0]).toMatchObject({ terminal: 'clamp', accepts: 'component', target: null })
  })
  it('ground-ref: one gnd jack under the ground singleton id', () => {
    const jacks = jacksFor({ kind: 'ground-ref', netId: 4 }, GROUND_INST_ID)
    expect(jacks[0]).toMatchObject({
      key: 'ground:gnd', terminal: 'gnd', accepts: 'net',
      color: JACK_COLORS.ground, target: { kind: 'net', netId: 4 },
    })
  })
})

describe('applyTerminal / clearTerminal', () => {
  const net7 = { kind: 'net', netId: 7 } as const
  it('net terminal → netId', () => {
    const next = applyTerminal(defaultBenchInstrument('dc-supply', 's1', '#6f6'), 'net', net7)
    expect(next).toMatchObject({ netId: 7, volts: 5 })
  })
  it('pot terminals map per mode (A→netA rheostat, A→netHi divider)', () => {
    const rheo = applyTerminal(defaultBenchInstrument('potentiometer', 'p1', '#6f6'), 'A', net7)
    expect(rheo).toMatchObject({ netA: 7 })
    const div: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: UNWIRED, netW: UNWIRED, netLo: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 }
    expect(applyTerminal(div, 'A', net7)).toMatchObject({ netHi: 7 })
    expect(applyTerminal(div, 'Lo', net7)).toMatchObject({ netLo: 7 })
  })
  it('clamp terminal → ref', () => {
    const next = applyTerminal(defaultBenchInstrument('current-probe', 'c1', '#f6f'), 'clamp', { kind: 'component', ref: 'D1' })
    expect(next).toMatchObject({ ref: 'D1' })
  })
  it('mismatched target kind returns the instrument unchanged', () => {
    const inst = defaultBenchInstrument('dc-supply', 's1', '#6f6')
    expect(applyTerminal(inst, 'net', { kind: 'component', ref: 'D1' })).toBe(inst)
    const clamp = defaultBenchInstrument('current-probe', 'c1', '#f6f')
    expect(applyTerminal(clamp, 'clamp', net7)).toBe(clamp)
  })
  it('clearTerminal rewires back to UNWIRED / empty ref', () => {
    const wired: Instrument = { kind: 'voltage-probe', id: 'v1', netId: 9, color: '#6f6' }
    expect(clearTerminal(wired, 'net')).toMatchObject({ netId: UNWIRED })
    const clamp: Instrument = { kind: 'current-probe', id: 'c1', ref: 'D1', color: '#f6f' }
    expect(clearTerminal(clamp, 'clamp')).toMatchObject({ ref: '' })
  })
})

describe('resolveDrop', () => {
  const netJack = { accepts: 'net' } as JackDef
  const clampJack = { accepts: 'component' } as JackDef
  it('net jack accepts a net hit, rejects a component hit', () => {
    expect(resolveDrop({ netId: 5 }, netJack)).toEqual({ kind: 'net', netId: 5 })
    expect(resolveDrop({ ref: 'D1' }, netJack)).toBeNull()
  })
  it('clamp jack accepts a component hit, rejects a net hit', () => {
    expect(resolveDrop({ ref: 'D1' }, clampJack)).toEqual({ kind: 'component', ref: 'D1' })
    expect(resolveDrop({ netId: 5 }, clampJack)).toBeNull()
  })
  it('null hit → null', () => {
    expect(resolveDrop(null, netJack)).toBeNull()
  })
})

describe('computeLeads', () => {
  const jackRects = new Map([['s1:net', { px: 10, py: 500 }], ['p1:A', { px: 60, py: 500 }]])
  const anchors = { nets: new Map([[7, { px: 200, py: 100 }]]), refs: new Map<string, { px: number; py: number }>() }
  it('wired jack with a live net + known anchors → one lead with a path', () => {
    const inst: Instrument = { kind: 'dc-supply', id: 's1', netId: 7, volts: 5, seriesOhms: 0.1 }
    const leads = computeLeads([{ inst, instId: 's1' }], jackRects, anchors, new Set([7]))
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ jackKey: 's1:net', dangling: false, color: expect.stringMatching(/^#/) })
    expect(leads[0].path).toMatch(/^M 10 500 C /)
    expect(leads[0].clip).toEqual({ px: 200, py: 100 })
  })
  it('wired jack whose net no longer exists → dangling, no clip', () => {
    const inst: Instrument = { kind: 'dc-supply', id: 's1', netId: 7, volts: 5, seriesOhms: 0.1 }
    const leads = computeLeads([{ inst, instId: 's1' }], jackRects, anchors, new Set([99]))
    expect(leads[0]).toMatchObject({ dangling: true, clip: null, path: null })
  })
  it('unwired jacks and jacks without a measured rect produce no lead', () => {
    const unwired: Instrument = { kind: 'dc-supply', id: 's1', netId: UNWIRED, volts: 5, seriesOhms: 0.1 }
    expect(computeLeads([{ inst: unwired, instId: 's1' }], jackRects, anchors, new Set([7]))).toHaveLength(0)
    const wired: Instrument = { kind: 'voltage-probe', id: 'zz', netId: 7, color: '#6f6' }
    expect(computeLeads([{ inst: wired, instId: 'zz' }], jackRects, anchors, new Set([7]))).toHaveLength(0)
  })
})

describe('potModeSwitch (spec §5: A/W wires survive, only Lo changes)', () => {
  it('rheostat→divider: A carries to Hi, W survives, Lo starts unwired', () => {
    const inst: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 3, netW: 4, totalOhms: 5000, wiperPct: 0.3 }
    expect(potModeSwitch(inst)).toEqual({ kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: 3, netW: 4, netLo: UNWIRED, totalOhms: 5000, wiperPct: 0.3 })
  })
  it('divider→rheostat: Hi carries to A, W survives, Lo discarded', () => {
    const inst: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: 3, netW: 4, netLo: 9, totalOhms: 5000, wiperPct: 0.3 }
    expect(potModeSwitch(inst)).toEqual({ kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 3, netW: 4, totalOhms: 5000, wiperPct: 0.3 })
  })
})
