/**
 * Tests for the bundled SPICE model library content (Task 14a / Spec §8.5, §14).
 *
 * These are pure-Node filesystem assertions over resources/models/ — no ngspice.
 * The real-ngspice "each card loads without error" check lives in
 * src/simhost/__tests__/library.integration.test.ts.
 *
 * Asserts (the Task 14a acceptance criteria):
 *  - every file in resources/models/ contains a 'Provenance:' header (Spec §14);
 *  - every index.json entry's referenced file + model name actually resolves
 *    (the .model card / .subckt exists in the named file);
 *  - every index.json entry has a non-empty pinMaps OR a defaultPinMap;
 *  - no obvious vendor-copyright marker text leaked into any .lib file.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import type { LibraryEntry } from '../types'

const MODELS_DIR = join(process.cwd(), 'resources', 'models')

interface LibraryIndex {
  entries: LibraryEntry[]
}

function readIndex(): LibraryIndex {
  return JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as LibraryIndex
}

/** All non-index files in resources/models/. */
function modelFiles(): string[] {
  return readdirSync(MODELS_DIR).filter((f) => f !== 'index.json' && !f.startsWith('.'))
}

/**
 * Extract every `.model NAME` and `.subckt NAME` defined in a model file,
 * folding `+` continuation lines first so multi-line cards are seen whole.
 */
function definedNames(file: string): Set<string> {
  const text = readFileSync(join(MODELS_DIR, file), 'utf8')
  const names = new Set<string>()
  if (file.endsWith('.json')) {
    // xspice-digital template library: names are the keys of `templates`.
    const j = JSON.parse(text) as { templates?: Record<string, unknown> }
    for (const k of Object.keys(j.templates ?? {})) names.add(k.toUpperCase())
    return names
  }
  const joined = text.replace(/\r?\n\+/g, ' ')
  for (const m of joined.matchAll(/^\s*\.model\s+(\S+)\s+\w+/gim)) names.add(m[1].toUpperCase())
  for (const m of joined.matchAll(/^\s*\.subckt\s+(\S+)/gim)) names.add(m[1].toUpperCase())
  return names
}

describe('bundled model library — Provenance headers (Spec §14)', () => {
  const files = modelFiles()

  it('resources/models is non-empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s contains a Provenance: header', (file) => {
    const text = readFileSync(join(MODELS_DIR, file), 'utf8')
    expect(text).toMatch(/Provenance:/)
  })

  it('index.json itself records provenance', () => {
    const text = readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')
    expect(text).toMatch(/Provenance:/)
  })
})

