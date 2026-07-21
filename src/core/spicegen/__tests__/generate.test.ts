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
 *   - alterPlan: netId change on dc-supply/logic-input/function-gen/voltage-probe → reload
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, test, expect } from 'vitest'
import { generateDeck, formatSpiceValue, alterPlan, instrumentSpiceName, buildLedSpiceNames, isLedPart, subcktTerminalConductivity, digitalVddNet } from '../generate'
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

  test('digitalVddNet resolves the VDD net and VSS-grounded flag', () => {
    const tpl = { power: { vcc: 'VCC', gnd: 'GND' } } as any
    const pinMap = { '14': 'VCC', '7': 'GND', '1': '1A' }
    const part = { padNet: new Map([['14', 4], ['7', 5], ['1', 1]]) }
    const netIdToNode = new Map([[4, 'vcc'], [5, '0'], [1, 'a']])
    const r = digitalVddNet(tpl, pinMap, part, netIdToNode)
    expect(r.vddNetId).toBe(4)
    expect(r.vssGrounded).toBe(true)
  })

  test('digitalVddNet reports vssGrounded=false when VSS pad is not on node 0', () => {
    const tpl = { power: { vcc: 'VCC', gnd: 'GND' } } as any
    const pinMap = { '14': 'VCC', '7': 'GND' }
    const part = { padNet: new Map([['14', 4], ['7', 6]]) }
    const netIdToNode = new Map([[4, 'vcc'], [6, 'notground']])
    const r = digitalVddNet(tpl, pinMap, part, netIdToNode)
    expect(r.vddNetId).toBe(4)
    expect(r.vssGrounded).toBe(false)
  })

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
    // Placeholder-only decks carry no digital bridges → no DCOP option either.
    expect(deckText).not.toContain('.options noopalter')
  })

  test('a deck with an EXPANDED digital part carries .options noopalter (feedback-logic DCOP wedge)', () => {
    // Verified against real ngspice-46 on a real board: digital feedback loops
    // (a CD40106 RC astable) have no consistent DC event fixpoint, so the
    // mixed-mode DCOP analog/event alternation never terminates and the WHOLE
    // board op fails. .options noopalter takes one event pass instead.
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
    expect(deck).toContain('.options noopalter')
    // Exactly once, even with several digital parts sharing a deck.
    expect(deck.filter((l) => l === '.options noopalter').length).toBe(1)
  })

  test('a deck with no digital parts never carries .options noopalter', () => {
    const circuit = makeRcCircuit()
    const deck = generateDeck({
      circuit,
      resolutions: makeRcResolutions(),
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
    })
    expect(deck).not.toContain('.options noopalter')
  })

  // ── Milestone 5c: two digital family files (74HC at 5 V, CD4000 at 12 V) ────

  const LOGIC4000_JSON = JSON.stringify({
    family: { vHighDefault: 12.0, adc: { inLowFrac: 0.3, inHighFrac: 0.7 }, schmittAdc: { inLowFrac: 0.4, inHighFrac: 0.6 } },
    templates: {
      CD4011: {
        gates: [
          { prim: 'd_nand', in: ['1A', '1B'], out: '1Y' },
          { prim: 'd_nand', in: ['2A', '2B'], out: '2Y' },
          { prim: 'd_nand', in: ['3A', '3B'], out: '3Y' },
          { prim: 'd_nand', in: ['4A', '4B'], out: '4Y' },
        ],
        inputs: ['1A', '1B', '2A', '2B', '3A', '3B', '4A', '4B'],
        outputs: ['1Y', '2Y', '3Y', '4Y'],
        power: { vcc: 'VCC', gnd: 'GND' },
        delaysNs: 60,
      },
      CD40106: {
        schmitt: true,
        gates: [{ prim: 'd_inverter', in: ['1A'], out: '1Y' }],
        inputs: ['1A'],
        outputs: ['1Y'],
        power: { vcc: 'VCC', gnd: 'GND' },
        delaysNs: 80,
      },
    },
  })

  test('CD4011 expands from logic4000.json even when logic74hc.json is ALSO present (12 V rails)', () => {
    // Regression: the template-file lookup used to hard-prefer logic74hc.json
    // whenever it was present, which would leave any CD4000 part as a
    // comment-only placeholder. The lookup must pick the file that actually
    // contains the templateId.
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD4011',
        pinMap: { '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    // d_nand with the CD4011 delays, NOT the placeholder comment.
    expect(deckText).toMatch(/d_nand\(rise_delay=60n fall_delay=60n\)/)
    expect(deckText).not.toContain('template text unavailable')
    // adc/dac rails from the CD4000 family vHigh=12: 30%/70% thresholds.
    expect(deckText).toContain('adc_bridge(in_low=3.6000 in_high=8.4000)')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=12.0000)')
  })

  test('CD40106 Schmitt template expands to a self-referential hysteresis B-source (40%/60% band, 4.8/7.2 V at 12 V)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD40106'
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD40106',
        pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    // 1A lives on node `a` (pad 1 → net 1), 1Y on node `b` (pad 2 → net 2).
    // Self-referential Schmitt B-source: state held in the output node voltage.
    expect(deckText).toContain('b_u1_1 b 0 V =')
    expect(deckText).toContain('v(b) >')
    expect(deckText).toContain('6.0000') // mid-rail
    expect(deckText).toContain('7.2000') // V_T+ (in_high, 60% of 12 V)
    expect(deckText).toContain('4.8000') // V_T- (in_low, 40% of 12 V)
    expect(deckText).toContain('12.0000') // rail
    // Exact emitted line.
    expect(deckText).toContain(
      'b_u1_1 b 0 V = (v(a) > (v(b) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000',
    )
    // The old adc/dac/primitive expansion is gone for Schmitt templates.
    expect(deckText).not.toContain('adc_bridge')
    expect(deckText).not.toContain('dac_bridge')
    expect(deckText).not.toContain('d_inverter')
  })

  test('74HC00 still expands from logic74hc.json (5 V rails) when both family files are loaded', () => {
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
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    expect(deckText).toMatch(/d_nand\(rise_delay=9n fall_delay=9n\)/)
    expect(deckText).toContain('adc_bridge(in_low=1.5000 in_high=3.5000)')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=5.0000)')
  })

  test('the SHIPPED resources/models files expand a CD4011 with 12 V rails (loader loads both family files)', () => {
    const dir = join(process.cwd(), 'resources', 'models')
    const texts: Record<string, string> = {}
    for (const f of readdirSync(dir)) {
      if (f === 'index.json') continue
      texts[f] = readFileSync(join(dir, f), 'utf8')
    }
    expect(texts['logic74hc.json'], 'shipped logic74hc.json').toBeTruthy()
    expect(texts['logic4000.json'], 'shipped logic4000.json').toBeTruthy()

    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD4011',
        pinMap: { '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: texts,
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=12.0000)')
    expect(deckText).toMatch(/d_nand\(/)
    expect(deckText).not.toContain('template text unavailable')
  })

  // ── Milestone M10: vHigh derived from the actual DC bench supply ────────────
  //
  // A CD4000 part runs at whatever VDD actually is. When the part's VDD pad net
  // has EXACTLY one dc-supply instrument directly attached (and its VSS pad is
  // on the ground net), the expansion uses that supply's voltage for the
  // dac_bridge out_high AND the adc thresholds (fractions × vHigh). Everything
  // else keeps the family vHighDefault — byte-identical to the pre-M10 decks.

  /** CD4011 fixture with full power pinMap: pad 14 → net 4 (VDD), pad 7 → net 5 (GND). */
  function makeCd4011Resolutions(): Resolution[] {
    return [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD4011',
        pinMap: { '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
  }

  test('M10: CD4011 with a 5 V dc-supply DIRECTLY on its VDD pad net derives vHigh=5', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const deck = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    // BOTH the dac rail and the adc thresholds scale off the supply (5 V):
    // 30 %/70 % of 5 V, same .toFixed(4) formatting as the default path.
    expect(deckText).toContain('.model adcm_u1 adc_bridge(in_low=1.5000 in_high=3.5000)')
    expect(deckText).toContain('.model dacm_u1 dac_bridge(out_low=0 out_high=5.0000)')
    expect(deckText).not.toContain('out_high=12.0000')
    // Provenance: the deck says where the rail came from.
    expect(deck).toContain('* U1 vhigh: 5 (dc-supply on VDD net; family default 12)')
  })

  test('rail precedence: manual override beats measured rail beats family default', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD40106'
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: { kind: 'xspice-digital', templateId: 'CD40106',
        pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' } },
    }]
    const base = {
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 5 } as any],
      groundNetId: 5,
      modelTexts: { 'logic4000.json': LOGIC4000_JSON },
    }
    // Family default (12 V): mid 6.0000, V_T+ 7.2000.
    expect(generateDeck(base).join('\n')).toContain('6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')
    // Measured rail 5 V (netId 4 = VDD): mid 2.5, V_T+ 3.0.
    expect(generateDeck({ ...base, measuredRailVHigh: new Map([[4, 5]]) }).join('\n'))
      .toContain('2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000')
    // Manual override 3.3 V beats the measured 5 V.
    expect(generateDeck({ ...base, measuredRailVHigh: new Map([[4, 5]]), railOverrides: new Map([[4, 3.3]]) }).join('\n'))
      .toContain('1.6500 ? 1.9800 : 1.3200)) ? 0 : 3.3000')
    // Tier 1: a direct dc-supply (9 V) on the VDD net beats BOTH an override and a
    // measured rail on the same net → mid 4.5, V_T+ 5.4, V_T- 3.6, rail 9.
    const withSupply = generateDeck({
      ...base,
      instruments: [{ kind: 'dc-supply', id: 'psu1', netId: 4, volts: 9, seriesOhms: 0.1 } as any, { kind: 'ground-ref', netId: 5 } as any],
      measuredRailVHigh: new Map([[4, 5]]),
      railOverrides: new Map([[4, 3.3]]),
    }).join('\n')
    expect(withSupply).toContain('4.5000 ? 5.4000 : 3.6000)) ? 0 : 9.0000')
    expect(withSupply).toContain('(dc-supply on VDD net;')
    expect(withSupply).not.toContain('3.3000')
    expect(withSupply).not.toContain('? 0 : 5.0000')
  })

  test('M10: CD40106 Schmitt thresholds scale too (40 %/60 % of a 5 V supply)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD40106'
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD40106',
        pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    // The Schmitt B-source thresholds all scale off the derived 5 V supply:
    // mid=2.5, V_T+=3.0 (60%), V_T-=2.0 (40%), rail=5.0.
    expect(deckText).toContain(
      'b_u1_1 b 0 V = (v(a) > (v(b) > 2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000',
    )
    expect(deckText).not.toContain('adc_bridge')
    expect(deckText).not.toContain('dac_bridge')
    expect(deckText).not.toContain('out_high=12.0000')
    // Provenance: the deck says where the rail came from.
    expect(deck).toContain('* U1 vhigh: 5 (dc-supply on VDD net; family default 12)')
  })

  test('M10: a supply attached ELSEWHERE keeps the 12 V family default (expansion byte-identical to a supply-less deck)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const deckSupplyElsewhere = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        // Supply on net 1 (input A) — NOT the VDD net. No tracing through parts.
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const text = deckSupplyElsewhere.join('\n')
    expect(text).toContain('.model adcm_u1 adc_bridge(in_low=3.6000 in_high=8.4000)')
    expect(text).toContain('.model dacm_u1 dac_bridge(out_low=0 out_high=12.0000)')
    expect(text).not.toContain('vhigh:')

    // The xspice expansion block is byte-identical to a deck with no supply at
    // all (pre-M10 behaviour): only instrument cards / island bleeds may differ.
    const deckNoSupply = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [{ kind: 'ground-ref', netId: 5 }],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    // The filter INCLUDES the `* <ref> vhigh:` provenance comment shape so a
    // wrongly-emitted derivation comment breaks the byte-identity comparison
    // itself (not just the not.toContain above).
    const expansionOf = (deck: string[]): string[] =>
      deck.filter(l => /^(\* xspice-digital|\* \w+ vhigh:|\.model (adcm_|dacm_|a_u1)|abr_u1|a_u1)/.test(l))
    expect(expansionOf(deckSupplyElsewhere)).toEqual(expansionOf(deckNoSupply))
  })

  test('M10: 74HC part with a 3.3 V supply on VCC derives 3.3 V rails/thresholds', () => {
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
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 3.3, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('adc_bridge(in_low=0.9900 in_high=2.3100)')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=3.3000)')
    expect(deck).toContain('* U1 vhigh: 3.3 (dc-supply on VDD net; family default 5)')
  })

  test('M10: TWO supplies on the VDD net → ambiguous → family default', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const deck = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
        { kind: 'dc-supply', id: '2', netId: 4, volts: 9, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=12.0000)')
    expect(deckText).toContain('adc_bridge(in_low=3.6000 in_high=8.4000)')
  })

  test('M10: VSS pad NOT on the ground net → family default (vHigh is measured supply-minus-0)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    // Rewire pad 7 (GND signal) onto net 2 (node 'b') — a lifted VSS.
    circuit.parts[0].padNet = new Map([['1', 1], ['2', 2], ['3', 3], ['7', 2], ['14', 4]])
    const deck = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('dac_bridge(out_low=0 out_high=12.0000)')
  })

  test('M10: a non-positive supply voltage on VDD → family default (degenerate rails rejected)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const deck = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 0, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    expect(deck.join('\n')).toContain('dac_bridge(out_low=0 out_high=12.0000)')
  })

  test('M10: a NEGATIVE or NaN supply voltage on VDD → family default (guard covers both)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    for (const volts of [-5, Number.NaN]) {
      const deck = generateDeck({
        circuit, resolutions: makeCd4011Resolutions(),
        instruments: [
          { kind: 'ground-ref', netId: 5 },
          { kind: 'dc-supply', id: '1', netId: 4, volts, seriesOhms: 0.1 },
        ],
        groundNetId: 5,
        modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
      })
      const text = deck.join('\n')
      expect(text, `volts=${volts} must fall back`).toContain('dac_bridge(out_low=0 out_high=12.0000)')
      expect(text, `volts=${volts} must not derive`).not.toContain('vhigh:')
    }
  })

  test('M10: two supplies on DIFFERENT nets, one of them on VDD → still derives (exactly-one is per-net)', () => {
    // The must-not-over-trigger side of rule 3: a second bench supply anywhere
    // ELSE on the board must not defeat the derivation for the one that IS
    // directly on the VDD net.
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    const deck = generateDeck({
      circuit, resolutions: makeCd4011Resolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
        // Second supply on net 1 (input A) — a different net entirely.
        { kind: 'dc-supply', id: '2', netId: 1, volts: 9, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const deckText = deck.join('\n')
    expect(deckText).toContain('.model adcm_u1 adc_bridge(in_low=1.5000 in_high=3.5000)')
    expect(deckText).toContain('.model dacm_u1 dac_bridge(out_low=0 out_high=5.0000)')
    expect(deck).toContain('* U1 vhigh: 5 (dc-supply on VDD net; family default 12)')
  })

  test('M10: a pin-map override splitting the VCC signal across two nets → family default (ambiguous VDD)', () => {
    const circuit = makeDigitalCircuit()
    circuit.parts[0].value = 'CD4011'
    // Pad 8 exists on the package and is wired to net 1 (node 'a'); a pin-map
    // override marks BOTH pad 14 (net 4) and pad 8 (net 1) as VCC.
    circuit.parts[0].padNet = new Map([['1', 1], ['2', 2], ['3', 3], ['7', 5], ['8', 1], ['14', 4]])
    const resolutions: Resolution[] = [{
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD4011',
        pinMap: { '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '8': 'VCC', '14': 'VCC' },
      },
    }]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [
        { kind: 'ground-ref', netId: 5 },
        { kind: 'dc-supply', id: '1', netId: 4, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 5,
      modelTexts: { 'logic74hc.json': LOGIC_JSON, 'logic4000.json': LOGIC4000_JSON },
    })
    const text = deck.join('\n')
    expect(text).toContain('dac_bridge(out_low=0 out_high=12.0000)')
    expect(text).not.toContain('vhigh:')
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

// ─── M11: LM339 quad comparator from the real bundled opamp.lib ───────────────

describe('generateDeck — LM339 quad comparator from the real bundled opamp.lib', () => {
  // Reads the actual resources/models/opamp.lib so it validates the shipped
  // LM339_QUAD wrapper (not a hand-rolled copy), like the mosfet.lib tests.
  const REAL_OPAMP_LIB = readFileSync(join(process.cwd(), 'resources', 'models', 'opamp.lib'), 'utf8')
  const modelTexts = { 'opamp.lib': REAL_OPAMP_LIB }

  test('LM339 on SOP-14: x_ card carries all 14 nets in wrapper-terminal order + 3-deep transitive inlining', () => {
    // A synthetic quad comparator with every pad on a named net, wired per the
    // TI LM339 DIP/SOIC-14 pinout (the comparator-lm339 pinMap).
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'C1P', spiceNode: 'c1p', padRefs: [] },
      { id: 2, kicadName: 'C1N', spiceNode: 'c1n', padRefs: [] },
      { id: 3, kicadName: 'O1', spiceNode: 'o1', padRefs: [] },
      { id: 4, kicadName: 'C2P', spiceNode: 'c2p', padRefs: [] },
      { id: 5, kicadName: 'C2N', spiceNode: 'c2n', padRefs: [] },
      { id: 6, kicadName: 'O2', spiceNode: 'o2', padRefs: [] },
      { id: 7, kicadName: 'C3P', spiceNode: 'c3p', padRefs: [] },
      { id: 8, kicadName: 'C3N', spiceNode: 'c3n', padRefs: [] },
      { id: 9, kicadName: 'O3', spiceNode: 'o3', padRefs: [] },
      { id: 10, kicadName: 'C4P', spiceNode: 'c4p', padRefs: [] },
      { id: 11, kicadName: 'C4N', spiceNode: 'c4n', padRefs: [] },
      { id: 12, kicadName: 'O4', spiceNode: 'o4', padRefs: [] },
      { id: 13, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
      { id: 14, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'LM339', libId: 'Package_SO:SOP-14_3.9x8.7mm_P1.27mm', layer: 'F',
      // DIP/SOIC-14: 1=OUT2 2=OUT1 3=VCC 4=IN1- 5=IN1+ 6=IN2- 7=IN2+
      //              8=IN3- 9=IN3+ 10=IN4- 11=IN4+ 12=GND 13=OUT4 14=OUT3
      padNet: new Map([
        ['1', 6], ['2', 3], ['3', 13], ['4', 2], ['5', 1], ['6', 5], ['7', 4],
        ['8', 8], ['9', 7], ['10', 11], ['11', 10], ['12', 14], ['13', 12], ['14', 9],
      ]),
      properties: {},
    }
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: {
          kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM339_QUAD',
          pinMap: {
            '1': 'out2', '2': 'out1', '3': 'vcc', '4': 'in1n', '5': 'in1p',
            '6': 'in2n', '7': 'in2p', '8': 'in3n', '9': 'in3p', '10': 'in4n',
            '11': 'in4p', '12': 'vee', '13': 'out4', '14': 'out3',
          },
        },
      },
    ]
    const deck = generateDeck({
      circuit: { nets, parts: [u1], warnings: [] },
      resolutions,
      instruments: [{ kind: 'ground-ref', netId: 14 }],
      groundNetId: 14,
      modelTexts,
    })
    // All 14 nets, in the wrapper's DECLARED terminal order
    // (in1p in1n out1 … in4p in4n out4 vcc vee) — every unit wired.
    const xLine = deck.find(l => l.startsWith('x_u1'))
    expect(xLine).toBe('x_u1 c1p c1n o1 c2p c2n o2 c3p c3n o3 c4p c4n o4 vcc 0 LM339_QUAD')
    // Transitive inlining, 3 levels deep: wrapper → LM393 cell → opamp_core.
    expect(deck.filter(l => /^\.subckt LM339_QUAD\b/i.test(l)).length).toBe(1)
    expect(deck.filter(l => /^\.subckt LM393\b/i.test(l)).length).toBe(1)
    expect(deck.filter(l => /^\.subckt opamp_core\b/i.test(l)).length).toBe(1)
    expect(deck.join('\n')).not.toContain('.include')
  })
})

// ─── M12: per-subckt terminal conductivity (sense-only terminals ≠ grounded) ──

describe('M12 — subckt terminal-conductivity analysis (real bundled opamp.lib)', () => {
  const REAL_OPAMP_LIB = readFileSync(join(process.cwd(), 'resources', 'models', 'opamp.lib'), 'utf8')

  test('opamp_core: every terminal is its own group — inp/inn/vcc/vee are sense-only, out conducts only to internal ground-referenced nodes', () => {
    // Body truth: bin/bg/rp/cp/bout tie e/vpole/obuf/out to internal node 0;
    // inp/inn appear ONLY inside the b-source expression (v(inp)-v(inn)) and
    // vcc/vee ONLY inside the clamp expression — none is a branch node. So no
    // TERMINAL conducts to another terminal.
    expect(subcktTerminalConductivity(REAL_OPAMP_LIB, 'opamp_core')).toEqual([
      ['inp'], ['inn'], ['out'], ['vcc'], ['vee'],
    ])
  })

  test('LM393 (one nesting level): bsw makes {out,vee} one conductive group; inp/inn/vcc stay sense-only', () => {
    expect(subcktTerminalConductivity(REAL_OPAMP_LIB, 'LM393')).toEqual([
      ['inp'], ['inn'], ['out', 'vee'], ['vcc'],
    ])
  })

  test('LM339_QUAD (two nesting levels): out1-4+vee one group via the four LM393 cells; all 8 inputs and vcc sense-only', () => {
    expect(subcktTerminalConductivity(REAL_OPAMP_LIB, 'LM339_QUAD')).toEqual([
      ['in1p'], ['in1n'],
      ['out1', 'out2', 'out3', 'out4', 'vee'],
      ['in2p'], ['in2n'], ['in3p'], ['in3n'], ['in4p'], ['in4n'],
      ['vcc'],
    ])
  })

  test('unknown subckt name → undefined (deck-gen falls back to the blanket union)', () => {
    expect(subcktTerminalConductivity(REAL_OPAMP_LIB, 'NO_SUCH_SUBCKT')).toBeUndefined()
  })

  test('b-source tokenization: the two explicit branch nodes conduct; v(...) expression references are NOT nodes', () => {
    const LIB = [
      '* fixture',
      '.subckt probe a b c d',
      'bx a b v = v(c) - v(d)',
      '.ends probe',
    ].join('\n')
    expect(subcktTerminalConductivity(LIB, 'probe')).toEqual([['a', 'b'], ['c'], ['d']])
  })

  test('e-source inside a body: output pair conducts, sense pair stays singleton (synthetic, E-mechanism only)', () => {
    // SYNTHETIC fixture isolating the E-source rule: the two source-branch
    // pairs union {vss,chg,dsg}; vdd appears only in sense positions. NOTE:
    // this is deliberately NOT the shipped BQ7791502 — the real power-ic.lib
    // body also carries `rq vdd vss 10Meg` (genuine conductance), which welds
    // vdd into the group. The real file is pinned in the suite below.
    const LIB = [
      '* fixture',
      '.subckt prot vdd vss chg dsg',
      'echg chg vss vdd vss 1',
      'edsg dsg vss vdd vss 1',
      '.ends prot',
    ].join('\n')
    expect(subcktTerminalConductivity(LIB, 'prot')).toEqual([['vdd'], ['vss', 'chg', 'dsg']])
  })
})

describe('M12 — terminal conductivity of every OTHER shipped lib (island-behavior pinning)', () => {
  // Real-text assertions mirroring the opamp.lib suite above: each expected
  // partition below is hand-derived from the shipped file. The point is that a
  // future .lib edit (adding/removing an rq-style resistor, changing a b-card
  // to sense a different node) FAILS a test here instead of silently changing
  // which board nets get island bleeds.
  const lib = (f: string): string => readFileSync(join(process.cwd(), 'resources', 'models', f), 'utf8')

  test('power-ic.lib BQ7791502: ONE full group — rq vdd->vss is genuine conductance, so vdd is NOT sense-only', () => {
    // echg {chg,vss} + edsg {dsg,vss} + rq {vdd,vss} → everything unions.
    expect(subcktTerminalConductivity(lib('power-ic.lib'), 'BQ7791502')).toEqual([
      ['vdd', 'vss', 'chg', 'dsg'],
    ])
  })

  test('power-ic.lib LTC4020: one full group (every pin has a resistive path to gnd)', () => {
    // bint {int,gnd}; rint {int,intvcc}; rtg1/rbg1/rtg2/rbg2 {tgN|bgN,gnd};
    // rq {vin,gnd} → all seven terminals reach gnd.
    expect(subcktTerminalConductivity(lib('power-ic.lib'), 'LTC4020')).toEqual([
      ['vin', 'intvcc', 'tg1', 'bg1', 'tg2', 'bg2', 'gnd'],
    ])
  })

  test('power-ic.lib AL8860: one full group (rctrl/rset/rq pull-ups + the bled sink branch)', () => {
    // bled {sw,gnd}; rctrl {ctrl,vin}; rset {vin,set}; rq {vin,gnd}.
    expect(subcktTerminalConductivity(lib('power-ic.lib'), 'AL8860')).toEqual([
      ['vin', 'set', 'sw', 'ctrl', 'gnd'],
    ])
  })

  test('mosfet.lib NCE6005AS: two independent channel groups {d1,g1,s1} / {d2,g2,s2}', () => {
    // m1/m2 each contribute their D/G/S triple (gate deliberately in scope —
    // the VDMOS cards carry gate capacitance, and a capacitor counts as a
    // path of ANY kind for island purposes; bulk is tied to source).
    expect(subcktTerminalConductivity(lib('mosfet.lib'), 'NCE6005AS')).toEqual([
      ['d1', 'g1', 's1'],
      ['d2', 'g2', 's2'],
    ])
  })

  test('regulators.lib reg_lin: one full group {vin,gnd,vout} — vin joins ONLY through the biq current source (pinned approximation)', () => {
    // breg {reg,gnd}; rpass {reg,rsen}; vsense {rsen,vout}; bilim {vout,gnd};
    // biq {vin,gnd}. NOTE biq is a CONSTANT-current b-card (`i = iq`) — an
    // ideal current source is not true conductance, but subcktBodyCardGroups
    // deliberately treats every b-card branch as conductive (documented
    // approximation; safe: merging can only suppress a bleed the blanket
    // union also suppressed). If biq is ever removed, vin becomes a singleton
    // and this test must be updated knowingly.
    expect(subcktTerminalConductivity(lib('regulators.lib'), 'reg_lin')).toEqual([
      ['vin', 'gnd', 'vout'],
    ])
  })

  test('regulators.lib 7805 / AMS1117-3.3 (one nesting level): inherit the full reg_lin group', () => {
    expect(subcktTerminalConductivity(lib('regulators.lib'), '7805')).toEqual([['vin', 'gnd', 'vout']])
    expect(subcktTerminalConductivity(lib('regulators.lib'), 'AMS1117-3.3')).toEqual([['vin', 'gnd', 'vout']])
  })

  test('regulators.lib TL431: one full group {k,a,ref} — ref joins through the constant bref current source (pinned approximation)', () => {
    // bshunt {k,a}; bref {ref,a} (`i = 2u`, same b-card approximation as biq).
    expect(subcktTerminalConductivity(lib('regulators.lib'), 'TL431')).toEqual([
      ['k', 'a', 'ref'],
    ])
  })

  test('timer555.lib NE555: {gnd,out,ctrl,disch,vcc} conduct; trig/reset/thres are sense-only comparator inputs', () => {
    // rdiv_a/b/c chain vcc–ctrl–n13–gnd; bout+rout reach out; bdisch reaches
    // disch; trig/reset/thres appear ONLY inside b-source expressions. So a
    // board net wired only to the 555's TRIG pin is a genuine island.
    expect(subcktTerminalConductivity(lib('timer555.lib'), 'NE555')).toEqual([
      ['gnd', 'out', 'ctrl', 'disch', 'vcc'],
      ['trig'],
      ['reset'],
      ['thres'],
    ])
  })
})

describe('M12 — sense-only subckt terminals in deck generation (real bundled opamp.lib)', () => {
  const REAL_OPAMP_LIB = readFileSync(join(process.cwd(), 'resources', 'models', 'opamp.lib'), 'utf8')
  const modelTexts = { 'opamp.lib': REAL_OPAMP_LIB }

  const LM339_PINMAP = {
    '1': 'out2', '2': 'out1', '3': 'vcc', '4': 'in1n', '5': 'in1p',
    '6': 'in2n', '7': 'in2p', '8': 'in3n', '9': 'in3p', '10': 'in4n',
    '11': 'in4p', '12': 'vee', '13': 'out4', '14': 'out3',
  }

  test('a net wired ONLY to a comparator input is a floating island (bled); driven/conductive nets are not', () => {
    // Pre-M12 the x-card blanket union welded all 14 terminals into one
    // grounded component, so the dangling sense net escaped the M8 bleed and
    // left a structurally singular matrix row. Unit-3's + input (pad 9) hangs
    // on a net touched by nothing else; every other input is biased through a
    // real resistor, the outputs carry pull-ups, vcc is bench-supplied.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'C1P', spiceNode: 'c1p', padRefs: [] },
      { id: 2, kicadName: 'C1N', spiceNode: 'c1n', padRefs: [] },
      { id: 3, kicadName: 'O1', spiceNode: 'o1', padRefs: [] },
      { id: 4, kicadName: 'C2P', spiceNode: 'c2p', padRefs: [] },
      { id: 5, kicadName: 'C2N', spiceNode: 'c2n', padRefs: [] },
      { id: 6, kicadName: 'O2', spiceNode: 'o2', padRefs: [] },
      { id: 7, kicadName: 'DANGLE', spiceNode: 'dangle', padRefs: [] },
      { id: 8, kicadName: 'C3N', spiceNode: 'c3n', padRefs: [] },
      { id: 9, kicadName: 'O3', spiceNode: 'o3', padRefs: [] },
      { id: 10, kicadName: 'C4P', spiceNode: 'c4p', padRefs: [] },
      { id: 11, kicadName: 'C4N', spiceNode: 'c4n', padRefs: [] },
      { id: 12, kicadName: 'O4', spiceNode: 'o4', padRefs: [] },
      { id: 13, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
      { id: 14, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'LM339', libId: 'Package_SO:SOP-14_3.9x8.7mm_P1.27mm', layer: 'F',
      padNet: new Map([
        ['1', 6], ['2', 3], ['3', 13], ['4', 2], ['5', 1], ['6', 5], ['7', 4],
        ['8', 8], ['9', 7], ['10', 11], ['11', 10], ['12', 14], ['13', 12], ['14', 9],
      ]),
      properties: {},
    }
    const biasCards: Array<[string, string]> = [
      ['R1', 'r_r1 c1p 0 100000'], ['R2', 'r_r2 c1n 0 100000'],
      ['R3', 'r_r3 c2p 0 100000'], ['R4', 'r_r4 c2n 0 100000'],
      ['R5', 'r_r5 c3n 0 100000'],
      ['R6', 'r_r6 c4p 0 100000'], ['R7', 'r_r7 c4n 0 100000'],
      ['R8', 'r_r8 vcc o1 10000'], ['R9', 'r_r9 vcc o2 10000'],
      ['R10', 'r_r10 vcc o3 10000'], ['R11', 'r_r11 vcc o4 10000'],
    ]
    const parts: Part[] = [
      u1,
      ...biasCards.map(([ref]): Part => ({
        ref, value: '10k', libId: 'R', layer: 'F', padNet: new Map(), properties: {},
      })),
    ]
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: { kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM339_QUAD', pinMap: LM339_PINMAP },
      },
      ...biasCards.map(([ref, card]): Resolution => ({
        ref, status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card },
      })),
    ]
    const deck = generateDeck({
      circuit: { nets, parts, warnings: [] },
      resolutions,
      instruments: [
        { kind: 'ground-ref', netId: 14 },
        { kind: 'dc-supply', id: '1', netId: 13, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 14,
      modelTexts,
    })
    const bleeds = deck.filter(l => l.startsWith('r_float_'))
    // ONLY the dangling sense net is an island. The biased inputs conduct via
    // their resistors, the outputs via the {out1..4,vee} internal group
    // (vee = 0), and vcc via the bench supply + pull-ups.
    expect(bleeds).toEqual(['r_float_1 dangle 0 1e9'])
  })
})

// ─── M8: floating-island bleed resistors ──────────────────────────────────────

describe('generateDeck — floating-island bleed resistors (M8)', () => {
  /**
   * Lantern-shaped fixture: a grounded R (R1) plus a dangling R pair (R38)
   * whose two nets have no path of ANY kind to node 0 — the real-board
   * `r_r38 _led3_k _gauge_c3 2200` case (LED strings off-board, connectors
   * resolved as open stubs). A floating R pair contributes matrix rows
   * [g, -g; -g, g] — structurally singular for every analysis, so a fresh
   * `tran … uic` aborts on the first step.
   */
  function makeIslandCircuit(): Circuit {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      { id: 3, kicadName: '/LED3_K', spiceNode: '_led3_k', padRefs: [] },
      { id: 4, kicadName: '/GAUGE_C3', spiceNode: '_gauge_c3', padRefs: [] },
    ]
    const r1: Part = {
      ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0805_2012Metric', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2]]), properties: {},
    }
    const r38: Part = {
      ref: 'R38', value: '2.2k', libId: 'Resistor_SMD:R_0402_1005Metric', layer: 'F',
      padNet: new Map([['1', 3], ['2', 4]]), properties: {},
    }
    return { nets, parts: [r1, r38], warnings: [] }
  }

  function makeIslandResolutions(): Resolution[] {
    return [
      {
        ref: 'R1', status: 'ok', tier: 2, warnings: [],
        model: { kind: 'primitive', card: 'r_r1 vin 0 10000' },
      },
      {
        ref: 'R38', status: 'ok', tier: 2, warnings: [],
        model: { kind: 'primitive', card: 'r_r38 _led3_k _gauge_c3 2200' },
      },
    ]
  }

  test('dangling R pair → exactly one 1G bleed per island net + provenance comment', () => {
    const deck = generateDeck({
      circuit: makeIslandCircuit(),
      resolutions: makeIslandResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 2 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 2,
    })
    const bleeds = deck.filter(l => l.startsWith('r_float_'))
    // Per-NET bleeds (not per-island): both island nets get one, in card order.
    expect(bleeds).toEqual(['r_float_1 _led3_k 0 1e9', 'r_float_2 _gauge_c3 0 1e9'])
    // Provenance comment sits directly above the group.
    const commentIdx = deck.indexOf('* floating-island bleed resistors (no DC path to ground)')
    expect(commentIdx).toBeGreaterThan(-1)
    expect(deck[commentIdx + 1]).toBe(bleeds[0])
  })

  test('grounded fixture gains no bleed lines', () => {
    const deck = generateDeck({
      circuit: makeRcCircuit(3),
      resolutions: makeRcResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 3 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 3,
    })
    expect(deck.some(l => l.startsWith('r_float_'))).toBe(false)
    expect(deck.join('\n')).not.toContain('floating-island')
  })

  test('R in series with C floating → EVERY island net gets a bleed (per-net, not per-island)', () => {
    // A capacitively-linked island needs a bleed on every net: one bleed per
    // ISLAND leaves the C-only side singular at DC (capacitor = open at DC).
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      { id: 3, kicadName: 'FA', spiceNode: 'fa', padRefs: [] },
      { id: 4, kicadName: 'FB', spiceNode: 'fb', padRefs: [] },
      { id: 5, kicadName: 'FC', spiceNode: 'fc', padRefs: [] },
    ]
    const circuit: Circuit = {
      nets,
      parts: [
        { ref: 'R1', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
        { ref: 'R2', value: '1k', libId: 'R', layer: 'F', padNet: new Map([['1', 3], ['2', 4]]), properties: {} },
        { ref: 'C1', value: '100n', libId: 'C', layer: 'F', padNet: new Map([['1', 4], ['2', 5]]), properties: {} },
      ],
      warnings: [],
    }
    const resolutions: Resolution[] = [
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 vin 0 10000' } },
      { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 fa fb 1000' } },
      { ref: 'C1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'c_c1 fb fc 1e-07' } },
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [
        { kind: 'ground-ref', netId: 2 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 2,
    })
    const bleeds = deck.filter(l => l.startsWith('r_float_'))
    expect(bleeds).toEqual([
      'r_float_1 fa 0 1e9',
      'r_float_2 fb 0 1e9',
      'r_float_3 fc 0 1e9',
    ])
  })

  test('bleeds are emitted after the element cards and before .save all', () => {
    const deck = generateDeck({
      circuit: makeIslandCircuit(),
      resolutions: makeIslandResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 2 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 2,
    })
    const bleedIdx = deck.findIndex(l => l.startsWith('r_float_'))
    const lastElementIdx = deck.findIndex(l => l.startsWith('r_r38'))
    const saveIdx = deck.indexOf('.save all')
    expect(bleedIdx).toBeGreaterThan(lastElementIdx)
    expect(bleedIdx).toBeLessThan(saveIdx)
  })

  test('bleed names are index-based so the convergence-culprit parser cannot mis-map them to a part', () => {
    // convergenceCulprit.ts maps instance tokens back to parts via
    // /(?:^|\.)[a-z][a-z0-9_]*_<ref>(?:$|[._])/ — so ANY name embedding the raw
    // spice node (r_float__gauge_c3, rfloat__gauge_c3, …) would false-positive
    // onto part C3 whenever the node ends (or contains a segment) shaped like a
    // refdes. Index-based names (r_float_1) can never match: a KiCad refdes is
    // letter-led, so no part ref equals a bare integer.
    const deck = generateDeck({
      circuit: makeIslandCircuit(),
      resolutions: makeIslandResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 2 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 2,
    })
    const bleedNames = deck
      .filter(l => l.startsWith('r_float_'))
      .map(l => l.split(/\s+/)[0])
    expect(bleedNames.length).toBeGreaterThan(0)
    for (const name of bleedNames) {
      expect(name).toMatch(/^r_float_\d+$/)
      // Demonstrate the hazard the naming avoids: the culprit-parser regex for a
      // part "C3" WOULD match a node-embedding name, but not the index name.
      const c3Regex = /(?:^|\.)[a-z][a-z0-9_]*_c3(?:$|[._])/
      expect(c3Regex.test('r_float__gauge_c3')).toBe(true) // node-embedding: mis-maps
      expect(c3Regex.test(name)).toBe(false)               // index-based: safe
    }
  })

  test('a net grounded only through a subckt terminal is NOT bled (x-card nodes union)', () => {
    // R5 links n_a–n_b; U1's subckt instance ties n_b and 0 together at its
    // terminals. The union-find must run over the FINAL emitted cards, so the
    // x_ card's terminal list grounds the whole component — no bleeds.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'NA', spiceNode: 'n_a', padRefs: [] },
      { id: 2, kicadName: 'NB', spiceNode: 'n_b', padRefs: [] },
      { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const circuit: Circuit = {
      nets,
      parts: [
        { ref: 'R5', value: '1k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
        { ref: 'U1', value: 'NE555', libId: 'Timer:NE555', layer: 'F', padNet: new Map([['1', 2], ['2', 3]]), properties: {} },
      ],
      warnings: [],
    }
    const resolutions: Resolution[] = [
      { ref: 'R5', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r5 n_a n_b 1000' } },
      {
        ref: 'U1', status: 'ok', tier: 1, warnings: [],
        model: { kind: 'subckt', libFile: 'timer555.lib', subcktName: 'ne555', pinMap: { '1': '1', '2': '2' } },
      },
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 3 }],
      groundNetId: 3,
    })
    expect(deck.some(l => l.startsWith('r_float_'))).toBe(false)
  })

  test('a net attached ONLY to an E-source sense terminal gets a bleed (sense pair = singletons)', () => {
    // A VCVS sense input carries NO conductance — a net whose only attachment
    // is tokens 3-4 of an e/g card contributes an empty matrix row, the same
    // singularity M8 exists to fix. The sense nodes must therefore be
    // REGISTERED (so they're bled when nothing else grounds them) but never
    // UNIONED with the driven output pair (which would fake a ground path).
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'EO', spiceNode: 'eo', padRefs: [] },
      { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      { id: 3, kicadName: 'SA', spiceNode: 'sa', padRefs: [] },
      { id: 4, kicadName: 'SB', spiceNode: 'sb', padRefs: [] },
    ]
    const circuit: Circuit = {
      nets,
      parts: [
        { ref: 'E1', value: 'VCVS', libId: 'Simulation:E', layer: 'F', padNet: new Map([['1', 1], ['2', 2], ['3', 3], ['4', 4]]), properties: {} },
      ],
      warnings: [],
    }
    const resolutions: Resolution[] = [
      { ref: 'E1', status: 'ok', tier: 1, warnings: [], model: { kind: 'primitive', card: 'e_e1 eo 0 sa sb 100000' } },
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 2 }],
      groundNetId: 2,
    })
    const bleeds = deck.filter(l => l.startsWith('r_float_'))
    // Output pair eo–0 is grounded by the source branch; each floating sense
    // net gets its own bleed.
    expect(bleeds).toEqual(['r_float_1 sa 0 1e9', 'r_float_2 sb 0 1e9'])
  })

  test('a primitive m card with a model + param tail never bleeds the model name as a phantom node', () => {
    // resolve.ts primitive cards are `<name> <one node per pad> <value…>` — a
    // discrete MOSFET footprint contributes 3 nodes (D/G/S; the 4-terminal
    // bulk-tied m cards come from generateDeck's model-card path, which
    // registers its nodes exactly). A naive "take 4" would swallow the model
    // name as a node whenever a param tail follows it.
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'MD', spiceNode: 'md', padRefs: [] },
      { id: 2, kicadName: 'MG', spiceNode: 'mg', padRefs: [] },
      { id: 3, kicadName: 'MS', spiceNode: 'ms', padRefs: [] },
      { id: 4, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const circuit: Circuit = {
      nets,
      parts: [
        { ref: 'Q9', value: 'AO3401', libId: 'M', layer: 'F', padNet: new Map([['1', 1], ['2', 2], ['3', 3]]), properties: {} },
        { ref: 'R1', value: '1k', libId: 'R', layer: 'F', padNet: new Map([['1', 4], ['2', 4]]), properties: {} },
      ],
      warnings: [],
    }
    const resolutions: Resolution[] = [
      { ref: 'Q9', status: 'ok', tier: 1, warnings: [], model: { kind: 'primitive', card: 'm_q9 md mg ms mpmos_gen l=1e-6' } },
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 0 0 1000' } },
    ]
    const deck = generateDeck({
      circuit, resolutions,
      instruments: [{ kind: 'ground-ref', netId: 4 }],
      groundNetId: 4,
    })
    const bleeds = deck.filter(l => l.startsWith('r_float_'))
    // The floating D/G/S island is bled per net — and ONLY those nets: the
    // model name (token 5) and the param tail must never appear as nodes.
    expect(bleeds).toEqual([
      'r_float_1 md 0 1e9',
      'r_float_2 mg 0 1e9',
      'r_float_3 ms 0 1e9',
    ])
  })

  test('golden decks are byte-identical (zero islands → strictly additive feature)', () => {
    // Belt-and-braces restatement of the M8 invariant: the grounded golden
    // fixtures must not change AT ALL. (The golden-equality tests above already
    // enforce this; this pins the reason to the island feature.)
    const deck = generateDeck({
      circuit: makeRcCircuit(3),
      resolutions: makeRcResolutions(),
      instruments: [
        { kind: 'ground-ref', netId: 3 },
        { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      ],
      groundNetId: 3,
      title: 'fixture-rc',
    })
    expect(deck.join('\n')).toBe(goldenFile('deck-rc-supply.txt'))
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

describe('alterPlan — netId change → reload (net rewire ≠ value alter)', () => {
  // Table-driven: one row per instrument kind whose branch previously never
  // compared netId (the fixed defect). Each row asserts BOTH halves:
  //   - net-only change  → reload (the fix)
  //   - value-only change → alter (pins the pre-existing, still-correct behavior)
  // Full literals (not spreads) per case: spreading across a discriminated
  // union defeats TS's narrowing on `kind`, so each variant is written out.
  const cases: Array<{ name: string; prev: Instrument; valueChanged: Instrument; netChanged: Instrument }> = [
    {
      name: 'dc-supply',
      prev:         { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
      valueChanged: { kind: 'dc-supply', id: '1', netId: 1, volts: 9, seriesOhms: 0.1 },
      netChanged:   { kind: 'dc-supply', id: '1', netId: 2, volts: 5, seriesOhms: 0.1 },
    },
    {
      name: 'logic-input',
      prev:         { kind: 'logic-input', id: '3', netId: 1, level: 0, vHigh: 5 },
      valueChanged: { kind: 'logic-input', id: '3', netId: 1, level: 1, vHigh: 5 },
      netChanged:   { kind: 'logic-input', id: '3', netId: 2, level: 0, vHigh: 5 },
    },
    {
      name: 'function-gen',
      prev: {
        kind: 'function-gen', id: '2', netId: 1,
        wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
      },
      valueChanged: {
        kind: 'function-gen', id: '2', netId: 1,
        wave: 'sine', freqHz: 2000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
      },
      netChanged: {
        kind: 'function-gen', id: '2', netId: 2,
        wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
      },
    },
    {
      name: 'voltage-probe',
      prev:         { kind: 'voltage-probe', id: 'p1', netId: 1, color: 'blue' },
      valueChanged: { kind: 'voltage-probe', id: 'p1', netId: 1, color: 'red' },
      netChanged:   { kind: 'voltage-probe', id: 'p1', netId: 2, color: 'blue' },
    },
  ]

  for (const { name, prev, valueChanged, netChanged } of cases) {
    test(`${name}: netId change (net rewire) → reload`, () => {
      const result = alterPlan(prev, netChanged)
      expect(result.kind).toBe('reload')
    })

    test(`${name}: value-only change (netId unchanged) → alter (unchanged behavior)`, () => {
      const result = alterPlan(prev, valueChanged)
      expect(result.kind).toBe('alter')
    })
  }
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
