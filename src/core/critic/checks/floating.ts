/**
 * core/critic/checks/floating.ts
 *
 * Floating / dangling connectivity. Promotes the netlist-extraction warnings
 * (floating pads, single-pad nets) into critic findings with 3D locations.
 * No simulation needed.
 *
 * KiCad's intentional `unconnected-(...)` nets are NOT flagged — they are
 * deliberately-unconnected pads, so reporting them would be noise.
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import { padWorldPos } from '../geom'

function padLocation(ctx: CriticContext, ref: string | undefined, pad: string | undefined) {
  if (!ref || !pad) return undefined
  const fp = ctx.refToFootprint.get(ref)
  const p = fp?.pads.find((pd) => pd.number === pad)
  return fp && p ? padWorldPos(fp, p) : undefined
}

export function checkFloating(ctx: CriticContext): Finding[] {
  const findings: Finding[] = []
  // Pads with an empty number (exposed thermal/mechanical pads) would otherwise
  // collide on id and title — disambiguate with a per-ref counter.
  const blankCount = new Map<string, number>()

  for (const w of ctx.circuit.warnings) {
    if (w.kind === 'floating-pad') {
      const named = w.pad !== ''
      const n = (blankCount.get(w.ref) ?? 0) + 1
      if (!named) blankCount.set(w.ref, n)
      findings.push({
        id: named ? `floating:${w.ref}.${w.pad}` : `floating:${w.ref}.#${n}`,
        check: 'floating',
        severity: 'warn',
        title: named
          ? `${w.ref} pad ${w.pad} is not connected to any net`
          : `${w.ref} has an unconnected pad (likely an exposed/thermal or mechanical pad)`,
        detail: named
          ? 'This pad has no copper connection. If it should carry signal or power, ' +
            "it's a missing/unrouted connection; if it's a mechanical or no-connect pad, it's fine."
          : 'An unnumbered pad with no connection — often a QFN/DFN exposed thermal pad, ' +
            'which usually should tie to GND for heat-sinking and a solid reference. ' +
            'Otherwise it may be a mechanical/no-connect pad.',
        refs: [w.ref],
        location: padLocation(ctx, w.ref, w.pad),
        suggestion: named
          ? 'Confirm this pad is intentionally a no-connect.'
          : 'If this is an exposed thermal pad, connect it to GND.',
      })
    } else if (w.kind === 'single-pad-net') {
      // Skip KiCad's intentional unconnected-(...) nets — flagging them is noise.
      if (/^unconnected-/i.test(w.netName)) continue
      findings.push({
        id: `floating:net:${w.netName}`,
        check: 'floating',
        severity: 'info',
        title: `Net "${w.netName}" reaches only one pad`,
        detail:
          'A net connected to a single pad goes nowhere — often a stub, a test point, ' +
          'or a missing connection worth a quick look.',
        refs: w.ref ? [w.ref] : undefined,
        location: padLocation(ctx, w.ref, w.pad),
      })
    }
  }

  return findings
}
