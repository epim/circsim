/**
 * core/critic/checks/ampacity.ts
 *
 * Trace-ampacity audit (spec §5). For each power/ground rail it estimates the
 * rail current from the operating-point part currents, then checks the rail's
 * narrowest track against the IPC-2221 external-layer current capacity. A track
 * that can't carry the estimated current is flagged — undersized copper runs
 * hot and can fuse.
 *
 * Needs an operating-point sim (registry `needs:'op'`). Even when one is
 * present its `partCurrents` may be missing — then this check no-ops.
 *
 * IPC-2221 external-layer fit (ΔT = 10 °C): Imax = k·ΔT^0.44·A^0.725 with
 * k = 0.048 and A the cross-section in mil². Pure core; deterministic (rails
 * iterated in sorted netId order).
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { TrackSegment, Vec2 } from '../../kicad/types'
import { classifyRails } from '../classify'

/** IPC-2221 external-layer constant and the ΔT (°C) this check assumes. */
const IPC_K = 0.048
const DELTA_T_C = 10
/** mm → mil. */
const MM_PER_MIL = 0.0254
/** 1 oz copper thickness in mil. */
const OZ_THICKNESS_MIL = 1.378

/** IPC-2221 external-layer current capacity (A) for a track of the given width. */
function ipcImax(widthMm: number, copperOz: number): number {
  const widthMil = widthMm / MM_PER_MIL
  const thicknessMil = copperOz * OZ_THICKNESS_MIL
  const areaMil2 = widthMil * thicknessMil
  return IPC_K * Math.pow(DELTA_T_C, 0.44) * Math.pow(areaMil2, 0.725)
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function checkAmpacity(ctx: CriticContext): Finding[] {
  const { board, circuit, opResult, opts } = ctx
  const partCurrents = opResult?.partCurrents
  if (!partCurrents) return []

  const { powerNetIds, groundNetIds } = classifyRails(circuit, ctx)
  const railNets = new Set<number>([...powerNetIds, ...groundNetIds])

  const findings: Finding[] = []

  for (const netId of [...railNets].sort((a, b) => a - b)) {
    // Estimate rail current: Σ over parts touching the net of |partCurrent| / 2.
    let sumAbs = 0
    for (const part of circuit.parts) {
      let touches = false
      for (const n of part.padNet.values()) {
        if (n === netId) {
          touches = true
          break
        }
      }
      if (!touches) continue
      sumAbs += Math.abs(partCurrents[part.ref] ?? 0)
    }
    const iNet = sumAbs / 2

    // Worst (narrowest / lowest-Imax) track on this net.
    let worst: TrackSegment | undefined
    let worstImax = Infinity
    for (const t of board.tracks) {
      if (t.netId !== netId) continue
      const imax = ipcImax(t.widthMm, opts.copperOz)
      if (imax < worstImax) {
        worstImax = imax
        worst = t
      }
    }
    if (!worst || !isFinite(worstImax)) continue

    if (iNet > worstImax) {
      const netName = board.netById.get(netId)?.name ?? `net ${netId}`
      const severity = iNet > 1.5 * worstImax ? 'error' : 'warn'
      findings.push({
        id: `ampacity:${netId}`,
        check: 'ampacity',
        severity,
        title: `"${netName}" trace (${worst.widthMm}mm) may be undersized: ~${worstImax.toFixed(2)}A rated vs ~${iNet.toFixed(2)}A`,
        detail:
          `The narrowest track on ${netName} is ${worst.widthMm} mm wide, rated for about ` +
          `${worstImax.toFixed(2)} A (IPC-2221), but the estimated rail current is about ` +
          `${iNet.toFixed(2)} A. Undersized copper runs hot and can fuse.`,
        assumption:
          'external copper, ΔT 10°C (IPC-2221); rail current estimated as Σ|part currents|/2',
        netId,
        location: mid(worst.start, worst.end),
        suggestion: 'Widen the trace or add copper.',
        metrics: { ratedA: worstImax, currentA: iNet, widthMm: worst.widthMm },
      })
    }
  }

  return findings
}
