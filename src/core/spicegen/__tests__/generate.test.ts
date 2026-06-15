/**
 * Tests for core/spicegen/generate.ts + instruments.ts
 *
 * Spec §8.8, §9. Tests cover:
 *   - Golden deck #1: fixture-rc + dc-supply on VIN (deterministic)
 *   - Golden deck #2: subckt part + current probe (ammeter splice, reload-path)
 *   - Numeric emission (4.7µF → "4.7e-06", no letter suffixes)
 *   - Function-gen sine/pulse sources
 *   - Logic-input DC card
 *   - Stub-open / stub-short element cards
 *   - Current-probe on primitive (no ammeter, .save @dev[i])
 *   - .save all present, .options savecurrents ABSENT
 *   - Every deck ends .end
 *   - Element names lowercase
 *   - alterPlan: dc-supply.volts → alter
 *   - alterPlan: logic-input.level → alter
 *   - alterPlan: function-gen freq/amp/offset → alter (SIN vector form)
 *   - alterPlan: function-gen wave type change → reload
 *   - alterPlan: current-probe on subckt → reload
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, test, expect } from 'vitest'
import { generateDeck, formatSpiceValue, alterPlan, instrumentSpiceName } from '../generate'
import type { Circuit, CircuitNet, Part } from '../../netlist/extract'
import type { Resolution } from '../../models/types'
import type { Instrument } from '../instruments'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function goldenFile(name: string): string {
  // Normalize CRLF→LF: git may check these text files out with CRLF on Windows,
  // but generated decks use LF. Comparison must be line-ending-agnostic.
  return readFileSync(join(__dirname, 'golden', name), 'utf8').replace(/\r\n/g, '\n').trimEnd()
}

/**
 * Build a minimal Circuit for fixture-rc:
 *   net 1 VIN → vin
 *   net 2 OUT → out
 *   net 3 GND → 0 (ground)
 *
 * Parts:
 *   R1: pad 1 → net 1 (VIN), pad 2 → net 2 (OUT)
 *   R2: pad 1 → net 2 (OUT), pad 2 → net 3 (GND)
 */
function makeRcCircuit(_groundNetId = 3): Circuit {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin',  padRefs: [{ ref: 'R1', pad: '1' }] },
    { id: 2, kicadName: 'OUT', spiceNode: 'out',  padRefs: [{ ref: 'R1', pad: '2' }, { ref: 'R2', pad: '1' }] },
    { id: 3, kicadName: 'GND', spiceNode: '0',    padRefs: [{ ref: 'R2', pad: '2' }] },
  ]

  const r1: Part = {
    ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0805_2012Metric',
    layer: 'F',
    padNet: new Map([['1', 1], ['2', 2]]),
    properties: {},
  }
  const r2: Part = {
    ref: 'R2', value: '10k', libId: 'Resistor_SMD:R_0805_2012Metric',
    layer: 'F',
    padNet: new Map([['1', 2], ['2', 3]]),
    properties: {},
  }

  return {
    nets,
    parts: [r1, r2],
    warnings: [],
  }
}

/** Tier-2 resolutions for R1 and R2 in fixture-rc. */
function makeRcResolutions(): Resolution[] {
  return [
    {
      ref: 'R1',
      status: 'ok',
      model: { kind: 'primitive', card: 'r_r1 vin out 10000' },
      tier: 2,
      warnings: [],
    },
    {
      ref: 'R2',
      status: 'ok',
      model: { kind: 'primitive', card: 'r_r2 out 0 10000' },
      tier: 2,
      warnings: [],
    },
  ]
}

// ─── Golden deck #1: fixture-rc + dc-supply 5V on VIN ─────────────────────────

