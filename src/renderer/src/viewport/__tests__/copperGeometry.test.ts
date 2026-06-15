/**
 * copperGeometry.test.ts
 *
 * Task 17 — copper geometry math tests.
 *
 * Tests buildCopper(board) and via instancing.
 * THREE.js core geometry (Shape/ExtrudeGeometry/BufferGeometry) runs headless
 * in Node under Vitest — no WebGL context required.
 *
 * Fixtures used:
 *   fixture-rc.kicad_pcb  — 2 footprints (4 pads), 1 track segment, nets 1/2/3
 *   fixture-arcs.kicad_pcb — 1 via on net 3
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parseBoard } from '../../../../core/kicad/board'
import { buildCopper, buildViaInstances } from '../copperGeometry'

// ─── fixture-rc copper map ────────────────────────────────────────────────────

describe('buildCopper — fixture-rc', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)
  const copperMap = buildCopper(board)

  it('copper map has entries for nets 1, 2, and 3', () => {
    expect(copperMap.has(1)).toBe(true)  // VIN — 1 pad on R1
    expect(copperMap.has(2)).toBe(true)  // OUT — 2 pads (R1 pad2, R2 pad1) + 1 track
    expect(copperMap.has(3)).toBe(true)  // GND — 1 pad on R2
  })

  it('net 2 F-layer geometry exists', () => {
    const net2 = copperMap.get(2)!
    expect(net2.F).toBeDefined()
    expect(net2.F!.isBufferGeometry).toBe(true)
  })

  it('net 2 (track + 2 pads) has more vertices than net 1 (1 pad only)', () => {
    const net1 = copperMap.get(1)!
    const net2 = copperMap.get(2)!
    const count1 = net1.F?.getAttribute('position')?.count ?? 0
    const count2 = net2.F?.getAttribute('position')?.count ?? 0
    expect(count2).toBeGreaterThan(count1)
  })

  it('net 1 F-layer has position data', () => {
    const net1 = copperMap.get(1)!
    expect(net1.F).toBeDefined()
    const pos = net1.F!.getAttribute('position')
    expect(pos).toBeDefined()
    expect(pos.count).toBeGreaterThan(0)
  })

  it('net 3 F-layer has position data', () => {
    const net3 = copperMap.get(3)!
    expect(net3.F).toBeDefined()
    const pos = net3.F!.getAttribute('position')
    expect(pos).toBeDefined()
    expect(pos.count).toBeGreaterThan(0)
  })

  it('pads on correct layer (F.Cu → F slot)', () => {
    // All fixture-rc pads are on F.Cu, so every net entry should have F defined
    for (const [, entry] of copperMap) {
      expect(entry.F).toBeDefined()
    }
  })

  it('geometries are BufferGeometry instances', () => {
    for (const [, entry] of copperMap) {
      if (entry.F) expect(entry.F.isBufferGeometry).toBe(true)
      if (entry.B) expect(entry.B.isBufferGeometry).toBe(true)
    }
  })
})

// ─── via instancing — fixture-arcs ───────────────────────────────────────────

describe('buildViaInstances — fixture-arcs', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-arcs.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)

  it('fixture-arcs has exactly 1 via', () => {
    // The fixture file has one (via ...) entry
    expect(board.vias.length).toBe(1)
  })

  it('buildViaInstances returns count matching board via count', () => {
    const result = buildViaInstances(board)
    expect(result.count).toBe(board.vias.length)
  })

  it('instance→netId array has same length as via count', () => {
    const result = buildViaInstances(board)
    expect(result.netIds.length).toBe(board.vias.length)
  })

  it('via netId matches board data', () => {
    const result = buildViaInstances(board)
    // The via in fixture-arcs has net 3 (SIG)
    expect(result.netIds[0]).toBe(3)
  })

  it('mesh geometry is a cylinder (has position attribute)', () => {
    const result = buildViaInstances(board)
    const geo = result.mesh.geometry
    expect(geo).toBeDefined()
    const pos = geo.getAttribute('position')
    expect(pos).toBeDefined()
    expect(pos.count).toBeGreaterThan(0)
  })
})

// ─── arc track geometry ───────────────────────────────────────────────────────

describe('buildCopper — arc track tessellation', () => {
  // Synthetic board with one arc track segment
  // to verify arc tessellation produces a non-trivial geometry
  const syntheticBoard = {
    netById: new Map([[1, { id: 1, name: 'ARC_NET' }]]),
    footprints: [],
    tracks: [
      {
        kind: 'arc' as const,
        start: { x: 0, y: 0 },
        mid: { x: 5, y: -5 },
        end: { x: 10, y: 0 },
        widthMm: 0.25,
        layer: 'F.Cu',
        netId: 1,
      },
    ],
    vias: [],
    zones: [],
    edgeCuts: [],
    outline: { outer: [], holes: [], warnings: [] },
    silkscreen: [],
    boardThicknessMm: 1.6,
  }

  it('arc track produces copper geometry', () => {
    const copperMap = buildCopper(syntheticBoard)
    expect(copperMap.has(1)).toBe(true)
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    const pos = entry.F!.getAttribute('position')
    expect(pos).toBeDefined()
    // Arc with ≥8 pts/90° should produce many vertices
    expect(pos.count).toBeGreaterThan(10)
  })
})

// ─── pad shapes geometry ──────────────────────────────────────────────────────

describe('buildCopper — pad shape variety', () => {
  const mkBoard = (shape: string, width = 1.0, height = 1.0) => ({
    netById: new Map([[1, { id: 1, name: 'NET1' }]]),
    footprints: [
      {
        ref: 'C1',
        value: '100n',
        libId: 'Test:Pad',
        layer: 'F' as const,
        at: { x: 10, y: 10, rotDeg: 0 },
        pads: [
          {
            number: '1',
            type: 'smd' as const,
            shape: shape as 'circle' | 'rect' | 'oval' | 'roundrect' | 'custom',
            at: { x: 0, y: 0, rotDeg: 0 },
            size: { w: width, h: height },
            layers: ['F.Cu'],
            netId: 1,
          },
        ],
        properties: {},
      },
    ],
    tracks: [],
    vias: [],
    zones: [],
    edgeCuts: [],
    outline: { outer: [], holes: [], warnings: [] },
    silkscreen: [],
    boardThicknessMm: 1.6,
  })

  it('circle pad produces geometry', () => {
    const copperMap = buildCopper(mkBoard('circle'))
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    expect(entry.F!.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('rect pad produces geometry', () => {
    const copperMap = buildCopper(mkBoard('rect'))
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    expect(entry.F!.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('oval pad produces geometry', () => {
    const copperMap = buildCopper(mkBoard('oval', 1.5, 1.0))
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    expect(entry.F!.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('roundrect pad produces geometry', () => {
    const copperMap = buildCopper(mkBoard('roundrect'))
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    expect(entry.F!.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('custom pad falls back to bounding rect (produces geometry with warning)', () => {
    const copperMap = buildCopper(mkBoard('custom'))
    // custom pads fall back to bounding rect, should still produce geometry
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    expect(entry.F!.getAttribute('position').count).toBeGreaterThan(0)
  })
})

// ─── zone geometry ────────────────────────────────────────────────────────────

describe('buildCopper — zone polygon', () => {
  const boardWithZone = {
    netById: new Map([[1, { id: 1, name: 'GND' }]]),
    footprints: [],
    tracks: [],
    vias: [],
    zones: [
      {
        netId: 1,
        layer: 'F.Cu',
        polygon: [
          // outer polygon (counter-clockwise rectangle 10×10)
          [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
        ],
      },
    ],
    edgeCuts: [],
    outline: { outer: [], holes: [], warnings: [] },
    silkscreen: [],
    boardThicknessMm: 1.6,
  }

  it('zone polygon produces copper geometry', () => {
    const copperMap = buildCopper(boardWithZone)
    expect(copperMap.has(1)).toBe(true)
    const entry = copperMap.get(1)!
    expect(entry.F).toBeDefined()
    const pos = entry.F!.getAttribute('position')
    expect(pos).toBeDefined()
    expect(pos.count).toBeGreaterThan(0)
  })
})
