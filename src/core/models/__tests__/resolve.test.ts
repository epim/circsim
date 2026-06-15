/**
 * Tests for core/models/resolve.ts — model resolution pipeline (tiers 1, 2, 6).
 *
 * Task 12 scope: tier 1 (Sim.* → primitive/subckt), tier 2 (R/C/L primitive
 * inference), tier 6 (stub open/short/interactive-pins).
 * Library matching (tier 3) and user libs (tier 4) are seams tested separately.
 */

import { describe, it, expect } from 'vitest'
import type { Circuit, Part } from '../../netlist/extract'
import type { SchematicSimData, SymbolSimInfo } from '../../kicad/schematic'
import { resolveAll } from '../resolve'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePart(
  ref: string,
  value: string,
  libId = 'Resistor_SMD:R_0805_2012Metric',
  properties: Record<string, string> = {},
): Part {
  return {
    ref,
    value,
    libId,
    layer: 'F',
    padNet: new Map([['1', 1], ['2', 2]]),
    properties,
  }
}

function makeCircuit(parts: Part[]): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
      { id: 2, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    ],
    parts,
    warnings: [],
  }
}

function makeSimInfo(simFields: Partial<SymbolSimInfo['sim']>, value?: string): SymbolSimInfo {
  return {
    value,
    sim: simFields,
    pins: [],
    noConnects: [],
  }
}

// ─── Tier 2: R/C/L primitive inference ───────────────────────────────────────

