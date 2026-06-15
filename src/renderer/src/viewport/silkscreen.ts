/**
 * viewport/silkscreen.ts
 *
 * Task 18 — Silkscreen text placement.
 *
 * Exports:
 *   SilkscreenEntry            — placement info for one text item
 *   buildSilkscreenEntries()   — pure math: computes SilkscreenEntry[] from board silkscreen
 *   createSilkscreenTexts()    — creates troika Text objects (scene.ts calls this; NOT imported
 *                                in tests to avoid worker dependency)
 *
 * Design:
 *   - `buildSilkscreenEntries` is pure — no THREE or troika imports; safe in headless tests.
 *   - `createSilkscreenTexts` wraps troika Text construction behind a dynamic import guard
 *     so it only runs in a browser/Electron context that has a worker.
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
 * This is pure math — no THREE or troika objects created here.
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

// ─── troika Text factory (scene use only — not imported in tests) ──────────────

/**
 * Create troika Text objects for silkscreen entries.
 *
 * Called only from scene.ts (which runs in an Electron renderer context with
 * a DOM+worker available). Tests should call buildSilkscreenEntries() directly.
 *
 * @param entries   SilkscreenEntry[] from buildSilkscreenEntries().
 * @param fontSize  Text size in mm (default 1.0).
 * @returns Array of THREE.Object3D (troika Text instances).
 */
export async function createSilkscreenTexts(
  entries: SilkscreenEntry[],
  fontSize = 1.0
): Promise<THREE.Object3D[]> {
  // Dynamic import so that this module is safe to require in headless Node tests
  // (troika attempts to spawn a worker which fails in Node).
  const { Text } = await import('troika-three-text')

  return entries.map(entry => {
    const textObj = new Text()
    textObj.text = entry.text
    textObj.fontSize = fontSize
    textObj.color = 0xffffff   // white silkscreen
    textObj.anchorX = 'center'
    textObj.anchorY = 'middle'

    textObj.position.set(entry.worldX, entry.worldY, entry.worldZ)
    textObj.rotation.set(0, 0, entry.rotRad)

    // B-side: mirror the text by flipping X scale so it reads correctly
    // from the component side when the board is flipped.
    if (entry.isBSide) {
      textObj.scale.x = -1
    }

    // Sync the text geometry
    textObj.sync()

    return textObj as unknown as THREE.Object3D
  })
}
