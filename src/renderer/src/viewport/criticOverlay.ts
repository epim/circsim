/**
 * viewport/criticOverlay.ts
 *
 * Board Critic — READ-ONLY 3D overlay (Spec §7).
 *
 * Two layers:
 *   1. A PURE marker-placement helper (`criticMarkerPlacements`) that maps each
 *      located finding's BOARD-mm `location` to a world position via the shared
 *      `kicadToWorld` transform (the SAME conversion every geometry builder uses)
 *      and assigns a severity color (red / amber / grey). This is headless +
 *      unit-tested: no THREE objects, no GL context.
 *   2. A thin imperative `CriticOverlayController` that materialises those
 *      placements as small marker meshes on a DEDICATED overlay group (so the
 *      critic never touches copper/component geometry) and is rebuilt whenever the
 *      report changes / cleared when the board closes.
 *
 * The critic is strictly read-only: this module only ADDS markers + reads the
 * finding's location. Camera fly-to + net/part highlight are handled in scene.ts
 * by reusing the existing OrbitControls + picking emissive-highlight paths.
 *
 * Spec: docs/superpowers/specs/2026-06-19-circsim-board-critic-design.md §7
 */

import * as THREE from 'three'
import type { Finding, Severity } from '../../../core/critic/types'
import { kicadToWorld } from './boardGeometry'

// ─── severity → color ────────────────────────────────────────────────────────

/** Marker color by severity: error → red, warn → amber, info → grey. */
export const SEVERITY_COLOR: Record<Severity, number> = {
  error: 0xff4444,
  warn: 0xffaa22,
  info: 0x9aa0aa,
}

/** Severity color for a finding (CSS hex string — handy for the panel too). */
export function severityCssColor(severity: Severity): string {
  return '#' + SEVERITY_COLOR[severity].toString(16).padStart(6, '0')
}

// ─── pure marker-placement helper ──────────────────────────────────────────────

export interface CriticMarkerPlacement {
  /** The finding this marker stands for. */
  id: string
  severity: Severity
  /** Marker color (THREE hex) by severity. */
  color: number
  /**
   * World position from kicadToWorld(location). The Z is left at 0 here; the
   * controller raises it to sit above the board (mirrors how scene.ts offsets the
   * copper/component groups). The CENTERING offset the scene applies to every
   * group (−cx,−cy) is applied by the controller, not here, so this stays pure.
   */
  world: { x: number; y: number }
}

/**
 * Map located findings → marker placements (BOARD-mm → world via kicadToWorld).
 *
 * One marker per finding that carries a `location`; findings without a location
 * (e.g. a whole-net IR-drop with no single point) are skipped. Deterministic:
 * placements are returned in findings order. Pure — no THREE, no GL.
 */
export function criticMarkerPlacements(findings: Finding[]): CriticMarkerPlacement[] {
  const out: CriticMarkerPlacement[] = []
  for (const f of findings) {
    if (!f.location) continue
    const world = kicadToWorld(f.location.x, f.location.y)
    out.push({ id: f.id, severity: f.severity, color: SEVERITY_COLOR[f.severity], world })
  }
  return out
}

// ─── imperative overlay controller (THREE) ──────────────────────────────────────

/**
 * Height (mm) the markers float above the board's top copper plane. Exported so
 * the camera fly-to (scene.ts focusFinding) can target the SAME marker plane
 * (boardThicknessMm + MARKER_Z_LIFT) the markers sit on.
 */
export const MARKER_Z_LIFT = 1.5
/** Marker radius (mm). */
const MARKER_RADIUS = 0.9

export interface CriticOverlayController {
  /** The group to add to the scene (positioned by the caller, like other groups). */
  readonly group: THREE.Group
  /**
   * Rebuild the markers from the current findings. Replaces any existing markers.
   * @param boardThicknessMm  top copper Z, so markers float just above it.
   */
  setFindings(findings: Finding[], boardThicknessMm: number): void
  /**
   * Re-apply the LAST findings pushed via setFindings. Called at the END of a
   * board (re)load: loadBoard() clears the overlay while rebuilding geometry, so
   * the current report's markers would otherwise vanish. This rebuilds them from
   * the remembered findings so they survive the reload. No-op if none remembered.
   */
  reapplyLast(boardThicknessMm: number): void
  /** Remove all markers (report changed to empty / board closed). */
  clear(): void
  /** Dispose all GPU resources. */
  dispose(): void
}

/**
 * Create a critic overlay controller. The returned `group` should be added to the
 * scene by the caller and given the same board-centering offset (−cx,−cy) the
 * copper/component groups use, so marker world positions line up with the board.
 */
export function createCriticOverlayController(): CriticOverlayController {
  const group = new THREE.Group()
  // Shared sphere geometry; per-marker materials (colored by severity).
  const geo = new THREE.SphereGeometry(MARKER_RADIUS, 12, 8)
  const materials: THREE.Material[] = []
  // Remember the last findings pushed so they can be re-applied after a board
  // (re)load wipes the overlay (loadBoard clears geometry groups). Cleared only
  // by an explicit empty setFindings([]) (i.e. the report really went away).
  let lastFindings: Finding[] = []

  function clearMeshes(): void {
    for (let i = group.children.length - 1; i >= 0; i--) {
      group.remove(group.children[i])
    }
    for (const m of materials) m.dispose()
    materials.length = 0
  }

  function build(findings: Finding[], boardThicknessMm: number): void {
    clearMeshes()
    const placements = criticMarkerPlacements(findings)
    const z = boardThicknessMm + MARKER_Z_LIFT
    for (const p of placements) {
      const mat = new THREE.MeshBasicMaterial({ color: p.color })
      materials.push(mat)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(p.world.x, p.world.y, z)
      mesh.userData = { criticFindingId: p.id }
      group.add(mesh)
    }
  }

  return {
    group,

    setFindings(findings, boardThicknessMm): void {
      lastFindings = findings
      build(findings, boardThicknessMm)
    },

    reapplyLast(boardThicknessMm): void {
      build(lastFindings, boardThicknessMm)
    },

    clear(): void {
      clearMeshes()
    },

    dispose(): void {
      clearMeshes()
      lastFindings = []
      geo.dispose()
    },
  }
}
