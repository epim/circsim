/**
 * picking.test.ts
 *
 * Task 19 — headless picking tests.
 *
 * THREE.Raycaster + BufferGeometry run headlessly in Node under Vitest.
 * No WebGL context is needed — we never call renderer.render().
 *
 * Test strategy:
 *   1. Build a simple known-position mesh (or use buildCopper geometry from
 *      fixture-rc).
 *   2. Register it with a PickingController.
 *   3. Set up an orthographic camera looking straight down (+Z direction).
 *   4. Fire onPointerMove / onClick / raycastFirst with NDC coords that should
 *      hit the mesh.
 *   5. Assert the correct event / netId / ref is returned.
 *
 * Coordinate maths:
 *   Fixture-rc R1 pad "1" is at KiCad (10 - 0.9125, 10) = (9.0875, 10).
 *   kicadToWorld → world (9.0875, -10).
 *   Pad size 1.025 × 1.4 mm.
 *
 *   For simpler, self-contained tests we create synthetic PlaneGeometry meshes
 *   at known positions and shoot rays at them.
 *
 * Spec §10.2
 */

import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import * as fs from 'fs'
import * as path from 'path'
import { createPicker, type PickEvent } from '../picking'
import { parseBoard } from '../../../../core/kicad/board'
import { buildCopper } from '../copperGeometry'
import { kicadToWorld } from '../boardGeometry'

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build an orthographic camera looking straight down (along -Z) at the XY plane.
 * The camera is positioned far above Z=0 so it sees everything below.
 */
function makeTopDownCamera(
  viewHalfW = 50,
  viewHalfH = 50
): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(
    -viewHalfW, viewHalfW,
    viewHalfH, -viewHalfH,
    0.1, 500
  )
  cam.position.set(0, 0, 200)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld()
  return cam
}

/**
 * Convert a world XY position to NDC for a top-down orthographic camera.
 * For an ortho camera looking down at the XY plane:
 *   ndcX = worldX / viewHalfW
 *   ndcY = worldY / viewHalfH
 */
function worldToNDC(wx: number, wy: number, halfW = 50, halfH = 50): { x: number; y: number } {
  return { x: wx / halfW, y: wy / halfH }
}

/**
 * Build a flat PlaneGeometry mesh at the given XY center, sized w×h.
 * Used for synthetic copper-like test meshes.
 */
function makePlaneMesh(
  cx: number, cy: number,
  w = 2, h = 2,
  netId?: number,
  ref?: string
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, h)
  const mat = new THREE.MeshStandardMaterial({ color: 0xb87333 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(cx, cy, 0)
  // Force bounding sphere update (needed for raycasting without a scene)
  mesh.updateMatrixWorld(true)
  if (netId !== undefined) mesh.userData.netId = netId
  if (ref !== undefined)   mesh.userData.ref   = ref
  return mesh
}

// ─── basic registration and raycast ──────────────────────────────────────────

describe('createPicker — copper mesh registration + raycast', () => {
  it('raycastFirst returns null when no objects registered', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()
    const result = picker.raycastFirst({ x: 0, y: 0 }, cam)
    expect(result).toBeNull()
  })

  it('raycastFirst hits a registered copper mesh at its world position', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    // Place a 4×4 mm copper-like plane at (10, -10, 0)
    const mesh = makePlaneMesh(10, -10, 4, 4)
    picker.registerCopperMesh(mesh, 1)

    // NDC for world (10, -10) with half-extents 50×50
    const ndc = worldToNDC(10, -10)
    const result = picker.raycastFirst(ndc, cam)
    expect(result).not.toBeNull()
    expect(result!.netId).toBe(1)
  })

  it('raycastFirst returns netId 2 when that mesh is at the hit point', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    // Two meshes at different X positions — ray hits net 2 at X=20
    const mesh1 = makePlaneMesh(0, 0, 2, 2)
    const mesh2 = makePlaneMesh(20, 0, 2, 2)
    picker.registerCopperMesh(mesh1, 1)
    picker.registerCopperMesh(mesh2, 2)

    const ndc = worldToNDC(20, 0)
    const result = picker.raycastFirst(ndc, cam)
    expect(result).not.toBeNull()
    expect(result!.netId).toBe(2)
  })

  it('raycastFirst returns null for a ray that misses all meshes', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(10, -10, 2, 2)
    picker.registerCopperMesh(mesh, 1)

    // NDC for far corner (45, 45) — well outside the 2×2 mesh at (10,-10)
    const ndc = worldToNDC(45, 45)
    const result = picker.raycastFirst(ndc, cam)
    expect(result).toBeNull()
  })
})

