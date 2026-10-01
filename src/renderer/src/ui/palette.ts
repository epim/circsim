/**
 * ui/palette.ts - shared text colors that meet WCAG 2.1 AA (4.5:1) on every
 * dark surface the renderer uses (#0c0c14 .. #1a1a2e). Issue #70: hints and
 * disabled labels were #555 / #666 (2.3:1 to 3.1:1). Use these tokens instead
 * of ad-hoc greys; ui/__tests__/contrast.test.ts proves the ratios and fails
 * if a sub-AA grey comes back.
 */

/** Hints, empty-state text, counts, disabled labels. */
export const TEXT_HINT = '#9a9aab'
/** Secondary text that is not a hint (units, group labels). */
export const TEXT_MUTED = '#a8a8b8'

/** Dark surfaces the hint colors must clear 4.5:1 against. */
export const DARK_SURFACES = [
  '#0c0c14',
  '#0d1117',
  '#15151f',
  '#181822',
  '#1a1a24',
  '#1a1a2e',
] as const

/** WCAG 2.1 relative luminance of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** WCAG 2.1 contrast ratio between two #rrggbb colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
