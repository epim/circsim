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
import { generateDeck, formatSpiceValue, alterPlan, instrumentSpiceName, buildLedSpiceNames, isLedPart } from '../generate'
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

  test('connector resolution (status ok, stub open) emits comment, no element cards', () => {
    // Connector auto-resolution emits { status: 'ok', model: stub open } —
    // the deck generator must treat it identically to a user stub-open.
    const circuit = makeRcCircuit(3)
    const resolutions: Resolution[] = [
      {
        ref: 'R1',
        status: 'ok',
        model: { kind: 'stub', mode: 'open' },
        tier: 6,
        warnings: ['R1 is a connector — stubbed open'],
      },
      makeRcResolutions()[1],
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('R1: stubbed open')
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

  test('LED model-card: splices a 0V ammeter on the anode + emits the diode + inlines its (multi-line) .model card', () => {
    const circuit = make555LedCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: make555LedResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts,
    })
    const deckText = deck.join('\n')
    // D1 pinMap {1:"2",2:"1"} → position 1 (anode)=pad2=GND(0); position 2 (cathode)=pad1=led_a.
    // The anode is spliced through a 0V series ammeter vsense_d1 into an internal
    // node, so the diode now drives from the internal node (ngspice-46 glow source).
    const senseLine = deck.find(l => l.startsWith('vsense_d1'))
    expect(senseLine).toBe('vsense_d1 0 0__ledsense_d1 DC 0')
    const dLine = deck.find(l => l.startsWith('d_d1'))
    expect(dLine).toBe('d_d1 0__ledsense_d1 led_a LED_RED')
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

  test('LED ammeter branch current is saved in the OP deck (.save i(vsense_d1))', () => {
    const circuit = make555LedCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: make555LedResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts,
    })
    // The LED's 0V series ammeter is vsense_d1 → its branch current is saved for
    // glow. The diode's own @d_d1[i] vector is NEVER saved (carries no data on
    // ngspice 46, and saving it kills the live transient stream).
    expect(deck).toContain('.save i(vsense_d1)')
    expect(deck.some(l => /^\.save @d_d1\[i\]/.test(l))).toBe(false)
    // Non-LED parts (the NE555 subckt) get no extra current save.
    expect(deck.filter(l => /^\.save i\(vsense_/.test(l))).toEqual(['.save i(vsense_d1)'])
  })

  test('buildLedSpiceNames maps each LED ref → its 0V ammeter (vsense) name', () => {
    const circuit = make555LedCircuit()
    const map = buildLedSpiceNames(make555LedResolutions(), circuit)
    expect(map.get('D1')).toBe('vsense_d1')
    // The NE555 (a non-LED subckt) is not an LED.
    expect(map.has('U1')).toBe(false)
  })

  test('isLedPart classifies an LED part, rejects a plain rectifier diode', () => {
    // LED: refdes Dx + value/libId mentions LED.
    expect(isLedPart({ ref: 'D1', value: 'LED', libId: 'LED:LED_0805', subcktName: 'LED_RED' })).toBe(true)
    expect(isLedPart({ ref: 'D7', value: 'RED', libId: 'Diode:LED_0603' })).toBe(true)
    // Plain rectifier diode (no LED anywhere) → not an LED.
    expect(isLedPart({ ref: 'D2', value: '1N4148', libId: 'Diode_SMD:D_SOD-123', subcktName: 'D1N4148' })).toBe(false)
    // Resistor → not an LED.
    expect(isLedPart({ ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0402' })).toBe(false)
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

// ─── model-card device letter from an unconventional refdes ───────────────────

describe('generateDeck — model-card device letter derives from the .model type', () => {
  test('a DZ-prefixed zener (model-card) emits a diode d_ card, not an x_ subckt call', () => {
    // DZ is a common zener refdes convention not in the primitive prefix map.
    // Because the resolution is a .model card (not a .subckt), the device letter
    // must come from the card's declared type (D → diode), never fall back to x_.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VREF', spiceNode: 'vref', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const dz1: Part = {
      ref: 'DZ1', value: '3.0V', libId: 'Diode_SMD:D_SOD-123', layer: 'F',
      padNet: new Map([['1', 2], ['2', 1]]), // pad1→GND, pad2→VREF
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'DZ1', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'DZ3V0', pinMap: { '1': '2', '2': '1' } },
      },
    ]
    const modelTexts = { 'diodes.lib': '.model DZ3V0 D(is=1n rs=0.6 bv=3.0 ibv=1m)' }
    const deck = generateDeck({
      circuit: { nets, parts: [dz1], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts,
    })
    expect(deck.some(l => l.startsWith('x_dz1'))).toBe(false)
    const dLine = deck.find(l => l.startsWith('d_dz1'))
    expect(dLine).toBeDefined()
    // pinMap {1:"2",2:"1"}: position1(anode)=pad2=VREF, position2(cathode)=pad1=GND.
    expect(dLine).toBe('d_dz1 vref 0 DZ3V0')
    // .model card inlined exactly once.
    expect(deck.filter(l => /^\.model DZ3V0\b/i.test(l)).length).toBe(1)
  })

  test('a PNP BJT model-card on an odd refdes (TR1) still emits a q_ card', () => {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'C', spiceNode: 'c', padRefs: [] },
      { id: 2, kicadName: 'B', spiceNode: 'b', padRefs: [] },
      { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const tr1: Part = {
      ref: 'TR1', value: 'BC557', libId: 'Package_TO_SOT_SMD:SOT-23', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2], ['3', 3]]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'TR1', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'bjt.lib', subcktName: 'QBC557', pinMap: { '1': '1', '2': '2', '3': '3' } },
      },
    ]
    const modelTexts = { 'bjt.lib': '.model QBC557 PNP(bf=200 is=1e-14)' }
    const deck = generateDeck({
      circuit: { nets, parts: [tr1], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
      modelTexts,
    })
    expect(deck.some(l => l.startsWith('x_tr1'))).toBe(false)
    expect(deck.find(l => l.startsWith('q_tr1'))).toBeDefined()
  })

  test('a VDMOS model-card on a Q refdes emits an m_ card with 4 terminals (bulk=source)', () => {
    // Q is a common MOSFET refdes; the refdes map would wrongly give a BJT `q`
    // letter, and a VDMOS device line needs 4 nodes (D G S B), not 3.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'DRAIN', spiceNode: 'drain', padRefs: [] },
      { id: 2, kicadName: 'GATE', spiceNode: 'gate', padRefs: [] },
      { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const q3: Part = {
      ref: 'Q3', value: 'AO3401', libId: 'Package_TO_SOT_SMD:SOT-23', layer: 'F',
      // pmos-generic pinMap {1:"2",2:"3",3:"1"}: pad1→pos2(G), pad2→pos3(S), pad3→pos1(D)
      padNet: new Map([['1', 2], ['2', 3], ['3', 1]]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'Q3', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'mosfet.lib', subcktName: 'MPMOS_GEN', pinMap: { '1': '2', '2': '3', '3': '1' } },
      },
    ]
    const modelTexts = { 'mosfet.lib': '.model MPMOS_GEN VDMOS(pchan=1 vto=-1.1 kp=18)' }
    const deck = generateDeck({
      circuit: { nets, parts: [q3], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
      modelTexts,
    })
    expect(deck.some(l => l.startsWith('q_q3'))).toBe(false)
    const mLine = deck.find(l => l.startsWith('m_q3'))
    expect(mLine).toBeDefined()
    // Terminal order D G S + bulk(=S): drain gate 0 0
    expect(mLine).toBe('m_q3 drain gate 0 0 MPMOS_GEN')
  })
})

// ─── transitive subckt inlining ───────────────────────────────────────────────

describe('generateDeck — inlines nested (transitive) subckt dependencies', () => {
  // An op-amp/comparator/regulator subckt that internally instantiates a shared
  // helper subckt (opamp_core, reg_lin). Inlining only the top-level block leaves
  // ngspice with "unknown subckt: … opamp_core".
  const OPAMP_LIB = [
    '* opamp.lib',
    '.subckt opamp_core inp inn out vcc vee',
    'e1 out 0 inp inn 100k',
    '.ends opamp_core',
    '.subckt LM393 inp inn out vcc vee',
    'xc inp inn dec vcc vee opamp_core',
    'rload dec out 1k',
    '.ends LM393',
  ].join('\n')

  function comparatorCircuit(): Circuit {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'INP', spiceNode: 'inp', padRefs: [] },
      { id: 2, kicadName: 'INN', spiceNode: 'inn', padRefs: [] },
      { id: 3, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
      { id: 4, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
      { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'LM393', libId: 'Package_SO:SOIC-8', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]),
      properties: {},
    }
    return { nets, parts: [u1], warnings: [] }
  }

  test('a subckt that instantiates a helper subckt inlines BOTH definitions', () => {
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: {
          kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM393',
          pinMap: { '1': 'inp', '2': 'inn', '3': 'out', '4': 'vcc', '5': 'vee' },
        },
      },
    ]
    const deck = generateDeck({
      circuit: comparatorCircuit(),
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: { 'opamp.lib': OPAMP_LIB },
    })
    const deckText = deck.join('\n')
    // Both the top-level subckt AND its nested dependency are present, once each.
    expect(deck.filter(l => /^\.subckt LM393\b/i.test(l)).length).toBe(1)
    expect(deck.filter(l => /^\.subckt opamp_core\b/i.test(l)).length).toBe(1)
    expect(deckText).toContain('.ends opamp_core')
  })

  test('resolves the nested subckt named before a `params:` tail (regulator form)', () => {
    // The 78xx/AMS1117 regulators instantiate reg_lin as `xr … reg_lin params: …`;
    // the dependency name is the token BEFORE params:, not the last token.
    const REG_LIB = [
      '* regulators.lib',
      '.subckt reg_lin vin gnd vout params: vreg=5.0 drop=2.0',
      'b1 vout gnd v=vreg',
      '.ends reg_lin',
      '.subckt 7805 vin gnd vout',
      'xr vin gnd vout reg_lin params: vreg=5.0 drop=2.0',
      '.ends 7805',
    ].join('\n')
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      { id: 3, kicadName: 'VOUT', spiceNode: 'vout', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: '7805', libId: 'Package_TO_SOT_SMD:TO-220', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2], ['3', 3]]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'regulators.lib', subcktName: '7805', pinMap: { '1': 'vin', '2': 'gnd', '3': 'vout' } },
      },
    ]
    const deck = generateDeck({
      circuit: { nets, parts: [u1], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
      modelTexts: { 'regulators.lib': REG_LIB },
    })
    expect(deck.filter(l => /^\.subckt 7805\b/i.test(l)).length).toBe(1)
    expect(deck.filter(l => /^\.subckt reg_lin\b/i.test(l)).length).toBe(1)
  })
})

