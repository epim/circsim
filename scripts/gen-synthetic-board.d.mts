// Type declarations for scripts/gen-synthetic-board.mjs.
export const FORMAT_VERSIONS: Record<number, number>

export interface SyntheticPad {
  num: string
  x: number
  y: number
  w: number
  h: number
  shape?: string
  type?: 'smd' | 'thru_hole'
  drill?: number
  net?: string
  /** KiCad (pintype ...) text, for example 'unspecified+no_connect' for an intentionally open pin. */
  pintype?: string
}

export interface SyntheticFootprint {
  ref: string
  value: string
  lib: string
  at: { x: number; y: number; rot?: number }
  side: 'F' | 'B'
  pads: SyntheticPad[]
}

export interface SyntheticBoardSpec {
  kicad: 6 | 7 | 8 | 9 | 10
  nets: string[]
  outline?: { x0: number; y0: number; x1: number; y1: number }
  footprints: SyntheticFootprint[]
  tracks?: { net: string; layer: string; width: number; pts: [number, number][] }[]
  vias?: { net: string; x: number; y: number; size?: number; drill?: number }[]
  zones?: { net: string; layer: string; outline: [number, number][] }[]
}

export function rotateKicad(pt: { x: number; y: number }, rotDeg: number): { x: number; y: number }
export function padWorld(fp: SyntheticFootprint, pad: SyntheticPad): { x: number; y: number }
export function generateBoard(spec: SyntheticBoardSpec): string
export function dialectProbe(kicad: number): SyntheticBoardSpec
export function routedRotated(kicad?: number): SyntheticBoardSpec
export function lanternShape(kicad?: number): SyntheticBoardSpec
export const PRESETS: Record<string, (kicad: number) => SyntheticBoardSpec>
export const FIXTURES: [string, string, number][]
export function generatePreset(preset: string, kicad: number): string
