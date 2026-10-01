/**
 * Issue #5: no footprint-name regex can know polarity on a JLC/EasyEDA-origin
 * footprint. The led_lantern rev B board the old rule was derived from
 * contradicts it on three of its four JLC diodes (D2, D8, D9: pin 1 = K; only
 * D7 has pin 1 = A). With the schematic attached, pin names win; without it the
 * part must carry a polarity-unverified warning instead of a confident,
 * reversed, silent map.
 *
 * Footprint names below are the real ones from that board (names only; no
 * board file is committed).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { resolveAll, resolutionNoteLines } from '../resolve'
import {
  selectPinMap,
  isEasyEdaOriginFootprint,
  hasUnverifiedPolarity,
  POLARITY_UNVERIFIED_PREFIX,
  SCHEMATIC_PINMAP_NOTE,
} from '../libraryMatch'
import type { SchematicSimData } from '../../kicad/schematic'
import { bundledLibrary, makeCircuit, makePart, simInfo } from './p2-helpers'

const lib = bundledLibrary()
const KICAD_CATHODE_FIRST = { '1': '2', '2': '1' }

// ref, MPN, footprint, schematic pins (number -> name) as the board's schematic has them
const LANTERN: Array<[string, string, string, Array<[string, string]>]> = [
  ['D2', 'B5819W', 'JLC-MCP:SOD-123_L2.8-W1.8-LS3.7-RD', [['2', 'A'], ['1', 'K']]],
  ['D7', 'SS54', 'SMC_L7.1-W6.2-LS8.1-R-RD', [['1', 'A'], ['2', 'K']]],
  ['D8', 'SS14', 'SMA_L4.2-W2.6-LS5.0-RD_1', [['2', 'A'], ['1', 'K']]],
  ['D9', 'SS14', 'SMA_L4.2-W2.6-LS5.0-RD_1', [['2', 'A'], ['1', 'K']]],
]

function resolveLantern(withSchematic: boolean) {
  const circuit = makeCircuit(LANTERN.map(([ref, mpn, fp]) => makePart(ref, mpn, fp, { MPN: mpn })))
  const sch: SchematicSimData = new Map(
    LANTERN.map(([ref, , , pins]) => [
      ref,
      simInfo({}, pins.map(([number, name]) => ({ number, name, type: 'passive' }))),
    ]),
  )
  return resolveAll(circuit, withSchematic ? sch : undefined, undefined, lib)
}

describe('JLC/EasyEDA diode footprints: polarity is never a silent footprint guess (issue #5)', () => {
  it('recognizes EasyEDA-origin footprint names', () => {
    for (const fp of LANTERN.map(l => l[2])) expect(isEasyEdaOriginFootprint(fp), fp).toBe(true)
    for (const fp of ['Diode_SMD:D_SMA', 'Diode_SMD:D_SOD-123', 'LED_SMD:LED_0805_2012Metric', 'Diode_THT:D_DO-41_SOD81_P10.16mm_Horizontal']) {
      expect(isEasyEdaOriginFootprint(fp), fp).toBe(false)
    }
  })

  it('without the schematic, every lantern diode carries a polarity-unverified warning', () => {
    const res = resolveLantern(false)
    for (const r of res) {
      expect(r.status, r.ref).toBe('ok')
      expect(r.warnings.some(w => w.startsWith('pinmap-unverified:') && /polarity/i.test(w)), r.ref).toBe(true)
    }
  })

  it('without the schematic, the map is the KiCad default, not an anode-first guess', () => {
    for (const r of resolveLantern(false)) {
      expect(r.model).toMatchObject({ pinMap: KICAD_CATHODE_FIRST })
    }
  })

  it('with the schematic attached, pin names decide and the unverified warning is gone', () => {
    const res = resolveLantern(true)
    const byRef = new Map(res.map(r => [r.ref, r]))
    for (const ref of ['D2', 'D8', 'D9']) {
      expect(byRef.get(ref)!.model).toMatchObject({ pinMap: KICAD_CATHODE_FIRST })
      expect(byRef.get(ref)!.warnings.filter(w => w.startsWith('pinmap-unverified:'))).toEqual([])
    }
    // D7 is the one part where pad 1 is the anode; the schematic says so.
    expect(byRef.get('D7')!.model).toMatchObject({ pinMap: { '1': '1', '2': '2' } })
    expect(byRef.get('D7')!.warnings).not.toContain(SCHEMATIC_PINMAP_NOTE)
    expect(byRef.get('D7')!.warnings.filter(w => w.startsWith('pinmap-unverified:'))).toEqual([])
  })

  it('every two-terminal polarized entry warns on every EasyEDA-origin name', () => {
    const polarized = lib.filter(e => e.model.type === 'model-card' && Object.values(e.pinMaps).length > 0 &&
      [...Object.values(e.pinMaps), e.defaultPinMap ?? {}].every(m => Object.keys(m).join() === '1,2'))
    expect(polarized.length).toBeGreaterThanOrEqual(12)
    for (const e of polarized) {
      for (const fp of LANTERN.map(l => l[2])) {
        const { warnings } = selectPinMap(e, fp)
        expect(warnings.some(w => w.startsWith('pinmap-unverified:')), `${e.id} ${fp}`).toBe(true)
      }
    }
  })

  // This predicate decides which resolved parts the sim log names as a polarity
  // guess, so it must be true exactly when nothing confirmed the polarity.
  it('hasUnverifiedPolarity: true without the schematic, false once its A/K names decide', () => {
    for (const r of resolveLantern(false)) expect(hasUnverifiedPolarity(r), r.ref).toBe(true)
    for (const r of resolveLantern(true)) expect(hasUnverifiedPolarity(r), r.ref).toBe(false)
  })

  // A part that resolved ok has no Model Doctor card (the Doctor lists parts
  // whose status is not ok), so the sim log is where the guess is stated.
  it('the sim-log lines name each resolved diode whose polarity is a guess, and none once the schematic decides', () => {
    const lines = resolutionNoteLines(resolveLantern(false), 'polarity')
    expect(lines.map(l => l.split(':')[0])).toEqual(['D2', 'D7', 'D8', 'D9'])
    for (const l of lines) expect(l).toMatch(/^D\d: pinmap-unverified: polarity of "/)
    expect(resolutionNoteLines(resolveLantern(true), 'polarity')).toEqual([])
  })

  it('the polarity warning names the confirmation a resolved part can reach: the schematic', () => {
    const w = resolveLantern(false)[0].warnings.find(x => x.startsWith(POLARITY_UNVERIFIED_PREFIX))!
    expect(w).toMatch(/attach the schematic/i)
    // A resolved part has no Doctor card, so the warning must not send the user there.
    expect(w).not.toMatch(/Model Doctor/)
  })

  it('hasUnverifiedPolarity: false on a KiCad-official diode footprint and on an unrelated pin-map warning', () => {
    const kicad = resolveAll(
      makeCircuit([makePart('D1', 'SS14', 'Diode_SMD:D_SMA', { MPN: 'SS14' })]),
      undefined,
      undefined,
      lib,
    )[0]
    expect(kicad.status).toBe('ok')
    expect(hasUnverifiedPolarity(kicad)).toBe(false)
    const e = lib.find(x => x.id === 'diode-1n5819')!
    const generic = selectPinMap(e, 'MyLib:Odd_Package')
    expect(generic.warnings[0]).toMatch(/^pinmap-unverified:/)
    expect(hasUnverifiedPolarity({ warnings: generic.warnings })).toBe(false)
  })

  it('KiCad-official footprints stay confident (no warning)', () => {
    const e = lib.find(x => x.id === 'diode-1n5819')!
    expect(selectPinMap(e, 'Diode_SMD:D_SMA')).toEqual({ pinMap: KICAD_CATHODE_FIRST, warnings: [] })
  })

  it('ICs with JLC footprints are not affected (pad numbers follow the datasheet)', () => {
    const e = lib.find(x => x.id === 'mosfet-nce4012s')!
    const { pinMap, warnings } = selectPinMap(e, 'JLC-MCP:SOP-8_L4.9-W3.9-P1.27-LS6.0-BL')
    expect(pinMap).toEqual({ '5': '1', '4': '2', '1': '3' })
    expect(warnings).toEqual([])
  })

  it('the index header no longer states the JLC convention as verified fact', () => {
    const text = readFileSync(join(process.cwd(), 'resources', 'models', 'index.json'), 'utf8')
    const header = (JSON.parse(text) as { $comment: string }).$comment
    expect(header).not.toMatch(/verified on the led_lantern/i)
    expect(header).not.toMatch(/pad-1 = ANODE/)
  })
})
