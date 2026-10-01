/**
 * viewport/boardAssembly.ts
 *
 * Builds the THREE objects for one board (substrate, copper, vias, component
 * boxes) and registers them with the picker. Extracted from scene.loadBoard so
 * the draw-call budget (#57) can be tested headlessly: nothing here needs a
 * WebGL context, a DOM, or a renderer.
 *
 * Draw-call budget for a board, independent of part, net, or track count:
 *   substrate           1
 *   copper              1 per side that has copper (2)
 *   vias                1 (InstancedMesh)
 *   component boxes     1 (InstancedMesh) + 1 per LED (LEDs own a material)
 *   silkscreen          1 (see silkscreen.ts; assembled separately because it
 *                         needs a canvas)
 *
 * Group layout (matches the previous scene.ts so picking and overlays keep
 * their coordinates): every group is offset by the board-centering (-cx, -cy);
 * the copper group additionally sits at the board's top surface, and back
 * copper and vias are positioned back down inside it.
 */

import * as THREE from 'three'
import type { BoardModel, Footprint } from '../../../core/kicad/types'
import { padWorldPos } from '../../../core/critic/geom'
import { buildSubstrate, kicadToWorld } from './boardGeometry'
import { buildCopperLayers, buildViaInstances, copperBaseMaterial } from './copperGeometry'
import { buildComponentBoxBatch, makeBoxMaterial } from './componentGeometry'
import { isLed } from './ledGlow'
import { NetTintTable } from './netTint'
import type { PickingController } from './picking'

const FR4_COLOR = 0x1a6b2a  // dark green

/** An LED box that owns its material; the scene hands it to the LED glow controller. */
export interface LedBox {
  ref: string
  mesh: THREE.Mesh
  fp: Footprint
}

export interface AssembledBoard {
  substrateGroup: THREE.Group
  /** Copper layers and vias. */
  copperGroup: THREE.Group
  /** Component boxes and (later) LED halos. */
  componentGroup: THREE.Group
  /** Per-net copper color and emissive; the overlay and hover write here. */
  netTints: NetTintTable
  /** Net id to a world position on that net (first pad), for annotations. */
  netPositions: Map<number, THREE.Vector3>
  /** Part ref to its box position in scene space, for bench lead clamps. */
  componentAnchors: Map<string, THREE.Vector3>
  ledBoxes: LedBox[]
  /** Substrate bounding box, before centering. */
  bounds: THREE.Box3
  /** Board-centering offset subtracted from every group. */
  center: { x: number; y: number }
}

/**
 * Build every board object and register copper, vias, and component boxes with
 * `picker`. The caller adds the returned groups to its scene.
 */