describe('bundled model library — index resolution (Spec §8.5)', () => {
  const index = readIndex()

  it('index has at least the Task 14a discrete entries', () => {
    expect(index.entries.length).toBeGreaterThanOrEqual(16)
  })

  it('entry ids are unique', () => {
    const ids = index.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s resolves: model.name exists in model.file',
    (_id, entry) => {
      expect(entry.model.file, `entry ${entry.id} must name a model file`).toBeTruthy()
      const names = definedNames(entry.model.file as string)
      expect(
        names.has(entry.model.name.toUpperCase()),
        `entry ${entry.id}: model "${entry.model.name}" not found in ${entry.model.file}`
      ).toBe(true)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has pinMaps or defaultPinMap',
    (_id, entry) => {
      const hasPinMaps = entry.pinMaps && Object.keys(entry.pinMaps).length > 0
      const hasDefault = entry.defaultPinMap && Object.keys(entry.defaultPinMap).length > 0
      expect(
        Boolean(hasPinMaps || hasDefault),
        `entry ${entry.id} must have non-empty pinMaps or defaultPinMap`
      ).toBe(true)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has a non-empty provenance string',
    (_id, entry) => {
      expect(typeof entry.provenance).toBe('string')
      expect(entry.provenance.length).toBeGreaterThan(0)
    }
  )

  it.each(readIndex().entries.map((e) => [e.id, e] as const))(
    'entry %s has at least one match criterion',
    (_id, entry) => {
      const m = entry.match
      const has =
        (m.mpn && m.mpn.length > 0) ||
        Boolean(m.valueRegex) ||
        (m.refdesPrefix && m.refdesPrefix.length > 0) ||
        Boolean(m.footprintRegex)
      expect(Boolean(has), `entry ${entry.id} must have a match criterion`).toBe(true)
    }
  )
})

describe('bundled model library — licensing hygiene (Spec §8.5 never-bundle list)', () => {
  // No vendor-copyright / vendor-encrypted-model markers may leak into a .lib.
  // We do not bundle TI/ADI/onsemi/Micro-Cap/Intusoft text (Spec §8.5).
  const forbidden = [
    /All Rights Reserved/i,
    /Micro-?Cap/i,
    /Intusoft/i,
    /\bSPICE2\b.*copyright/i,
    /Texas Instruments.*Copyright/i,
    /Analog Devices.*Copyright/i,
    /onsemi.*Copyright/i,
    /\*\*\*\* encrypted/i
  ]

  it.each(modelFiles())('%s contains no forbidden vendor-copyright markers', (file) => {
    const text = readFileSync(join(MODELS_DIR, file), 'utf8')
    for (const re of forbidden) {
      expect(re.test(text), `${file} matched forbidden marker ${re}`).toBe(false)
    }
  })

  it('every .lib/.json declares MIT provenance', () => {
    for (const file of modelFiles()) {
      const text = readFileSync(join(MODELS_DIR, file), 'utf8')
      expect(text, `${file} should declare MIT provenance`).toMatch(/MIT/)
    }
  })
})

// ─── Task 14b: ICs (op-amp/comparator/regulator/555) + digital (74HC) ─────────

describe('bundled model library — Task 14b IC + digital entries (Spec §8.5)', () => {
  const index = readIndex()

  it('includes the op-amp / comparator / regulator / 555 subckt entries', () => {
    const subcktIds = index.entries.filter((e) => e.model.type === 'subckt').map((e) => e.id)
    for (const id of [
      'opamp-lm358',
      'opamp-lm324',
      'opamp-tl072',
      'comparator-lm393',
      'reg-7805',
      'reg-ams1117-3v3',
      'reg-ams1117-5v0',
      'timer-ne555'
    ]) {
      expect(subcktIds, `missing subckt entry ${id}`).toContain(id)
    }
  })

  it('includes all nine 74HC xspice-digital entries', () => {
    const digIds = index.entries.filter((e) => e.model.type === 'xspice-digital').map((e) => e.id)
    for (const part of ['00', '04', '08', '14', '32', '74', '86', '164', '595']) {
      expect(digIds, `missing 74HC${part}`).toContain(`logic-74hc${part}`)
    }
    expect(digIds.length).toBe(9)
  })

  it('every subckt entry references a .subckt that exists in opamp/regulators/555 files', () => {
    for (const e of index.entries.filter((x) => x.model.type === 'subckt')) {
      const names = definedNames(e.model.file as string)
      expect(names.has(e.model.name.toUpperCase()), `${e.id}: ${e.model.name} not in ${e.model.file}`).toBe(true)
    }
  })

  it('every xspice-digital entry references a template that exists in logic74hc.json', () => {
    for (const e of index.entries.filter((x) => x.model.type === 'xspice-digital')) {
      expect(e.model.file).toBe('logic74hc.json')
      const names = definedNames('logic74hc.json')
      expect(names.has(e.model.name.toUpperCase()), `${e.id}: template ${e.model.name} missing`).toBe(true)
    }
  })
})

// ─── Milestone 1: resolution quick-win library additions ─────────────────────

describe('bundled model library — Milestone 1 additions (JLC/KiCad-9 board coverage)', () => {
  const index = readIndex()
  const byId = new Map(index.entries.map((e) => [e.id, e]))

  it('diode-1n4148 also matches BAS16 / BAS16W (100V/150mA switching, 1N4148-equivalent)', () => {
    const mpns = byId.get('diode-1n4148')?.match.mpn ?? []
    expect(mpns).toContain('BAS16')
    expect(mpns).toContain('BAS16W')
  })

  it('diode-1n5819 also matches B5819W / SS14 (1A/40V-class Schottky)', () => {
    const mpns = byId.get('diode-1n5819')?.match.mpn ?? []
    expect(mpns).toContain('B5819W')
    expect(mpns).toContain('SS14')
  })

  it('zener-3v0 entry: 3.0V zener model card in diodes.lib', () => {
    const e = byId.get('zener-3v0')
    expect(e, 'zener-3v0 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('model-card')
    expect(e!.model.file).toBe('diodes.lib')
    expect(definedNames('diodes.lib').has(e!.model.name.toUpperCase())).toBe(true)
    expect(e!.match.mpn).toContain('BZX84C3V0')
    expect(e!.match.mpn).toContain('3V0')
  })

  it('zener-3v0 model card sets bv=3.0 (reverse breakdown at the zener voltage)', () => {
    const text = readFileSync(join(MODELS_DIR, 'diodes.lib'), 'utf8').replace(/\r?\n\+/g, ' ')
    const card = text.match(/^\s*\.model\s+DZ3V0\s+D\([^)]*\)/im)?.[0] ?? ''
    expect(card, 'DZ3V0 card must exist in diodes.lib').toBeTruthy()
    expect(card).toMatch(/\bbv=3(\.0)?\b/i)
    expect(card).toMatch(/\bibv=1m\b/i)
  })

  it('zener-3v0 valueRegex matches part value "3.0V" only (bare "3V" is ambiguous with battery values; not 3V3, 5V, or net-ish names)', () => {
    const e = byId.get('zener-3v0')!
    let pattern = e.match.valueRegex as string
    expect(pattern).toBeTruthy()
    let flags = ''
    if (pattern.startsWith('(?i)')) {
      pattern = pattern.slice(4)
      flags = 'i'
    }
    const re = new RegExp(pattern, flags)
    expect(re.test('3.0V')).toBe(true)
    expect(re.test('3.0v')).toBe(true)
    // Bare "3V" also appears as a battery VALUE (refdes BT) — valueRegex is not
    // refdes-gated, so the ambiguous form must NOT match (the mpn "3V0" and the
    // explicit "3.0V" value are the unambiguous spellings).
    expect(re.test('3V')).toBe(false)
    expect(re.test('3v')).toBe(false)
    expect(re.test('3V3')).toBe(false)
    expect(re.test('5V')).toBe(false)
    expect(re.test('3V0_RAIL')).toBe(false)
  })

  it('comparator-lm339 reuses the LM393 cell with the LM339 quad 14-pin pinMap (unit 1)', () => {
    const e = byId.get('comparator-lm339')
    expect(e, 'comparator-lm339 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('opamp.lib')
    // Same model cell as comparator-lm393 (open-collector dual comparator core).
    expect(e!.model.name).toBe('LM393')
    for (const m of ['LM339', 'LM339D', 'LM2901', 'LM339N']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
    // MPN/value matching ONLY — refdes/footprint fallback rules silently
    // misresolved a CD4011 (quad NAND, SOP-14) as an LM393 on a real board.
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
    // Unit-1 map per the LM339 pinout: IN1+=5, IN1-=4, OUT1=2, VCC=3, GND=12.
    const key = Object.keys(e!.pinMaps).find((k) => /14/.test(k))
    expect(key, '14-pin pinMap key must exist').toBeTruthy()
    const map = e!.pinMaps[key!]
    expect(map['5']).toBe('inp')
    expect(map['4']).toBe('inn')
    expect(map['2']).toBe('out')
    expect(map['3']).toBe('vcc')
    expect(map['12']).toBe('vee')
    // The footprint pattern must cover SOP-14 / SOIC-14 / TSSOP-14 / DIP-14.
    for (const fp of [
      'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm',
      'Package_SO:TSSOP-14_4.4x5mm_P0.65mm',
      'Package_SO:SOP-14_3.9x8.7mm_P1.27mm',
      'Package_DIP:DIP-14_W7.62mm',
    ]) {
      expect(new RegExp(key!, 'i').test(fp), `pinMap key must match ${fp}`).toBe(true)
    }
  })

  it('ref-tl431 entry: behavioral shunt reference subckt in regulators.lib', () => {
    const e = byId.get('ref-tl431')
    expect(e, 'ref-tl431 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('regulators.lib')
    expect(definedNames('regulators.lib').has(e!.model.name.toUpperCase())).toBe(true)
    for (const m of ['TL431', 'TL431A', 'TL432', 'AZ431']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
  })
})

describe('logic74hc.json — XSPICE template structure (Spec §8.5)', () => {
  const j = JSON.parse(readFileSync(join(MODELS_DIR, 'logic74hc.json'), 'utf8')) as {
    templates: Record<
      string,
      {
        gates: Array<Record<string, unknown> & { prim: string }>
        inputs: string[]
        outputs: string[]
        power: { vcc: string; gnd: string }
        pinMaps: Record<string, Record<string, string>>
        delaysNs: number
        schmitt?: boolean
      }
    >
  }

  // The set of digital primitives VERIFIED to exist in ngspice-46 digital.cm
  // (probed live during Task 14b). d_inv / d_buf do NOT exist.
  const VERIFIED_PRIMS = new Set([
    'd_inverter',
    'd_buffer',
    'd_and',
    'd_nand',
    'd_or',
    'd_nor',
    'd_xor',
    'd_xnor',
    'd_dff'
  ])

  it('every gate uses a primitive name verified to exist in ngspice-46', () => {
    for (const [id, tpl] of Object.entries(j.templates)) {
      for (const g of tpl.gates) {
        expect(VERIFIED_PRIMS.has(g.prim), `${id}: gate prim "${g.prim}" is not a verified ngspice-46 primitive`).toBe(
          true
        )
        // The plan calls out the d_inv/d_buf trap explicitly.
        expect(g.prim).not.toBe('d_inv')
        expect(g.prim).not.toBe('d_buf')
      }
    }
  })

  it('74HC00 is four 2-input NANDs; 74HC04 is six inverters; 74HC14 is a schmitt', () => {
    expect(j.templates['74HC00'].gates.every((g) => g.prim === 'd_nand')).toBe(true)
    expect(j.templates['74HC00'].gates.length).toBe(4)
    expect(j.templates['74HC04'].gates.every((g) => g.prim === 'd_inverter')).toBe(true)
    expect(j.templates['74HC04'].gates.length).toBe(6)
    expect(j.templates['74HC14'].schmitt).toBe(true)
    expect(j.templates['74HC14'].gates.every((g) => g.prim === 'd_inverter')).toBe(true)
  })

  it('every template has power pins, inputs, outputs and at least one pinMap', () => {
    for (const [id, tpl] of Object.entries(j.templates)) {
      expect(tpl.power.vcc, `${id} power.vcc`).toBeTruthy()
      expect(tpl.power.gnd, `${id} power.gnd`).toBeTruthy()
      expect(tpl.inputs.length, `${id} inputs`).toBeGreaterThan(0)
      expect(tpl.outputs.length, `${id} outputs`).toBeGreaterThan(0)
      expect(Object.keys(tpl.pinMaps).length, `${id} pinMaps`).toBeGreaterThan(0)
      expect(typeof tpl.delaysNs).toBe('number')
    }
  })

  it('each 14-pin pinMap maps exactly pads 1..14 and includes VCC+GND', () => {
    for (const id of ['74HC00', '74HC04', '74HC08', '74HC14', '74HC32', '74HC74', '74HC86', '74HC164']) {
      const tpl = j.templates[id]
      const key = Object.keys(tpl.pinMaps).find((k) => /14/.test(k))!
      const map = tpl.pinMaps[key]
      const pads = Object.keys(map).map(Number).sort((a, b) => a - b)
      expect(pads, `${id} pads`).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      const signals = Object.values(map)
      expect(signals, `${id} VCC`).toContain('VCC')
      expect(signals, `${id} GND`).toContain('GND')
    }
  })

  it('74HC595 pinMap covers pads 1..16 with VCC+GND', () => {
    const tpl = j.templates['74HC595']
    const key = Object.keys(tpl.pinMaps).find((k) => /16/.test(k))!
    const map = tpl.pinMaps[key]
    const pads = Object.keys(map).map(Number).sort((a, b) => a - b)
    expect(pads.length).toBe(16)
    expect(Object.values(map)).toContain('VCC')
    expect(Object.values(map)).toContain('GND')
  })

  it('d_dff gates carry data/clk/q terminal roles (verified pin order data clk set reset | q qbar)', () => {
    for (const [, tpl] of Object.entries(j.templates)) {
      for (const g of tpl.gates) {
        if (g.prim === 'd_dff') {
          expect(g['data'], 'dff data').toBeTruthy()
          expect(g['clk'], 'dff clk').toBeTruthy()
          expect(g['q'], 'dff q').toBeTruthy()
        }
      }
    }
  })
})