describe('Tier 2: primitive inference from refdes prefix + value', () => {
  it('R with value 10k → tier 2 primitive, resolved, card contains 10000', () => {
    const circuit = makeCircuit([makePart('R1', '10k')])
    const resolutions = resolveAll(circuit)
    expect(resolutions).toHaveLength(1)
    const r = resolutions[0]
    expect(r.ref).toBe('R1')
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    expect(r.model?.kind).toBe('primitive')
    if (r.model?.kind === 'primitive') {
      // Value must be plain decimal — no letter suffixes
      expect(r.model.card).toContain('10000')
      // Element name must be lowercase and start with r_
      expect(r.model.card).toMatch(/^r_r1\s/)
    }
  })

  it('R with value 4k7 → tier 2 primitive with value 4700', () => {
    const circuit = makeCircuit([makePart('R1', '4k7')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('4700')
    }
  })

  it('C with value 4.7u → tier 2 primitive, value 4.7e-6', () => {
    const circuit = makeCircuit([
      makePart('C1', '4.7u', 'Device:C'),
    ])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    expect(r.model?.kind).toBe('primitive')
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('4.7e-6')
      expect(r.model.card).toMatch(/^c_c1\s/)
    }
  })

  it('C with value 100n → tier 2, value 1e-7', () => {
    const circuit = makeCircuit([makePart('C1', '100n', 'Device:C')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('1e-7')
    }
  })

  it('L with value 10u → tier 2, card starts with l_', () => {
    const circuit = makeCircuit([makePart('L1', '10u', 'Device:L')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toMatch(/^l_l1\s/)
    }
  })

  it('R with value 0R22 → primitive with value 0.22', () => {
    const circuit = makeCircuit([makePart('R1', '0R22')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('0.22')
    }
  })

  it('R with value 470 (plain number) → primitive with value 470', () => {
    const circuit = makeCircuit([makePart('R1', '470')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('470')
    }
  })

  it('C with electrolytic footprint (CP_ prefix) → warns about polarity', () => {
    const circuit = makeCircuit([
      makePart('C1', '100u', 'Device:CP_Small'),
    ])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(2)
    // Should have a polarity warning
    expect(r.warnings.some(w => w.toLowerCase().includes('polar') || w.toLowerCase().includes('electro'))).toBe(true)
  })

  it('C with Elec footprint → warns about polarity', () => {
    const circuit = makeCircuit([
      makePart('C2', '220u', 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'),
    ])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.tier).toBe(2)
    expect(r.warnings.some(w => w.toLowerCase().includes('polar') || w.toLowerCase().includes('electro'))).toBe(true)
  })

  it('DNP value → stub open with warning', () => {
    const circuit = makeCircuit([makePart('R1', 'DNP')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('stubbed')
    expect(r.tier).toBe(6)
    expect(r.model?.kind).toBe('stub')
    if (r.model?.kind === 'stub') {
      expect(r.model.mode).toBe('open')
    }
    // Must emit a warning
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('R without parseable value (e.g. "???") → unresolved', () => {
    const circuit = makeCircuit([makePart('R1', '???')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    // Can't infer value → not tier 2
    expect(r.tier).not.toBe(2)
    expect(r.status).not.toBe('ok')
  })

  it('primitive card uses node names from circuit nets', () => {
    const part = makePart('R1', '10k')
    // padNet: pad 1 → netId 1 (spiceNode 'vin'), pad 2 → netId 2 (spiceNode 'out')
    const circuit = makeCircuit([part])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toContain('vin')
      expect(r.model.card).toContain('out')
    }
  })
})

// ─── Tier 1: Schematic Sim.* fields ──────────────────────────────────────────

describe('Tier 1: Schematic Sim.* fields', () => {
  it('Sim.Device=R, Sim.Params="R=10k" → tier 1 wins over tier 2', () => {
    const circuit = makeCircuit([makePart('R1', '10k')])
    const schData: SchematicSimData = new Map([
      ['R1', makeSimInfo({ Device: 'R', Params: 'R=10k' }, '10k')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(1)
    expect(r.model?.kind).toBe('primitive')
    if (r.model?.kind === 'primitive') {
      // Value from Sim.Params parsed: 10k = 10000
      expect(r.model.card).toContain('10000')
      expect(r.model.card).toMatch(/^r_r1\s/)
    }
  })

  it('Sim.Device=C → tier 1 capacitor primitive', () => {
    const circuit = makeCircuit([makePart('C1', '4.7u', 'Device:C')])
    const schData: SchematicSimData = new Map([
      ['C1', makeSimInfo({ Device: 'C', Params: 'C=4.7u' }, '4.7u')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.tier).toBe(1)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toMatch(/^c_c1\s/)
    }
  })

  it('Sim.Device=L → tier 1 inductor primitive', () => {
    const circuit = makeCircuit([makePart('L1', '100u', 'Device:L')])
    const schData: SchematicSimData = new Map([
      ['L1', makeSimInfo({ Device: 'L', Params: 'L=100u' }, '100u')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.tier).toBe(1)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toMatch(/^l_l1\s/)
    }
  })

  it('Sim.Device=V (voltage source) → tier 1 primitive', () => {
    const circuit = makeCircuit([makePart('V1', '5V', 'Device:Battery')])
    const schData: SchematicSimData = new Map([
      ['V1', makeSimInfo({ Device: 'V', Params: 'DC=5' }, '5V')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.tier).toBe(1)
    expect(r.status).toBe('ok')
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toMatch(/^v_v1\s/)
    }
  })

  it('Sim.Device=I (current source) → tier 1 primitive', () => {
    const circuit = makeCircuit([makePart('I1', '1m', 'Device:Battery')])
    const schData: SchematicSimData = new Map([
      ['I1', makeSimInfo({ Device: 'I', Params: 'DC=1m' }, '1m')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.tier).toBe(1)
    expect(r.status).toBe('ok')
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).toMatch(/^i_i1\s/)
    }
  })

  it('Sim.Type=SUBCKT + Sim.Library + Sim.Name → tier 1 subckt', () => {
    const circuit = makeCircuit([makePart('U1', 'NE555', 'Timer:NE555')])
    const schData: SchematicSimData = new Map([
      ['U1', makeSimInfo({
        Type: 'SUBCKT',
        Library: 'models/timer555.lib',
        Name: 'NE555',
        Pins: '1=GND 2=TRIG 3=OUT 4=RESET 5=CTRL 6=THRES 7=DISCH 8=VCC',
      }, 'NE555')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.tier).toBe(1)
    expect(r.status).toBe('ok')
    expect(r.model?.kind).toBe('subckt')
    if (r.model?.kind === 'subckt') {
      expect(r.model.subcktName).toBe('NE555')
      expect(r.model.libFile).toBe('models/timer555.lib')
      // Pin map should map pad numbers to subckt terminals
      expect(r.model.pinMap).toBeDefined()
    }
  })

  it('Sim.Device=KIBIS (out-of-scope) → unresolved with warning naming device type', () => {
    const circuit = makeCircuit([makePart('U1', 'SomeIC', 'Package:SOT23')])
    const schData: SchematicSimData = new Map([
      ['U1', makeSimInfo({ Device: 'KIBIS' }, 'SomeIC')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    expect(r.status).toBe('unresolved')
    expect(r.warnings.some(w => w.includes('KIBIS'))).toBe(true)
  })

  it('Sim.Pins parsed correctly into PinMap for subckt', () => {
    const circuit = makeCircuit([makePart('U1', 'NE555', 'Timer:NE555')])
    const schData: SchematicSimData = new Map([
      ['U1', makeSimInfo({
        Type: 'SUBCKT',
        Library: 'models/timer555.lib',
        Name: 'NE555',
        Pins: '1=GND 2=TRIG 3=OUT',
      }, 'NE555')],
    ])
    const resolutions = resolveAll(circuit, schData)
    const r = resolutions[0]
    if (r.model?.kind === 'subckt') {
      // Pad "1" maps to terminal "GND"
      expect(r.model.pinMap['1']).toBe('GND')
      expect(r.model.pinMap['2']).toBe('TRIG')
      expect(r.model.pinMap['3']).toBe('OUT')
    }
  })
})

// ─── Unknown IC → unresolved ──────────────────────────────────────────────────

describe('Unresolved parts', () => {
  it('unknown IC with no Sim.* fields and non-R/C/L prefix → unresolved', () => {
    const circuit = makeCircuit([makePart('U1', 'ESP32', 'Package:ESP32-WROOM-32')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    expect(r.status).toBe('unresolved')
    expect(r.tier).toBe(6)
  })

  it('D prefix without Sim.* and no library → unresolved', () => {
    const circuit = makeCircuit([makePart('D1', '1N4148', 'Device:D')])
    const resolutions = resolveAll(circuit)
    const r = resolutions[0]
    // No tier 1 or 2 for diodes without library
    expect(r.status).toBe('unresolved')
  })
})

// ─── Tier 6: Stub ─────────────────────────────────────────────────────────────

describe('Tier 6: stub modes', () => {
  it('user override to {kind:stub, mode:open} → tier 6 stubbed', () => {
    const circuit = makeCircuit([makePart('U1', 'ESP32', 'Package:ESP32')])
    const userOverrides = new Map<string, { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' }>([
      ['U1', { kind: 'stub', mode: 'open' }],
    ])
    const resolutions = resolveAll(circuit, undefined, undefined, undefined, userOverrides)
    const r = resolutions[0]
    expect(r.status).toBe('stubbed')
    expect(r.tier).toBe(6)
    expect(r.model?.kind).toBe('stub')
    if (r.model?.kind === 'stub') {
      expect(r.model.mode).toBe('open')
    }
  })

  it('user override to stub short → tier 6 stub short', () => {
    const circuit = makeCircuit([makePart('U1', 'Ferrite', 'Inductor:L_0805')])
    const userOverrides = new Map<string, { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' }>([
      ['U1', { kind: 'stub', mode: 'short' }],
    ])
    const resolutions = resolveAll(circuit, undefined, undefined, undefined, userOverrides)
    const r = resolutions[0]
    expect(r.status).toBe('stubbed')
    if (r.model?.kind === 'stub') {
      expect(r.model.mode).toBe('short')
    }
  })

  it('user override to interactive-pins → tier 6 stub interactive-pins', () => {
    const circuit = makeCircuit([makePart('U1', 'STM32', 'Package:LQFP64')])
    const userOverrides = new Map<string, { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' }>([
      ['U1', { kind: 'stub', mode: 'interactive-pins' }],
    ])
    const resolutions = resolveAll(circuit, undefined, undefined, undefined, userOverrides)
    const r = resolutions[0]
    expect(r.status).toBe('stubbed')
    if (r.model?.kind === 'stub') {
      expect(r.model.mode).toBe('interactive-pins')
    }
  })

  it('user override wins over Sim.* fields (override takes priority)', () => {
    const circuit = makeCircuit([makePart('R1', '10k')])
    const schData: SchematicSimData = new Map([
      ['R1', makeSimInfo({ Device: 'R', Params: 'R=10k' }, '10k')],
    ])
    const userOverrides = new Map<string, { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' }>([
      ['R1', { kind: 'stub', mode: 'open' }],
    ])
    const resolutions = resolveAll(circuit, schData, undefined, undefined, userOverrides)
    const r = resolutions[0]
    // User override wins
    expect(r.status).toBe('stubbed')
    expect(r.tier).toBe(6)
  })
})

// ─── resolveAll return contract ───────────────────────────────────────────────

describe('resolveAll return contract', () => {
  it('returns one Resolution per Part', () => {
    const circuit = makeCircuit([
      makePart('R1', '10k'),
      makePart('R2', '22k'),
      makePart('C1', '100n', 'Device:C'),
    ])
    const resolutions = resolveAll(circuit)
    expect(resolutions).toHaveLength(3)
    const refs = resolutions.map(r => r.ref)
    expect(refs).toContain('R1')
    expect(refs).toContain('R2')
    expect(refs).toContain('C1')
  })

  it('each Resolution has ref, status, tier, warnings array', () => {
    const circuit = makeCircuit([makePart('R1', '10k')])
    const [r] = resolveAll(circuit)
    expect(typeof r.ref).toBe('string')
    expect(['ok', 'stubbed', 'unresolved']).toContain(r.status)
    expect([1, 2, 3, 4, 5, 6]).toContain(r.tier)
    expect(Array.isArray(r.warnings)).toBe(true)
  })

  it('empty circuit → empty resolutions array', () => {
    const circuit = makeCircuit([])
    const resolutions = resolveAll(circuit)
    expect(resolutions).toHaveLength(0)
  })

  it('schematicSimData=undefined → falls through to tier 2 for R/C/L', () => {
    const circuit = makeCircuit([makePart('R1', '100')])
    const resolutions = resolveAll(circuit, undefined)
    const r = resolutions[0]
    expect(r.tier).toBe(2)
    expect(r.status).toBe('ok')
  })

  it('library param empty/undefined → seam for tier 3, falls through', () => {
    // Q prefix is not R/C/L, so should fall through to unresolved
    const circuit = makeCircuit([makePart('Q1', '2N3904', 'Device:Q_NPN_BCE')])
    const resolutions = resolveAll(circuit, undefined, undefined, [])
    const r = resolutions[0]
    // Library is empty → unresolved
    expect(r.status).toBe('unresolved')
  })
})

// ─── Numeric value emission rules ────────────────────────────────────────────

describe('numeric value emission (no letter suffixes in card)', () => {
  it('10k emits 10000 (not "10k")', () => {
    const circuit = makeCircuit([makePart('R1', '10k')])
    const [r] = resolveAll(circuit)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).not.toMatch(/10k/i)
      expect(r.model.card).toContain('10000')
    }
  })

  it('4.7u emits 4.7e-6 (not "4.7u")', () => {
    const circuit = makeCircuit([makePart('C1', '4.7u', 'Device:C')])
    const [r] = resolveAll(circuit)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).not.toMatch(/4\.7u/i)
      expect(r.model.card).toContain('4.7e-6')
    }
  })

  it('100n emits 1e-7 (not "100n")', () => {
    const circuit = makeCircuit([makePart('C1', '100n', 'Device:C')])
    const [r] = resolveAll(circuit)
    if (r.model?.kind === 'primitive') {
      expect(r.model.card).not.toMatch(/100n/i)
      expect(r.model.card).toContain('1e-7')
    }
  })
})
