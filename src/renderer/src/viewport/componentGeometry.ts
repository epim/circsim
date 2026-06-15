/**
 * viewport/componentGeometry.ts
 *
 * Task 18 — Component placeholder geometry builder.
 *
 * Exports:
 *   COMPONENT_CLASSES          — class name → { heightMm, color }
 *   classifyFootprint(libId)   → { className, heightMm, color }
 *   computePlaceholderBox(fp, boardThicknessMm) → PlaceholderBoxInfo
 *   buildComponentBoxes(fps, boardThicknessMm)  → ComponentBoxEntry[]
 *
 * VRML loading is deferred to post-v1 polish (spec §10.1). Placeholders only.
 *
 * Design principles (spec §10.1):
 *   - Classify footprint by libId regex table (passives/SOT/SOIC+DIP/TO-220).
 *   - Box dimensions from courtyardBounds when available; fallback = pad bbox + 0.4 mm margin.
 *   - F-side: box sits on top of board (Z = boardThickness + heightMm/2).
 *   - B-side: box hangs below board (Z = -(heightMm/2)), mirrored under board.
 *   - Troika Text is NOT instantiated here — that's done in scene.ts to avoid
 *     worker dependency in headless tests.
 *
 * All KiCad coords converted via kicadToWorld (from boardGeometry.ts).
 *
 * No WebGL context required — THREE core geometry runs headless in Node.
 *
 * Spec §10.1
 */

import * as THREE from 'three'
import type { Footprint } from '../../../core/kicad/types'
import { kicadToWorld } from './boardGeometry'

// ─── classification table ──────────────────────────────────────────────────────

export interface ComponentClass {
  /** Height of the component body above the PCB surface in mm. */
  heightMm: number
  /** THREE.js color hex for the placeholder box. */
  color: number
}

/**
 * Class name → { heightMm, color }.
 *
 * Heights per spec §10.1:
 *   passives  0.6 mm
 *   sot       1.1 mm
 *   soic/dip  2.5 mm
 *   to220     4.0 mm
 */
export const COMPONENT_CLASSES: Record<string, ComponentClass> = {
  passive: { heightMm: 0.6,  color: 0x888888 },  // grey for passives
  sot:     { heightMm: 1.1,  color: 0x4444aa },  // blue for small transistors
  soic:    { heightMm: 2.5,  color: 0x336633 },  // dark green for ICs
  to220:   { heightMm: 4.0,  color: 0x774433 },  // brown for power devices
}

export interface ClassifyResult {
  className: string
  heightMm: number
  color: number
}

/**
 * Classify a footprint by its libId using a regex table.
 *
 * Matching is case-insensitive against the full libId string.
 * First match wins; falls back to 'passive' for unknown footprints.
 */
export function classifyFootprint(libId: string): ClassifyResult {
  const lower = libId.toLowerCase()

  // TO-220 / TO-247 / TO-263 power packages — check before generic SOT
  if (/\bto[-_]?22[0-9]\b|\bto[-_]?247\b|\bto[-_]?263\b/.test(lower)) {
    return { className: 'to220', ...COMPONENT_CLASSES.to220 }
  }

  // SOT packages (SOT-23, SOT-223, SOT-89, SOT-363, SOT-353, etc.)
  if (/\bsot[-_]?[0-9]/.test(lower)) {
    return { className: 'sot', ...COMPONENT_CLASSES.sot }
  }

  // SOIC, SOP, SSOP, TSSOP, MSOP, QFP, QFN, DIP packages → soic height
  if (/\bsoic\b|\bssop\b|\bsop[-_]|\bmsop\b|\btssop\b|\bqfp\b|\bqfn\b|\bsmd_soic\b/.test(lower)) {
    return { className: 'soic', ...COMPONENT_CLASSES.soic }
  }
  if (/\bdip[-_]?\d/.test(lower)) {
    return { className: 'soic', ...COMPONENT_CLASSES.soic }
  }

  // Passives: R, C, L, D, LED (SMD packages) — also default fallback
  // These typically match Resistor_SMD, Capacitor_SMD, Inductor_SMD, Diode_SMD, LED_SMD, etc.
  // If nothing more specific matched, default to passive.
  return { className: 'passive', ...COMPONENT_CLASSES.passive }
}

// ─── placeholder box info ──────────────────────────────────────────────────────

export interface PlaceholderBoxInfo {
  /** Board-plane width in mm (X-extent of the box). */
  w: number
  /** Board-plane height in mm (Y-extent of the box). */
  h: number
  /** Height above/below board surface in mm (Z-extent of the box). */
  heightMm: number
  /** World-space X center. */
  worldX: number
  /** World-space Y center. */
  worldY: number
  /** World-space Z center (positive = above board, negative = below board). */
  worldZ: number
  /** Part class name. */
  className: string
  /** Box color hex. */
  color: number
}