describe('Golden deck #1 — fixture-rc + dc-supply on VIN', () => {
  test('matches golden file exactly', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()

    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]

    const deck = generateDeck({
      circuit,
      resolutions,
      instruments,
      groundNetId: 3,
      title: 'fixture-rc',
    })

    const expected = goldenFile('deck-rc-supply.txt')
    expect(deck.join('\n')).toBe(expected)
  })

  test('first line is a title comment', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [{ kind: 'ground-ref', netId: 3 }]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3, title: 'fixture-rc' })
    expect(deck[0]).toMatch(/^\* circsim deck/)
  })

  test('last line is .end', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [{ kind: 'ground-ref', netId: 3 }]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    expect(deck[deck.length - 1]).toBe('.end')
  })

  test('series-R splice: source-side synthetic node (vpsu_1_int), KiCad net vin preserved', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })

    // voltage source: vpsu_1_int to 0
    expect(deck).toContain('vpsu_1 vpsu_1_int 0 DC 5')
    // series R: from synthetic node to KiCad net
    expect(deck).toContain('rpsu_1 vpsu_1_int vin 0.1')
    // KiCad net 'vin' appears as a node in part elements (not _int)
    expect(deck).toContain('r_r1 vin out 10000')
  })

  test('no .options savecurrents line present', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [{ kind: 'ground-ref', netId: 3 }]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).not.toContain('.options savecurrents')
    expect(deckText).not.toContain('savecurrents')
  })

  test('.save all is present', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [{ kind: 'ground-ref', netId: 3 }]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    expect(deck).toContain('.save all')
  })

  test('all element names are lowercase', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    for (const line of deck) {
      if (line.startsWith('*') || line.startsWith('.')) continue
      // The first token of each element card should be lowercase
      const firstToken = line.split(/\s+/)[0]
      expect(firstToken).toBe(firstToken.toLowerCase())
    }
  })
})

// ─── Numeric emission ─────────────────────────────────────────────────────────

describe('formatSpiceValue — no letter suffixes', () => {
  test('4.7e-6 → "4.7e-06"', () => {
    expect(formatSpiceValue(4.7e-6)).toBe('4.7e-06')
  })

  test('1e-7 → "1e-07"', () => {
    expect(formatSpiceValue(1e-7)).toBe('1e-07')
  })

  test('10000 → "10000"', () => {
    expect(formatSpiceValue(10000)).toBe('10000')
  })

  test('0.22 → "0.22"', () => {
    expect(formatSpiceValue(0.22)).toBe('0.22')
  })

  test('470 → "470"', () => {
    expect(formatSpiceValue(470)).toBe('470')
  })

  test('0.1 → "0.1"', () => {
    expect(formatSpiceValue(0.1)).toBe('0.1')
  })

  test('0 → "0"', () => {
    expect(formatSpiceValue(0)).toBe('0')
  })

  test('1e-6 → "1e-06" (never "1u")', () => {
    const s = formatSpiceValue(1e-6)
    expect(s).not.toContain('u')
    expect(s).not.toContain('n')
    expect(s).not.toContain('k')
    expect(s).toBe('1e-06')
  })

  test('deck with 4.7µF cap emits "4.7e-06"', () => {
    // Build a simple C circuit
    const circuit: Circuit = {
      nets: [
        { id: 1, kicadName: 'A', spiceNode: 'a', padRefs: [{ ref: 'C1', pad: '1' }] },
        { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [{ ref: 'C1', pad: '2' }] },
      ],
      parts: [{
        ref: 'C1', value: '4.7u', libId: 'C',
        layer: 'F',
        padNet: new Map([['1', 1], ['2', 2]]),
        properties: {},
      }],
      warnings: [],
    }

    const resolutions: Resolution[] = [{
      ref: 'C1',
      status: 'ok',
      model: { kind: 'primitive', card: 'c_c1 a 0 4.7e-06' },
      tier: 2,
      warnings: [],
    }]

    const deck = generateDeck({
      circuit,
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
    })

    const deckText = deck.join('\n')
    expect(deckText).toContain('4.7e-06')
    // Must not contain letter suffix
    expect(deckText).not.toMatch(/\d+u\b/)
    expect(deckText).not.toMatch(/\d+n\b/)
  })
})

// ─── Function-gen sources ─────────────────────────────────────────────────────