// ─── Milestone 2: power-path discretes against the SHIPPED mosfet.lib ─────────

describe('generateDeck — power-path MOSFETs from the real bundled mosfet.lib', () => {
  // These tests read the actual resources/models/mosfet.lib so they validate the
  // shipped library content (not a hand-rolled copy), like library-content does.
  const REAL_MOSFET_LIB = readFileSync(join(process.cwd(), 'resources', 'models', 'mosfet.lib'), 'utf8')
  const modelTexts = { 'mosfet.lib': REAL_MOSFET_LIB }

  test('NCE4012S model-card on Q5 emits an m_ card with 4 nodes (D G S bulk=S)', () => {
    // SOP-8 pads: 1-3=S, 4=G, 5-8=D. The pinMap maps ONE representative pad per
    // terminal ({5:"1",4:"2",1:"3"}) — the generator emits one node per entry.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VBUS', spiceNode: 'vbus', padRefs: [] },
      { id: 2, kicadName: 'GATE', spiceNode: 'gate', padRefs: [] },
      { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const q5: Part = {
      ref: 'Q5', value: 'NCE4012S', libId: 'SOP-8_L4.9-W3.9-P1.27-LS6.0-BL', layer: 'F',
      padNet: new Map([
        ['1', 3], ['2', 3], ['3', 3], ['4', 2], ['5', 1], ['6', 1], ['7', 1], ['8', 1],
      ]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'Q5', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'mosfet.lib', subcktName: 'MNCE4012S', pinMap: { '5': '1', '4': '2', '1': '3' } },
      },
    ]
    const deck = generateDeck({
      circuit: { nets, parts: [q5], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
      modelTexts,
    })
    expect(deck.some(l => l.startsWith('x_q5'))).toBe(false)
    const mLine = deck.find(l => l.startsWith('m_q5'))
    // Terminal order D G S + bulk(=S): vbus gate 0 0
    expect(mLine).toBe('m_q5 vbus gate 0 0 MNCE4012S')
    // The real .model card is inlined exactly once.
    expect(deck.filter(l => /^\.model MNCE4012S\b/i.test(l)).length).toBe(1)
  })

  test('NCE6005AS dual-FET subckt on Q2: x_ card in declared terminal order + block inlined with its inner .model', () => {
    // Back-to-back battery-protection wiring: d1=PACK+, s1=s2=COM, d2=OUT.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'PACK', spiceNode: 'pack', padRefs: [] },
      { id: 2, kicadName: 'G1', spiceNode: 'g1drv', padRefs: [] },
      { id: 3, kicadName: 'COM', spiceNode: 'com', padRefs: [] },
      { id: 4, kicadName: 'OUT', spiceNode: 'outn', padRefs: [] },
      { id: 5, kicadName: 'G2', spiceNode: 'g2drv', padRefs: [] },
      { id: 6, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const q2: Part = {
      ref: 'Q2', value: 'NCE6005AS', libId: 'JLC-MCP:SOP-8_L4.9-W3.9-P1.27-LS6.0-BL', layer: 'F',
      // SOP-8 dual pinout: 1=S1 2=G1 3=S2 4=G2 5,6=D2 7,8=D1
      padNet: new Map([
        ['1', 3], ['2', 2], ['3', 3], ['4', 5], ['5', 4], ['6', 4], ['7', 1], ['8', 1],
      ]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'Q2', status: 'ok', tier: 3, warnings: [],
        model: {
          kind: 'subckt', libFile: 'mosfet.lib', subcktName: 'NCE6005AS',
          pinMap: { '7': 'd1', '2': 'g1', '1': 's1', '5': 'd2', '4': 'g2', '3': 's2' },
        },
      },
    ]
    const deck = generateDeck({
      circuit: { nets, parts: [q2], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 6 }],
      groundNetId: 6,
      modelTexts,
    })
    const deckText = deck.join('\n')
    // Nodes wired in the subckt's DECLARED terminal order d1 g1 s1 d2 g2 s2.
    const xLine = deck.find(l => l.startsWith('x_q2'))
    expect(xLine).toBe('x_q2 pack g1drv com outn g2drv com NCE6005AS')
    // The .subckt block is inlined once — and because the VDMOS .model card lives
    // INSIDE the block, the definition arrives with it (no dangling model ref).
    expect(deck.filter(l => /^\.subckt NCE6005AS\b/i.test(l)).length).toBe(1)
    expect(deckText).toContain('.ends NCE6005AS')
    expect(deckText).toMatch(/\.model \S+ VDMOS\([^)]*vto=1\.6/i)
    expect(deckText).not.toContain('.include')
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

// ─── Potentiometer deck emission ──────────────────────────────────────────────

/**
 * Minimal 3-net circuit for pot tests:
 *   net 1 HI → hi
 *   net 2 W  → w (wiper)
 *   net 3 LO → 0 (ground)
 * No parts (the pot itself supplies the resistors).
 */
function makePotCircuit(): Circuit {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'HI', spiceNode: 'hi', padRefs: [] },
    { id: 2, kicadName: 'W',  spiceNode: 'w',  padRefs: [] },
    { id: 3, kicadName: 'LO', spiceNode: '0',  padRefs: [] },
  ]
  return { nets, parts: [], warnings: [] }
}

/** Pull the value (last token) of a deck card by its element name. */
function cardValue(deck: string[], name: string): string | undefined {
  const line = deck.find(l => l.split(/\s+/)[0] === name)
  if (!line) return undefined
  const toks = line.split(/\s+/)
  return toks[toks.length - 1]
}

describe('Potentiometer — rheostat deck emission', () => {
  function rheostatDeck(wiperPct: number): string[] {
    const circuit = makePotCircuit()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct },
    ]
    return generateDeck({ circuit, resolutions: [], instruments, groundNetId: 3 })
  }

  test('wiperPct 0 → resistor clamped to RMIN (1Ω), stable name rpot_p1, nets hi–w', () => {
    const deck = rheostatDeck(0)
    const line = deck.find(l => l.startsWith('rpot_p1 '))
    expect(line).toBeDefined()
    expect(line).toBe('rpot_p1 hi w 1')
  })

  test('wiperPct 0.5 → totalOhms*0.5 = 5000', () => {
    const deck = rheostatDeck(0.5)
    expect(cardValue(deck, 'rpot_p1')).toBe('5000')
  })

  test('wiperPct 1 → totalOhms = 10000 (full)', () => {
    const deck = rheostatDeck(1)
    expect(cardValue(deck, 'rpot_p1')).toBe('10000')
  })
})

describe('Potentiometer — divider deck emission', () => {
  function dividerDeck(wiperPct: number): string[] {
    const circuit = makePotCircuit()
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 3 },
      { kind: 'potentiometer', mode: 'divider', id: 'p2', netHi: 1, netW: 2, netLo: 3, totalOhms: 10000, wiperPct },
    ]
    return generateDeck({ circuit, resolutions: [], instruments, groundNetId: 3 })
  }

  test('wiperPct 0.5 → two equal 5000Ω resistors with stable names, correct nets', () => {
    const deck = dividerDeck(0.5)
    // upper: netHi–netW = totalOhms*(1-wiperPct); lower: netW–netLo = totalOhms*wiperPct
    expect(deck.find(l => l.startsWith('rpot_p2_a '))).toBe('rpot_p2_a hi w 5000')
    expect(deck.find(l => l.startsWith('rpot_p2_b '))).toBe('rpot_p2_b w 0 5000')
  })

  test('wiperPct 0 → upper full (10000), lower clamped to RMIN (1)', () => {
    const deck = dividerDeck(0)
    expect(cardValue(deck, 'rpot_p2_a')).toBe('10000')
    expect(cardValue(deck, 'rpot_p2_b')).toBe('1')
  })

  test('wiperPct 1 → upper clamped to RMIN (1), lower full (10000)', () => {
    const deck = dividerDeck(1)
    expect(cardValue(deck, 'rpot_p2_a')).toBe('1')
    expect(cardValue(deck, 'rpot_p2_b')).toBe('10000')
  })
})