/** Margin (mm) added to pad bounding box when no courtyardBounds is present. */
const PAD_BBOX_MARGIN = 0.4

/**
 * Compute the bounding box and world position of a component placeholder box.
 *
 * Dimensions:
 *   If fp.courtyardBounds is present → use its w×h.
 *   Otherwise → compute pad bounding box in footprint-local coords, add
 *   PAD_BBOX_MARGIN on each side.
 *
 * World position:
 *   Center of the box = kicadToWorld(fp.at.x, fp.at.y).
 *   Z:
 *     F-side → boardThicknessMm + heightMm / 2
 *     B-side → -(heightMm / 2)
 */
export function computePlaceholderBox(
  fp: Footprint,
  boardThicknessMm: number
): PlaceholderBoxInfo {
  const cls = classifyFootprint(fp.libId)

  // Footprint origin in world coords
  const worldOrigin = kicadToWorld(fp.at.x, fp.at.y)

  // Determine w × h
  let w: number
  let h: number

  if (fp.courtyardBounds) {
    w = fp.courtyardBounds.w
    h = fp.courtyardBounds.h
  } else if (fp.pads.length > 0) {
    // Compute pad bounding box in footprint-local coords (before fp rotation).
    // Each pad is at fp.pads[i].at.{x,y} relative to footprint origin.
    // Include pad half-size in each direction.
    const fpRad = (fp.at.rotDeg * Math.PI) / 180
    const cosA = Math.cos(fpRad)
    const sinA = Math.sin(fpRad)

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity

    for (const pad of fp.pads) {
      // Rotate pad position by footprint rotation
      const pxLocal = pad.at.x
      const pyLocal = pad.at.y
      const pxFp = cosA * pxLocal - sinA * pyLocal
      const pyFp = sinA * pxLocal + cosA * pyLocal

      const hw = pad.size.w / 2
      const hh = pad.size.h / 2

      minX = Math.min(minX, pxFp - hw)
      maxX = Math.max(maxX, pxFp + hw)
      minY = Math.min(minY, pyFp - hh)
      maxY = Math.max(maxY, pyFp + hh)
    }

    w = Math.max(maxX - minX, 0.5) + PAD_BBOX_MARGIN * 2
    h = Math.max(maxY - minY, 0.5) + PAD_BBOX_MARGIN * 2
  } else {
    // No pads and no courtyard: use a minimal default 1×1 mm box
    w = 1.0 + PAD_BBOX_MARGIN * 2
    h = 1.0 + PAD_BBOX_MARGIN * 2
  }

  // Z placement (Z-up right-handed, board bottom face at Z=0)
  const worldZ = fp.layer === 'B'
    ? -(cls.heightMm / 2)
    : boardThicknessMm + cls.heightMm / 2

  return {
    w,
    h,
    heightMm: cls.heightMm,
    worldX: worldOrigin.x,
    worldY: worldOrigin.y,
    worldZ,
    className: cls.className,
    color: cls.color,
  }
}

// ─── ComponentBoxEntry ─────────────────────────────────────────────────────────

export interface ComponentBoxEntry {
  /** Reference designator (e.g. "R1"). */
  ref: string
  /** THREE.BufferGeometry for the box (BoxGeometry). */
  geo: THREE.BufferGeometry
  /** World-space X center. */
  worldX: number
  /** World-space Y center. */
  worldY: number
  /** World-space Z center. */
  worldZ: number
  /** Part class name (for color lookup in scene). */
  className: string
  /** Box color hex. */
  color: number
  /** Component layer side. */
  layer: 'F' | 'B'
}

/**
 * Build placeholder box entries for all footprints on a board.
 *
 * Returns one ComponentBoxEntry per footprint.
 * The geometry is a THREE.BoxGeometry centered at the origin (translation
 * is tracked separately in worldX/Y/Z so the scene can position a Mesh).
 *
 * Troika Text labels are NOT created here — scene.ts adds them when mounting,
 * to avoid worker dependency in headless tests.
 */
export function buildComponentBoxes(
  footprints: Footprint[],
  boardThicknessMm: number
): ComponentBoxEntry[] {
  return footprints.map(fp => {
    const info = computePlaceholderBox(fp, boardThicknessMm)

    // BoxGeometry centered at origin; scene.ts positions via mesh.position
    const geo = new THREE.BoxGeometry(info.w, info.h, info.heightMm)

    return {
      ref: fp.ref,
      geo,
      worldX: info.worldX,
      worldY: info.worldY,
      worldZ: info.worldZ,
      className: info.className,
      color: info.color,
      layer: fp.layer,
    }
  })
}
