/**
 * viewport/overlay.ts
 *
 * Task 20 — Overlay modes + voltage tinting.
 *
 * API:
 *   createOverlayController(netMaterials) → OverlayController
 *
 * OverlayController:
 *   setOverlay(mode)                  — switch between 'realistic'|'voltage'|'highlight'
 *   applyNetVoltages(voltages,min,max) — in voltage mode, lerp each net's material color
 *                                         blue→red for min→max voltage
 *   getMode()                          — return current mode
 *   getLegend()                        — return legend data (null outside voltage mode)
 *   dispose()                          — restore all materials
 *
 * Performance target (spec §10.3):
 *   applyNetVoltages for 500 nets ≤ 16 ms (pure color-write, no GL).
 *
 * Design:
 *   - Tint targets are abstracted as a NetTintSink. The viewport passes the
 *     NetTintTable (one float texture holding every net's color, #57), so a
 *     tint update is a handful of float writes plus one texture upload.
 *   - A Map of per-net materials is still accepted and adapted; it writes
 *     .color only. Color is a uniform three.js refreshes on every draw, so no
 *     code here sets material.needsUpdate (#77).
 *   - In voltage mode we write each net's color.
 *   - In realistic mode we restore the copper base color.
 *   - Blue (0,0,1) at min voltage, red (1,0,0) at max voltage (spec §10.2).
 *
 * Spec §10.2, §10.3
 */

import * as THREE from 'three'

// ─── colour constants ─────────────────────────────────────────────────────────

/** Copper base color (must match copperGeometry.ts) */
const COPPER_COLOR = new THREE.Color(0xb87333)

/** Voltage overlay: cold = blue (min), hot = red (max) */
const VOLTAGE_COLD = new THREE.Color(0x0000ff)   // blue
const VOLTAGE_HOT  = new THREE.Color(0xff0000)   // red

// ─── types ────────────────────────────────────────────────────────────────────

export type OverlayMode = 'realistic' | 'voltage' | 'highlight'

export interface LegendStop {
  /** Voltage value this stop represents. */
  volts: number
  /** The color at this stop. */
  color: THREE.Color
}

export interface LegendData {
  minVolts: number
  maxVolts: number
  /** Ordered array of stops from min (blue) to max (red). */
  stops: LegendStop[]
}

/** Where the overlay writes per-net colors. NetTintTable implements this. */
export interface NetTintSink {
  /** Set one net's color. Unknown nets are ignored. */
  setColor(netId: number, color: THREE.Color): void
  /** Restore every net to the given color. */
  resetColors(color: THREE.Color): void
}

/** Adapt a Map of per-net materials to a NetTintSink (writes .color only). */
function materialMapSink(netMaterials: Map<number, THREE.MeshStandardMaterial>): NetTintSink {
  return {
    setColor(netId, color) {
      netMaterials.get(netId)?.color.copy(color)
    },
    resetColors(color) {
      for (const mat of netMaterials.values()) mat.color.copy(color)
    },
  }
}

export interface OverlayController {
  /**
   * Switch overlay mode.
   *
   * 'realistic'  — copper base color restored
   * 'voltage'    — per-net color lerp driven by applyNetVoltages
   * 'highlight'  — reserved for per-net selection highlight (materials untouched here;
   *               the picking controller handles emissive; realistic colors kept)
   */
  setOverlay(mode: OverlayMode): void

  /** Apply per-net voltage tinting. Only has visual effect in 'voltage' mode. */
  applyNetVoltages(voltages: Map<number, number>, minVolts: number, maxVolts: number): void

  /** Current overlay mode. */
  getMode(): OverlayMode

  /**
   * Legend data for the UI to display.
   * Returns null when not in voltage mode, or before applyNetVoltages has been called.
   */
  getLegend(): LegendData | null

  /** Dispose: restore all material colors (call on board unload). */
  dispose(): void
}

// ─── legend builder ───────────────────────────────────────────────────────────

const LEGEND_STOP_COUNT = 5

function buildLegend(minVolts: number, maxVolts: number): LegendData {
  const stops: LegendStop[] = []
  for (let i = 0; i < LEGEND_STOP_COUNT; i++) {
    const t = i / (LEGEND_STOP_COUNT - 1)
    const volts = minVolts + t * (maxVolts - minVolts)
    const color = new THREE.Color().lerpColors(VOLTAGE_COLD, VOLTAGE_HOT, t)
    stops.push({ volts, color })
  }
  return { minVolts, maxVolts, stops }
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Create an OverlayController.
 *
 * @param target  The net tint table (scene.ts), or a Map from netId to that net's
 *                MeshStandardMaterial.
 */
export function createOverlayController(
  target: NetTintSink | Map<number, THREE.MeshStandardMaterial>
): OverlayController {
  const sink: NetTintSink = target instanceof Map ? materialMapSink(target) : target
  let mode: OverlayMode = 'realistic'
  let legend: LegendData | null = null

  // ── internal helpers ────────────────────────────────────────────────────────

  /** Restore all net materials to the copper base color. */
  function restoreCopper(): void {
    sink.resetColors(COPPER_COLOR)
  }

  // ── public API ──────────────────────────────────────────────────────────────

  return {
    setOverlay(newMode: OverlayMode): void {
      mode = newMode
      if (mode === 'realistic' || mode === 'highlight') {
        restoreCopper()
        legend = null
      }
      // In 'voltage' mode: don't change colors until applyNetVoltages is called
    },

    applyNetVoltages(
      voltages: Map<number, number>,
      minVolts: number,
      maxVolts: number
    ): void {
      // Always update legend regardless of mode so callers can pre-compute it
      legend = buildLegend(minVolts, maxVolts)

      if (mode !== 'voltage') return

      // Avoid division by zero when min === max
      const range = maxVolts - minVolts
      const safeRange = range === 0 ? 1 : range

      // Reuse a single Color instance to avoid GC pressure in the hot loop
      const col = new THREE.Color()

      for (const [netId, volts] of voltages) {
        // Clamp t to [0, 1]
        const t = Math.max(0, Math.min(1, (volts - minVolts) / safeRange))

        // Lerp blue → red
        col.lerpColors(VOLTAGE_COLD, VOLTAGE_HOT, t)
        sink.setColor(netId, col)
      }
    },

    getMode(): OverlayMode {
      return mode
    },

    getLegend(): LegendData | null {
      if (mode !== 'voltage') return null
      return legend
    },

    dispose(): void {
      restoreCopper()
      legend = null
    },
  }
}