describe('Function-gen sine source', () => {
  test('sine wave → SIN(<offset> <amp> <freq>)', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      {
        kind: 'function-gen', id: '2', netId: 1,
        wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0,
        outputOhms: 50,
      },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    // Source line contains SIN
    expect(deckText).toMatch(/vfgen_2.*SIN\(/)
    // Check specific form: SIN(0 1 1000)
    expect(deckText).toContain('SIN(0 1 1000)')
  })

  test('sine wave with non-zero offset → SIN(<offset> <amp> <freq>)', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      {
        kind: 'function-gen', id: '2', netId: 1,
        wave: 'sine', freqHz: 500, amplitudeV: 2.5, offsetV: 2.5,
        outputOhms: 50,
      },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).toContain('SIN(2.5 2.5 500)')
  })
})

describe('Function-gen pulse source', () => {
  test('pulse wave with 50% duty → PULSE(lo hi 0 rise fall width period)', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      {
        kind: 'function-gen', id: '2', netId: 1,
        wave: 'pulse', freqHz: 1000, amplitudeV: 2.5, offsetV: 2.5, dutyPct: 50,
        outputOhms: 50,
      },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).toMatch(/PULSE\(/)
    // lo = offsetV - ampV = 0, hi = offsetV + ampV = 5
    expect(deckText).toContain('PULSE(0 5')
    // period = 1/1000 = 0.001
    expect(deckText).toContain('0.001)')
  })
})

// ─── Logic-input ──────────────────────────────────────────────────────────────

describe('Logic-input', () => {
  test('logic level 1 with vHigh=5 → DC 5', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'logic-input', id: '3', netId: 1, level: 1, vHigh: 5 },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).toContain('vlogic_3')
    expect(deckText).toContain('DC 5')
  })

  test('logic level 0 → DC 0', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'logic-input', id: '3', netId: 1, level: 0, vHigh: 5 },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).toContain('DC 0')
  })
})

// ─── Current probe on primitive (R/C/L) ───────────────────────────────────────

describe('Current probe on primitive part', () => {
  test('primitive current probe on R1 → .save @r_r1[i], no extra element', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      { kind: 'current-probe', id: 'cp1', ref: 'R1', color: 'red' },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')

    // Should contain .save @r_r1[i]
    expect(deckText).toContain('.save @r_r1[i]')
    // Should NOT contain a vamm_ ammeter element
    expect(deckText).not.toContain('vamm_')
    // The R1 primitive card should still be present unchanged
    expect(deckText).toContain('r_r1 vin out 10000')
  })
})

// ─── Current probe on subckt → ammeter splice ─────────────────────────────────

describe('Current probe on subckt part (golden deck #2)', () => {
  function makeSubcktCircuit(): Circuit {
    // Simple 2-pin subckt: U1 with pins 1=input(vin), 2=output(0)
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [{ ref: 'U1', pad: '1' }] },
      { id: 2, kicadName: 'GND', spiceNode: '0',   padRefs: [{ ref: 'U1', pad: '2' }] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'NE555', libId: 'Timer:NE555',
      layer: 'F',
      padNet: new Map([['1', 1], ['2', 2]]),
      properties: {},
    }
    return { nets, parts: [u1], warnings: [] }
  }

  function makeSubcktResolution(): Resolution[] {
    return [{
      ref: 'U1',
      status: 'ok',
      model: {
        kind: 'subckt',
        libFile: 'timer555.lib',
        subcktName: 'ne555',
        pinMap: { '1': '1', '2': '2' },
      },
      tier: 1,
      warnings: [],
    }]
  }

  test('matches golden file (vamm_ ammeter at pad, reload-path)', () => {
    const circuit = makeSubcktCircuit()
    const resolutions = makeSubcktResolution()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 2 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      { kind: 'current-probe', id: 'probe1', ref: 'U1', pad: '1', color: 'blue' },
    ]

    const deck = generateDeck({
      circuit,
      resolutions,
      instruments,
      groundNetId: 2,
      title: 'subckt-ammeter-test',
    })

    const expected = goldenFile('deck-subckt-amm.txt')
    expect(deck.join('\n')).toBe(expected)
  })

  test('vamm_ ammeter is a 0 V voltage source (DC 0)', () => {
    const circuit = makeSubcktCircuit()
    const resolutions = makeSubcktResolution()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 2 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      { kind: 'current-probe', id: 'probe1', ref: 'U1', pad: '1', color: 'blue' },
    ]

    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 2, title: 'subckt-ammeter-test' })
    const deckText = deck.join('\n')

    expect(deckText).toContain('vamm_probe1')
    expect(deckText).toContain('DC 0')
    // .save @vamm_probe1[i]
    expect(deckText).toContain('.save @vamm_probe1[i]')
  })

  test('subckt x_ element uses internal ammeter node instead of original net', () => {
    const circuit = makeSubcktCircuit()
    const resolutions = makeSubcktResolution()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 2 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      { kind: 'current-probe', id: 'probe1', ref: 'U1', pad: '1', color: 'blue' },
    ]

    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 2, title: 'subckt-ammeter-test' })
    const xLine = deck.find(l => l.startsWith('x_u1'))
    expect(xLine).toBeDefined()
    // The x_u1 line should use the vamm_ internal node, not 'vin'
    expect(xLine).toContain('vamm_probe1_n')
    expect(xLine).not.toContain(' vin ')
  })
})

