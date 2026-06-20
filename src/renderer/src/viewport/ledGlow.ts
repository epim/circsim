/**
 * viewport/ledGlow.ts
 *
 * LED operating-point glow — pure helpers + a scene-side controller.
 *
 * Scope: DC operating-point glow only. Given a part's real OP current, an LED
 * lights with an emissive channel proportional to current, plus a soft additive
 * halo Sprite above it. Additive over the existing voltage overlay / op
 * annotations — it never mutates copper materials or net tints.
 *
 * Pure pieces (unit-tested, no GL):
 *   isLed(part)            — classify a footprint/refdes as an LED
 *   ledColorFor(part)      — capture an LED color (value/props; default red)
 *   ledIntensity(currentA) — current → [0,1] perceptual intensity
 *
 * Controller (headless-THREE; no WebGL context needed):
 *   createLedGlowController(group) → registers LED meshes, updates emissive +
 *   halo sprites per-frame from intensities.
 *
 * Spec §10.1 (component bodies), additive glow layer.
 */

import * as THREE from 'three'

// ─── current → intensity curve ──────────────────────────────────────────────────

/** Current (A) at which an LED just begins to visibly glow. */
export const LED_I_ON = 0.5e-3
/** Current (A) at which an LED is fully lit. */
export const LED_I_FULL = 15e-3

/**
 * Map an LED's (signed) device current to a perceptual glow intensity in [0,1].
 *
 *   t = clamp((|I| - I_on) / (I_full - I_on), 0, 1)
 *   intensity = t ** 0.5            (gamma 0.5 — perceptual feel)
 *
 * Properties (unit-tested):
 *   - 0 at or below I_on (LEDs near 0 current stay dark)
 *   - 1 at or above I_full
 *   - monotonic non-decreasing in |I| between
 *   - always clamped to [0,1]
 *
 * Pure + side-effect free.
 */
export function ledIntensity(currentA: number): number {
  const i = Math.abs(currentA)
  const span = LED_I_FULL - LED_I_ON
  const t = span <= 0 ? (i >= LED_I_FULL ? 1 : 0) : (i - LED_I_ON) / span
  const clamped = Math.max(0, Math.min(1, t))
  return Math.sqrt(clamped) // gamma 0.5
}

// ─── classification ─────────────────────────────────────────────────────────────

/** Minimal shape needed to classify a part as an LED (footprint or circuit part). */
export interface LedClassifyInput {
  ref: string
  value?: string
  libId?: string
  properties?: Record<string, string>
}

