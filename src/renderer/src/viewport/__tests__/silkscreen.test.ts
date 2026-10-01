/**
 * silkscreen.test.ts
 *
 * #57: all silkscreen text is one merged glyph-quad geometry (one draw call)
 * instead of one troika Text object per string. The canvas atlas needs a DOM and
 * is exercised in the app; the layout and geometry math is pure and tested here
 * against a fixed-metrics fake atlas.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSilkscreenEntries,
  buildSilkscreenGeometry,
  type GlyphAtlasLayout,
  type SilkscreenEntry,
} from '../silkscreen'

/** Each non-space glyph is 0.6 em advance, a 1.4 em square quad, uv in a tiny cell. */
const ATLAS: GlyphAtlasLayout = {
  quadW: 1.4,
  quadH: 1.4,
  quadBottom: -0.7,
  glyph: ch => {
    if (ch.trim() === '') return { u0: 0, u1: 0, v0: 0, v1: 0, advance: 0.35 }
    const code = ch.charCodeAt(0)
    return { u0: code / 1000, u1: (code + 1) / 1000, v0: 0.25, v1: 0.5, advance: 0.6 }
  },
}

function entry(text: string, over: Partial<SilkscreenEntry> = {}): SilkscreenEntry {
  return { text, worldX: 0, worldY: 0, worldZ: 1.62, rotRad: 0, isBSide: false, layer: 'F.SilkS', ...over }
}

function bounds(pos: ArrayLike<number>, from: number, count: number) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = from; i < from + count; i++) {
    minX = Math.min(minX, pos[i * 3]); maxX = Math.max(maxX, pos[i * 3])
    minY = Math.min(minY, pos[i * 3 + 1]); maxY = Math.max(maxY, pos[i * 3 + 1])
  }
  return { minX, maxX, minY, maxY }
}

describe('buildSilkscreenGeometry', () => {
  it('returns null when there is nothing to draw', () => {
    expect(buildSilkscreenGeometry([], ATLAS)).toBeNull()
    expect(buildSilkscreenGeometry([entry('   ')], ATLAS)).toBeNull()
  })

  it('makes one quad (4 vertices, 6 indices) per drawn character, none for spaces', () => {
    const geo = buildSilkscreenGeometry([entry('R1'), entry('C 2')], ATLAS)!
    // R,1,C,2 = 4 glyphs
    expect(geo.getAttribute('position').count).toBe(16)
    expect(geo.getAttribute('uv').count).toBe(16)
    expect(geo.getIndex()!.count).toBe(24)
  })

  it('merges 1501 strings into a single geometry', () => {
    const entries = Array.from({ length: 1501 }, (_, i) => entry(`R${i}`, { worldX: i }))
    const geo = buildSilkscreenGeometry(entries, ATLAS)!
    const glyphs = entries.reduce((n, e) => n + e.text.length, 0)
    expect(geo.getAttribute('position').count).toBe(glyphs * 4)
    expect(geo.getIndex()!.count).toBe(glyphs * 6)
    // 32-bit indices: more than 65535 vertices must not wrap
    expect(geo.getIndex()!.array).toBeInstanceOf(Uint32Array)
  })

  it('indices reference the right quad corners', () => {
    const geo = buildSilkscreenGeometry([entry('AB')], ATLAS)!
    expect(Array.from(geo.getIndex()!.array)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  })

  it('centers the text on the entry position', () => {
    const geo = buildSilkscreenGeometry([entry('ABCD', { worldX: 10, worldY: -4 })], ATLAS)!
    const b = bounds(geo.getAttribute('position').array, 0, geo.getAttribute('position').count)
    // 4 glyphs advance 2.4 em; quads overhang by (1.4 - 0.6) / 2 on each side
    expect((b.minX + b.maxX) / 2).toBeCloseTo(10, 4)
    expect(b.maxX - b.minX).toBeCloseTo(2.4 - 0.6 + 1.4, 4)
    // quad spans -0.7 .. +0.7 em about the vertical center
    expect(b.minY).toBeCloseTo(-4 - 0.7, 4)
    expect(b.maxY).toBeCloseTo(-4 + 0.7, 4)
  })

  it('scales with font size', () => {
    const one = bounds(buildSilkscreenGeometry([entry('AB')], ATLAS, 1)!.getAttribute('position').array, 0, 8)
    const two = bounds(buildSilkscreenGeometry([entry('AB')], ATLAS, 2)!.getAttribute('position').array, 0, 8)
    expect(two.maxX - two.minX).toBeCloseTo((one.maxX - one.minX) * 2, 4)
  })

  it('places every vertex at the entry z', () => {
    const geo = buildSilkscreenGeometry([entry('A', { worldZ: -0.02, isBSide: true })], ATLAS)!
    const pos = geo.getAttribute('position')
    for (let i = 0; i < pos.count; i++) expect(pos.getZ(i)).toBeCloseTo(-0.02, 6)
  })

  it('rotates the text about its center', () => {
    const flat = buildSilkscreenGeometry([entry('ABCD')], ATLAS)!
    const turned = buildSilkscreenGeometry([entry('ABCD', { rotRad: Math.PI / 2 })], ATLAS)!
    const f = bounds(flat.getAttribute('position').array, 0, 16)
    const t = bounds(turned.getAttribute('position').array, 0, 16)
    expect(t.maxY - t.minY).toBeCloseTo(f.maxX - f.minX, 4)
    expect(t.maxX - t.minX).toBeCloseTo(f.maxY - f.minY, 4)
  })

  it('mirrors back-side text in x', () => {
    const front = buildSilkscreenGeometry([entry('AB')], ATLAS)!
    const back = buildSilkscreenGeometry([entry('AB', { isBSide: true })], ATLAS)!
    const fp = front.getAttribute('position')
    const bp = back.getAttribute('position')
    for (let i = 0; i < fp.count; i++) {
      expect(bp.getX(i)).toBeCloseTo(-fp.getX(i), 5)
      expect(bp.getY(i)).toBeCloseTo(fp.getY(i), 5)
    }
    // the first glyph of a mirrored string sits on the right
    const f0 = fp.getX(0), b0 = bp.getX(0)
    expect(f0).toBeLessThan(0)
    expect(b0).toBeGreaterThan(0)
  })

  it('uses the glyph uv rectangle for each quad', () => {
    const geo = buildSilkscreenGeometry([entry('A')], ATLAS)!
    const uv = geo.getAttribute('uv')
    const code = 'A'.charCodeAt(0)
    expect([uv.getX(0), uv.getY(0)]).toEqual([Math.fround(code / 1000), Math.fround(0.25)])
    expect([uv.getX(2), uv.getY(2)]).toEqual([Math.fround((code + 1) / 1000), Math.fround(0.5)])
  })
})

describe('buildSilkscreenEntries', () => {
  it('flags back-side layers and drops the text below the board', () => {
    const [front, back] = buildSilkscreenEntries([
      { text: 'F', at: { x: 1, y: 2, rotDeg: 0 }, layer: 'F.SilkS' },
      { text: 'B', at: { x: 1, y: 2, rotDeg: 0 }, layer: 'B.Silkscreen' },
    ], 1.6)
    expect(front.isBSide).toBe(false)
    expect(front.worldZ).toBeCloseTo(1.62)
    expect(back.isBSide).toBe(true)
    expect(back.worldZ).toBeCloseTo(-0.02)
  })
})