// ─── Stub parts ──────────────────────────────────────────────────────────────

describe('Stub-open part', () => {
  test('stub-open emits comment, no element cards', () => {
    const circuit = makeRcCircuit(3)
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'stubbed', model: { kind: 'stub', mode: 'open' }, tier: 6, warnings: [] },
      makeRcResolutions()[1],
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('R1: stubbed open')
    // No r_r1 element line (only the comment)
    const hasR1Card = deck.some(l => l.startsWith('r_r1'))
    expect(hasR1Card).toBe(false)
  })
})

describe('Stub-short part', () => {
  test('stub-short emits 1µΩ resistors tying all pads', () => {
    const circuit = makeRcCircuit(3)
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'stubbed', model: { kind: 'stub', mode: 'short' }, tier: 6, warnings: [] },
      makeRcResolutions()[1],
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
    })
    const deckText = deck.join('\n')
    // Should have a 1e-06 resistor
    expect(deckText).toContain('1e-06')
    expect(deckText).toMatch(/r_stub_r1/)
  })
})

// ─── Voltage probe ───────────────────────────────────────────────────────────

describe('Voltage probe', () => {
  test('voltage probe adds no element to the deck', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      { kind: 'voltage-probe', id: 'vp1', netId: 2, color: 'blue' },
    ]
    const deckWithProbe = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const instrumentsNoProbe: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]
    const deckWithout = generateDeck({ circuit, resolutions, instruments: instrumentsNoProbe, groundNetId: 3 })
    // Decks should be identical (voltage probes need no elements)
    expect(deckWithProbe).toEqual(deckWithout)
  })
})

// ─── XSPICE digital template ──────────────────────────────────────────────────

describe('XSPICE digital template', () => {
  test('xspice-digital resolution emits comment lines with adc/dac pattern reference', () => {
    const circuit: Circuit = {
      nets: [
        { id: 1, kicadName: 'IN', spiceNode: 'in', padRefs: [{ ref: 'U1', pad: '1' }] },
        { id: 2, kicadName: 'OUT', spiceNode: 'out', padRefs: [{ ref: 'U1', pad: '2' }] },
        { id: 3, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [{ ref: 'U1', pad: '14' }] },
        { id: 4, kicadName: 'GND', spiceNode: '0', padRefs: [{ ref: 'U1', pad: '7' }] },
      ],
      parts: [{
        ref: 'U1', value: '74HC00', libId: 'Logic:74HC00',
        layer: 'F',
        padNet: new Map([['1', 1], ['2', 2], ['14', 3], ['7', 4]]),
        properties: {},
      }],
      warnings: [],
    }

    const resolutions: Resolution[] = [{
      ref: 'U1',
      status: 'ok',
      model: { kind: 'xspice-digital', templateId: '74HC00', pinMap: { '1': '1', '2': '2', '14': '3', '7': '4' } },
      tier: 3,
      warnings: [],
    }]

    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 4 }],
      groundNetId: 4,
    })

    const deckText = deck.join('\n')
    expect(deckText).toContain('xspice-digital')
    expect(deckText).toContain('74HC00')
  })
})

