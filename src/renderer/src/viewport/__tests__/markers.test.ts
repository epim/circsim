/**
 * markers.test.ts — Task 20
 *
 * Tests for markers.ts:
 *   - Probe flags + instrument badges as screen-space sprites
 *   - showOpAnnotations: net voltage labels
 *   - Declutter logic: hide labels < 24 px apart at current zoom
 *
 * No WebGL context required: we test the declutter math and annotation
 * data structures purely (THREE.Vector3/Matrix4 work headlessly in Node).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  createMarkerController,
  type MarkerController,
  type ProbeMarker,
  type AnnotationLabel,
} from '../markers'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal orthographic camera looking down the Z axis. */
function makeOrthoCamera(zoom = 1): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  cam.position.set(0, 0, 100)
  cam.zoom = zoom
  cam.updateProjectionMatrix()
  cam.lookAt(0, 0, 0)
  return cam
}

// ── probe marker tests ────────────────────────────────────────────────────────

describe('MarkerController — probe markers', () => {
  let markers: MarkerController

  beforeEach(() => {
    markers = createMarkerController()
  })

  it('addProbeMarker returns a marker id', () => {
    const id = markers.addProbeMarker({
      worldPos: new THREE.Vector3(0, 0, 0),
      color: '#ff0000',
      label: 'VIN',
      netId: 1,
    })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('getProbeMarkers returns added markers', () => {
    markers.addProbeMarker({
      worldPos: new THREE.Vector3(1, 2, 0),
      color: '#00ff00',
      label: 'OUT',
      netId: 2,
    })
    markers.addProbeMarker({
      worldPos: new THREE.Vector3(5, 5, 0),
      color: '#0000ff',
      label: 'GND',
      netId: 3,
    })
    expect(markers.getProbeMarkers().length).toBe(2)
  })

  it('removeProbeMarker removes by id', () => {
    const id = markers.addProbeMarker({
      worldPos: new THREE.Vector3(0, 0, 0),
      color: '#ff0000',
      label: 'VIN',
      netId: 1,
    })
    markers.removeProbeMarker(id)
    expect(markers.getProbeMarkers().length).toBe(0)
  })

  it('clearProbeMarkers removes all', () => {
    markers.addProbeMarker({ worldPos: new THREE.Vector3(0,0,0), color: '#f00', label: 'A', netId: 1 })
    markers.addProbeMarker({ worldPos: new THREE.Vector3(1,1,0), color: '#0f0', label: 'B', netId: 2 })
    markers.clearProbeMarkers()
    expect(markers.getProbeMarkers().length).toBe(0)
  })

  it('probe marker color matches the probe color', () => {
    markers.addProbeMarker({
      worldPos: new THREE.Vector3(0, 0, 0),
      color: '#ff6600',
      label: 'NET',
      netId: 5,
    })
    const probe = markers.getProbeMarkers()[0] as ProbeMarker
    expect(probe.color).toBe('#ff6600')
  })
})

// ── op annotation tests ───────────────────────────────────────────────────────

describe('MarkerController — showOpAnnotations', () => {
  let markers: MarkerController

  beforeEach(() => {
    markers = createMarkerController()
  })

  it('showOpAnnotations creates one label per net with voltages', () => {
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
      [2, new THREE.Vector3(10, 0, 0)],
      [3, new THREE.Vector3(20, 0, 0)],
    ])
    const voltages = new Map<number, number>([[1, 5.0], [2, 2.5], [3, 0.0]])

    markers.showOpAnnotations(voltages, netPositions)

    const labels = markers.getAnnotationLabels()
    expect(labels.length).toBe(3)
  })

  it('label text includes voltage value', () => {
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
    ])
    const voltages = new Map<number, number>([[1, 3.14]])

    markers.showOpAnnotations(voltages, netPositions)

    const labels = markers.getAnnotationLabels()
    expect(labels[0].text).toContain('3.14')
  })

  it('clearOpAnnotations removes all labels', () => {
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
    ])
    markers.showOpAnnotations(new Map([[1, 5]]), netPositions)
    markers.clearOpAnnotations()
    expect(markers.getAnnotationLabels().length).toBe(0)
  })

  it('labels without a position entry are skipped', () => {
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
      // net 2 has no position
    ])
    const voltages = new Map<number, number>([[1, 5], [2, 2.5]])

    markers.showOpAnnotations(voltages, netPositions)
    const labels = markers.getAnnotationLabels()
    // Only net 1 has a position, net 2 should be skipped
    expect(labels.length).toBe(1)
  })
})

