/**
 * The hobbyist-parts library expansion of issue #29: each new part resolves to the
 * model it should (never to a footprint-fallback stand-in), every pin map names
 * real subcircuit terminals, and a synthetic lantern-class board no longer has an
 * unresolved part.
 *
 * Pure Node, no ngspice. The electrical behavior is the characterization rows
 * (npm run test:characterization).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../kicad/board'
import { extract, suggestGround } from '../../netlist/extract'
import { resolveAll } from '../resolve'
import type { Resolution } from '../types'
import { bundledLibrary, makeCircuit, makePart } from './p2-helpers'
import { lanternClassBoardText, targetClassParts } from './lanternClassBoard'

const library = bundledLibrary()
const MODELS_DIR = join(process.cwd(), 'resources', 'models')

function resolveOne(ref: string, value: string, libId: string, mpn?: string): Resolution {
  const part = makePart(ref, value, libId, mpn ? { MPN: mpn } : {})
  return resolveAll(makeCircuit([part]), undefined, undefined, library)[0]
}

// [ref, value, footprint, expected model name (subckt / card / template) or 'open']
const NEW_PARTS: Array<[string, string, string, string]> = [
  ['U1', 'LM317T', 'Package_TO_SOT_THT:TO-220-3_Vertical', 'LM317'],
  ['U1', 'AP2112K-3.3', 'Package_TO_SOT_SMD:SOT-23-5', 'AP2112K-3.3'],
  ['U1', 'MCP1700-3302E', 'Package_TO_SOT_SMD:SOT-23', 'MCP1700-3302'],
  ['U1', 'XC6206P332MR', 'Package_TO_SOT_SMD:SOT-23', 'XC6206-3.3'],
  ['U1', 'TP4056', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 'TP4056'],
  ['U1', 'LM2596S-ADJ', 'Package_TO_SOT_SMD:TO-263-5_TabPin3', 'open'],
  ['U1', 'MT3608', 'Package_TO_SOT_SMD:SOT-23-6', 'open'],
  ['U1', 'MP1584EN', 'Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm', 'open'],
  ['U1', 'MCP6001', 'Package_TO_SOT_SMD:SOT-23-5', 'MCP6001'],
  ['U1', 'MCP6002', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 'MCP6002'],
  ['U1', 'NE5532', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 'NE5532'],
  ['U1', 'LM741', 'Package_DIP:DIP-8_W7.62mm', 'LM741'],
  ['Q1', 'IRLZ44N', 'Package_TO_SOT_THT:TO-220-3_Vertical', 'MIRLZ44N'],
  ['Q1', 'IRF540N', 'Package_TO_SOT_THT:TO-220-3_Vertical', 'MIRF540N'],
  ['Q1', 'IRF3205', 'Package_TO_SOT_THT:TO-220-3_Vertical', 'MIRF3205'],
  ['Q1', 'IRF9540N', 'Package_TO_SOT_THT:TO-220-3_Vertical', 'MIRF9540N'],
  ['Q1', 'IRLML6402', 'Package_TO_SOT_SMD:SOT-23', 'MIRLML6402'],
  ['D1', 'SS34', 'Diode_SMD:D_SMA', 'DSS34'],
  ['D1', '1N5822', 'Diode_THT:D_DO-201AD_P15.24mm_Horizontal', 'D1N5822'],
  ['D1', 'BZX84C3V3', 'Diode_SMD:D_SOD-123', 'DZ3V3'],
  ['D1', 'BZX84C12', 'Diode_SMD:D_SOD-123', 'DZ12V'],
  ['D1', 'Yellow', 'LED_SMD:LED_0805_2012Metric', 'LED_YELLOW'],
  ['D1', 'orange', 'LED_SMD:LED_0603_1608Metric', 'LED_ORANGE'],
  ['U1', 'PC817', 'Package_DIP:DIP-4_W7.62mm', 'PC817'],
  ['U1', '4N35', 'Package_DIP:DIP-6_W7.62mm', '4N35'],
  ['U1', '74HC02', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm', '74HC02'],
  ['U1', '74HC10', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm', '74HC10'],
  ['U1', '74HC20', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm', '74HC20'],
]

describe('issue #29 library expansion: each new part resolves to its own model', () => {
  it.each(NEW_PARTS)('%s %s (%s)', (ref, value, libId, expected) => {
    const r = resolveOne(ref, value, libId)
    if (expected === 'open') {
      expect(r.status).toBe('documented-open')
      expect(r.note).toMatch(/Intentionally left open/)
      return
    }
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(3)
    const name = r.model?.kind === 'subckt' ? r.model.subcktName : r.model?.kind === 'xspice-digital' ? r.model.templateId : undefined
    expect(name).toBe(expected)
    // Matched by MPN or value, never by the refdes-and-footprint fallback.
    expect(r.warnings.filter(w => w.startsWith('library-fallback')), 'must not be a footprint-fallback match').toEqual([])
  })

  it('a SOT-23-5 AP2112K is no longer claimed by the LM358 fallback (it was before the entry existed)', () => {
    const r = resolveOne('U1', 'AP2112K-3.3', 'Package_TO_SOT_SMD:SOT-23-5')
    expect(r.model).toMatchObject({ subcktName: 'AP2112K-3.3' })
  })

  it('a TO-263 LM2596 is no longer claimed by the 7805 fallback', () => {
    const r = resolveOne('U1', 'LM2596S-ADJ', 'Package_TO_SOT_SMD:TO-263-5_TabPin3')
    expect(r.status).toBe('documented-open')
  })

  it('names the pins of the datasheet footprint: LM317 TO-220 is ADJ, OUT, IN', () => {
    const r = resolveOne('U1', 'LM317T', 'Package_TO_SOT_THT:TO-220-3_Vertical')
    expect(r.model).toMatchObject({ pinMap: { '1': 'adj', '2': 'vout', '3': 'vin' } })
  })

  it('maps the IRLZ44N TO-220 pads G, D, S to the VDMOS drain-gate-source positions', () => {
    const r = resolveOne('Q1', 'IRLZ44N', 'Package_TO_SOT_THT:TO-220-3_Vertical')
    expect(r.model).toMatchObject({ pinMap: { '1': '2', '2': '1', '3': '3' } })
  })
})

describe('every subckt entry pin map names real terminals of its subcircuit', () => {
  function terminalsOf(file: string, name: string): string[] | undefined {
    const text = readFileSync(join(MODELS_DIR, file), 'utf8').replace(/\r?\n\+/g, ' ')
    const re = new RegExp(`^\\.subckt\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([^\\n]*)`, 'im')
    const m = re.exec(text)
    if (!m) return undefined
    return m[1].split(/\s+/).filter(t => t !== '' && !t.includes('=') && t.toLowerCase() !== 'params:').map(t => t.toLowerCase())
  }

  const subckts = library.filter(e => e.model.type === 'subckt' && e.model.file && !e.model.file.startsWith('__user'))
  it.each(subckts.map(e => [e.id, e] as const))('%s', (_id, entry) => {
    const terminals = terminalsOf(entry.model.file as string, entry.model.name)
    expect(terminals, `${entry.model.name} must be defined in ${entry.model.file}`).toBeDefined()
    const maps = [...Object.values(entry.pinMaps), ...(entry.defaultPinMap ? [entry.defaultPinMap] : [])]
    for (const map of maps) {
      for (const node of Object.values(map)) {
        const ok = terminals!.includes(node.toLowerCase()) || /^\d+$/.test(node)
        expect(ok, `${entry.id}: pin map value "${node}" is not a terminal of ${entry.model.name} (${terminals!.join(' ')})`).toBe(true)
      }
    }
  })
})

describe('the synthetic lantern-class board (lantern-shape plus the target-board parts)', () => {
  const board = parseBoard(lanternClassBoardText())
  const probe = extract(board)
  const gnd = suggestGround(probe.nets)
  const circuit = extract(board, gnd ? { groundNetId: gnd.id } : {})
  const resolutions = resolveAll(circuit, undefined, undefined, library)
  const byRef = new Map(resolutions.map(r => [r.ref, r]))

  const count = (status: Resolution['status']): number => resolutions.filter(r => r.status === status).length

  it('has no unresolved part, where 18 of its 57 were unresolved before the stub rules and the new entries', () => {
    expect(resolutions).toHaveLength(57)
    expect(count('unresolved')).toBe(0)
    expect(count('ok')).toBe(46)
    expect(count('stubbed')).toBe(8)
    expect(count('documented-open')).toBe(3)
  })

  it('stubs the controllers, the addressable LEDs and the USB-serial bridge as supply loads with a reason', () => {
    for (const ref of ['U20', 'U21', 'U22', 'U23', 'U24', 'D20', 'D21', 'D22']) {
      const r = byRef.get(ref)!
      expect(r.status, ref).toBe('stubbed')
      expect(r.model?.kind, ref).toBe('subckt')
      expect(r.warnings[0], ref).toMatch(/^stub: .*supply-load stub/)
    }
  })

  it('binds every stub to the rail it really sits on', () => {
    const rail = (ref: string): string => {
      const r = byRef.get(ref)!
      const part = circuit.parts.find(p => p.ref === ref)!
      if (r.model?.kind !== 'subckt') throw new Error(`${ref} is not a subckt`)
      const vddPad = Object.keys(r.model.pinMap).find(p => r.model && r.model.kind === 'subckt' && r.model.pinMap[p] === 'vdd')!
      return circuit.nets.find(n => n.id === part.padNet.get(vddPad))!.kicadName
    }
    expect(rail('U20')).toBe('+3V3')
    expect(rail('U21')).toBe('+3V3')
    expect(rail('U22')).toBe('+5V')
    expect(rail('U23')).toBe('+3V3')
    expect(rail('U24')).toBe('+5V')
    expect(rail('D20')).toBe('+5V')
  })

  it('resolves the regulators, charger and discretes to their own models', () => {
    const name = (ref: string): string | undefined => {
      const m = byRef.get(ref)?.model
      return m?.kind === 'subckt' ? m.subcktName : m?.kind === 'xspice-digital' ? m.templateId : undefined
    }
    expect(name('U25')).toBe('TP4056')
    expect(name('U26')).toBe('AP2112K-3.3')
    expect(name('U27')).toBe('LM317')
    expect(name('U30')).toBe('PC817')
    expect(name('U31')).toBe('NE5532')
    expect(name('U32')).toBe('MCP6002')
    expect(name('U33')).toBe('74HC02')
    expect(name('D23')).toBe('DSS34')
    expect(name('D24')).toBe('LED_YELLOW')
    expect(name('Q20')).toBe('MIRLZ44N')
    expect(name('Q21')).toBe('MIRLML6402')
    expect(byRef.get('U28')?.status).toBe('documented-open')
    expect(byRef.get('U29')?.status).toBe('documented-open')
    expect(byRef.get('Y1')?.status).toBe('documented-open')
  })

  it('has the part list the measurement describes', () => {
    expect(targetClassParts()).toHaveLength(35)
  })
})
