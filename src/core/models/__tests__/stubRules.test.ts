/**
 * Tests for the automatic stub rules (issue #29): microcontrollers, addressable
 * LEDs and USB-serial bridges resolve to supply-load stubs, controllers of an
 * unlisted series to interactive pins, crystals to documented opens, and every
 * one of them says what it is.
 *
 * Pure Node, no ngspice. The deck behavior of the stubs is checked in
 * src/simhost/__tests__/stub-supply-load.integration.test.ts and the supply
 * currents in the characterization rows.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { matchLibraryEntry } from '../libraryMatch'
import { resolveAll, type BomData } from '../resolve'
import {
  STUB_NOTE_PREFIX,
  STUB_RULES,
  classifyStubPart,
  findSupplyPads,
} from '../stubRules'
import type { LibraryEntry } from '../types'
import type { Circuit, CircuitNet, Part } from '../../netlist/extract'
import { bundledLibrary, simInfo } from './p2-helpers'

// ─── builders ─────────────────────────────────────────────────────────────────

interface NetSpec { id: number; name: string; spiceNode?: string }

function circuitOf(parts: Part[], nets: NetSpec[]): Circuit {
  const circuitNets: CircuitNet[] = nets.map(n => ({
    id: n.id,
    kicadName: n.name,
    spiceNode: n.spiceNode ?? n.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
    padRefs: [],
  }))
  return { nets: circuitNets, parts, warnings: [] }
}

function partOn(
  ref: string,
  value: string,
  libId: string,
  pads: Record<string, number>,
  properties: Record<string, string> = {},
): Part {
  return { ref, value, libId, layer: 'F', padNet: new Map(Object.entries(pads)), properties }
}

const GND: NetSpec = { id: 1, name: 'GND', spiceNode: '0' }
const V33: NetSpec = { id: 2, name: '+3V3' }
const SIG: NetSpec = { id: 4, name: '/GPIO_A' }

const library = bundledLibrary()

/** A one-part board: the part's supply pad 2 on +3V3, ground pad 1, a signal on pad 3. */
function singlePart(ref: string, value: string, libId: string, properties: Record<string, string> = {}) {
  const part = partOn(ref, value, libId, { '1': 1, '2': 2, '3': 4 }, properties)
  return { part, circuit: circuitOf([part], [GND, V33, SIG]) }
}

// ─── classification ───────────────────────────────────────────────────────────

