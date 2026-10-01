/**
 * viewport/silkscreen.ts
 *
 * Task 18 — Silkscreen text placement.
 *
 * Exports:
 *   SilkscreenEntry            — placement info for one text item
 *   buildSilkscreenEntries()   — pure math: computes SilkscreenEntry[] from board silkscreen
 *   buildSilkscreenGeometry()  - ONE merged glyph-quad geometry for every entry (#57)
 *   createGlyphAtlas()         - canvas glyph atlas (browser only)
 *   createSilkscreenMesh()     - atlas + geometry + material as a single Mesh
 *
 * Design:
 *   - `buildSilkscreenEntries` and `buildSilkscreenGeometry` are pure THREE math
 *     with no canvas, DOM or worker; safe in headless tests (the geometry builder
 *     takes the atlas layout as a parameter, so a test can pass a fake one).
 *   - All silkscreen text, front and back, is one mesh and one draw call. It
 *     used to be one troika Text object per string (1501 draw calls on a
 *     1500-part board). The glyphs come from a single canvas atlas of the
 *     characters the board actually uses.
 *   - Silkscreen items sit +0.02 mm above the solder-mask surface.
 *   - B-side silkscreen is mirrored (X flipped) and placed below the board.
 *
 * Spec §10.1 (silkscreen row).
 */

import * as THREE from 'three'
import type { BoardText } from '../../../core/kicad/types'
import { kicadToWorld } from './boardGeometry'

// ─── z offsets ────────────────────────────────────────────────────────────────

/**
 * Height of silkscreen above the top solder-mask surface.
 * +0.02 mm above the mask layer (which is roughly at the board surface).
 */
const SILK_ABOVE_MASK_MM = 0.02

// ─── SilkscreenEntry ──────────────────────────────────────────────────────────

export interface SilkscreenEntry {
  /** The silkscreen text string. */
  text: string
  /** World-space X position (center). */
  worldX: number
  /** World-space Y position (center). */
  worldY: number
  /** World-space Z position (+0.02 above top mask or below bottom). */
  worldZ: number
  /** Rotation in radians around Z axis (for F-side) or adjusted for B-side. */
  rotRad: number
  /** Whether this item is on the B (back) side. */
  isBSide: boolean
  /** Layer string from the board file. */
  layer: string
}

/** Check if a layer is on the B (back) side. */
function isBSideLayer(layer: string): boolean {
  return (
    layer === 'B.SilkS' ||
    layer === 'B.Silkscreen' ||
    layer === 'B.Cu'   // should not appear in silkscreen but be safe
  )
}

/**
 * Build the list of silkscreen text placement entries from board.silkscreen.
 *
 * This is pure math: no THREE objects created here.
 *
 * @param silkscreen      Board text items (from BoardModel.silkscreen).
 * @param boardThicknessMm Board thickness for Z placement.
 * @returns Array of SilkscreenEntry, one per text item.
 */
export function buildSilkscreenEntries(
  silkscreen: BoardText[],
  boardThicknessMm: number
): SilkscreenEntry[] {
  return silkscreen.map(item => {
    const bSide = isBSideLayer(item.layer)

    // Convert KiCad coords to world
    const world = kicadToWorld(item.at.x, item.at.y)

    // Z placement:
    //   F-side: top surface = boardThicknessMm, plus SILK_ABOVE_MASK_MM
    //   B-side: bottom surface = 0, minus SILK_ABOVE_MASK_MM (below the board)
    const worldZ = bSide
      ? -SILK_ABOVE_MASK_MM
      : boardThicknessMm + SILK_ABOVE_MASK_MM

    // Rotation:
    // KiCad rotDeg is clockwise (positive = clockwise in KiCad screen space).
    // In world Z-up right-handed, CCW is positive.
    // kicadToWorld flips Y, so we negate the rotation.
    // For B-side we additionally need to account for the board flip.
    const rotRad = -(item.at.rotDeg * Math.PI) / 180

    return {
      text: item.text,
      worldX: world.x,
      worldY: world.y,
      worldZ,
      rotRad,
      isBSide: bSide,
      layer: item.layer,
    }
  })
}

