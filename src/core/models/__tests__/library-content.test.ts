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
    const digIds = index.entries
      .filter((e) => e.model.type === 'xspice-digital' && e.model.file === 'logic74hc.json')
      .map((e) => e.id)
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

  it('every xspice-digital entry references a template that exists in its family file', () => {
    const FAMILY_FILES = ['logic74hc.json', 'logic4000.json']
    for (const e of index.entries.filter((x) => x.model.type === 'xspice-digital')) {
      expect(FAMILY_FILES, `${e.id}: unknown family file ${e.model.file}`).toContain(e.model.file)
      const names = definedNames(e.model.file as string)
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

// ─── Milestone 2: power-path discretes (real Quilter/KiCad-9 board coverage) ──

describe('bundled model library — Milestone 2 power-path discretes', () => {
  const index = readIndex()
  const byId = new Map(index.entries.map((e) => [e.id, e]))
  const mosfetText = readFileSync(join(MODELS_DIR, 'mosfet.lib'), 'utf8').replace(/\r?\n\+/g, ' ')
  const diodesText = readFileSync(join(MODELS_DIR, 'diodes.lib'), 'utf8').replace(/\r?\n\+/g, ' ')

  it('mosfet-nce4012s entry: VDMOS model card in mosfet.lib, MPN-only matching', () => {
    const e = byId.get('mosfet-nce4012s')
    expect(e, 'mosfet-nce4012s entry must exist').toBeDefined()
    expect(e!.model.type).toBe('model-card')
    expect(e!.model.file).toBe('mosfet.lib')
    expect(definedNames('mosfet.lib').has(e!.model.name.toUpperCase())).toBe(true)
    expect(e!.match.mpn).toContain('NCE4012S')
    // MPN/value matching only — a Q + SOP-8 fallback would collide with the
    // NCE6005AS entry and false-positive on unknown SOP-8 parts (LM339 lesson).
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
  })

  it('mosfet-nce4012s pinMap maps exactly ONE representative pad per VDMOS terminal', () => {
    // SOP-8 pads 1-3 = S, 4 = G, 5-8 = D — but the deck generator emits one node
    // per pinMap ENTRY, so mapping two pads to the same terminal position is a bug.
    const e = byId.get('mosfet-nce4012s')!
    const key = Object.keys(e.pinMaps).find((k) => /SOP/i.test(k))
    expect(key, 'SOP-8 pinMap key must exist').toBeTruthy()
    const map = e.pinMaps[key!]
    expect(map).toEqual({ '5': '1', '4': '2', '1': '3' })
    // Terminal positions 1..3 each appear exactly once.
    expect(Object.values(map).sort()).toEqual(['1', '2', '3'])
    // The key matches both the bare and the JLC-prefixed SOP-8 footprint names.
    for (const fp of ['SOP-8_L4.9-W3.9-P1.27-LS6.0-BL', 'JLC-MCP:SOP-8_L4.9-W3.9-P1.27-LS6.0-BL']) {
      expect(new RegExp(key!, 'i').test(fp), `pinMap key must match ${fp}`).toBe(true)
    }
  })

  it('MNCE4012S card: VDMOS with vto=2.2, rd=0.009, cgs=1.6n, bv=40 (datasheet figures)', () => {
    const card = mosfetText.match(/^\s*\.model\s+MNCE4012S\s+VDMOS\([^)]*\)/im)?.[0] ?? ''
    expect(card, 'MNCE4012S card must exist in mosfet.lib').toBeTruthy()
    expect(card).toMatch(/\bvto=2\.2\b/i)
    expect(card).toMatch(/\brd=0?\.009\b/i)
    expect(card).toMatch(/\bcgs=1\.6n\b/i)
    expect(card).toMatch(/\bcgdmax=160p\b/i)
    expect(card).toMatch(/\bbv=40\b/i)
  })

  it('mosfet-nce6005as entry: dual-FET subckt in mosfet.lib with named terminals d1 g1 s1 d2 g2 s2', () => {
    const e = byId.get('mosfet-nce6005as')
    expect(e, 'mosfet-nce6005as entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('mosfet.lib')
    expect(e!.model.name).toBe('NCE6005AS')
    expect(e!.match.mpn).toContain('NCE6005AS')
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
    // The subckt declares its terminals in the documented order.
    expect(mosfetText).toMatch(/^\s*\.subckt\s+NCE6005AS\s+d1\s+g1\s+s1\s+d2\s+g2\s+s2\s*$/im)
    // TWO VDMOS instances (one per FET), and the .model card lives INSIDE the
    // subckt block so deck inlining carries it along transitively.
    const block = mosfetText.match(/\.subckt\s+NCE6005AS[\s\S]*?\.ends\s+NCE6005AS/i)?.[0] ?? ''
    expect(block, '.subckt NCE6005AS block must exist').toBeTruthy()
    expect(block.match(/^\s*m\d\s/gim)?.length).toBe(2)
    expect(block).toMatch(/\.model\s+\S+\s+VDMOS\(/i)
  })

  it('mosfet-nce6005as pinMap: one representative pad per terminal (SOP-8 dual pinout)', () => {
    const e = byId.get('mosfet-nce6005as')!
    const key = Object.keys(e.pinMaps).find((k) => /SOP/i.test(k))
    expect(key, 'SOP-8 pinMap key must exist').toBeTruthy()
    const map = e.pinMaps[key!]
    expect(map).toEqual({ '7': 'd1', '2': 'g1', '1': 's1', '5': 'd2', '4': 'g2', '3': 's2' })
    expect(Object.values(map).sort()).toEqual(['d1', 'd2', 'g1', 'g2', 's1', 's2'])
  })

  it('mosfet-ao3401 entry: dedicated PMOS card; aliases removed from mosfet-pmos-generic', () => {
    const e = byId.get('mosfet-ao3401')
    expect(e, 'mosfet-ao3401 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('model-card')
    expect(e!.model.file).toBe('mosfet.lib')
    expect(e!.model.name).toBe('MAO3401')
    expect(definedNames('mosfet.lib').has('MAO3401')).toBe(true)
    expect(e!.match.mpn).toContain('AO3401')
    expect(e!.match.mpn).toContain('AO3401A')
    // The generic must NOT still list the aliases (would be mpn-tier ambiguous).
    const generic = byId.get('mosfet-pmos-generic')!
    expect(generic.match.mpn).not.toContain('AO3401')
    expect(generic.match.mpn).not.toContain('AO3401A')
  })

  it('MAO3401 card: VDMOS pchan with negative vto and bv=30', () => {
    const card = mosfetText.match(/^\s*\.model\s+MAO3401\s+VDMOS\([^)]*\)/im)?.[0] ?? ''
    expect(card, 'MAO3401 card must exist in mosfet.lib').toBeTruthy()
    expect(card).toMatch(/\bpchan=1\b/i)
    expect(card).toMatch(/\bvto=-(0\.9|1(\.[0-3])?)\b/i)
    expect(card).toMatch(/\bbv=30\b/i)
  })

  it('schottky-ss54 entry: 5A/40V Schottky card in diodes.lib with the SS5x/SB540 aliases', () => {
    const e = byId.get('schottky-ss54')
    expect(e, 'schottky-ss54 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('model-card')
    expect(e!.model.file).toBe('diodes.lib')
    expect(e!.model.name).toBe('DSS54')
    expect(definedNames('diodes.lib').has('DSS54')).toBe(true)
    for (const m of ['SS54', 'SS52', 'SS56', 'SB540']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
    // pad 1 = cathode (existing Schottky convention: pinMap {1:"2",2:"1"}).
    expect(e!.defaultPinMap).toEqual({ '1': '2', '2': '1' })
    // Pin-map key covers the bare SMC footprint name routed boards use.
    const key = Object.keys(e!.pinMaps)[0]
    expect(new RegExp(key, 'i').test('SMC_L7.1-W6.2-LS8.1-R-RD')).toBe(true)
    expect(new RegExp(key, 'i').test('Diode_SMD:D_SMC_Handsoldering')).toBe(true)
  })

  it('DSS54 card: Schottky parameters (bv=40, eg=0.69, xti=2, cjo=300p)', () => {
    const card = diodesText.match(/^\s*\.model\s+DSS54\s+D\([^)]*\)/im)?.[0] ?? ''
    expect(card, 'DSS54 card must exist in diodes.lib').toBeTruthy()
    expect(card).toMatch(/\bbv=40\b/i)
    expect(card).toMatch(/\beg=0?\.69\b/i)
    expect(card).toMatch(/\bxti=2\b/i)
    expect(card).toMatch(/\bcjo=300p\b/i)
  })

  it('tvs-smaj24a entry: unidirectional 24V TVS card, MPN-only matching (D3 false-ambiguity fix)', () => {
    const e = byId.get('tvs-smaj24a')
    expect(e, 'tvs-smaj24a entry must exist').toBeDefined()
    expect(e!.model.type).toBe('model-card')
    expect(e!.model.file).toBe('diodes.lib')
    expect(e!.model.name).toBe('DSMAJ24A')
    expect(definedNames('diodes.lib').has('DSMAJ24A')).toBe(true)
    expect(e!.match.mpn).toEqual(['SMAJ24A'])
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
    expect(e!.defaultPinMap).toEqual({ '1': '2', '2': '1' })
  })

  it('DSMAJ24A card: bv=26.7 ibv=1m cjo=280p rs=1.16 n=1 (datasheet clamp figures)', () => {
    const card = diodesText.match(/^\s*\.model\s+DSMAJ24A\s+D\([^)]*\)/im)?.[0] ?? ''
    expect(card, 'DSMAJ24A card must exist in diodes.lib').toBeTruthy()
    expect(card).toMatch(/\bbv=26\.7\b/i)
    expect(card).toMatch(/\bibv=1m\b/i)
    expect(card).toMatch(/\bcjo=280p\b/i)
    // rs carries the clamp slope: (38.9V - 26.7V - ~0.24V junction)/10.3A ~ 1.16
    expect(card).toMatch(/\brs=1\.1[0-9]?\b/i)
    expect(card).toMatch(/\bn=1\b/i)
  })
})

// ─── Milestone 3: behavioral power-management IC stubs (real-board coverage) ──

describe('bundled model library — Milestone 3 behavioral power-IC stubs', () => {
  const index = readIndex()
  const byId = new Map(index.entries.map((e) => [e.id, e]))
  const powerIcText = readFileSync(join(MODELS_DIR, 'power-ic.lib'), 'utf8').replace(/\r?\n\+/g, ' ')

  /** Terminal list of a .subckt line in power-ic.lib (continuations folded). */
  function subcktTerminals(name: string): string[] {
    const m = powerIcText.match(new RegExp(`^\\s*\\.subckt\\s+${name}\\s+([^\\r\\n]*)$`, 'im'))
    return m ? m[1].trim().split(/\s+/) : []
  }

  it('power-ic.lib documents each stub as SIMPLIFIED behavioral (MIT provenance header)', () => {
    expect(powerIcText).toMatch(/Provenance:/)
    expect(powerIcText).toMatch(/MIT/)
    // The simplifications must be spelled out in the lib text itself.
    expect(powerIcText).toMatch(/SIMPLIFICATIONS/i)
  })

  it('protector-bq77915 entry: NORMAL-mode stub subckt, MPN-only matching', () => {
    const e = byId.get('protector-bq77915')
    expect(e, 'protector-bq77915 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('power-ic.lib')
    expect(e!.model.name).toBe('BQ7791502')
    expect(definedNames('power-ic.lib').has('BQ7791502')).toBe(true)
    for (const m of ['BQ7791502', 'BQ77915', 'BQ7791500', 'BQ7791503', 'BQ7791505']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
    // MPN/value matching only — a U + TSSOP-24 fallback would false-positive
    // on unknown 24-pin parts (the LM339/CD4011 lesson).
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
  })

  it('BQ7791502 subckt: terminals vdd vss chg dsg; both gate drivers held at v(vdd)', () => {
    expect(subcktTerminals('BQ7791502')).toEqual(['vdd', 'vss', 'chg', 'dsg'])
    const block = powerIcText.match(/\.subckt\s+BQ7791502[\s\S]*?\.ends\s+BQ7791502/i)?.[0] ?? ''
    expect(block, '.subckt BQ7791502 block must exist').toBeTruthy()
    // E-sources holding chg and dsg at v(vdd) relative to vss (NORMAL mode:
    // both external-FET drivers ON), plus a tiny load so the part draws ~0.
    expect(block).toMatch(/^\s*echg\s+chg\s+vss\s+vdd\s+vss\s+1\b/im)
    expect(block).toMatch(/^\s*edsg\s+dsg\s+vss\s+vdd\s+vss\s+1\b/im)
    expect(block).toMatch(/^\s*r\w*\s+vdd\s+vss\s+10Meg\b/im)
    // Documented simplifications: no protection trips, no balancing, no AVDD/VTB.
    expect(powerIcText).toMatch(/no protection trips/i)
    expect(powerIcText).toMatch(/cell balancing/i)
    expect(powerIcText).toMatch(/AVDD/i)
  })

  it('protector-bq77915 pinMap: datasheet TSSOP-24 pins 1=VDD 9=VSS 13=CHG 12=DSG', () => {
    const e = byId.get('protector-bq77915')!
    const key = Object.keys(e.pinMaps).find((k) => /TSSOP/i.test(k))
    expect(key, 'TSSOP-24 pinMap key must exist').toBeTruthy()
    expect(e.pinMaps[key!]).toEqual({ '1': 'vdd', '9': 'vss', '13': 'chg', '12': 'dsg' })
    // The key must match the real board's JLC footprint name.
    expect(new RegExp(key!, 'i').test('JLC-MCP:TSSOP-24_L7.8-W4.4-P0.65-LS6.4-BL_1')).toBe(true)
    // Every mapped terminal name exists in the subckt terminal list.
    const terms = new Set(subcktTerminals('BQ7791502'))
    for (const t of Object.values(e.pinMaps[key!])) expect(terms.has(t), `terminal ${t}`).toBe(true)
  })

  it('charger-ltc4020 entry: idle/off stub subckt with the #TRPBF alias (suffix not stripped by normalizeMpn)', () => {
    const e = byId.get('charger-ltc4020')
    expect(e, 'charger-ltc4020 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('power-ic.lib')
    expect(e!.model.name).toBe('LTC4020')
    expect(definedNames('power-ic.lib').has('LTC4020')).toBe(true)
    for (const m of ['LTC4020', 'LTC4020EUHF', 'LTC4020EUHF#TRPBF']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
  })

  it('LTC4020 subckt: terminals vin intvcc tg1 bg1 tg2 bg2 gnd; 5V LDO + gate pulldowns', () => {
    expect(subcktTerminals('LTC4020')).toEqual(['vin', 'intvcc', 'tg1', 'bg1', 'tg2', 'bg2', 'gnd'])
    const block = powerIcText.match(/\.subckt\s+LTC4020[\s\S]*?\.ends\s+LTC4020/i)?.[0] ?? ''
    expect(block, '.subckt LTC4020 block must exist').toBeTruthy()
    // Behavioral INTVCC LDO: v = vin-0.3 clamped to [0, 5], small resistive Rout.
    expect(block).toMatch(/^\s*bint\s+\S+\s+gnd\s+v\s*=\s*max\(0,\s*min\(v\(vin,gnd\)-0\.3,\s*5\)\)/im)
    // 100k pulldowns hold all four external gate pins low (FETs OFF, SW defined).
    for (const g of ['tg1', 'bg1', 'tg2', 'bg2']) {
      expect(block).toMatch(new RegExp(`^\\s*r\\w*\\s+${g}\\s+gnd\\s+100k\\b`, 'im'))
    }
    // Documented simplifications: no switching, no charging.
    expect(powerIcText).toMatch(/no switching/i)
    expect(powerIcText).toMatch(/no charging/i)
  })

  it('charger-ltc4020 pinMap: board-verified QFN-38 pads (one representative pad per rail)', () => {
    const e = byId.get('charger-ltc4020')!
    const key = Object.keys(e.pinMaps).find((k) => /QFN/i.test(k))
    expect(key, 'QFN-38 pinMap key must exist').toBeTruthy()
    expect(e.pinMaps[key!]).toEqual({
      '7': 'vin', '10': 'intvcc', '1': 'tg1', '37': 'bg1', '31': 'tg2', '33': 'bg2', '3': 'gnd',
    })
    expect(new RegExp(key!, 'i').test('QFN-38_L5.0-W7.0-P0.50-TL-EP')).toBe(true)
    const terms = new Set(subcktTerminals('LTC4020'))
    for (const t of Object.values(e.pinMaps[key!])) expect(terms.has(t), `terminal ${t}`).toBe(true)
  })

  it('leddriver-al8860 entry: DC-averaged constant-current sink, MPN-only matching', () => {
    const e = byId.get('leddriver-al8860')
    expect(e, 'leddriver-al8860 entry must exist').toBeDefined()
    expect(e!.model.type).toBe('subckt')
    expect(e!.model.file).toBe('power-ic.lib')
    expect(e!.model.name).toBe('AL8860')
    expect(definedNames('power-ic.lib').has('AL8860')).toBe(true)
    for (const m of ['AL8860', 'AL8860MP', 'AL8860MP-13']) {
      expect(e!.match.mpn, `mpn list must include ${m}`).toContain(m)
    }
    expect(e!.match.refdesPrefix).toBeUndefined()
    expect(e!.match.footprintRegex).toBeUndefined()
  })

  it('AL8860 subckt: terminals vin set sw ctrl gnd; smooth (tanh) servo + 1Meg trickle', () => {
    expect(subcktTerminals('AL8860')).toEqual(['vin', 'set', 'sw', 'ctrl', 'gnd'])
    const block = powerIcText.match(/\.subckt\s+AL8860[\s\S]*?\.ends\s+AL8860/i)?.[0] ?? ''
    expect(block, '.subckt AL8860 block must exist').toBeTruthy()
    // The servo is a B-source current sink sw->gnd built from SMOOTH limiting
    // functions (tanh) — no ternary discontinuities (convergence safety).
    expect(block).toMatch(/^\s*bled\s+sw\s+gnd\s+i\s*=/im)
    expect(block).toMatch(/tanh/i)
    expect(block).not.toMatch(/\?/)
    // 100 mV mean sense target across v(vin,set); CTRL 2.5V full-scale.
    expect(block).toMatch(/v\(vin,set\)/i)
    expect(block).toMatch(/2\.5/)
    // Output-compliance clamp: the sink collapses smoothly as v(sw,gnd) → 0,
    // so an OPEN LED path (unfitted connector on a real board) cannot strand
    // a forced current source on a dead-end node (hard singular matrix).
    expect(block).toMatch(/v\(sw,gnd\)/i)
    // 1Meg vin->gnd trickle.
    expect(block).toMatch(/^\s*r\w*\s+vin\s+gnd\s+1Meg\b/im)
    // Documented simplifications: averaged (no ripple), and CTRL dimming that
    // scales the 100 mV sense TARGET (not the current cap — an earlier form
    // cap-scaled and mid-range dimming silently returned full current; see the
    // mid-dim regression in library-ic.integration.test.ts).
    expect(powerIcText).toMatch(/no switching ripple/i)
    expect(powerIcText).toMatch(/scales the 100 mV sense target/i)
    expect(block).toMatch(/0\.1\*min\(1,\s*max\(0,\s*v\(ctrl,gnd\)\/2\.5\)\)/i)
  })

  it('leddriver-al8860 pinMap: MSOP-8EP pads 8=VIN 1=SET 5=SW 4=CTRL 2=GND', () => {
    const e = byId.get('leddriver-al8860')!
    const key = Object.keys(e.pinMaps).find((k) => /MSOP/i.test(k))
    expect(key, 'MSOP-8 pinMap key must exist').toBeTruthy()
    expect(e.pinMaps[key!]).toEqual({ '8': 'vin', '1': 'set', '5': 'sw', '4': 'ctrl', '2': 'gnd' })
    expect(new RegExp(key!, 'i').test('JLC-MCP:MSOP-8_L3.0-W3.0-P0.65-LS4.9-BL-EP1.8')).toBe(true)
    const terms = new Set(subcktTerminals('AL8860'))
    for (const t of Object.values(e.pinMaps[key!])) expect(terms.has(t), `terminal ${t}`).toBe(true)
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

// ─── Milestone 5c: CD4000-series family file (12 V swing) ─────────────────────

describe('logic4000.json — CD4000 XSPICE family (Spec §8.5)', () => {
  interface FamilyJson {
    family: {
      name: string
      vHighDefault: number
      adc: { inLowFrac: number; inHighFrac: number }
      schmittAdc: { inLowFrac: number; inHighFrac: number }
    }
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
  const raw = readFileSync(join(MODELS_DIR, 'logic4000.json'), 'utf8')
  const j = JSON.parse(raw) as FamilyJson

  // Same verified ngspice-46 primitive set as the 74HC family tests.
  const VERIFIED_PRIMS = new Set([
    'd_inverter', 'd_buffer', 'd_and', 'd_nand', 'd_or', 'd_nor', 'd_xor', 'd_xnor', 'd_dff'
  ])

  it('family rail is the documented fixed 12 V swing (dac_bridge out_high limitation)', () => {
    expect(j.family.vHighDefault).toBe(12.0)
    // The fixed-swing caveat MUST be documented in the file itself: CD4000 runs
    // 3-18 V but XSPICE dac_bridge out_high is a per-file constant, so outputs
    // are modeled at 12 V regardless of the actual board rail.
    expect(raw).toMatch(/12 V swing/i)
    expect(raw).toMatch(/3-18\s?V/i)
    expect(raw).toMatch(/Provenance:/)
    expect(raw).toMatch(/MIT/)
  })

  it('standard adc thresholds are 30%/70% of rail; Schmitt thresholds 40%/60% (4.8/7.2 V at 12 V)', () => {
    expect(j.family.adc).toEqual({ inLowFrac: 0.3, inHighFrac: 0.7 })
    expect(j.family.schmittAdc).toEqual({ inLowFrac: 0.4, inHighFrac: 0.6 })
    expect(j.family.schmittAdc.inLowFrac * j.family.vHighDefault).toBeCloseTo(4.8, 6)
    expect(j.family.schmittAdc.inHighFrac * j.family.vHighDefault).toBeCloseTo(7.2, 6)
  })

  it('every gate uses a primitive name verified to exist in ngspice-46', () => {
    for (const [id, tpl] of Object.entries(j.templates)) {
      for (const g of tpl.gates) {
        expect(VERIFIED_PRIMS.has(g.prim), `${id}: gate prim "${g.prim}" is not a verified ngspice-46 primitive`).toBe(
          true
        )
      }
    }
  })

  it('CD40106 is six Schmitt inverters with the 74HC14-compatible pinout', () => {
    const tpl = j.templates['CD40106']
    expect(tpl, 'CD40106 template must exist').toBeDefined()
    expect(tpl.schmitt).toBe(true)
    expect(tpl.gates.length).toBe(6)
    expect(tpl.gates.every((g) => g.prim === 'd_inverter')).toBe(true)
    const key = Object.keys(tpl.pinMaps).find((k) => /14/.test(k))!
    const map = tpl.pinMaps[key]
    // Pin-compatible with the 74HC14: 1=1A 2=1Y … 7=GND 13=6A 14=VCC.
    expect(map).toEqual({
      '1': '1A', '2': '1Y', '3': '2A', '4': '2Y', '5': '3A', '6': '3Y',
      '7': 'GND', '8': '4Y', '9': '4A', '10': '5Y', '11': '5A', '12': '6Y',
      '13': '6A', '14': 'VCC',
    })
  })

  it('CD4011 is four 2-input NANDs with outputs on pins 3/4/10/11 (NOT the 74HC00 pinout)', () => {
    const tpl = j.templates['CD4011']
    expect(tpl, 'CD4011 template must exist').toBeDefined()
    expect(tpl.gates.length).toBe(4)
    expect(tpl.gates.every((g) => g.prim === 'd_nand')).toBe(true)
    const key = Object.keys(tpl.pinMaps).find((k) => /14/.test(k))!
    const map = tpl.pinMaps[key]
    expect(map).toEqual({
      '1': '1A', '2': '1B', '3': '1Y', '4': '2Y', '5': '2A', '6': '2B',
      '7': 'GND', '8': '3A', '9': '3B', '10': '3Y', '11': '4Y', '12': '4A',
      '13': '4B', '14': 'VCC',
    })
  })

  it('every template has power pins, inputs, outputs, delays and pads 1..14 with VCC+GND', () => {
    for (const [id, tpl] of Object.entries(j.templates)) {
      expect(tpl.power.vcc, `${id} power.vcc`).toBeTruthy()
      expect(tpl.power.gnd, `${id} power.gnd`).toBeTruthy()
      expect(tpl.inputs.length, `${id} inputs`).toBeGreaterThan(0)
      expect(tpl.outputs.length, `${id} outputs`).toBeGreaterThan(0)
      expect(typeof tpl.delaysNs, `${id} delaysNs`).toBe('number')
      const key = Object.keys(tpl.pinMaps).find((k) => /14/.test(k))!
      const map = tpl.pinMaps[key]
      const pads = Object.keys(map).map(Number).sort((a, b) => a - b)
      expect(pads, `${id} pads`).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      const signals = Object.values(map)
      expect(signals, `${id} VCC`).toContain('VCC')
      expect(signals, `${id} GND`).toContain('GND')
    }
  })

  it('index entries logic-cd40106 / logic-cd4011: mpn/value matching only, 12 V caveat documented', () => {
    const index = readIndex()
    const byId = new Map(index.entries.map((e) => [e.id, e]))
    const expected: Array<[string, string, string[]]> = [
      ['logic-cd40106', 'CD40106', ['CD40106', 'CD40106B', 'CD40106BM', 'HEF40106', 'MC14584']],
      ['logic-cd4011', 'CD4011', ['CD4011', 'CD4011B', 'CD4011BM', 'HEF4011', 'MC14011']],
    ]
    for (const [id, template, mpns] of expected) {
      const e = byId.get(id)
      expect(e, `${id} entry must exist`).toBeDefined()
      expect(e!.model.type).toBe('xspice-digital')
      expect(e!.model.file).toBe('logic4000.json')
      expect(e!.model.name).toBe(template)
      for (const m of mpns) expect(e!.match.mpn, `${id} mpn list must include ${m}`).toContain(m)
      // MPN/value matching only — a U + 14-pin fallback would collide with the
      // nine 74HC fallback rules (the LM339/CD4011 lesson).
      expect(e!.match.refdesPrefix).toBeUndefined()
      expect(e!.match.footprintRegex).toBeUndefined()
      // Each entry documents the fixed 12 V swing caveat in its $comment.
      const withComment = e as unknown as { $comment?: string }
      expect(withComment.$comment, `${id} $comment`).toBeTruthy()
      expect(withComment.$comment).toMatch(/12 V/i)
    }
  })

  it('pinMaps keys match the real routed-board JLC footprint names (SOIC-14 / SOP-14)', () => {
    const index = readIndex()
    const byId = new Map(index.entries.map((e) => [e.id, e]))
    const boards: Array<[string, string]> = [
      ['logic-cd40106', 'JLC-MCP:SOIC-14_L8.7-W3.9-P1.27-LS6.0-BL'],
      ['logic-cd4011', 'JLC-MCP:SOP-14_L8.6-W3.9-P1.27-LS6.0-BL'],
    ]
    for (const [id, fp] of boards) {
      const e = byId.get(id)!
      const key = Object.keys(e.pinMaps).find((k) => new RegExp(k, 'i').test(fp))
      expect(key, `${id}: no pinMaps key matches ${fp}`).toBeTruthy()
    }
  })

  it('EVERY xspice-digital entry covers bare SOP-nn footprints (JLC boards use SOP-14, not SOIC-14)', () => {
    // Review follow-up: the nine 74HC entries' `(DIP|SOIC|TSSOP|SO)-?14` did
    // not match `SOP-14…` (the `SO` alternative needs the digit right after
    // `-?`, and `SOP` was absent) — a 74HC part on a JLC SOP-14 board resolved
    // by mpn but got an EMPTY pinMap (pinmap-unverified, no pads wired). Every
    // digital entry's match.footprintRegex and at least one pinMaps key must
    // now match a bare SOP-style name.
    const index = readIndex()
    for (const e of index.entries.filter((x) => x.model.type === 'xspice-digital')) {
      const pins = /16/.test(e.match.footprintRegex ?? Object.keys(e.pinMaps)[0]) ? 16 : 14
      const fp = `JLC-MCP:SOP-${pins}_L8.6-W3.9-P1.27-LS6.0-BL`
      if (e.match.footprintRegex) {
        expect(
          new RegExp(e.match.footprintRegex, 'i').test(fp),
          `${e.id}: match.footprintRegex must cover ${fp}`
        ).toBe(true)
      }
      const key = Object.keys(e.pinMaps).find((k) => new RegExp(k, 'i').test(fp))
      expect(key, `${e.id}: no pinMaps key matches ${fp}`).toBeTruthy()
    }
  })

  it('templateIds are disjoint across XSPICE family files (nondeterministic lookup otherwise)', () => {
    // findDigitalTemplateFile picks the family file that CONTAINS the
    // templateId; if two files defined the same id the winner would depend on
    // file-read completion order (Promise.all in the main-process loader).
    const families = modelFiles().filter((f) => f.endsWith('.json'))
    const seen = new Map<string, string>()
    for (const f of families) {
      const j = JSON.parse(readFileSync(join(MODELS_DIR, f), 'utf8')) as {
        templates?: Record<string, unknown>
      }
      for (const id of Object.keys(j.templates ?? {})) {
        const prev = seen.get(id.toUpperCase())
        expect(prev, `templateId ${id} defined in both ${prev} and ${f}`).toBeUndefined()
        seen.set(id.toUpperCase(), f)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
  })
})