// ─── fixture-rc: R1 pad 1 → net 1 ────────────────────────────────────────────

describe('createPicker — fixture-rc copper geometry hit test', () => {
  const fixturePath = path.resolve(
    __dirname,
    '../../../../../fixtures/fixture-rc.kicad_pcb'
  )
  const text = fs.readFileSync(fixturePath, 'utf-8')
  const board = parseBoard(text)
  const copperMap = buildCopper(board)

  /**
   * scene.ts centers the board geometry:
   *   substGeo.computeBoundingBox() → bb covers x:[0..30], y:[-20..0]
   *   cx = 15, cy = -10
   *   copperGroup.position.set(-15, 10, copperZ)  ← world offset
   *
   * To mimic scene centering we apply the same offset to the mesh manually
   * or, for the test, we skip the offset and query the raw geometry position.
   *
   * The raw world coords (before scene centering):
   *   R1 pad "1" at KiCad (9.0875, 10) → kicadToWorld → (9.0875, -10)
   *   R1 pad "2" at KiCad (10.9125, 10) → kicadToWorld → (10.9125, -10)
   *   R2 pad "1" at KiCad (19.0875, 10) → kicadToWorld → (19.0875, -10)
   *   R2 pad "2" at KiCad (20.9125, 10) → kicadToWorld → (20.9125, -10)
   *
   * We build meshes from the copper geometry directly (which encodes these
   * world coords in vertex data already), then position the parent group at
   * the scene offset and confirm hits.
   */

  it('copper map has nets 1, 2, 3', () => {
    expect(copperMap.has(1)).toBe(true)
    expect(copperMap.has(2)).toBe(true)
    expect(copperMap.has(3)).toBe(true)
  })

  it('ray at R1 pad 1 world position hits net 1', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera(30, 30)

    // Scene centering offset (scene.ts logic): board spans x:0..30, y:-20..0
    // cx = (0+30)/2 = 15, cy = (-20+0)/2 = -10
    // copperGroup.position = (-15, 10, copperZ)
    // So a copper mesh vertex at raw world (9.0875, -10) appears at:
    //   scene X = 9.0875 + (-15) = -5.9125
    //   scene Y = -10 + 10       = 0
    const boardCenterOffsetX = -15
    const boardCenterOffsetY = 10

    // Build a parent group mirroring scene.ts offset
    const group = new THREE.Group()
    group.position.set(boardCenterOffsetX, boardCenterOffsetY, 1.6)

    // Register net 1 geometry (R1 pad "1" is on F layer, net 1)
    const net1Entry = copperMap.get(1)!
    expect(net1Entry.F).toBeDefined()
    const net1Mesh = new THREE.Mesh(net1Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net1Mesh)
    group.updateMatrixWorld(true)

    // Also register net 2 and 3 meshes so we can confirm we hit net 1 specifically
    const net2Entry = copperMap.get(2)!
    const net2Mesh = new THREE.Mesh(net2Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net2Mesh)
    net2Mesh.updateMatrixWorld(true)

    const net3Entry = copperMap.get(3)!
    const net3Mesh = new THREE.Mesh(net3Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net3Mesh)
    net3Mesh.updateMatrixWorld(true)

    net1Mesh.updateMatrixWorld(true)

    picker.registerCopperMesh(net1Mesh, 1)
    picker.registerCopperMesh(net2Mesh, 2)
    picker.registerCopperMesh(net3Mesh, 3)

    // R1 pad "1" in scene coords:
    //   raw world X = 9.0875, scene X = 9.0875 - 15 = -5.9125
    //   raw world Y = -10,    scene Y = -10 + 10 = 0
    const r1Pad1SceneX = 9.0875 + boardCenterOffsetX   // -5.9125
    const r1Pad1SceneY = -10 + boardCenterOffsetY        // 0

    // The ortho camera views ±30 in each direction
    const ndc = worldToNDC(r1Pad1SceneX, r1Pad1SceneY, 30, 30)

    const result = picker.raycastFirst(ndc, cam)
    expect(result).not.toBeNull()
    expect(result!.netId).toBe(1)
  })

  it('ray at R2 pad 1 world position hits net 2', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera(30, 30)

    const boardCenterOffsetX = -15
    const boardCenterOffsetY = 10

    const group = new THREE.Group()
    group.position.set(boardCenterOffsetX, boardCenterOffsetY, 1.6)

    const net1Entry = copperMap.get(1)!
    const net1Mesh = new THREE.Mesh(net1Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net1Mesh)

    const net2Entry = copperMap.get(2)!
    const net2Mesh = new THREE.Mesh(net2Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net2Mesh)

    const net3Entry = copperMap.get(3)!
    const net3Mesh = new THREE.Mesh(net3Entry.F!, new THREE.MeshStandardMaterial())
    group.add(net3Mesh)

    group.updateMatrixWorld(true)
    net1Mesh.updateMatrixWorld(true)
    net2Mesh.updateMatrixWorld(true)
    net3Mesh.updateMatrixWorld(true)

    picker.registerCopperMesh(net1Mesh, 1)
    picker.registerCopperMesh(net2Mesh, 2)
    picker.registerCopperMesh(net3Mesh, 3)

    // R2 pad "1" at KiCad (19.0875, 10) → world (19.0875, -10)
    // Scene: X = 19.0875 - 15 = 4.0875, Y = -10 + 10 = 0
    const sceneX = 19.0875 + boardCenterOffsetX  // 4.0875
    const sceneY = -10 + boardCenterOffsetY       // 0

    const ndc = worldToNDC(sceneX, sceneY, 30, 30)
    const result = picker.raycastFirst(ndc, cam)
    expect(result).not.toBeNull()
    expect(result!.netId).toBe(2)
  })
})

