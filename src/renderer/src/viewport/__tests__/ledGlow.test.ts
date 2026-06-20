/**
 * ledGlow.test.ts — LED operating-point glow
 *
 * Headless THREE (no WebGL): MeshStandardMaterial / Sprite / DataTexture all
 * construct fine in Node. We test the pure intensity curve + classifier + the
 * controller's emissive/halo wiring without a GL context.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  ledIntensity,
  isLed,
  ledColorFor,
  createLedGlowController,
  DEFAULT_LED_COLOR,
  LED_I_ON,
  LED_I_FULL,
  type LedGlowController,
} from '../ledGlow'

// ─── ledIntensity curve ─────────────────────────────────────────────────────────

describe('ledIntensity', () => {
  it('is 0 at or below I_on', () => {
    expect(ledIntensity(0)).toBe(0)
    expect(ledIntensity(LED_I_ON)).toBe(0)
    expect(ledIntensity(LED_I_ON * 0.5)).toBe(0)
    expect(ledIntensity(-LED_I_ON)).toBe(0) // uses |I|
  })

  it('is 1 at or above I_full', () => {
    expect(ledIntensity(LED_I_FULL)).toBe(1)
    expect(ledIntensity(LED_I_FULL * 2)).toBe(1)
    expect(ledIntensity(-LED_I_FULL)).toBe(1) // sign-independent
  })

  it('is monotonic non-decreasing between I_on and I_full', () => {
    let prev = -1
    for (let i = LED_I_ON; i <= LED_I_FULL; i += (LED_I_FULL - LED_I_ON) / 50) {
      const v = ledIntensity(i)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('is always clamped to [0,1]', () => {
    for (const i of [-1, -0.02, 0, 1e-6, 5e-3, 0.02, 1, 1e6]) {
      const v = ledIntensity(i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('applies gamma 0.5 (mid current lifts perceptually)', () => {
    const mid = (LED_I_ON + LED_I_FULL) / 2 // linear t = 0.5
    expect(ledIntensity(mid)).toBeCloseTo(Math.sqrt(0.5), 5)
  })
})

// ─── isLed classifier ───────────────────────────────────────────────────────────

describe('isLed', () => {
  it('matches an LED footprint + refdes', () => {
    expect(isLed({ ref: 'D1', value: 'LED', libId: 'LED:LED_0805' })).toBe(true)
    expect(isLed({ ref: 'D7', value: 'RED', libId: 'Diode_SMD:LED_0603' })).toBe(true)
  })

  it('matches a footprint whose package is LED_* even without a value hint', () => {
    expect(isLed({ ref: 'D3', value: '', libId: 'LED_SMD:LED_0402' })).toBe(true)
  })

  it('rejects a plain resistor', () => {
    expect(isLed({ ref: 'R1', value: '10k', libId: 'Resistor_SMD:R_0402' })).toBe(false)
  })

  it('rejects a rectifier diode (Dx but no LED token)', () => {
    expect(isLed({ ref: 'D2', value: '1N4148', libId: 'Diode_SMD:D_SOD-123' })).toBe(false)
  })
})

// ─── ledColorFor ────────────────────────────────────────────────────────────────

describe('ledColorFor', () => {
  it('defaults to red', () => {
    expect(ledColorFor({ ref: 'D1', value: 'LED' })).toBe(DEFAULT_LED_COLOR)
  })

  it('reads a named color from the value', () => {
    expect(ledColorFor({ ref: 'D1', value: 'LED_GREEN' })).toBe(0x30ff40)
    expect(ledColorFor({ ref: 'D2', value: 'Blue LED' })).toBe(0x4060ff)
  })

  it('reads an explicit hex from props', () => {
    expect(ledColorFor({ ref: 'D1', value: 'LED', properties: { Color: '#ff8800' } })).toBe(0xff8800)
  })
})

// ─── controller: emissive + halo ────────────────────────────────────────────────

describe('createLedGlowController', () => {
  let group: THREE.Group
  let ctrl: LedGlowController

  function makeLedMesh(): THREE.Mesh {
    const mat = new THREE.MeshStandardMaterial({ color: 0x888888 })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    mesh.position.set(2, 3, 1)
    return mesh
  }

  beforeEach(() => {
    group = new THREE.Group()
    ctrl = createLedGlowController(group)
  })

  it('registerLed adds a halo sprite to the group and sets emissive color', () => {
    const before = group.children.length
    ctrl.registerLed('D1', makeLedMesh(), 0xff3030)
    expect(group.children.length).toBe(before + 1)
    const mat = ctrl.getMaterial('D1')!
    expect(mat.emissive.getHex()).toBe(0xff3030)
    expect(mat.emissiveIntensity).toBe(0) // dark until lit
    expect(ctrl.getHalo('D1')).toBeInstanceOf(THREE.Sprite)
  })

  it('updateComponentEmissive sets emissiveIntensity and scales/shows the halo', () => {
    ctrl.registerLed('D1', makeLedMesh(), 0xff3030)
    const halo = ctrl.getHalo('D1')!
    const darkScale = halo.scale.x

    ctrl.updateComponentEmissive('D1', 1, 0x30ff40)
    const mat = ctrl.getMaterial('D1')!
    expect(mat.emissiveIntensity).toBeGreaterThan(0)
    expect(mat.emissive.getHex()).toBe(0x30ff40) // recolored
    // Halo grows + becomes opaque when lit.
    expect(halo.scale.x).toBeGreaterThan(darkScale)
    expect((halo.material as THREE.SpriteMaterial).opacity).toBeGreaterThan(0)
  })

  it('intensity 0 keeps the LED dark and the halo hidden', () => {
    ctrl.registerLed('D1', makeLedMesh(), 0xff3030)
    ctrl.updateComponentEmissive('D1', 1)
    ctrl.updateComponentEmissive('D1', 0)
    expect(ctrl.getMaterial('D1')!.emissiveIntensity).toBe(0)
    expect((ctrl.getHalo('D1')!.material as THREE.SpriteMaterial).opacity).toBe(0)
  })

  it('applyCurrents lights LEDs by current and darkens absent ones', () => {
    ctrl.registerLed('D1', makeLedMesh(), 0xff3030)
    ctrl.registerLed('D2', makeLedMesh(), 0xff3030)
    ctrl.updateComponentEmissive('D2', 1) // pre-light D2
    ctrl.applyCurrents(new Map([['D1', LED_I_FULL]]))
    expect(ctrl.getMaterial('D1')!.emissiveIntensity).toBeGreaterThan(0)
    // D2 absent from the map → goes dark.
    expect(ctrl.getMaterial('D2')!.emissiveIntensity).toBe(0)
  })

  it('updateComponentEmissive is a no-op for an unregistered ref', () => {
    expect(() => ctrl.updateComponentEmissive('D9', 1)).not.toThrow()
  })
})