// ─── Model-definition inlining (opts.modelTexts) ──────────────────────────────

describe('generateDeck — inlines model definitions when modelTexts is provided', () => {
  const NE555_LIB = [
    '* timer555.lib',
    '.subckt NE555 gnd trig out reset ctrl thres disch vcc',
    'rdiv_a vcc ctrl 5k',
    'rdiv_b ctrl n13 5k',
    'rdiv_c n13 gnd 5k',
    '.ends NE555',
  ].join('\n')

  const LED_LIB = [
    '* led.lib',
    '.model LED_RED D(is=1e-19 rs=2.0 n=1.7 cjo=30p vj=0.75 m=0.333',
    '+ bv=5 ibv=100u eg=1.9 xti=3)',
    '.model LED_GREEN D(is=1e-20 rs=3.0 n=1.8)',
  ].join('\n')

  /** Build a circuit with an NE555 (U1) and an LED (D1). */
  function make555LedCircuit(): Circuit {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      { id: 3, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
      { id: 4, kicadName: 'TRIG', spiceNode: 'trig', padRefs: [] },
      { id: 5, kicadName: 'LED_A', spiceNode: 'led_a', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'NE555', libId: 'Timer:NE555', layer: 'F',
      // pads 1..8 → gnd trig out reset ctrl thres disch vcc (identity by 555 pin)
      padNet: new Map([
        ['1', 2], ['2', 4], ['3', 3], ['4', 1], ['5', 1], ['6', 4], ['7', 1], ['8', 1],
      ]),
      properties: {},
    }
    const d1: Part = {
      ref: 'D1', value: 'LED', libId: 'LED:LED_0805', layer: 'F',
      // pad 1 → LED_A net, pad 2 → GND. pinMap {1:"2",2:"1"} (1=anode,2=cathode).
      padNet: new Map([['1', 5], ['2', 2]]),
      properties: {},
    }
    return { nets, parts: [u1, d1], warnings: [] }
  }

  function make555LedResolutions(): Resolution[] {
    return [
      {
        ref: 'U1', status: 'ok', tier: 1, warnings: [],
        model: {
          kind: 'subckt', libFile: 'timer555.lib', subcktName: 'NE555',
          // Sim.Pins map: pad → terminal NAME (uppercase as KiCad writes them)
          pinMap: { '1': 'GND', '2': 'TRIG', '3': 'OUT', '4': 'RESET', '5': 'CTRL', '6': 'THRES', '7': 'DISCH', '8': 'VCC' },
        },
      },
      {
        ref: 'D1', status: 'ok', tier: 3, warnings: [],
        // model-card resolves as subckt-kind in ResolvedModel (resolve.ts)
        model: { kind: 'subckt', libFile: 'led.lib', subcktName: 'LED_RED', pinMap: { '1': '2', '2': '1' } },
      },
    ]
  }

  const modelTexts = { 'timer555.lib': NE555_LIB, 'led.lib': LED_LIB }

  test('NE555 subckt: x_u1 nodes wired in DECLARED terminal order + .subckt inlined', () => {
    const circuit = make555LedCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: make555LedResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts,
    })
    const deckText = deck.join('\n')
    // Subckt declared order: gnd trig out reset ctrl thres disch vcc.
    // pads 1..8 map there → nodes: 0 trig out vcc vcc trig vcc vcc
    const xLine = deck.find(l => l.startsWith('x_u1'))
    expect(xLine).toBe('x_u1 0 trig out vcc vcc trig vcc vcc NE555')
    // The .subckt definition is inlined (loaded from memory, NOT .include'd).
    expect(deckText).toContain('.subckt NE555 gnd trig out reset ctrl thres disch vcc')
    expect(deckText).toContain('.ends NE555')
    expect(deckText).not.toContain('.include')
  })

  test('LED model-card: emits a diode device + inlines its (multi-line) .model card', () => {
    const circuit = make555LedCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: make555LedResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts,
    })
    const deckText = deck.join('\n')
    // D1 pinMap {1:"2",2:"1"} → position 1 (anode)=pad2=GND(0); position 2 (cathode)=pad1=led_a
    const dLine = deck.find(l => l.startsWith('d_d1'))
    expect(dLine).toBe('d_d1 0 led_a LED_RED')
    // The matching .model card is inlined, with its continuation joined.
    expect(deckText).toMatch(/\.model LED_RED D\(.*eg=1\.9.*\)/)
    // The unused LED_GREEN card is NOT pulled in (only referenced models inline).
    expect(deckText).not.toContain('LED_GREEN')
  })

  test('definitions are deduplicated when two parts share a model', () => {
    const circuit = make555LedCircuit()
    // add a second LED (D2) referencing the same LED_RED model
    circuit.parts.push({
      ref: 'D2', value: 'LED', libId: 'LED:LED_0805', layer: 'F',
      padNet: new Map([['1', 3], ['2', 2]]), properties: {},
    })
    const resolutions = make555LedResolutions()
    resolutions.push({
      ref: 'D2', status: 'ok', tier: 3, warnings: [],
      model: { kind: 'subckt', libFile: 'led.lib', subcktName: 'LED_RED', pinMap: { '1': '2', '2': '1' } },
    })
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2, modelTexts,
    })
    // Two diode devices…
    expect(deck.filter(l => l.startsWith('d_d')).length).toBe(2)
    // …but the .model LED_RED card appears exactly once.
    const modelCardCount = deck.filter(l => /^\.model LED_RED\b/.test(l)).length
    expect(modelCardCount).toBe(1)
  })

  test('without modelTexts the subckt path is unchanged (x_ instantiation, no defs)', () => {
    const circuit = make555LedCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: make555LedResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      // no modelTexts
    })
    const deckText = deck.join('\n')
    // Still instantiates the subckt and the (un-disambiguated) LED as x_ (legacy).
    expect(deck.some(l => l.startsWith('x_u1'))).toBe(true)
    // No inlined definitions section.
    expect(deckText).not.toContain('.subckt NE555')
    expect(deckText).not.toMatch(/^\.model LED_RED/m)
  })
})