// ─── hover event emission ─────────────────────────────────────────────────────

describe('createPicker — hover events', () => {
  it('onPointerMove emits hoverNet when pointer hits a copper mesh', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(5, -5, 4, 4)
    picker.registerCopperMesh(mesh, 7)

    picker.onPointerMove(worldToNDC(5, -5), cam)

    expect(events.length).toBeGreaterThan(0)
    const lastEvent = events[events.length - 1]
    expect(lastEvent.type).toBe('hoverNet')
    if (lastEvent.type === 'hoverNet') {
      expect(lastEvent.netId).toBe(7)
    }
  })

  it('onPointerMove emits clearHover when pointer leaves the mesh', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(5, -5, 4, 4)
    picker.registerCopperMesh(mesh, 7)

    // First hover
    picker.onPointerMove(worldToNDC(5, -5), cam)

    // Move to empty space
    picker.onPointerMove(worldToNDC(-40, -40), cam)

    const clearEvents = events.filter(e => e.type === 'clearHover')
    expect(clearEvents.length).toBeGreaterThan(0)
  })

  it('does not emit duplicate hoverNet for same net', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 10, 10)
    picker.registerCopperMesh(mesh, 3)

    // Move twice within the same mesh area
    picker.onPointerMove(worldToNDC(-1, -1), cam)
    picker.onPointerMove(worldToNDC(1, 1), cam)

    // Should only have 1 hoverNet(3) since the net hasn't changed
    const hoverEvents = events.filter(e => e.type === 'hoverNet')
    expect(hoverEvents.length).toBe(1)
  })

  it('emits hoverNet for new net when pointer moves from one net to another', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh1 = makePlaneMesh(-10, 0, 3, 3)
    const mesh2 = makePlaneMesh( 10, 0, 3, 3)
    picker.registerCopperMesh(mesh1, 1)
    picker.registerCopperMesh(mesh2, 2)

    picker.onPointerMove(worldToNDC(-10, 0), cam)
    picker.onPointerMove(worldToNDC( 10, 0), cam)

    const hoverEvents = events.filter(e => e.type === 'hoverNet')
    expect(hoverEvents.length).toBe(2)
    if (hoverEvents[0].type === 'hoverNet') expect(hoverEvents[0].netId).toBe(1)
    if (hoverEvents[1].type === 'hoverNet') expect(hoverEvents[1].netId).toBe(2)
  })
})

