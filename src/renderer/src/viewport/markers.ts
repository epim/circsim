/**
 * viewport/markers.ts
 *
 * Task 20 — Probe markers + op annotation labels with declutter.
 *
 * API:
 *   createMarkerController() → MarkerController
 *
 * MarkerController:
 *   addProbeMarker(opts)               — register a probe flag / instrument badge
 *   removeProbeMarker(id)              — remove by id
 *   clearProbeMarkers()                — remove all probe markers
 *   getProbeMarkers()                  — return all registered probe markers
 *
 *   showOpAnnotations(voltages, netPositions) — create net voltage labels
 *   clearOpAnnotations()               — remove all annotation labels
 *   getAnnotationLabels()              — return all annotation labels (pre-declutter)
 *   getVisibleAnnotations(cam, w, h)   — return labels after declutter (< 24 px removed)
 *
 * Declutter algorithm (spec §10.2):
 *   1. Project each label's worldPos into NDC via camera.
 *   2. Convert NDC to pixel coordinates given canvas width/height.
 *   3. Iterate labels; skip a label if any already-shown label is within 24 px.
 *   4. The first label is always shown.
 *   (Zoom is implicit in the camera's projection matrix — OrthographicCamera.zoom
 *    affects updateProjectionMatrix, so NDC distances shrink at higher zoom, meaning
 *    world positions that were close in px become farther apart in px.)
 *
 * Note: Scene integration (adding/removing THREE.Sprite objects) is done in scene.ts.
 *       This module manages the data layer only — pure math, no DOM, no GL context.
 *
 * Spec §10.2, §11
 */

import * as THREE from 'three'

// ─── types ────────────────────────────────────────────────────────────────────

export interface ProbeMarker {
  /** Unique id assigned by addProbeMarker. */
  id: string
  /** World position to anchor the sprite. */
  worldPos: THREE.Vector3
  /** CSS color string matching the probe's trace color. */
  color: string
  /** Short label text (e.g. net name or instrument label). */
  label: string
  /** Net id this probe is attached to. */
  netId: number
}

export interface ProbeMarkerOpts {
  worldPos: THREE.Vector3
  color: string
  label: string
  netId: number
}

export interface AnnotationLabel {
  /** Net id for this label. */
  netId: number
  /** World position for the label anchor. */
  worldPos: THREE.Vector3
  /** Display text, e.g. "2.50 V". */
  text: string
}

export interface MarkerController {
  // ── probe markers ───────────────────────────────────────────────────────────

  /** Add a probe flag / instrument badge. Returns its id. */
  addProbeMarker(opts: ProbeMarkerOpts): string

  /** Remove a probe marker by id. No-op if unknown. */
  removeProbeMarker(id: string): void

  /** Remove all probe markers. */
  clearProbeMarkers(): void

  /** Return all currently registered probe markers. */
  getProbeMarkers(): ProbeMarker[]

  // ── op annotation labels ────────────────────────────────────────────────────

  /**
   * Replace all op annotation labels with new ones.
   *
   * @param voltages      Map<netId, volts> from op result.
   * @param netPositions  Map<netId, THREE.Vector3> world position for each net label.
   *                      Nets without a position entry are silently skipped.
   */
  showOpAnnotations(
    voltages: Map<number, number>,
    netPositions: Map<number, THREE.Vector3>
  ): void

  /** Remove all annotation labels. */
  clearOpAnnotations(): void

  /** Return all annotation labels (before declutter). */
  getAnnotationLabels(): AnnotationLabel[]

  /**
   * Return the subset of annotation labels that are visible at the current zoom.
   *
   * Declutter: a label is hidden if any earlier (higher-priority) visible label
   * projects to within 24 screen pixels of it.
   *
   * @param camera    Active camera (perspective or ortho); must have a valid
   *                  projection matrix (call camera.updateProjectionMatrix() first).
   * @param canvasW   Canvas pixel width.
   * @param canvasH   Canvas pixel height.
   */
  getVisibleAnnotations(
    camera: THREE.Camera,
    canvasW: number,
    canvasH: number
  ): AnnotationLabel[]
}

