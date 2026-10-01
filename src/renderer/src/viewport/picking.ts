/**
 * viewport/picking.ts
 *
 * Task 19 — Picking + hover/selection.
 *
 * Design (spec §10.2):
 *   - Copper is planar, so it is NOT raycast triangle by triangle (#58). The
 *     ray is intersected with each copper layer's plane and a 2D spatial index
 *     (copperIndex.ts) resolves the net at that point. three.js Raycaster is
 *     kept for the things that are genuinely 3D: via instances
 *     (instanceId→netId) and component boxes (→ref).
 *   - Emits typed pick events via a callback so scene.ts stays React-free.
 *   - Hover: emissive boost on ALL copper that shares a netId (both layers + vias).
 *     Only the previously boosted net and the newly hovered net are touched (#77).
 *
 * Pick event union:
 *   { type:'hoverNet',     netId: number }
 *   { type:'clickNet',     netId: number; worldPos: THREE.Vector3 }
 *   { type:'clickComponent', ref: string }
 *   { type:'clearHover' }
 *
 * Copper comes in two registration forms:
 *   registerCopperLayer(mesh, netIds, tints)  the viewport form: one merged mesh
 *       per board side with a per-vertex netIndex attribute; emissive lives in
 *       the NetTintTable texture (netTint.ts).
 *   registerCopperMesh(mesh, netId)  one mesh per net, emissive on the mesh's
 *       own material. Kept for tests and simple scenes.
 * Components likewise: registerComponentInstances (one InstancedMesh, instance
 * colors) for the bulk of the parts, registerComponentBox (one Mesh each) for
 * parts that own a material, such as LEDs.
 *
 * Usage (scene.ts wires this up):
 *   const picker = createPicker(callback)
 *   picker.registerCopperLayer(mesh, netIds, tints)
 *   picker.registerViaInstance(instancedMesh, netIds)   // netIds[i] → netId for instance i
 *   picker.registerComponentInstances(instancedMesh, refs)
 *   picker.onPointerMove(ndc, camera)   // call at most once per animation frame
 *   picker.clear()  // called from scene on board reload
 *
 * No WebGL context required in tests — THREE.Raycaster and BufferGeometry
 * work headlessly in Node under Vitest.
 *
 * Spec §10.2
 */

import * as THREE from 'three'
import { CopperHitIndex } from './copperIndex'
import type { NetTintTable } from './netTint'

// ─── pick event types ─────────────────────────────────────────────────────────

export type PickEvent =
  | { type: 'hoverNet';       netId: number }
  | { type: 'clickNet';       netId: number; worldPos: THREE.Vector3 }
  | { type: 'clickComponent'; ref: string }
  | { type: 'clearHover' }

export type PickCallback = (event: PickEvent) => void

// ─── internal registration records ───────────────────────────────────────────

interface ViaRecord {
  mesh: THREE.InstancedMesh
  netIds: number[]   // netIds[instanceId] → netId
  netSet: Set<number>
}

interface InstancedComponentRecord {
  mesh: THREE.InstancedMesh
  refs: string[]
  /** ref → instance indices (a ref can repeat on an unannotated board). */
  indexByRef: Map<string, number[]>
  /** Instance colors at registration, restored when a highlight ends. */
  baseColors: Float32Array
  /** Instance indices currently drawn highlighted. */
  highlighted: Set<number>
}

interface Hit {
  distance: number
  point: THREE.Vector3
  netId?: number
  ref?: string
}

// ─── emissive hover helpers ───────────────────────────────────────────────────

const EMISSIVE_BOOST = new THREE.Color(0x885500)
const EMISSIVE_OFF   = new THREE.Color(0x000000)

/** Instance color a highlighted component box is blended toward. */
const BOX_HIGHLIGHT = new THREE.Color(0xffb040)
const BOX_HIGHLIGHT_MIX = 0.6

/**
 * Write a mesh material's emissive. Emissive is a uniform three.js re-reads on
 * every draw, so unlike a defines or map change it needs no material.needsUpdate
 * (#77): that flag only forces a program re-selection.
 */