export function assembleBoard(board: BoardModel, picker: PickingController): AssembledBoard {
  // ── Substrate ──
  const substrateGroup = new THREE.Group()
  const substGeo = buildSubstrate(board.outline, board.boardThicknessMm)
  const substMat = new THREE.MeshStandardMaterial({
    color: FR4_COLOR,
    roughness: 0.8,
    metalness: 0.0,
  })
  const substMesh = new THREE.Mesh(substGeo, substMat)

  // Center the board around the origin
  substGeo.computeBoundingBox()
  const bounds = substGeo.boundingBox!.clone()
  const cx = (bounds.min.x + bounds.max.x) / 2
  const cy = (bounds.min.y + bounds.max.y) / 2
  substMesh.position.set(-cx, -cy, 0)
  substrateGroup.add(substMesh)

  // ── Net positions (world-space position of first pad per net) ──
  // Used for op annotation label placement.
  const copperZ = board.boardThicknessMm
  const netPositions = new Map<number, THREE.Vector3>()
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (pad.netId === undefined || pad.netId === 0) continue
      if (!netPositions.has(pad.netId)) {
        const pos = padWorldPos(fp, pad)
        const world = kicadToWorld(pos.x, pos.y)
        // Apply the same board-centering offset used for the copper group
        netPositions.set(pad.netId, new THREE.Vector3(world.x - cx, world.y - cy, copperZ))
      }
    }
  }

  // ── Copper: one mesh and one shared material per board side ──
  const copperGroup = new THREE.Group()
  // Copper sits on top of the substrate (Z = boardThickness)
  copperGroup.position.set(-cx, -cy, copperZ)

  const layers = buildCopperLayers(board)
  const netTints = new NetTintTable(layers.netIds, copperBaseMaterial.color)
  const copperMaterial = netTints.createMaterial({
    metalness: copperBaseMaterial.metalness,
    roughness: copperBaseMaterial.roughness,
  })
  if (layers.F) {
    const mesh = new THREE.Mesh(layers.F, copperMaterial)
    mesh.name = 'copper-F'
    copperGroup.add(mesh)
    picker.registerCopperLayer(mesh, layers.netIds, netTints)
  }
  if (layers.B) {
    // B-side copper sits on the back face: undo the group's top-surface offset.
    const mesh = new THREE.Mesh(layers.B, copperMaterial)
    mesh.name = 'copper-B'
    mesh.position.z = -copperZ
    copperGroup.add(mesh)
    picker.registerCopperLayer(mesh, layers.netIds, netTints)
  }

  // ── Vias ──
  if (board.vias.length > 0) {
    const viaResult = buildViaInstances(board)
    viaResult.mesh.name = 'vias'
    // Vias span the full board thickness, so they sit at the bottom surface.
    viaResult.mesh.position.set(0, 0, -copperZ)
    copperGroup.add(viaResult.mesh)
    picker.registerViaInstance(viaResult.mesh, viaResult.netIds)
  }

  // ── Component placeholder boxes ──
  const componentGroup = new THREE.Group()
  componentGroup.position.set(-cx, -cy, 0)

  const asLed = (fp: Footprint) =>
    isLed({ ref: fp.ref, value: fp.value, libId: fp.libId, properties: fp.properties })
  const batch = buildComponentBoxBatch(board.footprints, board.boardThicknessMm, asLed)

  if (batch.instanced) {
    batch.instanced.name = 'component-boxes'
    componentGroup.add(batch.instanced)
    picker.registerComponentInstances(batch.instanced, batch.instancedRefs)
  }

  const fpByRef = new Map(board.footprints.map(fp => [fp.ref, fp]))
  const ledBoxes: LedBox[] = []
  for (const entry of batch.individual) {
    const mesh = new THREE.Mesh(entry.geo, makeBoxMaterial(entry.color))
    mesh.position.set(entry.worldX, entry.worldY, entry.worldZ)
    mesh.userData = { ref: entry.ref, className: entry.className }
    // Flag the mesh so the picker's external-highlight (critic focus) leaves
    // this LED-owned material alone: it shares its emissive with the glow.
    mesh.userData.isLed = true
    componentGroup.add(mesh)
    picker.registerComponentBox(mesh, entry.ref)
    const fp = fpByRef.get(entry.ref)
    if (fp) ledBoxes.push({ ref: entry.ref, mesh, fp })
  }

  // World-space anchor for bench lead clamps: the box position plus the
  // group's board-centering offset (same convention as netPositions).
  const componentAnchors = new Map<string, THREE.Vector3>()
  for (const p of batch.placements) {
    componentAnchors.set(p.ref, new THREE.Vector3(p.worldX - cx, p.worldY - cy, p.worldZ))
  }

  return {
    substrateGroup,
    copperGroup,
    componentGroup,
    netTints,
    netPositions,
    componentAnchors,
    ledBoxes,
    bounds,
    center: { x: cx, y: cy },
  }
}

/**
 * Dispose the geometries, materials, and textures an assembled board owns.
 * Safe to call on any object tree built by assembleBoard (and on the silkscreen
 * mesh, whose material owns the atlas texture).
 */
export function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse(obj => {
    const o = obj as THREE.Mesh
    if (o.geometry) o.geometry.dispose()
    const mat = o.material as THREE.Material | THREE.Material[] | undefined
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : []
    for (const m of mats) {
      const map = (m as THREE.MeshBasicMaterial).map
      if (map) map.dispose()
      m.dispose()
    }
  })
}