// ─── helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0
function nextId(): string {
  return `marker_${++_idCounter}`
}

/**
 * Format a voltage for op annotations: "V" suffix, 3 decimals for readable
 * magnitudes, e-notation for small-but-representable readings.
 * Examples: 5 → "5.000 V", 2.5 → "2.500 V", 6e-4 → "6.000e-4 V".
 *
 * Anything that ROUNDS to zero at the displayed precision — including negative
 * zero and sub-noise values like -1e-7 — is normalized to exactly "0.000 V";
 * "-0.000 V" must never appear on the board (F5).
 *
 * Exported: shared by the 3D annotation labels and the Viewport's DOM mirror,
 * and unit-tested directly.
 */
export function formatVolts(v: number): string {
  // Noise floor: |v| < 0.5 mV rounds to "0.000" at 3 decimals (covers ±0 too).
  if (Math.abs(v) < 0.0005) {
    return '0.000 V'
  }
  if (Math.abs(v) < 0.001) {
    return `${v.toExponential(3)} V`
  }
  return `${v.toFixed(3)} V`
}

/**
 * Project a world-space Vector3 into screen pixel coordinates.
 *
 * @returns { px, py } in pixel space (top-left origin, as CSS pixels).
 */
function projectToScreen(
  worldPos: THREE.Vector3,
  camera: THREE.Camera,
  canvasW: number,
  canvasH: number
): { px: number; py: number } {
  // Clone to avoid mutating the input
  const ndc = worldPos.clone().project(camera)
  // NDC: x,y in [-1, +1] where (+1,+1) = top-right
  // Screen: (0,0) = top-left
  const px = (ndc.x + 1) * 0.5 * canvasW
  const py = (1 - (ndc.y + 1) * 0.5) * canvasH
  return { px, py }
}

// ─── factory ──────────────────────────────────────────────────────────────────

export function createMarkerController(): MarkerController {
  const probeMarkers = new Map<string, ProbeMarker>()
  let annotationLabels: AnnotationLabel[] = []

  return {
    // ── probe markers ─────────────────────────────────────────────────────────

    addProbeMarker(opts: ProbeMarkerOpts): string {
      const id = nextId()
      probeMarkers.set(id, { id, ...opts })
      return id
    },

    removeProbeMarker(id: string): void {
      probeMarkers.delete(id)
    },

    clearProbeMarkers(): void {
      probeMarkers.clear()
    },

    getProbeMarkers(): ProbeMarker[] {
      return Array.from(probeMarkers.values())
    },

    // ── op annotation labels ──────────────────────────────────────────────────

    showOpAnnotations(
      voltages: Map<number, number>,
      netPositions: Map<number, THREE.Vector3>
    ): void {
      annotationLabels = []
      for (const [netId, volts] of voltages) {
        const worldPos = netPositions.get(netId)
        if (!worldPos) continue   // no position → skip silently
        const text = formatVolts(volts)
        annotationLabels.push({ netId, worldPos, text })
      }
    },

    clearOpAnnotations(): void {
      annotationLabels = []
    },

    getAnnotationLabels(): AnnotationLabel[] {
      return annotationLabels
    },

    getVisibleAnnotations(
      camera: THREE.Camera,
      canvasW: number,
      canvasH: number
    ): AnnotationLabel[] {
      const DECLUTTER_PX = 24

      const visible: AnnotationLabel[] = []
      // Screen positions of already-visible labels
      const shownScreenPositions: { px: number; py: number }[] = []

      for (const label of annotationLabels) {
        const screenPos = projectToScreen(label.worldPos, camera, canvasW, canvasH)

        // Check distance to all already-shown labels
        let tooClose = false
        for (const shown of shownScreenPositions) {
          const dx = screenPos.px - shown.px
          const dy = screenPos.py - shown.py
          const distPx = Math.sqrt(dx * dx + dy * dy)
          if (distPx < DECLUTTER_PX) {
            tooClose = true
            break
          }
        }

        if (!tooClose) {
          visible.push(label)
          shownScreenPositions.push(screenPos)
        }
      }

      return visible
    },
  }
}
