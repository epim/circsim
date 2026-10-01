/**
 * boardAssembly.test.ts
 *
 * #57: the viewport's draw-call count must not scale with parts, nets, tracks,
 * or silkscreen strings. On the synthetic 1500-part, 20000-track board the
 * pre-fix scene was about 4400 draw calls (one Mesh per net per side, one Mesh
 * and material per footprint box, one troika Text per silkscreen string).
 *
 * A draw call is counted for every visible Mesh, InstancedMesh, Sprite, Line or
 * Points object, the same objects WebGLRenderer issues a draw for. No GL
 * context is needed to count them.
 */

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { assembleBoard } from '../boardAssembly'
import { buildSilkscreenEntries, buildSilkscreenGeometry, type GlyphAtlasLayout } from '../silkscreen'
import { createPicker } from '../picking'
import { kicadToWorld } from '../boardGeometry'
import { padWorldPos } from '../../../../core/critic/geom'
import { makeSyntheticBoard, BIG_BOARD, MID_BOARD } from './syntheticBoard'

/** Number of draw calls a renderer would issue for everything under `roots`. */
function countDrawCalls(...roots: THREE.Object3D[]): number {
  let n = 0
  for (const root of roots) {
    root.traverseVisible(obj => {
      const o = obj as THREE.Object3D & Record<string, unknown>
      if (o.isMesh || o.isSprite || o.isLine || o.isPoints) n++
    })
  }
  return n
}

/** A fixed-metrics glyph layout so silkscreen geometry builds without a canvas. */
const FAKE_ATLAS: GlyphAtlasLayout = {
  quadW: 1.4,
  quadH: 1.4,
  quadBottom: -0.7,
  glyph: ch => (ch.trim() === ''
    ? { u0: 0, u1: 0, v0: 0, v1: 0, advance: 0.35 }
    : { u0: 0, u1: 0.1, v0: 0, v1: 0.1, advance: 0.6 }),
}

function silkscreenMesh(board: ReturnType<typeof makeSyntheticBoard>): THREE.Mesh {
  const geo = buildSilkscreenGeometry(
    buildSilkscreenEntries(board.silkscreen, board.boardThicknessMm),
    FAKE_ATLAS,
  )!
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
}