// ─── click events ─────────────────────────────────────────────────────────────

describe('createPicker — click events', () => {
  it('onClick emits clickNet with netId and worldPos', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 6, 6)
    picker.registerCopperMesh(mesh, 5)

    picker.onClick(worldToNDC(0, 0), cam)

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('clickNet')
    if (events[0].type === 'clickNet') {
      expect(events[0].netId).toBe(5)
      expect(events[0].worldPos).toBeDefined()
      expect(events[0].worldPos).toBeInstanceOf(THREE.Vector3)
    }
  })

  it('onClick does not emit when ray misses all objects', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 2, 2)
    picker.registerCopperMesh(mesh, 1)

    picker.onClick(worldToNDC(40, 40), cam)
    expect(events.length).toBe(0)
  })
})

// ─── component box picking ─────────────────────────────────────────────────────

describe('createPicker — component box picking', () => {
  it('onClick on component mesh emits clickComponent with ref', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(10, -10, 4, 2)
    picker.registerComponentBox(mesh, 'R1')

    picker.onClick(worldToNDC(10, -10), cam)

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('clickComponent')
    if (events[0].type === 'clickComponent') {
      expect(events[0].ref).toBe('R1')
    }
  })

  it('onPointerMove on component mesh clears net hover (emits clearHover)', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    // First hover a net
    const copperMesh = makePlaneMesh(-10, 0, 4, 4)
    picker.registerCopperMesh(copperMesh, 1)
    picker.onPointerMove(worldToNDC(-10, 0), cam)

    // Then move over a component
    const compMesh = makePlaneMesh(10, 0, 4, 4)
    picker.registerComponentBox(compMesh, 'U1')
    picker.onPointerMove(worldToNDC(10, 0), cam)

    const clearEvents = events.filter(e => e.type === 'clearHover')
    expect(clearEvents.length).toBeGreaterThan(0)
  })
})

// ─── clearHover ───────────────────────────────────────────────────────────────

describe('createPicker — clearHover', () => {
  it('clearHover emits clearHover event', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 6, 6)
    picker.registerCopperMesh(mesh, 3)

    // Hover first
    picker.onPointerMove(worldToNDC(0, 0), cam)
    events.length = 0  // reset

    picker.clearHover()
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('clearHover')
  })

  it('clearHover is idempotent when nothing is hovered', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))
    picker.clearHover()
    expect(events.length).toBe(0)
  })
})

// ─── emissive boost on hover ──────────────────────────────────────────────────

