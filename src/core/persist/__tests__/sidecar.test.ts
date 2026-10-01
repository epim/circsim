/**
 * core/persist sidecar tests: round trip, validation, and the damaged-file
 * cases (v0, truncated, garbage, newer, hostile). Pure; no store, no board.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSidecar,
  GROUND_LEAD_KEY,
  loadSidecar,
  parseSidecar,
  planRestore,
  serializeSidecar,
  unsafeModelTextReason,
  type SidecarSnapshot,
} from '../sidecar'
import { UNWIRED, type Instrument } from '../../spicegen/instruments'
import type { CircuitNet } from '../../netlist/extract'
import { sidecarPathFor, isSidecarPath, baseName } from '../paths'
import { addRecent, normalizeRecent, removeRecent, MAX_RECENT } from '../recent'
import { sha256Hex } from '../hash'

function net(id: number, name: string): CircuitNet {
  return { id, kicadName: name, spiceNode: name, padRefs: [] }
}
const NETS = [net(1, 'VCC'), net(2, 'GND'), net(3, 'OUT'), net(4, '/MID')]
const REFS = new Set(['R1', 'U1', 'D1'])
const ctx = { nets: NETS, partRefs: REFS }

const BENCH: Instrument[] = [
  { kind: 'dc-supply', id: 'dc_supply_bench_1', netId: 1, volts: 9, seriesOhms: 0.2 },
  { kind: 'function-gen', id: 'function_gen_bench_2', netId: 3, wave: 'square', freqHz: 1000, amplitudeV: 1, offsetV: 0.5, dutyPct: 25, outputOhms: 50 },
  { kind: 'logic-input', id: 'logic_input_bench_3', netId: 3, level: 1, vHigh: 3.3 },
  { kind: 'voltage-probe', id: 'voltage_probe_bench_4', netId: 4, color: '#f96' },
  { kind: 'current-probe', id: 'current_probe_bench_5', ref: 'R1', pad: '1', color: '#9cf' },
  { kind: 'potentiometer', mode: 'divider', id: 'pot_bench_6', netHi: 1, netW: 4, netLo: 2, totalOhms: 10000, wiperPct: 0.25 },
  { kind: 'potentiometer', mode: 'rheostat', id: 'pot_bench_7', netA: 1, netW: UNWIRED, totalOhms: 5000, wiperPct: 0.5 },
]

function snapshot(over: Partial<SidecarSnapshot> = {}): SidecarSnapshot {
  return {
    appVersion: '0.2.9',
    board: { fileName: 'b.kicad_pcb', sha256: 'a'.repeat(64) },
    nets: NETS,
    groundNetId: 2,
    instruments: BENCH,
    leadPositions: new Map([
      [GROUND_LEAD_KEY, { x: 1, y: 2 }],
      ['dc_supply_bench_1:net', { x: 10.5, y: -20.25 }],
      ['pot_bench_6:W', { x: 3, y: 4 }],
      ['current_probe_bench_5:clamp', { x: 7, y: 8 }],
    ]),
    stubOverrides: new Map([['D1', { kind: 'stub', mode: 'short' }]]),
    pinMapOverrides: new Map([['U1', { '1': 'A', '2': 'K' }]]),
    railOverrides: new Map([['/MID', 3.3]]),
    userModels: new Map([
      ['U1', { mpn: 'X', subcktText: '.subckt X 1 2\nR1 1 2 1k\n.ends X\n', subcktName: 'X', pinMap: { '1': '1' }, provenance: 'user-import' as const }],
    ]),
    ...over,
  }
}

describe('round trip', () => {
  it('writes version 1 and loads back what was written', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const doc = JSON.parse(text)
    expect(doc.format).toBe('circsim-sidecar')
    expect(doc.version).toBe(1)
    expect(doc.ground).toEqual({ net: 'GND', lead: { x: 1, y: 2 } })
    // Nets are stored by name, never by id.
    expect(doc.instruments[0].nets).toEqual({ netId: 'VCC' })
    expect(doc.instruments[0].instrument.netId).toBeUndefined()

    const out = loadSidecar(text, ctx)
    expect(out.status).toBe('ok')
    expect(out.notes).toEqual([])
    expect(out.plan!.ground).toEqual({ netId: 2 })
    expect(out.plan!.instruments).toEqual(BENCH)
    expect(out.plan!.leadPositions.get('dc_supply_bench_1:net')).toEqual({ x: 10.5, y: -20.25 })
    expect(out.plan!.leadPositions.get('pot_bench_6:W')).toEqual({ x: 3, y: 4 })
    expect(out.plan!.leadPositions.get('current_probe_bench_5:clamp')).toEqual({ x: 7, y: 8 })
    expect(out.plan!.leadPositions.get(GROUND_LEAD_KEY)).toEqual({ x: 1, y: 2 })
    expect(out.plan!.stubOverrides.get('D1')).toEqual({ kind: 'stub', mode: 'short' })
    expect(out.plan!.pinMapOverrides.get('U1')).toEqual({ '1': 'A', '2': 'K' })
    expect(out.plan!.railOverrides.get('/MID')).toBe(3.3)
    expect(out.plan!.userModels.get('U1')?.subcktName).toBe('X')
    // ground + 7 instruments + stub + pinmap + rail + model
    expect(out.restored).toBe(12)
  })

  it('output is stable: same state, same text (diff-friendly, no timestamp)', () => {
    const a = serializeSidecar(buildSidecar(snapshot()))
    const b = serializeSidecar(buildSidecar(snapshot()))
    expect(a).toBe(b)
    expect(a).not.toMatch(/savedAt|\d{4}-\d{2}-\d{2}T/)
  })

  it('survives net ids being renumbered after a board edit', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const renumbered = [net(10, 'OUT'), net(11, 'VCC'), net(12, '/MID'), net(13, 'GND')]
    const out = loadSidecar(text, { nets: renumbered, partRefs: REFS })
    expect(out.plan!.ground).toEqual({ netId: 13 })
    const supply = out.plan!.instruments!.find(i => i.kind === 'dc-supply')
    expect(supply).toMatchObject({ netId: 11 })
  })

  it('explicit no-ground and an empty bench are real states, not absent', () => {
    const text = serializeSidecar(buildSidecar(snapshot({ groundNetId: null, instruments: [] })))
    const out = loadSidecar(text, ctx)
    expect(out.plan!.ground).toEqual({ netId: null })
    expect(out.plan!.instruments).toEqual([])
  })
})

describe('what is dropped when the board changed', () => {
  it('overrides for missing parts and nets are dropped with a note naming them', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const out = loadSidecar(text, { nets: [net(1, 'VCC'), net(2, 'GND')], partRefs: new Set(['R1']) })
    const notes = out.notes.join('\n')
    expect(notes).toContain('stub for D1')
    expect(notes).toContain('pin map for U1')
    expect(notes).toContain('rail override for /MID')
    expect(notes).toContain('model for U1')
    expect(out.plan!.stubOverrides.size).toBe(0)
    expect(out.plan!.railOverrides.size).toBe(0)
  })

  it('an instrument on a vanished net stays on the shelf, unwired', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const out = loadSidecar(text, { nets: [net(2, 'GND')], partRefs: REFS })
    const supply = out.plan!.instruments!.find(i => i.kind === 'dc-supply')
    expect(supply).toMatchObject({ netId: UNWIRED, volts: 9 })
    expect(out.notes.join('\n')).toMatch(/net VCC is not on this board/)
    expect(out.plan!.leadPositions.has('dc_supply_bench_1:net')).toBe(false)
  })

  it('a clamp on a vanished part is left unwired', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const out = loadSidecar(text, { nets: NETS, partRefs: new Set(['U1']) })
    const probe = out.plan!.instruments!.find(i => i.kind === 'current-probe')
    expect(probe).toMatchObject({ ref: '' })
  })

  it('a saved ground that no longer exists keeps the default', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const out = loadSidecar(text, { nets: [net(1, 'VCC')], partRefs: REFS })
    expect(out.plan!.ground).toBeUndefined()
    expect(out.notes.join('\n')).toMatch(/ground net GND is not on this board/)
  })
})

describe('v0, truncated, garbage and newer files', () => {
  it('v0: no version, bare ground string, flat instrument with net names', () => {
    const v0 = JSON.stringify({
      ground: 'GND',
      instruments: [{ kind: 'dc-supply', id: 'psu', netId: 'VCC', volts: 5, seriesOhms: 0.1 }],
      stubs: { D1: { kind: 'stub', mode: 'open' } },
    })
    const out = loadSidecar(v0, ctx)
    expect(out.status).toBe('legacy')
    expect(out.plan!.ground).toEqual({ netId: 2 })
    expect(out.plan!.instruments).toEqual([{ kind: 'dc-supply', id: 'psu', netId: 1, volts: 5, seriesOhms: 0.1 }])
    expect(out.plan!.stubOverrides.get('D1')).toEqual({ kind: 'stub', mode: 'open' })
    expect(out.notes.join('\n')).toMatch(/no version/)
  })

  it('truncated at every position never throws, and recovers a complete prefix', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    let recoveredSomething = 0
    for (let n = 0; n <= text.length; n++) {
      const out = loadSidecar(text.slice(0, n), ctx)
      expect(['ok', 'salvaged', 'unreadable', 'legacy']).toContain(out.status)
      if (out.plan && out.restored > 0) recoveredSomething++
    }
    expect(recoveredSomething).toBeGreaterThan(100)
  })

  it('truncation inside a late section keeps the earlier sections', () => {
    const text = serializeSidecar(buildSidecar(snapshot()))
    const cut = text.slice(0, text.indexOf('"userModels"') + 40)
    const out = loadSidecar(cut, ctx)
    expect(out.status).toBe('salvaged')
    expect(out.plan!.ground).toEqual({ netId: 2 })
    expect(out.plan!.instruments).toHaveLength(7)
    expect(out.plan!.railOverrides.get('/MID')).toBe(3.3)
    expect(out.plan!.userModels.size).toBe(0)
    expect(out.notes.join('\n')).toMatch(/cut off or damaged/)
  })

  it('garbage is unreadable with a note, not an exception', () => {
    for (const junk of ['', 'hello', '[]', '42', '"str"', 'null', '{"format":"other"}', '\u0000\u0001\u0002', '{'.repeat(1000)]) {
      const out = loadSidecar(junk, ctx)
      expect(out.status === 'unreadable' || out.status === 'salvaged' || out.status === 'legacy').toBe(true)
      expect(out.notes.length).toBeGreaterThan(0)
    }
    expect(loadSidecar('hello', ctx).plan).toBeNull()
  })

  it('a UTF-8 BOM is tolerated', () => {
    const text = '\ufeff' + serializeSidecar(buildSidecar(snapshot()))
    expect(loadSidecar(text, ctx).status).toBe('ok')
  })

  it('a newer version loads the sections it knows and says it will not overwrite', () => {
    const doc = JSON.parse(serializeSidecar(buildSidecar(snapshot())))
    doc.version = 3
    doc.brandNewSection = { x: 1 }
    const out = loadSidecar(JSON.stringify(doc), ctx)
    expect(out.status).toBe('newer')
    expect(out.plan!.ground).toEqual({ netId: 2 })
    expect(out.notes.join('\n')).toMatch(/newer circsim/)
  })

  it('one bad entry loses only itself', () => {
    const doc = JSON.parse(serializeSidecar(buildSidecar(snapshot())))
    doc.instruments[0].instrument.volts = 'nine'
    doc.instruments[1].instrument.freqHz = -5
    doc.instruments.push(42, null, { kind: 7 })
    doc.railOverrides = { '/MID': 'high', VCC: 5, OUT: -1 }
    doc.stubs.U1 = 'explode'
    const out = loadSidecar(JSON.stringify(doc), ctx)
    expect(out.status).toBe('ok')
    expect(out.plan!.instruments).toHaveLength(5)
    expect([...out.plan!.railOverrides]).toEqual([['VCC', 5]])
    expect(out.plan!.stubOverrides.has('U1')).toBe(false)
    expect(out.plan!.stubOverrides.has('D1')).toBe(true)
  })

  it('duplicate instrument ids keep the first', () => {
    const doc = JSON.parse(serializeSidecar(buildSidecar(snapshot())))
    doc.instruments.push(JSON.parse(JSON.stringify(doc.instruments[0])))
    const out = loadSidecar(JSON.stringify(doc), ctx)
    expect(out.plan!.instruments).toHaveLength(7)
    expect(out.notes.join('\n')).toMatch(/id is used twice/)
  })

  it('prototype-pollution keys are ignored', () => {
    const text = '{"format":"circsim-sidecar","version":1,"railOverrides":{"__proto__":5,"VCC":5},"stubs":{"constructor":"open"}}'
    const out = loadSidecar(text, ctx)
    expect([...out.plan!.railOverrides]).toEqual([['VCC', 5]])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(out.plan!.stubOverrides.size).toBe(0)
  })
})

describe('model text from a sidecar is untrusted', () => {
  it('allows ordinary model directives', () => {
    expect(unsafeModelTextReason('.subckt X 1 2\n.param a=1\nR1 1 2 {a}\n.model D1N D(Is=1e-14)\n.ends X\n')).toBeNull()
  })
  it('refuses control blocks, includes and libs', () => {
    expect(unsafeModelTextReason('.control\nshell calc\n.endc')).toMatch(/\.control/)
    expect(unsafeModelTextReason('.subckt X 1 2\n  .INCLUDE C:\\secret.txt\n.ends')).toMatch(/\.include/)
    expect(unsafeModelTextReason('.lib foo.lib x')).toMatch(/\.lib/)
    expect(unsafeModelTextReason('.osdi evil.osdi')).toMatch(/\.osdi/)
  })
  it('refuses oversize text', () => {
    expect(unsafeModelTextReason('*'.repeat(1024 * 1024 + 1))).toMatch(/larger/)
  })
  it('a hostile model is dropped on load but the rest of the file loads', () => {
    const doc = JSON.parse(serializeSidecar(buildSidecar(snapshot())))
    doc.userModels.U1.subcktText = '.subckt X 1 2\n.control\nshell calc\n.endc\n.ends'
    const out = loadSidecar(JSON.stringify(doc), ctx)
    expect(out.plan!.userModels.size).toBe(0)
    expect(out.plan!.ground).toEqual({ netId: 2 })
  })
})

describe('planRestore and parseSidecar direct', () => {
  it('parseSidecar needs no board', () => {
    const p = parseSidecar(serializeSidecar(buildSidecar(snapshot())))
    expect(p.status).toBe('ok')
    expect(p.sidecar!.instruments).toHaveLength(7)
    const plan = planRestore(p.sidecar!, ctx)
    expect(plan.restored).toBe(12)
  })
  it('a lead position with non-finite or absurd coordinates is dropped', () => {
    const doc = JSON.parse(serializeSidecar(buildSidecar(snapshot())))
    doc.instruments[0].leads.net = { x: 1e9, y: 0 }
    doc.ground.lead = { x: 'a', y: 1 }
    const out = loadSidecar(JSON.stringify(doc), ctx)
    expect(out.plan!.leadPositions.has('dc_supply_bench_1:net')).toBe(false)
    expect(out.plan!.leadPositions.has(GROUND_LEAD_KEY)).toBe(false)
  })
})

describe('paths', () => {
  it('derives the sidecar beside the board for both separators', () => {
    expect(sidecarPathFor('C:\\work\\blinker.kicad_pcb')).toBe('C:\\work\\blinker.circsim.json')
    expect(sidecarPathFor('/home/u/blinker.KICAD_PCB')).toBe('/home/u/blinker.circsim.json')
  })
  it('refuses to derive a sidecar for anything that is not a board', () => {
    expect(sidecarPathFor('C:\\work\\notes.txt')).toBeNull()
    expect(sidecarPathFor('.kicad_pcb')).toBeNull()
    expect(sidecarPathFor('C:\\work\\blinker.kicad_sch')).toBeNull()
  })
  it('isSidecarPath and baseName', () => {
    expect(isSidecarPath('a/b.circsim.json')).toBe(true)
    expect(isSidecarPath('a/b.json')).toBe(false)
    expect(baseName('C:\\x\\y.circsim.json')).toBe('y.circsim.json')
    expect(baseName('/x/y.circsim.json')).toBe('y.circsim.json')
  })
})

describe('recent boards', () => {
  it('puts the newest first, de-duplicates, and caps', () => {
    let list: string[] = []
    for (let i = 0; i < MAX_RECENT + 3; i++) list = addRecent(list, `/b/${i}.kicad_pcb`)
    expect(list).toHaveLength(MAX_RECENT)
    expect(list[0]).toBe(`/b/${MAX_RECENT + 2}.kicad_pcb`)
    list = addRecent(list, '/b/5.kicad_pcb')
    expect(list[0]).toBe('/b/5.kicad_pcb')
    expect(list.filter(p => p === '/b/5.kicad_pcb')).toHaveLength(1)
  })
  it('treats / and \\ as the same path', () => {
    const list = addRecent(['C:\\w\\a.kicad_pcb'], 'C:/w/a.kicad_pcb')
    expect(list).toEqual(['C:/w/a.kicad_pcb'])
  })
  it('ignores non-board paths and normalizes junk', () => {
    expect(addRecent([], '/x/readme.txt')).toEqual([])
    expect(normalizeRecent(null)).toEqual([])
    expect(normalizeRecent('str')).toEqual([])
    expect(normalizeRecent([1, null, '/a.txt', '/a/b.kicad_pcb', '/a/b.kicad_pcb'])).toEqual(['/a/b.kicad_pcb'])
    expect(normalizeRecent({ boards: ['/a/c.kicad_pcb'] })).toEqual(['/a/c.kicad_pcb'])
  })
  it('removeRecent', () => {
    expect(removeRecent(['/a/b.kicad_pcb', '/a/c.kicad_pcb'], '/a/b.kicad_pcb')).toEqual(['/a/c.kicad_pcb'])
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
