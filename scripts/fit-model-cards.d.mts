// Type declarations for scripts/fit-model-cards.mjs.
export interface DerivedCard {
  /** SPICE .model type: NPN, PNP or D. */
  type: string
  params: Record<string, number>
}
export const VT: number
export const ASSUMPTIONS: Record<string, string>
export function fitDiodeTwoPoint(
  n: number,
  points: [[number, number], [number, number]]
): { is: number; rs: number }
export function diodeVf(is: number, n: number, rs: number, i: number): number
export function fitLedIs(vf20: number, n: number, rs: number): number
export function deriveDiodes(): Record<string, DerivedCard>
export function deriveLeds(): Record<string, DerivedCard>
export function deriveBjts(): Record<string, DerivedCard>
export function deriveCards(): Record<string, DerivedCard>
export function fmtSpice(x: number): string
export function cardText(name: string, card: DerivedCard): string
