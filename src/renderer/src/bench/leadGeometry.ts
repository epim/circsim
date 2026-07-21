/**
 * bench/leadGeometry.ts — pure projection + lead-path math.
 *
 * Spec §3: sag = clamp(0.15 · chordLen, 12, 80) px, cubic bézier control
 * points at 25% / 75% of the chord, each dropped `sag` px in +y (screen down).
 * Same world→screen projection as the annotation declutter (markers.ts).
 */

import * as THREE from 'three'

export interface Pt {
  px: number
  py: number
}

export function projectAnchor(
  worldPos: THREE.Vector3, camera: THREE.Camera, w: number, h: number,
): Pt {
  const ndc = worldPos.clone().project(camera)
  return {
    px: (ndc.x + 1) * 0.5 * w,
    py: (1 - (ndc.y + 1) * 0.5) * h,
  }
}

export function projectAnchorSet(
  nets: Map<number, THREE.Vector3>,
  refs: Map<string, THREE.Vector3>,
  camera: THREE.Camera, w: number, h: number,
): { nets: Map<number, Pt>; refs: Map<string, Pt> } {
  const outNets = new Map<number, Pt>()
  for (const [netId, pos] of nets) outNets.set(netId, projectAnchor(pos, camera, w, h))
  const outRefs = new Map<string, Pt>()
  for (const [ref, pos] of refs) outRefs.set(ref, projectAnchor(pos, camera, w, h))
  return { nets: outNets, refs: outRefs }
}

/** Round to 0.1 px so path strings are stable for tests and cheap to diff. */
function r1(v: number): number {
  return Math.round(v * 10) / 10
}

export function leadPath(jack: Pt, clip: Pt): string {
  const dx = clip.px - jack.px
  const dy = clip.py - jack.py
  const chord = Math.hypot(dx, dy)
  const sag = Math.min(80, Math.max(12, 0.15 * chord))
  const c1x = jack.px + 0.25 * dx
  const c1y = jack.py + 0.25 * dy + sag
  const c2x = jack.px + 0.75 * dx
  const c2y = jack.py + 0.75 * dy + sag
  return `M ${r1(jack.px)} ${r1(jack.py)} C ${r1(c1x)} ${r1(c1y)}, ${r1(c2x)} ${r1(c2y)}, ${r1(clip.px)} ${r1(clip.py)}`
}
