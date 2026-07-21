/**
 * viewport/picking.ts
 *
 * Task 19 — Picking + hover/selection.
 *
 * Design (spec §10.2):
 *   - Raycaster tests copper meshes (mesh→netId map), via InstancedMesh
 *     (instanceId→netId), and component boxes (→ref).
 *   - Emits typed pick events via a callback so scene.ts stays React-free.
 *   - Hover: emissive boost on ALL meshes that share a netId (both layers + vias).
 *
 * Pick event union:
 *   { type:'hoverNet',     netId: number }
 *   { type:'clickNet',     netId: number; worldPos: THREE.Vector3 }
 *   { type:'clickComponent', ref: string }
 *   { type:'clearHover' }
 *
 * Usage (scene.ts wires this up):
 *   const picker = createPicker(callback)
 *   picker.registerCopperMesh(mesh, netId)
 *   picker.registerViaInstance(instancedMesh, netIds)   // netIds[i] → netId for instance i
 *   picker.registerComponentBox(mesh, ref)
 *   canvas.addEventListener('pointermove', e => picker.onPointerMove(e, camera))
 *   canvas.addEventListener('click',       e => picker.onClick(e, camera))
 *   picker.setHoveredNet(null)  // called from scene on board reload
 *
 * No WebGL context required in tests — THREE.Raycaster and BufferGeometry
 * work headlessly in Node under Vitest.
 *
 * Spec §10.2
 */

import * as THREE from 'three'

// ─── pick event types ─────────────────────────────────────────────────────────

export type PickEvent =
  | { type: 'hoverNet';       netId: number }
  | { type: 'clickNet';       netId: number; worldPos: THREE.Vector3 }
  | { type: 'clickComponent'; ref: string }
  | { type: 'clearHover' }

export type PickCallback = (event: PickEvent) => void

// ─── internal registration records ───────────────────────────────────────────

interface CopperRecord {
  mesh: THREE.Mesh
  netId: number
}

interface ViaRecord {
  mesh: THREE.InstancedMesh
  netIds: number[]   // netIds[instanceId] → netId
}

interface ComponentRecord {
  mesh: THREE.Mesh
  ref: string
}

// ─── emissive hover helpers ───────────────────────────────────────────────────

const EMISSIVE_BOOST = new THREE.Color(0x885500)
const EMISSIVE_OFF   = new THREE.Color(0x000000)

function setMeshEmissive(mesh: THREE.Mesh | THREE.InstancedMesh, color: THREE.Color): void {
  const mat = mesh.material
  if (mat instanceof THREE.MeshStandardMaterial) {
    mat.emissive.copy(color)
    mat.needsUpdate = true
  }
}

// ─── PickingController interface ──────────────────────────────────────────────

export interface PickingController {
  /**
   * Register a copper mesh (flat segment / pad / zone).
   * The mesh must already be added to the scene before events are tested.
   */
  registerCopperMesh(mesh: THREE.Mesh, netId: number): void

  /**
   * Register the via InstancedMesh.
   * netIds[i] is the netId for instance i.
   */
  registerViaInstance(mesh: THREE.InstancedMesh, netIds: number[]): void

  /**
   * Register a component placeholder box mesh.
   */
  registerComponentBox(mesh: THREE.Mesh, ref: string): void

  /** Remove all registered objects (call before board reload). */
  clear(): void

  /**
   * Handle pointer-move: raycast → hover highlight + hoverNet event.
   * @param ndc  Normalised device coordinates {x,y} in [-1, +1]
   * @param camera  Current active camera
   */
  onPointerMove(ndc: { x: number; y: number }, camera: THREE.Camera): void

  /**
   * Handle click: raycast → clickNet or clickComponent event.
   * @param ndc  Normalised device coordinates {x,y} in [-1, +1]
   * @param camera  Current active camera
   */
  onClick(ndc: { x: number; y: number }, camera: THREE.Camera): void

  /**
   * Programmatically clear hover state (e.g. when board reloads).
   */
  clearHover(): void

  /**
   * Convenience: fire a raycast and return the first hit result.
   * Useful for unit-tests that want to inspect the raw hit.
   */
  raycastFirst(
    ndc: { x: number; y: number },
    camera: THREE.Camera
  ): { netId?: number; ref?: string; point: THREE.Vector3 } | null

