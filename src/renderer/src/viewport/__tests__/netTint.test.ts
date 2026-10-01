/**
 * netTint.test.ts
 *
 * #57/#77: per-net copper color and emissive live in one float texture, so a
 * tint or hover update never touches a material (no material.version bump, so
 * no program re-selection) and one material serves every net.
 *
 * GLSL cannot be compiled headlessly. The shader patch is checked against the
 * real three.js MeshStandard shader source for the chunks it must hook; the
 * compiled result was also verified in a real WebGL context (see the PR).
 */

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { NetTintTable, NET_TINT_TEX_WIDTH, patchNetTintShader } from '../netTint'

const COPPER = new THREE.Color(0xb87333)

function rgb(c: THREE.Color | null): [number, number, number] {
  return [c!.r, c!.g, c!.b]
}

describe('NetTintTable', () => {
  it('starts every net at the base color with zero emissive', () => {
    const t = new NetTintTable([5, 9, 12], COPPER)
    for (const id of [5, 9, 12]) {
      expect(rgb(t.getColor(id))).toEqual([COPPER.r, COPPER.g, COPPER.b].map(Math.fround))
      expect(rgb(t.getEmissive(id))).toEqual([0, 0, 0])
    }
  })

  it('maps net ids to indices in the given order', () => {
    const t = new NetTintTable([5, 9, 12], COPPER)
    expect(t.indexOf(5)).toBe(0)
    expect(t.indexOf(12)).toBe(2)
    expect(t.indexOf(77)).toBeUndefined()
    expect(t.has(9)).toBe(true)
    expect(t.has(10)).toBe(false)
  })

  it('setColor and setEmissive change only that net', () => {
    const t = new NetTintTable([1, 2, 3], COPPER)
    t.setColor(2, new THREE.Color(0x0000ff))
    t.setEmissive(3, new THREE.Color(0x885500))
    expect(t.getColor(2)!.b).toBeCloseTo(1, 5)
    expect(t.getColor(2)!.r).toBeCloseTo(0, 5)
    expect(rgb(t.getColor(1))).toEqual([COPPER.r, COPPER.g, COPPER.b].map(Math.fround))
    expect(rgb(t.getEmissive(2))).toEqual([0, 0, 0])
    expect(t.getEmissive(3)!.r).toBeGreaterThan(0)
  })

  it('ignores unknown nets', () => {
    const t = new NetTintTable([1], COPPER)
    expect(() => t.setColor(99, new THREE.Color(0xff0000))).not.toThrow()
    expect(() => t.setEmissive(99, new THREE.Color(0xff0000))).not.toThrow()
    expect(t.getColor(99)).toBeNull()
  })

  it('resetColors and resetEmissive restore every net', () => {
    const t = new NetTintTable([1, 2], COPPER)
    t.setColor(1, new THREE.Color(0xff0000))
    t.setEmissive(2, new THREE.Color(0x00ff00))
    t.resetColors(COPPER)
    t.resetEmissive()
    expect(rgb(t.getColor(1))).toEqual([COPPER.r, COPPER.g, COPPER.b].map(Math.fround))
    expect(rgb(t.getEmissive(2))).toEqual([0, 0, 0])
  })

  it('stores a color and emissive texel pair per net in a float texture', () => {
    const t = new NetTintTable(Array.from({ length: 1500 }, (_, i) => i), COPPER)
    // 3000 texels at 1024 wide is 3 rows
    expect(t.texture.image.width).toBe(NET_TINT_TEX_WIDTH)
    expect(t.texture.image.height).toBe(3)
    expect(t.texture.type).toBe(THREE.FloatType)
    // Net 1499 lands in the last row, past the first wrap
    t.setColor(1499, new THREE.Color(0x00ff00))
    expect(t.getColor(1499)!.g).toBeCloseTo(1, 5)
  })

  it('flags the texture for upload on a write', () => {
    const t = new NetTintTable([1], COPPER)
    const v = t.texture.version
    t.setColor(1, new THREE.Color(0xff0000))
    expect(t.texture.version).toBeGreaterThan(v)
  })

  it('writes for 1500 nets do not bump any material version (#77)', () => {
    const ids = Array.from({ length: 1500 }, (_, i) => i + 1)
    const t = new NetTintTable(ids, COPPER)
    const mat = t.createMaterial()
    const v = mat.version
    const c = new THREE.Color()
    for (const id of ids) {
      t.setColor(id, c.setHSL(id / 1500, 1, 0.5))
      t.setEmissive(id, c)
    }
    t.resetColors(COPPER)
    t.resetEmissive()
    expect(mat.version).toBe(v)
  })
})

describe('NetTintTable.createMaterial', () => {
  it('returns a white-based standard material so the texture carries the tint', () => {
    const mat = new NetTintTable([1], COPPER).createMaterial({ metalness: 0.9, roughness: 0.3 })
    expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(mat.color.getHex()).toBe(0xffffff)
    expect(mat.metalness).toBeCloseTo(0.9)
    expect(mat.roughness).toBeCloseTo(0.3)
  })

  it('two tables\' materials share one program cache key', () => {
    const a = new NetTintTable([1], COPPER).createMaterial()
    const b = new NetTintTable([2, 3], COPPER).createMaterial()
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
  })

  it('onBeforeCompile hooks the tint texture into the shader', () => {
    const t = new NetTintTable([1, 2], COPPER)
    const mat = t.createMaterial()
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    }
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never)
    expect(shader.uniforms.netTintTex.value).toBe(t.texture)
  })
})

describe('patchNetTintShader', () => {
  const run = () => {
    const tex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType)
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    }
    patchNetTintShader(shader, tex)
    return shader
  }

  it('declares the attribute, sampler and varyings in the vertex shader', () => {
    const { vertexShader } = run()
    expect(vertexShader).toContain('attribute float netIndex;')
    expect(vertexShader).toContain('uniform sampler2D netTintTex;')
    expect(vertexShader).toContain('varying vec3 vNetColor;')
    expect(vertexShader).toContain('varying vec3 vNetEmissive;')
  })

  it('fetches color and emissive texels using the table width', () => {
    const { vertexShader } = run()
    expect(vertexShader).toContain(`netTexel % ${NET_TINT_TEX_WIDTH}`)
    expect(vertexShader).toContain('vNetColor = texelFetch(netTintTex')
    expect(vertexShader).toContain('vNetEmissive = texelFetch(netTintTex')
  })

  it('multiplies diffuse by the net color and adds the net emissive in the fragment shader', () => {
    const { fragmentShader } = run()
    expect(fragmentShader).toContain('varying vec3 vNetColor;')
    expect(fragmentShader).toContain('diffuseColor.rgb *= vNetColor;')
    expect(fragmentShader).toContain('totalEmissiveRadiance += vNetEmissive;')
  })

  it('leaves the original chunk includes in place', () => {
    const { vertexShader, fragmentShader } = run()
    for (const chunk of ['<common>', '<begin_vertex>']) expect(vertexShader).toContain(`#include ${chunk}`)
    for (const chunk of ['<common>', '<color_fragment>', '<emissivemap_fragment>']) {
      expect(fragmentShader).toContain(`#include ${chunk}`)
    }
  })
})
