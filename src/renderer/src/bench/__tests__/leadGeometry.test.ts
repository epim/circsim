import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { projectAnchor, projectAnchorSet, leadPath } from '../leadGeometry'

function orthoCam(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  cam.position.set(0, 0, 100)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

describe('projectAnchor', () => {
  it('world origin lands at canvas center', () => {
    const p = projectAnchor(new THREE.Vector3(0, 0, 0), orthoCam(), 800, 600)
    expect(p.px).toBeCloseTo(400, 5)
    expect(p.py).toBeCloseTo(300, 5)
  })
  it('frustum edge lands at the canvas edge (+x → right, +y → up = smaller py)', () => {
    const cam = orthoCam()
    expect(projectAnchor(new THREE.Vector3(50, 0, 0), cam, 800, 600).px).toBeCloseTo(800, 5)
    expect(projectAnchor(new THREE.Vector3(0, 50, 0), cam, 800, 600).py).toBeCloseTo(0, 5)
  })
})

describe('projectAnchorSet', () => {
  it('projects both maps, preserving keys', () => {
    const cam = orthoCam()
    const out = projectAnchorSet(
      new Map([[7, new THREE.Vector3(0, 0, 0)]]),
      new Map([['D1', new THREE.Vector3(50, 0, 0)]]),
      cam, 800, 600,
    )
    expect(out.nets.get(7)!.px).toBeCloseTo(400, 5)
    expect(out.refs.get('D1')!.px).toBeCloseTo(800, 5)
  })
})

describe('leadPath (sag = clamp(0.15·chord, 12, 80), ctrl x at 25%/75%)', () => {
  it('exact path at chord 100 → sag 15', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 100, py: 0 }))
      .toBe('M 0 0 C 25 15, 75 15, 100 0')
  })
  it('short chord clamps sag to 12', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 40, py: 0 }))
      .toBe('M 0 0 C 10 12, 30 12, 40 0')
  })
  it('long chord clamps sag to 80', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 1000, py: 0 }))
      .toBe('M 0 0 C 250 80, 750 80, 1000 0')
  })
  it('sag is monotone in chord length between the clamps', () => {
    const sagOf = (d: number): number => {
      const m = leadPath({ px: 0, py: 0 }, { px: d, py: 0 }).match(/C [\d.-]+ ([\d.-]+),/)
      return Number(m![1])
    }
    expect(sagOf(200)).toBeGreaterThan(sagOf(100))
    expect(sagOf(400)).toBeGreaterThan(sagOf(200))
  })
  it('vertical component: control points drop below the chord (+y)', () => {
    const path = leadPath({ px: 0, py: 100 }, { px: 100, py: 100 })
    expect(path).toBe('M 0 100 C 25 115, 75 115, 100 100')
  })
})