  /**
   * Scan the FULL sorted hit list (nearest → farthest, same list
   * intersectObjects already returns) and return whichever of netId/ref
   * resolve to a registered object — carrying BOTH keys when a net hit AND a
   * component hit are both present along the ray. This matters because a
   * component placeholder box commonly OCCLUDES its own pad's copper (the
   * pad sits directly under the component body) — `raycastFirst` would only
   * ever see the nearer component and never the net underneath it.
   *
   * `point` is always the NEAREST hit's world position, regardless of
   * whether that nearest hit is the net or the component. Returns null only
   * when the ray hits nothing that resolves to either a netId or a ref.
   *
   * Bench Leads' pickAttachTargetAt (scene.ts) uses this so a net-accepting
   * jack (e.g. a voltage probe) can still attach to copper that a nearer
   * component box would otherwise hide from raycastFirst.
   */
  raycastTargets(
    ndc: { x: number; y: number },
    camera: THREE.Camera
  ): { netId?: number; ref?: string; point: THREE.Vector3 } | null

  /**
   * Programmatically highlight a net + component refs via the SAME emissive boost
   * the hover path uses (read-only, no geometry change). Passing null/[] clears
   * the respective highlight. Used by the Board Critic to spotlight a finding's
   * involved net/part without going through a pointer event.
   */
  setExternalHighlight(netId: number | null, refs?: string[]): void
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Create a PickingController.
 *
 * @param callback  Called whenever a pick event fires.  Keep it non-blocking.
 * @param invalidate  Optional: called after hover state changes so scene can re-render.
 */
export function createPicker(
  callback: PickCallback,
  invalidate?: () => void
): PickingController {
  const copperRecords: CopperRecord[] = []
  const viaRecords: ViaRecord[] = []
  const componentRecords: ComponentRecord[] = []

  let hoveredNetId: number | null = null
  const raycaster = new THREE.Raycaster()

  // ── hover highlight helpers ───────────────────────────────────────────────

  function applyHoverHighlight(netId: number | null): void {
    // Copper meshes
    for (const rec of copperRecords) {
      const on = netId !== null && rec.netId === netId
      setMeshEmissive(rec.mesh, on ? EMISSIVE_BOOST : EMISSIVE_OFF)
    }
    // Via instance mesh (tint the whole mesh; per-instance tinting would need
    // per-instance color which isn't set up yet — good enough for v1)
    for (const rec of viaRecords) {
      const netIds = rec.netIds
      const anyMatch = netId !== null && netIds.some(n => n === netId)
      setMeshEmissive(rec.mesh, anyMatch ? EMISSIVE_BOOST : EMISSIVE_OFF)
    }
    invalidate?.()
  }

  // ── build candidate object list for the raycaster ─────────────────────────

  function getCandidateObjects(): THREE.Object3D[] {
    const objs: THREE.Object3D[] = []
    for (const rec of copperRecords) objs.push(rec.mesh)
    for (const rec of viaRecords) objs.push(rec.mesh)
    for (const rec of componentRecords) objs.push(rec.mesh)
    return objs
  }

  // ── net/ref lookup from a raycaster intersection ──────────────────────────

  function resolveIntersection(
    intersection: THREE.Intersection
  ): { netId?: number; ref?: string } {
    const obj = intersection.object

    // Check copper meshes
    for (const rec of copperRecords) {
      if (rec.mesh === obj) return { netId: rec.netId }
    }

    // Check via InstancedMesh
    for (const rec of viaRecords) {
      if (rec.mesh === obj) {
        const iid = intersection.instanceId
        if (iid !== undefined && iid < rec.netIds.length) {
          return { netId: rec.netIds[iid] }
        }
        return {}
      }
    }

    // Check component boxes
    for (const rec of componentRecords) {
      if (rec.mesh === obj) return { ref: rec.ref }
    }

    return {}
  }

  // ── public API ────────────────────────────────────────────────────────────

  return {
    registerCopperMesh(mesh, netId) {
      copperRecords.push({ mesh, netId })
    },

    registerViaInstance(mesh, netIds) {
      viaRecords.push({ mesh, netIds })
    },

    registerComponentBox(mesh, ref) {
      componentRecords.push({ mesh, ref })
    },

    clear() {
      // Clear emissive state before removing
      for (const rec of copperRecords) setMeshEmissive(rec.mesh, EMISSIVE_OFF)
      for (const rec of viaRecords)    setMeshEmissive(rec.mesh, EMISSIVE_OFF)
      copperRecords.length = 0
      viaRecords.length = 0
      componentRecords.length = 0
      hoveredNetId = null
    },

    onPointerMove(ndc, camera) {
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
      const hits = raycaster.intersectObjects(getCandidateObjects(), false)

      if (hits.length === 0) {
        if (hoveredNetId !== null) {
          hoveredNetId = null
          applyHoverHighlight(null)
          callback({ type: 'clearHover' })
        }
        return
      }

      const resolved = resolveIntersection(hits[0])

      if (resolved.netId !== undefined) {
        if (resolved.netId !== hoveredNetId) {
          hoveredNetId = resolved.netId
          applyHoverHighlight(resolved.netId)
          callback({ type: 'hoverNet', netId: resolved.netId })
        }
      } else if (resolved.ref !== undefined) {
        // Hovering a component — clear net hover
        if (hoveredNetId !== null) {
          hoveredNetId = null
          applyHoverHighlight(null)
          callback({ type: 'clearHover' })
        }
      }
    },

    onClick(ndc, camera) {
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
      const hits = raycaster.intersectObjects(getCandidateObjects(), false)

      if (hits.length === 0) return

      const resolved = resolveIntersection(hits[0])

      if (resolved.netId !== undefined) {
        callback({ type: 'clickNet', netId: resolved.netId, worldPos: hits[0].point })
      } else if (resolved.ref !== undefined) {
        callback({ type: 'clickComponent', ref: resolved.ref })
      }
    },

    clearHover() {
      if (hoveredNetId !== null) {
        hoveredNetId = null
        applyHoverHighlight(null)
        callback({ type: 'clearHover' })
      }
    },

    raycastFirst(ndc, camera) {
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
      const hits = raycaster.intersectObjects(getCandidateObjects(), false)
      if (hits.length === 0) return null

      const resolved = resolveIntersection(hits[0])
      return {
        netId: resolved.netId,
        ref:   resolved.ref,
        point: hits[0].point,
      }
    },

    raycastTargets(ndc, camera) {
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
      const hits = raycaster.intersectObjects(getCandidateObjects(), false)
      if (hits.length === 0) return null

      // hits is sorted nearest→farthest; capture the FIRST (nearest) resolved
      // netId and the FIRST resolved ref independently, so a nearer component
      // box doesn't hide a net hit farther along the same ray (and vice versa).
      let netId: number | undefined
      let ref: string | undefined
      for (const hit of hits) {
        const resolved = resolveIntersection(hit)
        if (netId === undefined && resolved.netId !== undefined) netId = resolved.netId
        if (ref === undefined && resolved.ref !== undefined) ref = resolved.ref
        if (netId !== undefined && ref !== undefined) break
      }

      if (netId === undefined && ref === undefined) return null
      return { netId, ref, point: hits[0].point }
    },

    setExternalHighlight(netId, refs) {
      // Keep hover state consistent: a later pointermove compares against
      // hoveredNetId, so record the critic's highlighted net as the hovered net.
      // This also prevents a stray pointermove from silently erasing the highlight
      // (it now treats the critic net as already-hovered).
      hoveredNetId = netId
      // Reuse the hover emissive path for the net (copper + vias).
      applyHoverHighlight(netId)
      // Component boxes: boost the requested refs, clear the rest — but NEVER
      // touch LED-owned materials: an LED box shares its MeshStandardMaterial with
      // ledGlowController (which drives emissive for the glow), so writing
      // EMISSIVE_OFF here would zero the LED's glow until the next publish. Skip any
      // mesh flagged `userData.isLed`.
      const wanted = new Set(refs ?? [])
      for (const rec of componentRecords) {
        if (rec.mesh.userData?.isLed) continue
        setMeshEmissive(rec.mesh, wanted.has(rec.ref) ? EMISSIVE_BOOST : EMISSIVE_OFF)
      }
      invalidate?.()
    },
  }
}
