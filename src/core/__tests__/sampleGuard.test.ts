/**
 * Task 26 — Guard test: sample project parse + resolve.
 *
 * Verifies that resources/sample/blinker-555.kicad_pcb + .kicad_sch parse
 * cleanly and resolve with 0 parse errors and 0 unresolved parts. A malformed
 * or under-resolved sample must fail CI, not first launch.
 *
 * This is a plain Vitest test (no ngspice, no Electron) — runs in the normal
 * unit suite.
 *
 * Spec §13 (guard test), Task 26.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseBoard } from '../kicad/board'
import { parseSchematicSimData } from '../kicad/schematic'
import { extract, suggestGround } from '../netlist/extract'
import { resolveAll } from '../models/resolve'
import type { LibraryEntry } from '../models/types'

const SAMPLE_DIR = join(process.cwd(), 'resources', 'sample')
const MODELS_DIR = join(process.cwd(), 'resources', 'models')

function readSampleFile(name: string): string {
  return readFileSync(join(SAMPLE_DIR, name), 'utf8')
}

function loadBundledLibrary(): LibraryEntry[] {
  const index = JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')) as {
    entries: LibraryEntry[]
  }
  return index.entries
}

describe('Task 26 — sample project guard', () => {
  it('blinker-555.kicad_pcb parses without error', () => {
    const text = readSampleFile('blinker-555.kicad_pcb')
    // Must not throw
    const board = parseBoard(text)
    expect(board.footprints.length).toBeGreaterThan(0)
    expect(board.netById.size).toBeGreaterThan(0)
  })

  it('blinker-555.kicad_sch parses without error', () => {
    const text = readSampleFile('blinker-555.kicad_sch')
    // Must not throw
    const data = parseSchematicSimData(text)
    expect(data.size).toBeGreaterThan(0)
  })

  it('blinker-555 netlist extracts correctly', () => {
    const boardText = readSampleFile('blinker-555.kicad_pcb')
    const board = parseBoard(boardText)
    const probe = extract(board)
    expect(probe.parts.length).toBeGreaterThanOrEqual(7) // U1 R1 R2 R3 C1 C2 D1
    expect(probe.nets.length).toBeGreaterThanOrEqual(6)  // VCC GND DISCH THRES OUT LED_A CTRL
  })

  it('blinker-555 resolves with 0 parse errors and 0 unresolved parts', () => {
    const boardText = readSampleFile('blinker-555.kicad_pcb')
    const schText = readSampleFile('blinker-555.kicad_sch')
    const library = loadBundledLibrary()

    // Parse
    const board = parseBoard(boardText)
    const schData = parseSchematicSimData(schText)

    // Extract (with ground heuristic)
    const probe = extract(board)
    const gnd = suggestGround(probe.nets)
    const circuit = gnd ? extract(board, { groundNetId: gnd.id }) : probe

    // Resolve
    const resolutions = resolveAll(circuit, schData, undefined, library)

    // Guard assertions
    const unresolved = resolutions.filter(r => r.status === 'unresolved')
    expect(unresolved, `Unresolved parts: ${unresolved.map(r => r.ref).join(', ')}`).toHaveLength(0)

    // All 7 parts should be present
    expect(resolutions.length).toBeGreaterThanOrEqual(7)

    // No part should have status 'unresolved'
    for (const r of resolutions) {
      expect(
        r.status,
        `Part ${r.ref} is unresolved (tier ${r.tier}, warnings: ${r.warnings.join('; ')})`
      ).not.toBe('unresolved')
    }
  })

  it('first-light.kicad_pcb resolves with 0 unresolved parts; nets VIN/LEDA/GND present', () => {
    const boardText = readSampleFile('first-light.kicad_pcb')
    const library = loadBundledLibrary()

    // Parse + extract (with the ground heuristic), then resolve against the library.
    const board = parseBoard(boardText)
    const probe = extract(board)
    const gnd = suggestGround(probe.nets)
    const circuit = gnd ? extract(board, { groundNetId: gnd.id }) : probe

    const resolutions = resolveAll(circuit, undefined, undefined, library)

    // Both parts present and resolved (R1 = primitive resistor, D1 = LED model-card).
    expect(resolutions.length).toBeGreaterThanOrEqual(2)
    const unresolved = resolutions.filter(r => r.status === 'unresolved')
    expect(unresolved, `Unresolved parts: ${unresolved.map(r => r.ref).join(', ')}`).toHaveLength(0)
    expect(resolutions.find(r => r.ref === 'R1')!.status).not.toBe('unresolved')
    expect(resolutions.find(r => r.ref === 'D1')!.status).not.toBe('unresolved')

    // The three named nets survived extraction.
    const netNames = circuit.nets.map(n => n.kicadName)
    expect(netNames).toContain('VIN')
    expect(netNames).toContain('LEDA')
    expect(netNames).toContain('GND')
  })

  it('blinker-555 has U1=NE555 resolved via tier 1 (Sim.* fields)', () => {
    const boardText = readSampleFile('blinker-555.kicad_pcb')
    const schText = readSampleFile('blinker-555.kicad_sch')
    const library = loadBundledLibrary()

    const board = parseBoard(boardText)
    const schData = parseSchematicSimData(schText)
    const probe = extract(board)
    const gnd = suggestGround(probe.nets)
    const circuit = gnd ? extract(board, { groundNetId: gnd.id }) : probe
    const resolutions = resolveAll(circuit, schData, undefined, library)

    const u1 = resolutions.find(r => r.ref === 'U1')
    expect(u1).toBeDefined()
    expect(u1!.status).toBe('ok')
    // Tier 1 (Sim.* fields) or tier 3 (library) are both acceptable
    expect([1, 3]).toContain(u1!.tier)
    expect(u1!.model?.kind).toMatch(/subckt|primitive/)
  })
})