// ─── glyph layout (pure) ──────────────────────────────────────────────────────

/** One glyph's place in the atlas and its horizontal advance. */
export interface GlyphInfo {
  /** Atlas UV rectangle of the glyph cell. */
  u0: number
  v0: number
  u1: number
  v1: number
  /** Horizontal advance in em (1 em = the text's font size). */
  advance: number
}

/**
 * How glyph cells map to quads. Sizes are in em, so a quad for font size F mm is
 * F times these.
 */
export interface GlyphAtlasLayout {
  /** Quad width and height in em (the whole atlas cell). */
  quadW: number
  quadH: number
  /** Quad bottom edge relative to the text's vertical center, in em (negative). */
  quadBottom: number
  /** Glyph for a character, or undefined when the atlas lacks it. */
  glyph(ch: string): GlyphInfo | undefined
}

/** Default text size in mm, matching the previous troika text. */
export const SILK_FONT_SIZE_MM = 1.0

/**
 * Build one geometry holding a quad per glyph of every entry, text centered on
 * the entry position, rotated by rotRad, mirrored for B-side. Characters the
 * atlas lacks are skipped (their advance still counts as one half em).
 *
 * Returns null when there is nothing to draw. The geometry has `position` and
 * `uv` attributes and a 32-bit index; render it double sided because mirroring
 * flips the winding.
 */
