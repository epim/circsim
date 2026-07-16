/**
 * schematicPinMap.test.ts — schematic-authoritative diode pin maps (unit).
 *
 * pinMapFromSchematicPins derives a diode/LED pin map from schematic symbol
 * pin names (A/K — design-file ground truth). null = "fall through to the
 * footprint-regex tier", never an error. Guard rails per spec §5:
 * two-terminal polarized model-card entry; exactly two distinct pin numbers
 * named A and K; both numbers present in the routed part's pads.
 * Spec: docs/superpowers/specs/2026-07-15-schematic-authoritative-pinmaps-design.md
 */

import { describe, it, expect } from 'vitest'

import {
  pinMapFromSchematicPins,
  isTwoTerminalPolarizedEntry,
  type SchematicPin,
} from '../libraryMatch'
import type { LibraryEntry } from '../types'

const DIODE_ENTRY: LibraryEntry = {
  id: 'test-diode',
  match: { mpn: ['SS54'] },
  model: { type: 'model-card', file: 'diodes.lib', name: 'DSS54' },
  pinMaps: { 'D_SMC.*': { '1': '2', '2': '1' } },
  defaultPinMap: { '1': '2', '2': '1' },
  provenance: 'test fixture',
}

const BJT_ENTRY: LibraryEntry = {
  id: 'test-bjt',
  match: { mpn: ['2N3904'] },
  model: { type: 'model-card', file: 'bjt.lib', name: 'Q2N3904' },
  pinMaps: { 'SOT-23.*': { '1': '3', '2': '1', '3': '2' } },
  defaultPinMap: { '1': '3', '2': '1', '3': '2' },
  provenance: 'test fixture',
}

const SUBCKT_ENTRY: LibraryEntry = {
  id: 'test-subckt',
  match: { mpn: ['NE555'] },
  model: { type: 'subckt', file: 'timer.lib', name: 'NE555' },
  pinMaps: { 'DIP-8.*': { '1': '1', '2': '2' } },
  provenance: 'test fixture',
}

const pads12 = new Set(['1', '2'])

function pins(...list: Array<[string, string]>): SchematicPin[] {
  return list.map(([number, name]) => ({ number, name, type: 'passive' }))
}

describe('isTwoTerminalPolarizedEntry', () => {
  it('diode entry (all maps permute {1,2}) → true', () => {
    expect(isTwoTerminalPolarizedEntry(DIODE_ENTRY)).toBe(true)
  })

  it('3-terminal BJT entry → false', () => {
    expect(isTwoTerminalPolarizedEntry(BJT_ENTRY)).toBe(false)
  })

  it('entry with one polarized map but a non-polarized defaultPinMap → false', () => {
    const mixed: LibraryEntry = {
      ...DIODE_ENTRY,
      defaultPinMap: { '1': 'a', '2': 'k' },
    }
    expect(isTwoTerminalPolarizedEntry(mixed)).toBe(false)
  })
})

describe('pinMapFromSchematicPins — happy paths', () => {
  it('pin 1 = A, pin 2 = K → {1:"1", 2:"2"} (anode pad → terminal 1)', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)
    expect(map).toEqual({ '1': '1', '2': '2' })
  })

  it('pin 1 = K, pin 2 = A → {2:"1", 1:"2"} (KiCad-convention symbol)', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'K'], ['2', 'A']), pads12)
    expect(map).toEqual({ '2': '1', '1': '2' })
  })

  it('names normalize: lowercase + padded " a "/" k " accepted', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', ' a '], ['2', ' k ']), pads12)
    expect(map).toEqual({ '1': '1', '2': '2' })
  })

  it('duplicate pin entries (lib_symbols body styles) dedupe by number', () => {
    const dup = pins(['1', 'A'], ['1', 'A'], ['2', 'K'])
    expect(pinMapFromSchematicPins(DIODE_ENTRY, dup, pads12)).toEqual({ '1': '1', '2': '2' })
  })
})

describe('pinMapFromSchematicPins — guard rails → null', () => {
  it('undefined pins (no schematic) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, undefined, pads12)).toBeNull()
  })

  it('non-A/K names (+/-, AN/CAT) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', '+'], ['2', '-']), pads12)).toBeNull()
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'AN'], ['2', 'CAT']), pads12)).toBeNull()
  })

  it('two A pins (no K) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'A']), pads12)).toBeNull()
  })

  it('one pin / three distinct pins → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A']), pads12)).toBeNull()
    expect(
      pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K'], ['3', 'NC']), pads12),
    ).toBeNull()
  })

  it('pin number missing from the routed pads (stale schematic) → null', () => {
    const padsOnly1 = new Set(['1'])
    expect(
      pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K']), padsOnly1),
    ).toBeNull()
  })

  it('non-polarized entry (BJT) → null even with A/K pins', () => {
    expect(pinMapFromSchematicPins(BJT_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)).toBeNull()
  })

  it('subckt entry → null (v1 is model-card only)', () => {
    expect(pinMapFromSchematicPins(SUBCKT_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)).toBeNull()
  })
})