describe('createPicker — emissive boost on hover', () => {
  it('hovers boost emissive on matching net meshes', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    const mat1 = new THREE.MeshStandardMaterial()
    const mat2 = new THREE.MeshStandardMaterial()

    // Two meshes on the same net 1
    const mesh1 = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat1)
    mesh1.position.set(0, 0, 0)
    mesh1.updateMatrixWorld(true)

    const mesh2 = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat2)
    mesh2.position.set(0, 0, 0.01)  // slightly in front
    mesh2.updateMatrixWorld(true)

    // A mesh on net 2
    const mat3 = new THREE.MeshStandardMaterial()
    const mesh3 = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat3)
    mesh3.position.set(20, 0, 0)
    mesh3.updateMatrixWorld(true)

    picker.registerCopperMesh(mesh1, 1)
    picker.registerCopperMesh(mesh2, 1)  // same net
    picker.registerCopperMesh(mesh3, 2)

    // Hover net 1 by pointing at mesh1
    picker.onPointerMove(worldToNDC(0, 0), cam)

    // Net 1 meshes should have non-zero emissive
    expect(mat1.emissive.r + mat1.emissive.g + mat1.emissive.b).toBeGreaterThan(0)
    expect(mat2.emissive.r + mat2.emissive.g + mat2.emissive.b).toBeGreaterThan(0)
    // Net 2 mesh should have zero emissive
    expect(mat3.emissive.r + mat3.emissive.g + mat3.emissive.b).toBe(0)
  })

  it('clears emissive from all meshes when hover leaves', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    const mat = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), mat)
    mesh.position.set(0, 0, 0)
    mesh.updateMatrixWorld(true)
    picker.registerCopperMesh(mesh, 1)

    // Hover
    picker.onPointerMove(worldToNDC(0, 0), cam)
    expect(mat.emissive.r + mat.emissive.g + mat.emissive.b).toBeGreaterThan(0)

    // Leave
    picker.onPointerMove(worldToNDC(40, 40), cam)
    expect(mat.emissive.r + mat.emissive.g + mat.emissive.b).toBe(0)
  })
})

// ─── clear (board reload) ─────────────────────────────────────────────────────

describe('createPicker — clear on board reload', () => {
  it('clear removes all registered objects so raycasts miss', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 6, 6)
    picker.registerCopperMesh(mesh, 1)

    picker.clear()

    const result = picker.raycastFirst(worldToNDC(0, 0), cam)
    expect(result).toBeNull()
  })

  it('clear emits no clearHover if nothing was hovered', () => {
    const events: PickEvent[] = []
    const picker = createPicker(e => events.push(e))

    const mesh = makePlaneMesh(0, 0, 4, 4)
    picker.registerCopperMesh(mesh, 1)

    // No hover was set
    picker.clear()
    expect(events.filter(e => e.type === 'clearHover').length).toBe(0)
  })

  it('invalidate callback is called on hover state change', () => {
    const invalidate = vi.fn()
    const picker = createPicker(() => {}, invalidate)
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(0, 0, 6, 6)
    picker.registerCopperMesh(mesh, 1)

    picker.onPointerMove(worldToNDC(0, 0), cam)
    expect(invalidate).toHaveBeenCalled()
  })
})

// ─── setExternalHighlight (critic) leaves LED-owned materials alone ────────────

describe('createPicker — setExternalHighlight skips LED materials', () => {
  it('does not zero the emissive of an LED component box while dimming a normal part', () => {
    const picker = createPicker(() => {})

    // An LED box: its material's emissive is driven by ledGlowController (glow).
    const ledMat = new THREE.MeshStandardMaterial()
    ledMat.emissive.setHex(0x884400) // currently "lit" glow
    const ledMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ledMat)
    ledMesh.userData.isLed = true
    picker.registerComponentBox(ledMesh, 'D1')

    // A normal (non-LED) component box.
    const partMat = new THREE.MeshStandardMaterial()
    const partMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), partMat)
    picker.registerComponentBox(partMesh, 'R1')

    // Highlight some OTHER net/ref (neither D1 nor R1 is in refs).
    picker.setExternalHighlight(99, ['U7'])

    // The LED glow must be UNTOUCHED (still lit), not zeroed to black.
    expect(ledMat.emissive.getHex()).toBe(0x884400)
    // The normal non-highlighted part is dimmed (emissive off).
    expect(partMat.emissive.getHex()).toBe(0x000000)
  })
})