/** Leading-letter refdes prefix: "D1" → "D", "R10" → "R". */
function refPrefix(ref: string): string {
  const m = ref.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/**
 * Classify a part as an LED.
 *
 * True when EITHER:
 *   - refdes is Dx AND its value/libId mentions "LED", OR
 *   - the footprint libId matches an LED_* footprint (e.g. "LED:LED_0805",
 *     "Diode_SMD:LED_0603").
 *
 * Rejects plain resistors (wrong prefix) and rectifier diodes (Dx but no "LED"
 * token anywhere) where distinguishable.
 */
export function isLed(part: LedClassifyInput): boolean {
  const libId = part.libId ?? ''
  // Footprint libId names an LED package (the package portion after ':').
  const pkg = libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId
  if (/^led[_-]/i.test(pkg) || /\bled[_-]/i.test(pkg)) return true

  if (refPrefix(part.ref) !== 'D') return false
  const hay = `${part.value ?? ''} ${libId}`.toUpperCase()
  return hay.includes('LED')
}

// ─── color capture ───────────────────────────────────────────────────────────────

/** Default LED emissive color when none can be inferred (red). */
export const DEFAULT_LED_COLOR = 0xff3030

/**
 * Named LED colors → hex, matched case-insensitively in value/props. The token
 * boundary treats '_' / '-' / whitespace / start / end as separators (so
 * "LED_GREEN" and "Blue LED" both match), unlike \b which sees '_' as a word char.
 */
const SEP = '(?:^|[^a-z])'
const SEP_END = '(?:$|[^a-z])'
function colorRe(words: string): RegExp {
  return new RegExp(`${SEP}(?:${words})${SEP_END}`, 'i')
}
const NAMED_COLORS: { re: RegExp; hex: number }[] = [
  { re: colorRe('red'), hex: 0xff3030 },
  { re: colorRe('green|grn'), hex: 0x30ff40 },
  { re: colorRe('blue|blu'), hex: 0x4060ff },
  { re: colorRe('yellow|ylw'), hex: 0xffd000 },
  { re: colorRe('orange|amber'), hex: 0xff8000 },
  { re: colorRe('white|wht'), hex: 0xffffff },
  { re: colorRe('cyan'), hex: 0x30ffff },
  { re: colorRe('pink'), hex: 0xff60c0 },
]

/**
 * Capture an LED's glow color from its value / properties.
 *
 * Looks for an explicit `Color` property first, then color words in the part
 * value (e.g. "LED_RED", "Green"), then a `#rrggbb` / hex in props. Falls back
 * to DEFAULT_LED_COLOR (red). Returns a THREE color hex number.
 */
export function ledColorFor(part: LedClassifyInput): number {
  const props = part.properties ?? {}
  const explicit = props.Color ?? props.color ?? props.LedColor
  const hay = `${explicit ?? ''} ${part.value ?? ''} ${part.libId ?? ''}`

  // Explicit hex like "#ff8800" or "0xff8800".
  const hex = hay.match(/#([0-9a-f]{6})\b/i) ?? hay.match(/\b0x([0-9a-f]{6})\b/i)
  if (hex) return parseInt(hex[1], 16)

  for (const { re, hex: h } of NAMED_COLORS) {
    if (re.test(hay)) return h
  }
  return DEFAULT_LED_COLOR
}

// ─── halo sprite ─────────────────────────────────────────────────────────────────

/**
 * Build a soft radial-gradient sprite texture (additive halo). White core →
 * transparent edge; tinted per-LED via the sprite material color. Cached so all
 * halos share one texture.
 */
let _haloTexture: THREE.Texture | null = null
function haloTexture(): THREE.Texture {
  if (_haloTexture) return _haloTexture
  // Headless (no document/canvas): use a DataTexture radial gradient instead.
  const size = 64
  const data = new Uint8Array(size * size * 4)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c
      const dy = (y - c) / c
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy))
      const a = Math.max(0, 1 - r)
      const alpha = Math.round(255 * a * a) // soft falloff
      const i = (y * size + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = alpha
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.needsUpdate = true
  _haloTexture = tex
  return tex
}

// ─── controller ──────────────────────────────────────────────────────────────────

/** Base emissive multiplier so a fully-lit LED reads bright without blowing out. */
const MAX_EMISSIVE_INTENSITY = 2.0
/** Halo scale (mm) at full intensity. */
const HALO_FULL_SCALE_MM = 4.0

interface LedRecord {
  material: THREE.MeshStandardMaterial
  halo: THREE.Sprite
  color: THREE.Color
  /** World position above the LED body for the halo anchor. */
  anchor: THREE.Vector3
}

export interface LedGlowController {
  /**
   * Register an LED's body mesh so its emissive channel + halo can be driven.
   * The mesh's material must be a MeshStandardMaterial (emissive-capable).
   * Adds a halo Sprite to `group` anchored just above the LED body.
   */
  registerLed(ref: string, mesh: THREE.Mesh, color: number): void

  /**
   * Set an LED's emissive color + intensity (0..1) and scale its halo.
   * intensity 0 → dark (emissiveIntensity 0, halo hidden).
   * No-op for an unregistered ref.
   */
  updateComponentEmissive(ref: string, intensity: number, color?: number): void

  /** Drive every registered LED from a ref → current(A) map (via ledIntensity). */
  applyCurrents(currentsByRef: Map<string, number>): void

  /** Test/inspection: the emissive material for a ref (or undefined). */
  getMaterial(ref: string): THREE.MeshStandardMaterial | undefined

  /** Test/inspection: the halo sprite for a ref (or undefined). */
  getHalo(ref: string): THREE.Sprite | undefined

  /** Dispose halos + textures and clear the registry. */
  dispose(): void
}

/**
 * Create a controller that owns LED emissive materials + halo sprites.
 *
 * @param group  The THREE.Group halos are added to (usually the component group).
 *               Pass any Object3D in headless tests.
 */
export function createLedGlowController(group: THREE.Object3D): LedGlowController {
  const leds = new Map<string, LedRecord>()

  function registerLed(ref: string, mesh: THREE.Mesh, color: number): void {
    const material = mesh.material as THREE.MeshStandardMaterial
    const col = new THREE.Color(color)
    material.emissive = new THREE.Color(color)
    material.emissiveIntensity = 0

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTexture(),
        color: col.clone(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    // Anchor the halo just above the LED body.
    const anchor = mesh.position.clone()
    halo.position.copy(anchor)
    halo.scale.setScalar(0.0001) // effectively hidden until lit
    group.add(halo)

    leds.set(ref, { material, halo, color: col, anchor })
  }

  function updateComponentEmissive(ref: string, intensity: number, color?: number): void {
    const rec = leds.get(ref)
    if (!rec) return
    const clamped = Math.max(0, Math.min(1, intensity))
    if (color !== undefined) {
      rec.color.set(color)
      rec.material.emissive.set(color)
      ;(rec.halo.material as THREE.SpriteMaterial).color.set(color)
    }
    rec.material.emissiveIntensity = clamped * MAX_EMISSIVE_INTENSITY
    rec.material.needsUpdate = true

    const haloMat = rec.halo.material as THREE.SpriteMaterial
    if (clamped <= 0) {
      haloMat.opacity = 0
      rec.halo.scale.setScalar(0.0001)
    } else {
      haloMat.opacity = clamped
      rec.halo.scale.setScalar(HALO_FULL_SCALE_MM * (0.4 + 0.6 * clamped))
    }
    haloMat.needsUpdate = true
  }

  function applyCurrents(currentsByRef: Map<string, number>): void {
    // Every registered LED updates: those absent from the map go dark.
    for (const ref of leds.keys()) {
      const cur = currentsByRef.get(ref)
      updateComponentEmissive(ref, cur === undefined ? 0 : ledIntensity(cur))
    }
  }

  return {
    registerLed,
    updateComponentEmissive,
    applyCurrents,
    getMaterial: ref => leds.get(ref)?.material,
    getHalo: ref => leds.get(ref)?.halo,
    dispose(): void {
      for (const rec of leds.values()) {
        group.remove(rec.halo)
        ;(rec.halo.material as THREE.SpriteMaterial).dispose()
      }
      leds.clear()
    },
  }
}