describe('draw calls (#57)', () => {
  const big = makeSyntheticBoard(BIG_BOARD)
  const mid = makeSyntheticBoard(MID_BOARD)

  it('the synthetic big board has the sizes the issue measured', () => {
    expect(big.footprints.length).toBe(1500)
    expect(big.tracks.length).toBe(20000)
    expect(big.silkscreen.length).toBe(1501)
    expect(big.vias.length).toBe(456)
  })

  it('1500 parts, 20000 tracks, 1501 silkscreen strings render in at most 10 draw calls', () => {
    const a = assembleBoard(big, createPicker(() => {}))
    const calls = countDrawCalls(a.substrateGroup, a.copperGroup, a.componentGroup, silkscreenMesh(big))
    // substrate 1 + copper 2 + vias 1 + boxes 1 + silkscreen 1, plus a little
    // headroom for LEDs (none on this board).
    expect(calls).toBeLessThanOrEqual(10)
  })

  it('draw calls do not grow with board size', () => {
    const aBig = assembleBoard(big, createPicker(() => {}))
    const aMid = assembleBoard(mid, createPicker(() => {}))
    const callsBig = countDrawCalls(aBig.substrateGroup, aBig.copperGroup, aBig.componentGroup, silkscreenMesh(big))
    const callsMid = countDrawCalls(aMid.substrateGroup, aMid.copperGroup, aMid.componentGroup, silkscreenMesh(mid))
    expect(callsBig).toBe(callsMid)
  })

  it('copper is one mesh per side and shares one material', () => {
    const a = assembleBoard(big, createPicker(() => {}))
    const copper: THREE.Mesh[] = []
    a.copperGroup.traverse(o => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) copper.push(o as THREE.Mesh)
    })
    expect(copper.map(m => m.name).sort()).toEqual(['copper-B', 'copper-F'])
    expect(copper[0].material).toBe(copper[1].material)
    // 700 signal nets plus GND and VCC all live in the table
    expect(a.netTints.netIds.length).toBe(702)
  })

  it('every footprint is a box instance; vias are one InstancedMesh', () => {
    const a = assembleBoard(big, createPicker(() => {}))
    const instanced: THREE.InstancedMesh[] = []
    a.componentGroup.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) instanced.push(o as THREE.InstancedMesh) })
    expect(instanced.length).toBe(1)
    expect(instanced[0].count).toBe(1500)
    const vias = a.copperGroup.getObjectByName('vias') as THREE.InstancedMesh
    expect(vias.isInstancedMesh).toBe(true)
    expect(vias.count).toBe(456)
  })

  it('silkscreen is one mesh with a quad per drawn character', () => {
    const mesh = silkscreenMesh(big)
    const expectedGlyphs = big.silkscreen.reduce((n, t) => n + [...t.text].filter(c => c.trim() !== '').length, 0)
    expect(mesh.geometry.getAttribute('position').count).toBe(expectedGlyphs * 4)
    expect(mesh.geometry.getIndex()!.count).toBe(expectedGlyphs * 6)
  })

  it('LEDs keep their own mesh (they own an emissive material) and add one draw call each', () => {
    const board = makeSyntheticBoard(MID_BOARD)
    // Turn three footprints into LEDs.
    for (const fp of board.footprints.slice(2, 5)) {
      fp.ref = `D${fp.ref}`
      fp.value = 'LED'
      fp.libId = 'LED_SMD:LED_0603_1608Metric'
    }
    const base = assembleBoard(mid, createPicker(() => {}))
    const withLeds = assembleBoard(board, createPicker(() => {}))
    expect(withLeds.ledBoxes.length).toBe(3)
    const baseCalls = countDrawCalls(base.substrateGroup, base.copperGroup, base.componentGroup)
    const ledCalls = countDrawCalls(withLeds.substrateGroup, withLeds.copperGroup, withLeds.componentGroup)
    expect(ledCalls).toBe(baseCalls + 3)
  })
})

describe('picking on the assembled synthetic board', () => {
  const board = makeSyntheticBoard(MID_BOARD)
  const picker = createPicker(() => {})
  const a = assembleBoard(board, picker)
  // A render updates world matrices before any pick; do the same here.
  a.componentGroup.updateMatrixWorld(true)
  a.copperGroup.updateMatrixWorld(true)

  // Ortho camera straight down at the whole centered board.
  const cam = new THREE.OrthographicCamera(-60, 60, 50, -50, 0.1, 1000)
  cam.position.set(0, 0, 200)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  const toNdc = (sceneX: number, sceneY: number) => ({ x: sceneX / 60, y: sceneY / 50 })

  it('a ray through the middle of a front-side pad resolves that pad\'s net', () => {
    // A front-side SMD pad on a passive that is not rotated (rotDeg 0).
    const fp = board.footprints.find(f => f.layer === 'F' && f.at.rotDeg === 0 && f.pads.length === 2)!
    const pad = fp.pads[0]
    const p = padWorldPos(fp, pad)
    const w = kicadToWorld(p.x, p.y)
    const hit = picker.raycastFirst(toNdc(w.x - a.center.x, w.y - a.center.y), cam)
    expect(hit).not.toBeNull()
    // The pad's box sits above it, so the nearest hit may be the component; the
    // net is still found along the ray.
    const targets = picker.raycastTargets(toNdc(w.x - a.center.x, w.y - a.center.y), cam)
    expect(targets).not.toBeNull()
    expect(targets!.netId).toBe(pad.netId)
    expect(targets!.ref).toBe(fp.ref)
  })

  it('a ray off the board resolves nothing', () => {
    // Beyond the board edge: no copper, no box.
    expect(picker.raycastTargets(toNdc(59, 49), cam)).toBeNull()
  })
})