// ─── alterPlan — potentiometer ────────────────────────────────────────────────

describe('alterPlan — potentiometer wiperPct → alter', () => {
  test('rheostat wiperPct change → alter targeting rpot_<id> with new ohms (NOT reload)', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.8 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]).toBe('alter rpot_p1 8000')
    }
  })

  test('divider wiperPct change → two alters on rpot_<id>_a / _b with new ohms (NOT reload)', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p2', netHi: 1, netW: 2, netLo: 3, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p2', netHi: 1, netW: 2, netLo: 3, totalOhms: 10000, wiperPct: 0.25 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands).toContain('alter rpot_p2_a 7500')  // totalOhms*(1-0.25)
      expect(result.commands).toContain('alter rpot_p2_b 2500')  // totalOhms*0.25
    }
  })

  test('wiperPct change to extreme clamps to RMIN in the alter command', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('alter')
    if (result.kind === 'alter') {
      expect(result.commands[0]).toBe('alter rpot_p1 1')
    }
  })

  test('changing totalOhms → reload (not alter)', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 50000, wiperPct: 0.5 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('reload')
  })

  test('changing a net → reload', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 4, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('reload')
  })

  test('changing mode → reload', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: 1, netW: 2, netLo: 3, totalOhms: 10000, wiperPct: 0.5 }
    const result = alterPlan(prev, next)
    expect(result.kind).toBe('reload')
  })

  test('alter command carries no letter suffix (valid ngspice ohms)', () => {
    const prev: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.5 }
    const next: Instrument = { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: 1, netW: 2, totalOhms: 10000, wiperPct: 0.33 }
    const result = alterPlan(prev, next)
    if (result.kind === 'alter') {
      expect(result.commands[0]).not.toMatch(/\d+[a-z]/i)
    }
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