export function buildSilkscreenGeometry(
  entries: SilkscreenEntry[],
  atlas: GlyphAtlasLayout,
  fontSize = SILK_FONT_SIZE_MM,
): THREE.BufferGeometry | null {
  // Count glyphs first so the typed arrays are sized exactly.
  let glyphCount = 0
  for (const entry of entries) {
    for (const ch of entry.text) if (atlas.glyph(ch) && ch.trim() !== '') glyphCount++
  }
  if (glyphCount === 0) return null

  const positions = new Float32Array(glyphCount * 4 * 3)
  const uvs = new Float32Array(glyphCount * 4 * 2)
  const indices = new Uint32Array(glyphCount * 6)

  let g = 0
  for (const entry of entries) {
    const chars = [...entry.text]
    let total = 0
    for (const ch of chars) total += atlas.glyph(ch)?.advance ?? 0.5

    const cos = Math.cos(entry.rotRad)
    const sin = Math.sin(entry.rotRad)
    const mirror = entry.isBSide ? -1 : 1

    let pen = -total / 2
    for (const ch of chars) {
      const info = atlas.glyph(ch)
      if (!info) {
        pen += 0.5
        continue
      }
      const center = pen + info.advance / 2
      pen += info.advance
      if (ch.trim() === '') continue

      const x0 = (center - atlas.quadW / 2) * fontSize
      const x1 = (center + atlas.quadW / 2) * fontSize
      const y0 = atlas.quadBottom * fontSize
      const y1 = (atlas.quadBottom + atlas.quadH) * fontSize

      // Corner order: bottom-left, bottom-right, top-right, top-left.
      const corners: [number, number, number, number][] = [
        [x0, y0, info.u0, info.v0],
        [x1, y0, info.u1, info.v0],
        [x1, y1, info.u1, info.v1],
        [x0, y1, info.u0, info.v1],
      ]
      for (let k = 0; k < 4; k++) {
        const lx = corners[k][0] * mirror
        const ly = corners[k][1]
        const o = (g * 4 + k) * 3
        positions[o] = entry.worldX + lx * cos - ly * sin
        positions[o + 1] = entry.worldY + lx * sin + ly * cos
        positions[o + 2] = entry.worldZ
        const u = (g * 4 + k) * 2
        uvs[u] = corners[k][2]
        uvs[u + 1] = corners[k][3]
      }
      const base = g * 4
      const i = g * 6
      indices[i] = base
      indices[i + 1] = base + 1
      indices[i + 2] = base + 2
      indices[i + 3] = base
      indices[i + 4] = base + 2
      indices[i + 5] = base + 3
      g++
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(indices, 1))
  return geo
}

// ─── canvas glyph atlas (browser only) ────────────────────────────────────────

export interface GlyphAtlas {
  layout: GlyphAtlasLayout
  texture: THREE.Texture
}

/** Atlas cell size in px for small and large character sets. */
const CELL_PX_LARGE = 128
const CELL_PX_SMALL = 64
/** Font size drawn into a cell, as a fraction of the cell. */
const FONT_FRACTION = 0.7
/** Baseline position within a cell, as a fraction of the cell height from the top. */
const BASELINE_FRACTION = 0.72
/** Cap height as a fraction of the font size; used to center text vertically. */
const CAP_HEIGHT_EM = 0.7
/** Characters the atlas can hold at the smaller cell size within a 2048 px canvas. */
const MAX_GLYPHS = 1024

/**
 * Draw the given characters into a canvas atlas and describe how to lay them
 * out. Requires a DOM (`document.createElement('canvas')`); call it from the
 * renderer, not from headless tests.
 */
export function createGlyphAtlas(chars: Iterable<string>): GlyphAtlas {
  const set = new Set<string>(['?'])
  for (const ch of chars) {
    if (ch.trim() !== '') set.add(ch)
    if (set.size >= MAX_GLYPHS) break
  }
  const list = [...set]

  const cell = list.length <= 100 ? CELL_PX_LARGE : CELL_PX_SMALL
  const cols = Math.ceil(Math.sqrt(list.length))
  const rows = Math.ceil(list.length / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * cell
  canvas.height = rows * cell
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('silkscreen: 2D canvas context unavailable')

  const fontPx = cell * FONT_FRACTION
  ctx.font = `bold ${fontPx}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffffff'

  const info = new Map<string, GlyphInfo>()
  list.forEach((ch, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    ctx.fillText(ch, col * cell + cell / 2, row * cell + cell * BASELINE_FRACTION)
    info.set(ch, {
      u0: (col * cell) / canvas.width,
      u1: ((col + 1) * cell) / canvas.width,
      v0: 1 - ((row + 1) * cell) / canvas.height,
      v1: 1 - (row * cell) / canvas.height,
      advance: ctx.measureText(ch).width / fontPx,
    })
  })

  const quadEm = cell / fontPx
  // Baseline sits at BASELINE_FRACTION of the cell from the top; put the middle
  // of a capital letter on the text's vertical center.
  const baselineAboveBottomEm = ((1 - BASELINE_FRACTION) * cell) / fontPx
  const layout: GlyphAtlasLayout = {
    quadW: quadEm,
    quadH: quadEm,
    quadBottom: -CAP_HEIGHT_EM / 2 - baselineAboveBottomEm,
    glyph(ch: string): GlyphInfo | undefined {
      if (ch.trim() === '') return { u0: 0, u1: 0, v0: 0, v1: 0, advance: 0.35 }
      return info.get(ch) ?? info.get('?')
    },
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return { layout, texture }
}

/**
 * All silkscreen text as one Mesh (one draw call): a canvas atlas of the
 * characters used, one merged quad geometry, one basic white material.
 * Returns null when there is no text. Browser only (see createGlyphAtlas).
 */
export function createSilkscreenMesh(
  entries: SilkscreenEntry[],
  fontSize = SILK_FONT_SIZE_MM,
): THREE.Mesh | null {
  const chars = new Set<string>()
  for (const entry of entries) for (const ch of entry.text) chars.add(ch)
  if (chars.size === 0) return null

  const atlas = createGlyphAtlas(chars)
  const geo = buildSilkscreenGeometry(entries, atlas.layout, fontSize)
  if (!geo) {
    atlas.texture.dispose()
    return null
  }
  const material = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.name = 'silkscreen'
  return mesh
}