describe('generateDeck — expands xspice-digital from a logic74hc template', () => {
  const LOGIC_JSON = JSON.stringify({
    family: { vHighDefault: 5.0, adc: { inLowFrac: 0.3, inHighFrac: 0.7 }, schmittAdc: { inLowFrac: 0.28, inHighFrac: 0.55 } },
    templates: {
      '74HC00': {
        gates: [
          { prim: 'd_nand', in: ['1A', '1B'], out: '1Y' },
          { prim: 'd_nand', in: ['2A', '2B'], out: '2Y' },
          { prim: 'd_nand', in: ['3A', '3B'], out: '3Y' },
          { prim: 'd_nand', in: ['4A', '4B'], out: '4Y' },
        ],
        inputs: ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'],
        outputs: ['1Y', '2Y', '3Y', '4Y'],
        power: { vcc: 'VCC', gnd: 'GND' },
        delaysNs: 9,
      },
    },
  })

  function makeDigitalCircuit(): Circuit {
    return {
      nets: [
        { id: 1, kicadName: 'A', spiceNode: 'a', padRefs: [] },
        { id: 2, kicadName: 'B', spiceNode: 'b', padRefs: [] },
        { id: 3, kicadName: 'Y', spiceNode: 'y', padRefs: [] },
        { id: 4, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
        { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      ],
      parts: [{
        ref: 'U1', value: '74HC00', libId: 'Logic:74HC00', layer: 'F',
        padNet: new Map([['1', 1], ['2', 2], ['3', 3], ['7', 5], ['14', 4]]),
        properties: {},
      }],
      warnings: [],
    }
  }

  test('emits adc_bridge → d_nand → dac_bridge wired to the board nets', () => {
    const circuit = makeDigitalCircuit()
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: '74HC00',
        pinMap: { '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON },
    })
    const deckText = deck.join('\n')
    // VERIFIED-against-ngspice-46 primitive name is d_nand (not nand).
    expect(deckText).toMatch(/d_nand\(rise_delay=9n fall_delay=9n\)/)
    // adc_bridge on input 1A reads the board net 'a' (pad 1 → net A → node a).
    expect(deckText).toMatch(/abr_u1_1a \[a\] \[u1_d_1a\]/)
    // dac_bridge drives output 1Y back onto board net 'y' (pad 3 → net Y → node y).
    expect(deckText).toMatch(/abr_u1_out_1y \[u1_d_1y\] \[y\]/)
    // adc/dac rails from vHigh=5.
    expect(deckText).toContain('adc_bridge(in_low=1.5000 in_high=3.5000)')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=5.0000)')
    // no .include
    expect(deckText).not.toContain('.include')
  })

  test('without modelTexts the xspice-digital placeholder comment is unchanged', () => {
    const circuit = makeDigitalCircuit()
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: { kind: 'xspice-digital', templateId: '74HC00', pinMap: { '1': '1A', '3': '1Y' } },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('xspice-digital')
    expect(deckText).not.toContain('d_nand')
  })
})

