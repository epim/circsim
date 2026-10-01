/**
 * viewport/netTint.ts
 *
 * Per-net copper color and emissive, kept in a small float texture so that ONE
 * material and ONE mesh per copper side can show every net in its own color
 * (#57). Before this, every net had its own material and mesh, so draw calls
 * scaled with the net count and every tint or hover wrote material.needsUpdate
 * across the whole copper set (#77).
 *
 * Layout: texel 2i holds net index i's color (linear RGB), texel 2i+1 its
 * emissive. The texture is TEX_WIDTH texels wide and as many rows tall as the
 * net count needs. A tint or hover update writes a few floats and flags the
 * texture for upload; it never touches a material, so three.js does not re-run
 * program selection.
 *
 * Shader hookup: copper geometry carries a per-vertex `netIndex` float attribute
 * (see buildCopperLayers). The patched MeshStandardMaterial reads the two texels
 * for that index in the vertex shader and applies them in the fragment shader:
 * color multiplies the diffuse term, emissive adds to the emissive radiance.
 *
 * No Electron or React imports. Constructing the table and the material needs
 * no WebGL context.
 */

import * as THREE from 'three'

/** Texture width in texels. Even, so a color/emissive pair never wraps a row. */
export const NET_TINT_TEX_WIDTH = 1024

/** Program cache key shared by every net-tint material (one compiled program). */
const PROGRAM_KEY = 'circsim-net-tint-v1'

/**
 * Patch a MeshStandardMaterial shader (three r163 chunk names) to read per-net
 * color and emissive from the tint texture. Exported for the unit test, which
 * cannot compile GLSL headlessly but can check the chunks were hooked.
 */
export function patchNetTintShader(
  shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string },
  texture: THREE.Texture,
): void {
  const W = NET_TINT_TEX_WIDTH
  shader.uniforms.netTintTex = { value: texture }

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute float netIndex;
uniform sampler2D netTintTex;
varying vec3 vNetColor;
varying vec3 vNetEmissive;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
{
  int netTexel = int(netIndex + 0.5) * 2;
  vNetColor = texelFetch(netTintTex, ivec2(netTexel % ${W}, netTexel / ${W}), 0).rgb;
  int emTexel = netTexel + 1;
  vNetEmissive = texelFetch(netTintTex, ivec2(emTexel % ${W}, emTexel / ${W}), 0).rgb;
}`,
    )

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying vec3 vNetColor;
varying vec3 vNetEmissive;`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
diffuseColor.rgb *= vNetColor;`,
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
totalEmissiveRadiance += vNetEmissive;`,
    )
}

export class NetTintTable {
  /** netIds[i] is the net whose texels sit at index i (matches the netIndex attribute). */
  readonly netIds: number[]
  readonly texture: THREE.DataTexture

  private readonly indexByNet = new Map<number, number>()
  private readonly data: Float32Array<ArrayBuffer>
  private readonly baseColor = new THREE.Color()

  constructor(netIds: number[], baseColor: THREE.Color) {
    this.netIds = netIds.slice()
    this.baseColor.copy(baseColor)
    netIds.forEach((id, i) => this.indexByNet.set(id, i))

    const texels = Math.max(1, netIds.length * 2)
    const height = Math.max(1, Math.ceil(texels / NET_TINT_TEX_WIDTH))
    this.data = new Float32Array(NET_TINT_TEX_WIDTH * height * 4)
    this.texture = new THREE.DataTexture(
      this.data, NET_TINT_TEX_WIDTH, height, THREE.RGBAFormat, THREE.FloatType,
    )
    this.texture.minFilter = THREE.NearestFilter
    this.texture.magFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.resetColors(baseColor)
    this.resetEmissive()
  }

  /** Index of a net in the netIndex attribute, or undefined for an unknown net. */
  indexOf(netId: number): number | undefined {
    return this.indexByNet.get(netId)
  }

  has(netId: number): boolean {
    return this.indexByNet.has(netId)
  }

  /** Current color of a net (linear RGB), or null for an unknown net. Test and inspection use. */
  getColor(netId: number, out = new THREE.Color()): THREE.Color | null {
    const i = this.indexByNet.get(netId)
    if (i === undefined) return null
    const o = i * 8
    return out.setRGB(this.data[o], this.data[o + 1], this.data[o + 2])
  }

  getEmissive(netId: number, out = new THREE.Color()): THREE.Color | null {
    const i = this.indexByNet.get(netId)
    if (i === undefined) return null
    const o = i * 8 + 4
    return out.setRGB(this.data[o], this.data[o + 1], this.data[o + 2])
  }

  setColor(netId: number, color: THREE.Color): void {
    const i = this.indexByNet.get(netId)
    if (i === undefined) return
    const o = i * 8
    this.data[o] = color.r
    this.data[o + 1] = color.g
    this.data[o + 2] = color.b
    this.data[o + 3] = 1
    this.texture.needsUpdate = true
  }

  setEmissive(netId: number, color: THREE.Color): void {
    const i = this.indexByNet.get(netId)
    if (i === undefined) return
    const o = i * 8 + 4
    this.data[o] = color.r
    this.data[o + 1] = color.g
    this.data[o + 2] = color.b
    this.data[o + 3] = 1
    this.texture.needsUpdate = true
  }

  /** Set every net's color (realistic overlay: the copper base color). */
  resetColors(color: THREE.Color = this.baseColor): void {
    for (let i = 0; i < this.netIds.length; i++) {
      const o = i * 8
      this.data[o] = color.r
      this.data[o + 1] = color.g
      this.data[o + 2] = color.b
      this.data[o + 3] = 1
    }
    this.texture.needsUpdate = true
  }

  resetEmissive(): void {
    for (let i = 0; i < this.netIds.length; i++) {
      const o = i * 8 + 4
      this.data[o] = 0
      this.data[o + 1] = 0
      this.data[o + 2] = 0
      this.data[o + 3] = 1
    }
    this.texture.needsUpdate = true
  }

  /**
   * One shared copper material. Its own `color` stays white because the per-net
   * color from the texture carries the actual tint. Every mesh that uses this
   * table's material must carry the `netIndex` attribute.
   */
  createMaterial(params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ ...params, color: 0xffffff })
    const texture = this.texture
    mat.onBeforeCompile = shader => patchNetTintShader(shader, texture)
    mat.customProgramCacheKey = () => PROGRAM_KEY
    return mat
  }

  dispose(): void {
    this.texture.dispose()
  }
}