function setMeshEmissive(mesh: THREE.Mesh | THREE.InstancedMesh, color: THREE.Color): void {
  const mat = mesh.material
  if (mat instanceof THREE.MeshStandardMaterial) {
    mat.emissive.copy(color)
  }
}

// ─── PickingController interface ──────────────────────────────────────────────

export interface PickingController {
  /**
   * Register one net's copper mesh (flat segment / pad / zone). Its emissive is
   * written on the mesh's own material. The mesh must already be added to the
   * scene (or have its world matrix current) before events are tested.
   */
  registerCopperMesh(mesh: THREE.Mesh, netId: number): void

  /**
   * Register a merged copper layer: one mesh whose geometry has a per-vertex
   * `netIndex` attribute, `netIds[netIndex]` being the net. Hover emissive is
   * written to `tints`, not to a material.
   */
  registerCopperLayer(mesh: THREE.Mesh, netIds: number[], tints: NetTintTable): void

  /**
   * Register the via InstancedMesh.
   * netIds[i] is the netId for instance i.
   */
  registerViaInstance(mesh: THREE.InstancedMesh, netIds: number[]): void

  /**
   * Register a component placeholder box mesh.
   */
  registerComponentBox(mesh: THREE.Mesh, ref: string): void

  /**
   * Register an InstancedMesh of component boxes. refs[i] is the part for
   * instance i. Highlights recolor instances through setColorAt, so the mesh
   * must already carry instance colors.
   */
  registerComponentInstances(mesh: THREE.InstancedMesh, refs: string[]): void

  /** Remove all registered objects (call before board reload). */
  clear(): void

  /**
   * Handle pointer-move: pick → hover highlight + hoverNet event.
   * @param ndc  Normalised device coordinates {x,y} in [-1, +1]
   * @param camera  Current active camera
   */
  onPointerMove(ndc: { x: number; y: number }, camera: THREE.Camera): void

  /**
   * Handle click: pick → clickNet or clickComponent event.
   * @param ndc  Normalised device coordinates {x,y} in [-1, +1]
   * @param camera  Current active camera
   */
  onClick(ndc: { x: number; y: number }, camera: THREE.Camera): void

  /**
   * Programmatically clear hover state (e.g. when board reloads).
   */
  clearHover(): void

  /**
   * Convenience: fire a pick and return the first (nearest) hit result.
   * Useful for unit-tests that want to inspect the raw hit.
   */
  raycastFirst(
    ndc: { x: number; y: number },
    camera: THREE.Camera
  ): { netId?: number; ref?: string; point: THREE.Vector3 } | null

  /**
   * Scan the FULL sorted hit list (nearest → farthest) and return whichever of
   * netId/ref resolve to a registered object, carrying BOTH keys when a net hit
   * AND a component hit are both present along the ray. This matters because a
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

  /** Build the copper spatial index now instead of on the first pick. */
  warm(): void
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
  const copperIndex = new CopperHitIndex()
  /** Per-net copper meshes registered with registerCopperMesh (own materials). */
  const copperMeshesByNet = new Map<number, THREE.Mesh[]>()
  /** Tint tables of registered copper layers (hover emissive goes here). */
  const tintTables = new Set<NetTintTable>()
  const viaRecords: ViaRecord[] = []
  const viaByMesh = new Map<THREE.Object3D, ViaRecord>()
  const boxByMesh = new Map<THREE.Object3D, string>()
  const instancedByMesh = new Map<THREE.Object3D, InstancedComponentRecord>()
  /** Objects handed to the three.js Raycaster: vias and component boxes only. */
  const raycastObjects: THREE.Object3D[] = []

  let hoveredNetId: number | null = null
  /** The net whose copper currently carries the emissive boost, if any. */
  let boostedNetId: number | null = null
  const raycaster = new THREE.Raycaster()
  const ndcVec = new THREE.Vector2()
  const color = new THREE.Color()

  // ── hover highlight helpers ───────────────────────────────────────────────