// ─── alterPlan ────────────────────────────────────────────────────────────────

describe('alterPlan — dc-supply.volts', () => {
  test('dc-supply volts change → alter with @vpsu_1[dc]', () => {
    const prev: Instrument = { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 }
    const next: Instrument = { kind: 'dc-supply', id: '1', netId: 1, volts: 9, seriesOhms: 0.1 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]).toContain('alter @vpsu_1[dc] 9')
    }
  })

  test('dc-supply volts to fractional value → alter with decimal form', () => {
    const prev: Instrument = { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 }
    const next: Instrument = { kind: 'dc-supply', id: '1', netId: 1, volts: 3.3, seriesOhms: 0.1 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toContain('3.3')
      expect(result.commands[0]).not.toMatch(/\d+[a-z]/i)  // no letter suffixes
    }
  })
})

describe('alterPlan — logic-input.level', () => {
  test('logic-input level 0→1 → alter with vHigh', () => {
    const prev: Instrument = { kind: 'logic-input', id: '3', netId: 1, level: 0, vHigh: 5 }
    const next: Instrument = { kind: 'logic-input', id: '3', netId: 1, level: 1, vHigh: 5 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toContain('alter @vlogic_3[dc] 5')
    }
  })

  test('logic-input level 1→0 → alter with 0', () => {
    const prev: Instrument = { kind: 'logic-input', id: '3', netId: 1, level: 1, vHigh: 5 }
    const next: Instrument = { kind: 'logic-input', id: '3', netId: 1, level: 0, vHigh: 5 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toContain('alter @vlogic_3[dc] 0')
    }
  })
})

describe('alterPlan — function-gen freq/amp/offset', () => {
  test('sine freq change → alter @vfgen_2[sin] [ vo va freq ] (exact spacing)', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 2000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      // Exact spacing: "alter @vfgen_2[sin] [ <vo> <va> <freq> ]"
      expect(result.commands[0]).toBe('alter @vfgen_2[sin] [ 0 1 2000 ]')
    }
  })

  test('sine amp change → alter with all params re-sent', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 2.5, offsetV: 0, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toBe('alter @vfgen_2[sin] [ 0 2.5 1000 ]')
    }
  })

  test('sine offset change → alter with all params re-sent', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 2.5, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toBe('alter @vfgen_2[sin] [ 2.5 1 1000 ]')
    }
  })

  test('pulse freq change → alter @vfgen_2[pulse] [ ... ]', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'pulse', freqHz: 1000, amplitudeV: 2.5, offsetV: 2.5, dutyPct: 50, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'pulse', freqHz: 2000, amplitudeV: 2.5, offsetV: 2.5, dutyPct: 50, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toContain('alter @vfgen_2[pulse] [')
      expect(result.commands[0]).toContain(']')
    }
  })
})