describe('classifyStubPart: which parts get a stub', () => {
  const supplyLoad: Array<[string, string, string, string, Record<string, string>?]> = [
    // [ref, value, libId, expected entry id, properties]
    ['U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32', 'stub-mcu-esp32'],
    ['U1', 'ESP32-S3-WROOM-1', 'RF_Module:ESP32-S3-WROOM-1', 'stub-mcu-esp32'],
    ['U1', 'MCU', 'RF_Module:ESP32-C3-MINI-1', 'stub-mcu-esp32'],
    ['U1', 'MCU', 'Package_DFN_QFN:QFN-48', 'stub-mcu-esp32', { MPN: 'ESP32-WROOM-32E' }],
    ['U1', 'ESP-12E', 'RF_Module:ESP-12E', 'stub-mcu-esp8266'],
    ['U1', 'ESP8266EX', 'Package_DFN_QFN:QFN-32', 'stub-mcu-esp8266'],
    ['U2', 'STM32F103C8T6', 'Package_QFP:LQFP-48_7x7mm_P0.5mm', 'stub-mcu-stm32f1'],
    ['U2', 'STM32F407VGT6', 'Package_QFP:LQFP-100_14x14mm_P0.5mm', 'stub-mcu-stm32f4'],
    ['U2', 'STM32G031K8T6', 'Package_QFP:LQFP-32_7x7mm_P0.8mm', 'stub-mcu-stm32-lowpower'],
    ['U3', 'ATmega328P-AU', 'Package_QFP:TQFP-32_7x7mm_P0.8mm', 'stub-mcu-atmega'],
    ['A1', 'Arduino_Nano', 'Module:Arduino_Nano', 'stub-mcu-atmega'],
    ['U3', 'ATtiny85-20PU', 'Package_DIP:DIP-8_W7.62mm', 'stub-mcu-attiny'],
    ['U4', 'RP2040', 'Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm', 'stub-mcu-rp2040'],
    ['U4', 'MCU', 'Module:RaspberryPi_Pico_Common_THT', 'stub-mcu-rp2040'],
    ['U5', 'nRF52840-QIAA', 'Package_DFN_QFN:QFN-73', 'stub-mcu-nrf52'],
    ['U6', 'ATSAMD21G18A-AU', 'Package_QFP:TQFP-48_7x7mm_P0.5mm', 'stub-mcu-samd21'],
    ['U7', 'CH32V003F4P6', 'Package_SO:TSSOP-20', 'stub-mcu-ch32v003'],
    ['U8', 'MSP430G2553IPW20', 'Package_SO:TSSOP-20', 'stub-mcu-msp430'],
    ['D1', 'WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm', 'stub-ws2812b'],
    ['D2', 'NeoPixel', 'LED_SMD:LED_WS2812-2020', 'stub-ws2812b'],
    ['U9', 'CH340C', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', 'stub-ch340'],
    ['U9', 'CH340G', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', 'stub-ch340'],
  ]
  it.each(supplyLoad)('%s %s (%s) -> %s', (ref, value, libId, entryId, props) => {
    const cls = classifyStubPart(partOn(ref, value, libId, {}, props ?? {}))
    expect(cls?.kind).toBe('supply-load')
    if (cls?.kind === 'supply-load') expect(cls.rule.entryId).toBe(entryId)
  })

  it.each([
    ['STM32U575RIT6', 'Package_QFP:LQFP-64'],
    ['PIC16F877A-I/P', 'Package_DIP:DIP-40_W15.24mm'],
    ['LPC1768FBD100', 'Package_QFP:LQFP-100'],
    ['GD32F103C8T6', 'Package_QFP:LQFP-48'],
    ['MCU', 'MCU_ST_STM32F1:LQFP-48'],
  ])('%s (%s) is a controller with no bundled supply current', (value, libId) => {
    const cls = classifyStubPart(partOn('U1', value, libId, {}))
    expect(cls?.kind).toBe('controller')
  })

  it.each([
    ['R1', '10k', 'Resistor_SMD:R_0805_2012Metric'],
    ['C1', 'ATmega328P', 'Capacitor_SMD:C_0805_2012Metric'],
    ['J1', 'ESP32-WROOM-32', 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical'],
    ['TP1', 'ESP32', 'TestPoint:TestPoint_Pad_D1.0mm'],
    ['U1', 'LM358', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'],
    ['U1', '3V3', 'Package_TO_SOT_SMD:SOT-23-5'],
    ['U1', '74HC595', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm'],
    ['Q1', '2N7002', 'Package_TO_SOT_SMD:SOT-23'],
    ['Y1', 'FOO', 'Package_TO_SOT_SMD:SOT-23'],
  ])('%s %s (%s) is not stubbed', (ref, value, libId) => {
    expect(classifyStubPart(partOn(ref, value, libId, {}))).toBeNull()
  })

  it.each([
    ['Y1', '8MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm'],
    ['X1', '12.0MHz', 'Package_TO_SOT_SMD:SOT-23'],
    ['Y2', '32.768kHz', 'Crystal:Crystal_C26-LF_D2.1mm_L6.5mm'],
    ['Y3', 'Ceramic resonator', 'Crystal:Resonator_SMD_Murata_CSTxExxV-3Pin_3.0x1.1mm'],
  ])('%s %s is a crystal', (ref, value, libId) => {
    expect(classifyStubPart(partOn(ref, value, libId, {}))?.kind).toBe('crystal')
  })
})

// ─── pad discovery ────────────────────────────────────────────────────────────

describe('findSupplyPads: the supply and ground pads of a stubbed part', () => {
  it('finds them from the net names, ground by the ground net', () => {
    const part = partOn('U1', 'x', 'p', { '1': 1, '2': 2, '3': 4 })
    expect(findSupplyPads(part, circuitOf([part], [GND, V33, SIG]), undefined)).toEqual({ vdd: '2', gnd: '1', via: 'net-names' })
  })

  it('prefers a digital supply name over an analog one and a rail name over VBUS', () => {
    const nets: NetSpec[] = [GND, { id: 2, name: '+3V3' }, { id: 5, name: '/VDDA' }, { id: 6, name: 'VBUS' }]
    const part = partOn('U1', 'x', 'p', { '1': 1, '2': 5, '3': 6, '4': 2 })
    expect(findSupplyPads(part, circuitOf([part], nets), undefined)?.vdd).toBe('4')
  })

  it('reads the sheet-path form of a rail name (/Power/+3V3, VDD_3V3)', () => {
    const part = partOn('U1', 'x', 'p', { '1': 1, '7': 7 })
    const nets: NetSpec[] = [GND, { id: 7, name: '/Power/VDD_3V3' }]
    expect(findSupplyPads(part, circuitOf([part], nets), undefined)?.vdd).toBe('7')
  })

  it('takes the schematic power-input pin names over the net names', () => {
    const nets: NetSpec[] = [{ id: 1, name: 'Net-(U1-Pad7)' }, { id: 2, name: 'Net-(U1-Pad8)' }]
    const part = partOn('U1', 'x', 'p', { '7': 1, '8': 2 })
    const pins = [
      { number: '7', name: 'VDD', type: 'power_in' },
      { number: '8', name: 'VSS', type: 'power_in' },
    ]
    expect(findSupplyPads(part, circuitOf([part], nets), pins)).toEqual({ vdd: '7', gnd: '8', via: 'schematic' })
  })

  it('ignores a schematic pin named VDD that is not a power input', () => {
    const part = partOn('U1', 'x', 'p', { '1': 1, '2': 2 })
    const pins = [{ number: '2', name: 'VDD', type: 'passive' }]
    // The schematic offers nothing usable, so the net names decide.
    expect(findSupplyPads(part, circuitOf([part], [GND, V33]), pins)?.via).toBe('net-names')
  })

  it('uses a stub entry datasheet pinout when the footprint is the one it names', () => {
    const ch340 = library.find(e => e.id === 'stub-ch340') as LibraryEntry
    const nets: NetSpec[] = [{ id: 1, name: 'Net-(U1-Pad1)' }, { id: 2, name: 'Net-(U1-Pad16)' }]
    const part = partOn('U1', 'CH340C', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', { '1': 1, '16': 2 })
    expect(findSupplyPads(part, circuitOf([part], nets), undefined, ch340)).toEqual({ vdd: '16', gnd: '1', via: 'footprint' })
  })

  it('finds nothing when no pad is on a supply-looking net', () => {
    const nets: NetSpec[] = [{ id: 1, name: 'N1' }, { id: 2, name: 'N2' }]
    const part = partOn('U1', 'x', 'p', { '1': 1, '2': 2 })
    expect(findSupplyPads(part, circuitOf([part], nets), undefined)).toBeNull()
  })

  it('finds nothing when supply and ground are the same net', () => {
    const part = partOn('U1', 'x', 'p', { '1': 1, '2': 1 })
    expect(findSupplyPads(part, circuitOf([part], [GND]), undefined)).toBeNull()
  })
})

// ─── resolution through resolveAll ────────────────────────────────────────────

describe('resolveAll: automatic stubs', () => {
  it('an ESP32 module becomes a supply-load stub with its datasheet current, and says so', () => {
    const { circuit } = singlePart('U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32')
    const [r] = resolveAll(circuit, undefined, undefined, library)
    expect(r.status).toBe('stubbed')
    expect(r.tier).toBe(6)
    expect(r.model).toEqual({
      kind: 'subckt', libFile: 'stubs.lib', subcktName: 'MCU_STUB_ESP32', pinMap: { '2': 'vdd', '1': 'gnd' },
    })
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0].startsWith(STUB_NOTE_PREFIX)).toBe(true)
    expect(r.warnings[0]).toMatch(/supply-load stub/)
    expect(r.warnings[0]).toMatch(/100 mA/)
    expect(r.warnings[0]).toMatch(/\+3V3/)
  })

  it('no stub is ever status ok: the part is not simulated and must stay amber', () => {
    for (const [value, libId] of [
      ['ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32'],
      ['STM32F103C8T6', 'Package_QFP:LQFP-48'],
      ['WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm'],
      ['CH340C', 'Package_SO:SOIC-16'],
    ]) {
      const { circuit } = singlePart('U1', value, libId)
      expect(resolveAll(circuit, undefined, undefined, library)[0].status).toBe('stubbed')
    }
  })

  it('a controller whose supply pad cannot be found falls back to interactive pins, with a reason', () => {
    const part = partOn('U1', 'ATmega328P-AU', 'Package_QFP:TQFP-32_7x7mm_P0.8mm', { '1': 8, '2': 9 })
    const circuit = circuitOf([part], [{ id: 8, name: 'N1' }, { id: 9, name: 'N2' }])
    const [r] = resolveAll(circuit, undefined, undefined, library)
    expect(r.status).toBe('stubbed')
    expect(r.model).toEqual({ kind: 'stub', mode: 'interactive-pins' })
    expect(r.warnings[0]).toMatch(/supply and ground pads could not be identified/)
  })

  it('a controller of a series with no bundled figure is interactive pins and draws nothing', () => {
    const { circuit } = singlePart('U1', 'STM32U575RIT6', 'Package_QFP:LQFP-64')
    const [r] = resolveAll(circuit, undefined, undefined, library)
    expect(r.status).toBe('stubbed')
    expect(r.model).toEqual({ kind: 'stub', mode: 'interactive-pins' })
    expect(r.warnings[0]).toMatch(/no datasheet supply current is bundled/)
  })

  it('without the stub entry in the library the part is interactive pins, not unresolved', () => {
    const { circuit } = singlePart('U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32')
    const noStubs = library.filter(e => !e.id.startsWith('stub-'))
    const [r] = resolveAll(circuit, undefined, undefined, noStubs)
    expect(r.status).toBe('stubbed')
    expect(r.model).toEqual({ kind: 'stub', mode: 'interactive-pins' })
    expect(r.warnings[0]).toMatch(/is not in the model library/)
  })

  it('the schematic pin names choose the pads when the nets are anonymous', () => {
    const part = partOn('U1', 'ATmega328P-AU', 'Package_QFP:TQFP-32_7x7mm_P0.8mm', { '4': 8, '3': 9 })
    const circuit = circuitOf([part], [{ id: 8, name: 'Net-(U1-VCC)' }, { id: 9, name: 'Net-(U1-GND)' }])
    const sim = new Map([['U1', simInfo({}, [
      { number: '4', name: 'VCC', type: 'power_in' },
      { number: '3', name: 'GND', type: 'power_in' },
    ])]])
    const [r] = resolveAll(circuit, sim, undefined, library)
    expect(r.model).toMatchObject({ kind: 'subckt', subcktName: 'MCU_STUB_ATMEGA', pinMap: { '4': 'vdd', '3': 'gnd' } })
  })

  it('a BOM MPN identifies a part whose board value says nothing', () => {
    const { circuit } = singlePart('U1', 'MCU', 'Package_DFN_QFN:QFN-48')
    const bom: BomData = new Map([['U1', { mpn: 'ESP32-WROOM-32' }]])
    const [r] = resolveAll(circuit, undefined, bom, library)
    expect(r.model).toMatchObject({ kind: 'subckt', subcktName: 'MCU_STUB_ESP32' })
  })

  it('a user model or any library match wins over the stub (tier 3 runs first)', () => {
    const { circuit } = singlePart('U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32')
    const userModel: LibraryEntry = {
      id: 'user-model-ESP32-WROOM-32',
      match: { mpn: ['ESP32-WROOM-32'] },
      model: { type: 'subckt', file: '__user_model__:ESP32-WROOM-32', name: 'MYESP' },
      pinMaps: { '.*': { '1': 'gnd', '2': 'vdd' } },
      defaultPinMap: { '1': 'gnd', '2': 'vdd' },
      provenance: 'test',
    }
    const [r] = resolveAll(circuit, undefined, undefined, [userModel, ...library])
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(3)
  })

  it("the user's Model Doctor stub override wins over the automatic stub", () => {
    const { circuit } = singlePart('U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32')
    const overrides = new Map([['U1', { kind: 'stub' as const, mode: 'open' as const }]])
    const [r] = resolveAll(circuit, undefined, undefined, library, overrides)
    expect(r.model).toEqual({ kind: 'stub', mode: 'open' })
  })

  it('schematic Sim.* fields win over the stub (tier 1 runs first)', () => {
    const { circuit } = singlePart('U1', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32')
    const sim = new Map([['U1', simInfo({ Device: 'R', Params: 'R=1k' })]])
    const [r] = resolveAll(circuit, sim, undefined, library)
    expect(r.tier).toBe(1)
  })

  it('a crystal is a documented open with its note, not a red part', () => {
    const part = partOn('Y1', '8MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', { '1': 4, '2': 1 })
    const circuit = circuitOf([part], [GND, V33, SIG])
    const [r] = resolveAll(circuit, undefined, undefined, library)
    expect(r.status).toBe('documented-open')
    expect(r.model).toEqual({ kind: 'stub', mode: 'open' })
    expect(r.note).toMatch(/Intentionally left open/)
  })

  it('an unrecognized part is still unresolved (no blanket stubbing)', () => {
    const { circuit } = singlePart('U1', 'FOO1234', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')
    expect(resolveAll(circuit, undefined, undefined, library)[0].status).toBe('unresolved')
  })
})

// ─── the stub entries in the bundled library ──────────────────────────────────

describe('stub entries in resources/models', () => {
  const stubs = library.filter(e => e.id.startsWith('stub-'))
  const stubsLib = readFileSync(join(process.cwd(), 'resources', 'models', 'stubs.lib'), 'utf8')

  /** The `.subckt NAME vdd gnd` wrapper text and its iload, in amperes. */
  function wrapperLoadAmps(name: string): number | undefined {
    const text = stubsLib.replace(/\r?\n\+/g, ' ')
    const m = new RegExp(`^\\.subckt\\s+${name}\\s+vdd\\s+gnd\\b[\\s\\S]*?iload=([0-9.]+)([mu]?)`, 'im').exec(text)
    if (!m) return undefined
    return Number(m[1]) * (m[2] === 'm' ? 1e-3 : m[2] === 'u' ? 1e-6 : 1)
  }

  it('every rule names an entry that exists in the index', () => {
    const ids = new Set(library.map(e => e.id))
    for (const rule of STUB_RULES) expect(ids.has(rule.entryId), rule.entryId).toBe(true)
  })

  it('every stub entry has a rule, and the rule ids are unique', () => {
    const ruleIds = STUB_RULES.map(r => r.entryId)
    expect(new Set(ruleIds).size).toBe(ruleIds.length)
    expect(stubs.map(e => e.id).sort()).toEqual([...ruleIds].sort())
  })

  it.each(STUB_RULES.map(r => [r.entryId, r] as const))('%s: a two-terminal stubs.lib subckt whose current is the rule figure', (id, rule) => {
    const entry = library.find(e => e.id === id) as LibraryEntry
    expect(entry.model.type).toBe('subckt')
    expect(entry.model.file).toBe('stubs.lib')
    const amps = wrapperLoadAmps(entry.model.name)
    expect(amps, `${entry.model.name} must be a "vdd gnd" subckt with an iload`).toBeDefined()
    expect(amps!).toBeCloseTo(rule.supplyMa / 1000, 9)
  })

  it('stub entries carry no match criteria, so libraryMatch can never claim a part for them', () => {
    for (const e of stubs) {
      expect(e.match, e.id).toEqual({})
      expect(e.provenance).toMatch(/MIT/)
    }
    for (const [value, libId] of [
      ['ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32'], ['WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm'], ['CH340C', 'Package_SO:SOIC-16'],
    ]) {
      const m = matchLibraryEntry({ mpn: value, mpnIsValue: true, libId, value, ref: 'U1' }, library)
      expect(m.kind, `${value} must not match a library entry`).toBe('none')
    }
  })
})