  /** Boost or clear one net's copper everywhere it is drawn. */
  function setNetEmissive(netId: number, on: boolean): void {
    const c = on ? EMISSIVE_BOOST : EMISSIVE_OFF
    for (const table of tintTables) table.setEmissive(netId, c)
    const meshes = copperMeshesByNet.get(netId)
    if (meshes) for (const mesh of meshes) setMeshEmissive(mesh, c)
    // Via instance mesh (tint the whole mesh; per-instance tinting would need
    // per-instance color which isn't set up yet — good enough for v1)
    for (const rec of viaRecords) {
      if (rec.netSet.has(netId)) setMeshEmissive(rec.mesh, c)
    }
  }

  function applyHoverHighlight(netId: number | null): void {
    // Only the net losing the boost and the net gaining it change; every other
    // net's copper keeps the state it already has.
    if (boostedNetId !== null && boostedNetId !== netId) setNetEmissive(boostedNetId, false)
    if (netId !== null && netId !== boostedNetId) setNetEmissive(netId, true)
    boostedNetId = netId
    invalidate?.()
  }

  // ── hit collection ────────────────────────────────────────────────────────

  function resolveIntersection(intersection: THREE.Intersection): Hit {
    const obj = intersection.object
    const hit: Hit = { distance: intersection.distance, point: intersection.point }

    const via = viaByMesh.get(obj)
    if (via) {
      const iid = intersection.instanceId
      if (iid !== undefined && iid < via.netIds.length) hit.netId = via.netIds[iid]
      return hit
    }

    const inst = instancedByMesh.get(obj)
    if (inst) {
      const iid = intersection.instanceId
      if (iid !== undefined && iid < inst.refs.length) hit.ref = inst.refs[iid]
      return hit
    }

    const ref = boxByMesh.get(obj)
    if (ref !== undefined) hit.ref = ref
    return hit
  }

  /**
   * All hits along the ray for the given pointer, nearest first: copper from the
   * planar index, vias and component boxes from the three.js raycaster. A tie in
   * distance keeps copper first.
   */
  function collectHits(ndc: { x: number; y: number }, camera: THREE.Camera): Hit[] {
    ndcVec.set(ndc.x, ndc.y)
    raycaster.setFromCamera(ndcVec, camera)

    const hits: Hit[] = []
    for (const h of copperIndex.query(raycaster.ray)) {
      hits.push({ distance: h.distance, point: h.point, netId: h.netId })
    }
    if (raycastObjects.length > 0) {
      for (const i of raycaster.intersectObjects(raycastObjects, false)) {
        hits.push(resolveIntersection(i))
      }
    }
    // Array.prototype.sort is stable: copper stays ahead on equal distance.
    hits.sort((a, b) => a.distance - b.distance)
    return hits
  }

  // ── component highlight (instanced boxes) ─────────────────────────────────

  function setInstanceHighlight(rec: InstancedComponentRecord, index: number, on: boolean): void {
    const b = rec.baseColors
    color.setRGB(b[index * 3], b[index * 3 + 1], b[index * 3 + 2])
    if (on) color.lerp(BOX_HIGHLIGHT, BOX_HIGHLIGHT_MIX)
    rec.mesh.setColorAt(index, color)
    if (rec.mesh.instanceColor) rec.mesh.instanceColor.needsUpdate = true
  }

  // ── public API ────────────────────────────────────────────────────────────