describe('alterPlan — wave type change → reload', () => {
  test('sine → pulse wave type change requires reload', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'pulse', freqHz: 1000, amplitudeV: 1, offsetV: 0, dutyPct: 50, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('reload')
  })

  test('pulse → sine wave type change requires reload', () => {
    const prev: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'pulse', freqHz: 1000, amplitudeV: 1, offsetV: 0, dutyPct: 50, outputOhms: 50,
    }
    const next: Instrument = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('reload')
  })
})

describe('alterPlan — current-probe on subckt → reload', () => {
  test('current probe added/changed on subckt part → reload', () => {
    const resolutions: Resolution[] = [{
      ref: 'U1',
      status: 'ok',
      model: { kind: 'subckt', libFile: 'lib.lib', subcktName: 'ne555', pinMap: {} },
      tier: 1,
      warnings: [],
    }]

    const prev: Instrument = { kind: 'current-probe', id: 'cp1', ref: 'U1', pad: '8', color: 'blue' }
    const next: Instrument = { kind: 'current-probe', id: 'cp1', ref: 'U1', pad: '1', color: 'blue' }

    const result = alterPlan(prev, next, resolutions)
    expect(result.kind).toBe('reload')
  })

  test('current probe on primitive also results in reload (conservative)', () => {
    const resolutions: Resolution[] = [{
      ref: 'R1',
      status: 'ok',
      model: { kind: 'primitive', card: 'r_r1 vin out 10000' },
      tier: 2,
      warnings: [],
    }]

    const prev: Instrument = { kind: 'current-probe', id: 'cp1', ref: 'R1', color: 'red' }
    const next: Instrument = { kind: 'current-probe', id: 'cp1', ref: 'R1', color: 'green' }

    const result = alterPlan(prev, next, resolutions)
    // Conservative: reload for any probe change
    expect(result.kind).toBe('reload')
  })
})

// ─── instrumentSpiceName ──────────────────────────────────────────────────────

describe('instrumentSpiceName', () => {
  test('dc-supply id="1" → vpsu_1', () => {
    const inst: Extract<Instrument, { id: string }> = {
      kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1,
    }
    expect(instrumentSpiceName(inst)).toBe('vpsu_1')
  })

  test('function-gen id="2" → vfgen_2', () => {
    const inst: Extract<Instrument, { id: string }> = {
      kind: 'function-gen', id: '2', netId: 1,
      wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
    }
    expect(instrumentSpiceName(inst)).toBe('vfgen_2')
  })

  test('logic-input id="3" → vlogic_3', () => {
    const inst: Extract<Instrument, { id: string }> = {
      kind: 'logic-input', id: '3', netId: 1, level: 1, vHigh: 5,
    }
    expect(instrumentSpiceName(inst)).toBe('vlogic_3')
  })
})

// ─── Deck structure invariants ────────────────────────────────────────────────

describe('Deck structure invariants', () => {
  test('no deck contains .tran or .op (SimHost issues analysis)', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
    ]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const deckText = deck.join('\n')
    expect(deckText).not.toMatch(/^\.tran/m)
    expect(deckText).not.toMatch(/^\.op$/m)
  })

  test('provenance comment tier labels present for each part', () => {
    const circuit = makeRcCircuit(3)
    const resolutions = makeRcResolutions()
    const instruments: Instrument[] = [{ kind: 'ground-ref', netId: 3 }]
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3 })
    const commentLine = deck.find(l => l.startsWith('*') && l.includes('tier'))
    expect(commentLine).toBeDefined()
    expect(commentLine).toContain('R1')
    expect(commentLine).toContain('R2')
    expect(commentLine).toContain('tier 2')
  })
})