// ── declutter tests ───────────────────────────────────────────────────────────

describe('MarkerController — declutter logic', () => {
  it('getVisibleAnnotations hides labels that project < 24 px apart', () => {
    const markers = createMarkerController()

    // Camera: ortho, zoom=1, 100×100 px canvas
    // Two labels at almost the same world position → will project within 24 px
    const cam = makeOrthoCamera(1)
    const canvasW = 100
    const canvasH = 100

    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
      [2, new THREE.Vector3(0.001, 0, 0)],   // effectively same screen position
    ])
    markers.showOpAnnotations(new Map([[1, 5.0], [2, 2.5]]), netPositions)

    const visible = markers.getVisibleAnnotations(cam, canvasW, canvasH)
    // Both project to nearly the same pixel → second one hidden
    expect(visible.length).toBeLessThan(2)
    expect(visible.length).toBeGreaterThanOrEqual(1)
  })

  it('getVisibleAnnotations shows labels that are ≥ 24 px apart', () => {
    const markers = createMarkerController()

    // Ortho camera: left=-50, right=50, top=50, bot=-50 → 1 world unit ≈ 1 px at zoom=1 for 100px canvas
    // So 30 world units apart → 30 px apart → both visible
    const cam = makeOrthoCamera(1)
    const canvasW = 100
    const canvasH = 100

    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(-15, 0, 0)],   // -15 world → -15px offset → screen pixel ~35
      [2, new THREE.Vector3( 15, 0, 0)],   //  15 world →  15px offset → screen pixel ~65
    ])
    markers.showOpAnnotations(new Map([[1, 5.0], [2, 2.5]]), netPositions)

    const visible = markers.getVisibleAnnotations(cam, canvasW, canvasH)
    expect(visible.length).toBe(2)
  })

  it('getVisibleAnnotations: first label always shown when others are close', () => {
    const markers = createMarkerController()
    const cam = makeOrthoCamera(1)

    // Three labels all at the same position
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(0, 0, 0)],
      [2, new THREE.Vector3(0, 0, 0)],
      [3, new THREE.Vector3(0, 0, 0)],
    ])
    markers.showOpAnnotations(new Map([[1, 5], [2, 2.5], [3, 0]]), netPositions)

    const visible = markers.getVisibleAnnotations(cam, 100, 100)
    // At least 1 must be visible (the first one shown)
    expect(visible.length).toBeGreaterThanOrEqual(1)
    // But not all 3 (they're all at the same point)
    expect(visible.length).toBeLessThan(3)
  })

  it('getVisibleAnnotations respects zoom level: higher zoom → labels farther apart in px', () => {
    const markers = createMarkerController()

    // At zoom=1: two labels 10 world units apart → might be <24 px at low canvas res
    // At zoom=4: 10 world units → 4× more pixels → definitely >24 px
    const netPositions = new Map<number, THREE.Vector3>([
      [1, new THREE.Vector3(-5, 0, 0)],
      [2, new THREE.Vector3( 5, 0, 0)],
    ])
    markers.showOpAnnotations(new Map([[1, 5], [2, 2.5]]), netPositions)

    // At zoom=1, 100×100 canvas: orthographic -50..50 → 10 world units = 10 px → <24 px → only 1 visible
    const camLow = makeOrthoCamera(1)
    const lowVisible = markers.getVisibleAnnotations(camLow, 100, 100)

    // At zoom=4, 100×100 canvas: effective world range is -12.5..12.5 → 10 world units = ~40 px → >24 px → both visible
    const camHigh = makeOrthoCamera(4)
    const highVisible = markers.getVisibleAnnotations(camHigh, 100, 100)

    expect(highVisible.length).toBeGreaterThan(lowVisible.length)
  })
})

// ── annotation label structure ────────────────────────────────────────────────

describe('AnnotationLabel structure', () => {
  it('has worldPos, text, netId', () => {
    const markers = createMarkerController()
    const pos = new THREE.Vector3(1, 2, 0)
    markers.showOpAnnotations(new Map([[7, 3.3]]), new Map([[7, pos]]))

    const labels = markers.getAnnotationLabels()
    expect(labels.length).toBe(1)

    const label = labels[0] as AnnotationLabel
    expect(label.netId).toBe(7)
    expect(label.worldPos).toBeDefined()
    expect(label.text).toBeDefined()
  })
})
