/**
 * ui/voltageRamp.ts - the copper voltage color ramp, shared by the 3D overlay
 * (viewport/overlay.ts) and the on-screen legend (ui/VoltageLegend.tsx) so the
 * strip always matches the board.
 *
 * Issue #70: the old ramp was a raw blue-to-red lerp, which carries almost no
 * information for red-green color-deficient viewers and went through a muddy
 * purple. This is a viridis ramp (violet, blue, teal, green, yellow): its
 * luminance rises monotonically with voltage, so low-to-high stays readable
 * without hue. Pure TypeScript (no Three), so the legend can use it.
 */

/**
 * Viridis samples, low voltage first. The darkest viridis end is dropped so the
 * low end stays visible against a dark board.
 */
export const VOLTAGE_RAMP_STOPS: readonly string[] = [
  '#482878',
  '#3e4989',
  '#31688e',
  '#26828e',
  '#1f9e89',
  '#35b779',
  '#6dcd59',
  '#b4de2c',
  '#fde725',
]

function parseHex(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const STOPS_RGB = VOLTAGE_RAMP_STOPS.map(parseHex)

/** Ramp color at t in [0, 1] (clamped), as 0..255 channels. */
export function voltageRampRgb(t: number): [number, number, number] {
  const c = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0
  const scaled = c * (STOPS_RGB.length - 1)
  const i = Math.min(STOPS_RGB.length - 2, Math.floor(scaled))
  const f = scaled - i
  const a = STOPS_RGB[i]
  const b = STOPS_RGB[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** CSS `linear-gradient` for the legend strip, low voltage on the left. */
export function voltageRampGradient(): string {
  return `linear-gradient(to right, ${VOLTAGE_RAMP_STOPS.join(', ')})`
}
