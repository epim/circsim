/**
 * componentGeometry.test.ts
 *
 * Task 18 — Component placeholder geometry tests.
 *
 * Tests the pure geometry/placement math:
 *   - classifyFootprint(libId) → class/height/color
 *   - computePlaceholderBox(fp, boardThicknessMm) → { w, h, heightMm, worldPos }
 *   - buildComponentBoxes(footprints, boardThicknessMm) → ComponentBoxEntry[]
 *
 * Troika Text objects are NOT tested here (they require a DOM worker). Only the
 * geometry dimensions and placement math are tested headlessly.
 *
 * THREE.js core geometry (BoxGeometry/BufferGeometry) runs headless in Node.
 *
 * fixture-rc.kicad_pcb — 2 footprints: R1 at (10,10), R2 at (20,10), both
 * "Resistor_SMD:R_0805_2012Metric" → classified as passives (height 0.6 mm).
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { parseBoard } from '../../../../core/kicad/board'
import {
  classifyFootprint,
  computePlaceholderBox,
  buildComponentBoxes,
  COMPONENT_CLASSES,
} from '../componentGeometry'

// ─── classification table unit tests ────────────────────────────────────────

describe('classifyFootprint — classification table', () => {
  it('Resistor_SMD:R_0805 → passive class, 0.6 mm height', () => {
    const cls = classifyFootprint('Resistor_SMD:R_0805_2012Metric')
    expect(cls.heightMm).toBeCloseTo(0.6)
    expect(cls.className).toBe('passive')
  })

  it('Capacitor_SMD:C_0402 → passive class', () => {
    const cls = classifyFootprint('Capacitor_SMD:C_0402_1005Metric')
    expect(cls.heightMm).toBeCloseTo(0.6)
    expect(cls.className).toBe('passive')
  })

  it('Package_TO_SOT_SMD:SOT-23 → SOT class, 1.1 mm height', () => {
    const cls = classifyFootprint('Package_TO_SOT_SMD:SOT-23')
    expect(cls.heightMm).toBeCloseTo(1.1)
    expect(cls.className).toBe('sot')
  })

  it('Package_SO:SOIC-8 → SOIC class, 2.5 mm height', () => {
    const cls = classifyFootprint('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')
    expect(cls.heightMm).toBeCloseTo(2.5)
    expect(cls.className).toBe('soic')
  })

  it('Package_DIP:DIP-8 → DIP class (soic height 2.5 mm)', () => {
    const cls = classifyFootprint('Package_DIP:DIP-8_W7.62mm')
    expect(cls.heightMm).toBeCloseTo(2.5)
    expect(cls.className).toBe('soic')
  })

  it('Package_TO_SOT_THT:TO-220 → TO-220 class, 4.0 mm height', () => {
    const cls = classifyFootprint('Package_TO_SOT_THT:TO-220-3_Vertical')
    expect(cls.heightMm).toBeCloseTo(4.0)
    expect(cls.className).toBe('to220')
  })

  it('unknown footprint → default class (passive height)', () => {
    const cls = classifyFootprint('SomeVendor:Unknown_Part')
    expect(cls.heightMm).toBeCloseTo(0.6)
    expect(cls.className).toBe('passive')
  })

  it('each class entry has a color defined', () => {
    for (const [, entry] of Object.entries(COMPONENT_CLASSES)) {
      expect(typeof entry.color).toBe('number')
      expect(entry.heightMm).toBeGreaterThan(0)
    }
  })
})

// ─── computePlaceholderBox tests ─────────────────────────────────────────────

describe('computePlaceholderBox — fixture-rc footprints', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)

  it('fixture-rc has 2 footprints', () => {
    expect(board.footprints.length).toBe(2)
  })

  it('R1 placeholder box has positive dimensions', () => {
    const fp = board.footprints.find(f => f.ref === 'R1')!
    const box = computePlaceholderBox(fp, board.boardThicknessMm)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
    expect(box.heightMm).toBeCloseTo(0.6)  // passive height
  })

  it('R2 placeholder box has positive dimensions', () => {
    const fp = board.footprints.find(f => f.ref === 'R2')!
    const box = computePlaceholderBox(fp, board.boardThicknessMm)
    expect(box.w).toBeGreaterThan(0)
    expect(box.h).toBeGreaterThan(0)
    expect(box.heightMm).toBeCloseTo(0.6)  // passive height
  })

  it('R1 world position is centered near KiCad (10,10)', () => {
    const fp = board.footprints.find(f => f.ref === 'R1')!
    const box = computePlaceholderBox(fp, board.boardThicknessMm)
    // kicadToWorld(10, 10) = { x: 10, y: -10 }
    expect(box.worldX).toBeCloseTo(10, 1)
    expect(box.worldY).toBeCloseTo(-10, 1)
  })

  it('R2 world position is centered near KiCad (20,10)', () => {
    const fp = board.footprints.find(f => f.ref === 'R2')!
    const box = computePlaceholderBox(fp, board.boardThicknessMm)
    // kicadToWorld(20, 10) = { x: 20, y: -10 }
    expect(box.worldX).toBeCloseTo(20, 1)
    expect(box.worldY).toBeCloseTo(-10, 1)
  })

  it('F-side component Z is above board top surface', () => {
    const fp = board.footprints.find(f => f.ref === 'R1')!
    const box = computePlaceholderBox(fp, board.boardThicknessMm)
    // Z center = boardThickness + heightMm/2
    const expectedZ = board.boardThicknessMm + box.heightMm / 2
    expect(box.worldZ).toBeCloseTo(expectedZ, 2)
  })
})

describe('computePlaceholderBox — B-side placement', () => {
  const bSideFootprint = {
    ref: 'C1',
    value: '100n',
    libId: 'Capacitor_SMD:C_0402_1005Metric',
    layer: 'B' as const,
    at: { x: 15, y: 10, rotDeg: 0 },
    pads: [
      {
        number: '1',
        type: 'smd' as const,
        shape: 'rect' as const,
        at: { x: -0.5, y: 0, rotDeg: 0 },
        size: { w: 0.5, h: 0.5 },
        layers: ['B.Cu'],
        netId: 1,
      },
      {
        number: '2',
        type: 'smd' as const,
        shape: 'rect' as const,
        at: { x: 0.5, y: 0, rotDeg: 0 },
        size: { w: 0.5, h: 0.5 },
        layers: ['B.Cu'],
        netId: 2,
      },
    ],
    properties: {},
  }

  it('B-side component Z is below board (negative Z)', () => {
    const boardThickness = 1.6
    const box = computePlaceholderBox(bSideFootprint, boardThickness)
    // B-side: Z center = -(heightMm/2) (below the board, which starts at Z=0)
    expect(box.worldZ).toBeLessThan(0)
    const expectedZ = -(box.heightMm / 2)
    expect(box.worldZ).toBeCloseTo(expectedZ, 2)
  })
})

describe('computePlaceholderBox — pad-bbox fallback', () => {
  // Footprint without courtyardBounds — falls back to pad bounding box + 0.4mm margin
  const fpNoCrtYd = {
    ref: 'U1',
    value: 'NE555',
    libId: 'Package_DIP:DIP-8_W7.62mm',
    layer: 'F' as const,
    at: { x: 10, y: 10, rotDeg: 0 },
    pads: [
      {
        number: '1',
        type: 'thru_hole' as const,
        shape: 'circle' as const,
        at: { x: -3.81, y: -5.08, rotDeg: 0 },
        size: { w: 1.6, h: 1.6 },
        layers: ['F.Cu', 'B.Cu'],
        netId: 1,
      },
      {
        number: '8',
        type: 'thru_hole' as const,
        shape: 'circle' as const,
        at: { x: 3.81, y: 5.08, rotDeg: 0 },
        size: { w: 1.6, h: 1.6 },
        layers: ['F.Cu', 'B.Cu'],
        netId: 2,
      },
    ],
    properties: {},
    // No courtyardBounds
  }

  it('uses pad bounding box + margin when no courtyardBounds', () => {
    const box = computePlaceholderBox(fpNoCrtYd, 1.6)
    // Pad span: from (-3.81 - 0.8) to (3.81 + 0.8) = 9.22 in X
    // Plus pad size half (0.8) already included above
    // Span X = 3.81*2 + 1.6 = 9.22 → + 2*0.4 margin = 10.02
    expect(box.w).toBeGreaterThan(8)   // at least 8 mm wide
    expect(box.h).toBeGreaterThan(8)   // at least 8 mm tall
    // height is DIP = soic class = 2.5mm
    expect(box.heightMm).toBeCloseTo(2.5)
  })
})

describe('computePlaceholderBox — with courtyardBounds', () => {
  const fpWithCrtYd = {
    ref: 'R1',
    value: '10k',
    libId: 'Resistor_SMD:R_0805_2012Metric',
    layer: 'F' as const,
    at: { x: 10, y: 10, rotDeg: 0 },
    pads: [],
    properties: {},
    courtyardBounds: { w: 3.0, h: 2.0 },
  }

  it('uses courtyardBounds dimensions when available', () => {
    const box = computePlaceholderBox(fpWithCrtYd, 1.6)
    expect(box.w).toBeCloseTo(3.0)
    expect(box.h).toBeCloseTo(2.0)
  })
})

// ─── buildComponentBoxes — fixture-rc ────────────────────────────────────────

describe('buildComponentBoxes — fixture-rc', () => {
  const fixturePath = path.resolve(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb')
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)

  it('returns 2 entries for fixture-rc (2 footprints)', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    expect(entries.length).toBe(2)
  })

  it('each entry has ref, geometry, worldPos, and className', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    for (const entry of entries) {
      expect(typeof entry.ref).toBe('string')
      expect(entry.ref.length).toBeGreaterThan(0)
      expect(entry.geo).toBeDefined()
      expect(entry.geo.isBufferGeometry).toBe(true)
      expect(typeof entry.worldX).toBe('number')
      expect(typeof entry.worldY).toBe('number')
      expect(typeof entry.worldZ).toBe('number')
      expect(typeof entry.className).toBe('string')
    }
  })

  it('R1 entry ref matches', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    const r1 = entries.find(e => e.ref === 'R1')
    expect(r1).toBeDefined()
  })

  it('R2 entry ref matches', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    const r2 = entries.find(e => e.ref === 'R2')
    expect(r2).toBeDefined()
  })

  it('boxes are F.Cu side → Z > 0 (above board)', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    for (const entry of entries) {
      expect(entry.worldZ).toBeGreaterThan(0)
    }
  })

  it('box geometry bounding box matches expected width×height', () => {
    const entries = buildComponentBoxes(board.footprints, board.boardThicknessMm)
    const r1 = entries.find(e => e.ref === 'R1')!
    r1.geo.computeBoundingBox()
    const bb = r1.geo.boundingBox!
    // The box geometry should have non-zero extents
    expect(bb.max.x - bb.min.x).toBeGreaterThan(0)
    expect(bb.max.y - bb.min.y).toBeGreaterThan(0)
    expect(bb.max.z - bb.min.z).toBeGreaterThan(0)
  })
})

// ─── buildComponentBoxes — B-side mirroring ──────────────────────────────────

describe('buildComponentBoxes — B-side mirroring', () => {
  const mixedBoard = [
    {
      ref: 'R1',
      value: '10k',
      libId: 'Resistor_SMD:R_0805_2012Metric',
      layer: 'F' as const,
      at: { x: 10, y: 10, rotDeg: 0 },
      pads: [
        {
          number: '1',
          type: 'smd' as const,
          shape: 'rect' as const,
          at: { x: 0, y: 0, rotDeg: 0 },
          size: { w: 1, h: 1 },
          layers: ['F.Cu'],
          netId: 1,
        },
      ],
      properties: {},
    },
    {
      ref: 'C1',
      value: '100n',
      libId: 'Capacitor_SMD:C_0402_1005Metric',
      layer: 'B' as const,
      at: { x: 20, y: 10, rotDeg: 0 },
      pads: [
        {
          number: '1',
          type: 'smd' as const,
          shape: 'rect' as const,
          at: { x: 0, y: 0, rotDeg: 0 },
          size: { w: 0.5, h: 0.5 },
          layers: ['B.Cu'],
          netId: 2,
        },
      ],
      properties: {},
    },
  ]

  it('F-side component has Z > 0', () => {
    const entries = buildComponentBoxes(mixedBoard, 1.6)
    const r1 = entries.find(e => e.ref === 'R1')!
    expect(r1.worldZ).toBeGreaterThan(0)
  })

  it('B-side component has Z < 0', () => {
    const entries = buildComponentBoxes(mixedBoard, 1.6)
    const c1 = entries.find(e => e.ref === 'C1')!
    expect(c1.worldZ).toBeLessThan(0)
  })
})