  return {
    registerCopperMesh(mesh, netId) {
      let list = copperMeshesByNet.get(netId)
      if (!list) {
        list = []
        copperMeshesByNet.set(netId, list)
      }
      list.push(mesh)
      copperIndex.add(mesh, () => netId)
    },

    registerCopperLayer(mesh, netIds, tints) {
      tintTables.add(tints)
      const netIndexAttr = mesh.geometry.getAttribute('netIndex')
      copperIndex.add(mesh, vertexIndex => netIds[netIndexAttr.getX(vertexIndex)])
    },

    registerViaInstance(mesh, netIds) {
      const rec: ViaRecord = { mesh, netIds, netSet: new Set(netIds) }
      viaRecords.push(rec)
      viaByMesh.set(mesh, rec)
      raycastObjects.push(mesh)
    },

    registerComponentBox(mesh, ref) {
      boxByMesh.set(mesh, ref)
      raycastObjects.push(mesh)
    },

    registerComponentInstances(mesh, refs) {
      const baseColors = new Float32Array(refs.length * 3)
      const c = new THREE.Color()
      for (let i = 0; i < refs.length; i++) {
        if (mesh.instanceColor) mesh.getColorAt(i, c)
        else c.setRGB(1, 1, 1)
        baseColors[i * 3] = c.r
        baseColors[i * 3 + 1] = c.g
        baseColors[i * 3 + 2] = c.b
      }
      const indexByRef = new Map<string, number[]>()
      refs.forEach((r, i) => {
        const list = indexByRef.get(r)
        if (list) list.push(i)
        else indexByRef.set(r, [i])
      })
      instancedByMesh.set(mesh, {
        mesh,
        refs,
        indexByRef,
        baseColors,
        highlighted: new Set(),
      })
      raycastObjects.push(mesh)
    },

    clear() {
      // Clear emissive state before removing
      for (const meshes of copperMeshesByNet.values()) {
        for (const mesh of meshes) setMeshEmissive(mesh, EMISSIVE_OFF)
      }
      for (const table of tintTables) table.resetEmissive()
      for (const rec of viaRecords) setMeshEmissive(rec.mesh, EMISSIVE_OFF)
      for (const rec of instancedByMesh.values()) {
        for (const i of rec.highlighted) setInstanceHighlight(rec, i, false)
        rec.highlighted.clear()
      }
      copperIndex.clear()
      copperMeshesByNet.clear()
      tintTables.clear()
      viaRecords.length = 0
      viaByMesh.clear()
      boxByMesh.clear()
      instancedByMesh.clear()
      raycastObjects.length = 0
      hoveredNetId = null
      boostedNetId = null
    },

    onPointerMove(ndc, camera) {
      const hits = collectHits(ndc, camera)

      if (hits.length === 0) {
        if (hoveredNetId !== null) {
          hoveredNetId = null
          applyHoverHighlight(null)
          callback({ type: 'clearHover' })
        }
        return
      }

      const resolved = hits[0]

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
      const hits = collectHits(ndc, camera)
      if (hits.length === 0) return

      const resolved = hits[0]

      if (resolved.netId !== undefined) {
        callback({ type: 'clickNet', netId: resolved.netId, worldPos: resolved.point })
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
      const hits = collectHits(ndc, camera)
      if (hits.length === 0) return null

      const first = hits[0]
      return {
        netId: first.netId,
        ref:   first.ref,
        point: first.point,
      }
    },

    raycastTargets(ndc, camera) {
      const hits = collectHits(ndc, camera)
      if (hits.length === 0) return null

      // hits is sorted nearest→farthest; capture the FIRST (nearest) resolved
      // netId and the FIRST resolved ref independently, so a nearer component
      // box doesn't hide a net hit farther along the same ray (and vice versa).
      let netId: number | undefined
      let ref: string | undefined
      for (const hit of hits) {
        if (netId === undefined && hit.netId !== undefined) netId = hit.netId
        if (ref === undefined && hit.ref !== undefined) ref = hit.ref
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
      for (const [mesh, ref] of boxByMesh) {
        if (mesh.userData?.isLed) continue
        setMeshEmissive(mesh as THREE.Mesh, wanted.has(ref) ? EMISSIVE_BOOST : EMISSIVE_OFF)
      }
      // Instanced boxes: recolor only the instances whose state changes.
      for (const rec of instancedByMesh.values()) {
        for (const i of rec.highlighted) {
          if (!wanted.has(rec.refs[i])) {
            setInstanceHighlight(rec, i, false)
            rec.highlighted.delete(i)
          }
        }
        for (const ref of wanted) {
          for (const i of rec.indexByRef.get(ref) ?? []) {
            if (rec.highlighted.has(i)) continue
            setInstanceHighlight(rec, i, true)
            rec.highlighted.add(i)
          }
        }
      }
      invalidate?.()
    },

    warm() {
      copperIndex.warm()
    },
  }
}
