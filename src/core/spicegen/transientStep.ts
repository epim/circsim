/**
 * Bound a requested quiet-region step by literal source bandwidth. Generated
 * SIN and PULSE cards use decimal/exponent parameters. ngspice still inserts
 * breakpoints and refines below this ceiling for edges and circuit dynamics.
 */
export function transientMaxStep(requested: number, deck: readonly string[]): number {
  let step = requested
  for (const card of deck) {
    if (!/^[vi]\S*\s+\S+\s+\S+\s+/i.test(card)) continue
    const wave = card.match(/\b(SIN|PULSE)\s*\(([^)]*)\)/i)
    if (!wave) continue
    const params = wave[2].trim().split(/[\s,]+/).map(Number)
    const period = wave[1].toUpperCase() === 'SIN' ? 1 / params[2] : params[6]
    if (Number.isFinite(period) && period > 0) step = Math.min(step, period / 200)
  }
  return step
}