// ─── kicadToWorld sanity check ────────────────────────────────────────────────

describe('kicadToWorld sanity for pad positions', () => {
  it('R1 pad 1 KiCad coords convert correctly', () => {
    // Footprint at KiCad (10, 10), pad "1" at local (-0.9125, 0)
    const padKx = 10 + (-0.9125)  // = 9.0875
    const padKy = 10 + 0          // = 10
    const world = kicadToWorld(padKx, padKy)
    expect(world.x).toBeCloseTo(9.0875, 4)
    expect(world.y).toBeCloseTo(-10, 4)
  })

  it('R2 pad 1 KiCad coords convert correctly', () => {
    // Footprint at KiCad (20, 10), pad "1" at local (-0.9125, 0)
    const padKx = 20 + (-0.9125)  // = 19.0875
    const padKy = 10
    const world = kicadToWorld(padKx, padKy)
    expect(world.x).toBeCloseTo(19.0875, 4)
    expect(world.y).toBeCloseTo(-10, 4)
  })
})

// ─── bench lead clamp drops: component-hit pinning test ───────────────────────

describe('raycastFirst — component box path (bench lead clamp drops)', () => {
  it('returns { ref } when the first hit is a registered component box', () => {
    const picker = createPicker(() => {})
    const boxGeo = new THREE.BoxGeometry(10, 10, 2)
    const box = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial())
    box.position.set(0, 0, 0)
    box.updateMatrixWorld(true)
    picker.registerComponentBox(box, 'D1')

    const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
    cam.position.set(0, 0, 100)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)

    const hit = picker.raycastFirst({ x: 0, y: 0 }, cam)
    expect(hit).not.toBeNull()
    expect(hit!.ref).toBe('D1')
    expect(hit!.netId).toBeUndefined()
  })
})

// ─── raycastTargets — occlusion-aware hit-test (Bench Leads net-drop fix) ─────

describe('raycastTargets — returns both net and component under the cursor', () => {
  it('finds the net hit BEHIND a nearer component box, unlike raycastFirst', () => {
    const picker = createPicker(() => {})

    // Copper pad sitting at the board surface (z=0) — the common case: a
    // pad directly under its own component's placeholder body.
    const copper = makePlaneMesh(0, 0, 4, 4)
    picker.registerCopperMesh(copper, 42)

    // Component box directly above the pad, NEARER the camera, same XY.
    const boxGeo = new THREE.BoxGeometry(4, 4, 2)
    const box = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial())
    box.position.set(0, 0, 5) // spans z:[4,6] — above the copper at z=0
    box.updateMatrixWorld(true)
    picker.registerComponentBox(box, 'D1')

    const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
    cam.position.set(0, 0, 200) // above both — sees the box first, then the pad
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)

    // Pin the contrast: raycastFirst only reports the NEAREST hit (the box).
    const nearestOnly = picker.raycastFirst({ x: 0, y: 0 }, cam)
    expect(nearestOnly).not.toBeNull()
    expect(nearestOnly!.ref).toBe('D1')
    expect(nearestOnly!.netId).toBeUndefined()

    // raycastTargets scans the FULL hit list and returns BOTH — this is what
    // lets a net-accepting jack (e.g. a voltage probe) still find the pad.
    const both = picker.raycastTargets({ x: 0, y: 0 }, cam)
    expect(both).not.toBeNull()
    expect(both!.ref).toBe('D1')
    expect(both!.netId).toBe(42)
  })

  it('returns null when the ray misses everything', () => {
    const picker = createPicker(() => {})
    const cam = makeTopDownCamera()

    const mesh = makePlaneMesh(10, -10, 2, 2)
    picker.registerCopperMesh(mesh, 1)

    const ndc = worldToNDC(45, 45)
    expect(picker.raycastTargets(ndc, cam)).toBeNull()
  })
})
