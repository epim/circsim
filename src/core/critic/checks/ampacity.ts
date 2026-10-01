/**
 * core/critic/checks/ampacity.ts
 *
 * Trace-ampacity audit (spec §5). Each track segment is rated against the
 * current it actually carries: the IR-drop check's nodal solve (railGraph.ts)
 * gives every copper edge its current (I = dV/R), and a track is flagged when
 * the current through any piece of it exceeds the IPC-2221 external-layer
 * capacity of its width. A bypass-cap stub therefore sees milliamps and a trace
 * under a pour sees only its share of the pour's current (issue #45); nothing is
 * estimated from a lumped per-rail sum.
 *
 * Needs an operating-point sim (registry `needs:'op'`) that carries branch
 * currents; with none it reports "not assessed" rather than a clean pass. Parts
 * whose current the solve could not resolve, and pads the copper model cannot
 * connect to the supply entry, are named in the not-assessed line, as is a rail
 * that carries current but could not be solved at all. Copper
 * pours are not rated: a pour is a sheet, and its current density is an IR-drop
 * matter, not a fuse-a-trace matter.
 *
 * IPC-2221 external-layer fit (ΔT = 10 °C): Imax = k·ΔT^0.44·A^0.725 with
 * k = 0.048 and A the cross-section in mil². Pure core; deterministic (rails
 * iterated in sorted netId order).
 */

import type { CheckOutput, Finding } from '../types'
import type { CriticContext } from '../context'
import type { TrackSegment, Vec2 } from '../../kicad/types'
import { classifyRails } from '../classify'
import { hasBranchCurrents, railGapNotes, solveRail } from '../railGraph'

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

export function checkAmpacity(ctx: CriticContext): CheckOutput {
  const { board, circuit, opts } = ctx
  if (!hasBranchCurrents(ctx)) {
    return {
      findings: [],
      notAssessed: 'the operating point carries no branch currents to rate the traces against',
    }
  }

  const { powerNetIds, groundNetIds } = classifyRails(circuit, ctx)
  const findings: Finding[] = []
  const notes: string[] = []
  const nets = [
    ...[...powerNetIds].map((id) => ({ id, isGround: false })),
    ...[...groundNetIds].map((id) => ({ id, isGround: true })),
  ].sort((a, b) => a.id - b.id)

  for (const { id: netId, isGround } of nets) {
    const netName = board.netById.get(netId)?.name ?? `net ${netId}`
    notes.push(...railGapNotes(ctx, netId, isGround, netName))
    const sol = solveRail(ctx, netId, isGround)
    if (!sol) continue

    // The current through each board track: the largest of its pieces' currents.
    const carried = new Map<TrackSegment, number>()
    sol.graph.edges.forEach((e, k) => {
      if (e.kind !== 'track' || !e.track) return
      const amps = Math.abs(sol.edgeAmps[k])
      if (Number.isFinite(amps)) carried.set(e.track, Math.max(carried.get(e.track) ?? 0, amps))
    })

    // The worst track by current over rating.
    let worst: { track: TrackSegment; amps: number; imax: number } | undefined
    for (const [track, amps] of carried) {
      const imax = ipcImax(track.widthMm, opts.copperOz)
      if (!(imax > 0) || !Number.isFinite(imax) || amps <= imax) continue
      if (!worst || amps / imax > worst.amps / worst.imax) worst = { track, amps, imax }
    }
    if (!worst) continue

    const { track, amps, imax } = worst
    const severity = amps > 1.5 * imax ? 'error' : 'warn'
    findings.push({
      id: `ampacity:${netId}`,
      check: 'ampacity',
      severity,
      title: `"${netName}" trace (${track.widthMm}mm) may be undersized: ~${imax.toFixed(2)}A rated vs ~${amps.toFixed(2)}A`,
      detail:
        `A ${track.widthMm} mm track on ${netName} is rated for about ${imax.toFixed(2)} A (IPC-2221) ` +
        `but carries about ${amps.toFixed(2)} A at the operating point, by the copper solve. ` +
        `Undersized copper runs hot and can fuse.`,
      assumption:
        'external copper, ΔT 10°C (IPC-2221); each segment is rated against the current the ' +
        'copper solve puts through it (supply entry from the bench lead where one is attached, else guessed; currents from the operating-point solve, ' +
        'pours carry their share); pours are not rated',
      netId,
      location: mid(track.start, track.end),
      suggestion: 'Widen the trace or add copper.',
      metrics: { ratedA: imax, currentA: amps, widthMm: track.widthMm },
    })
  }

  if (notes.length === 0) return findings
  return { findings, notAssessed: `partly assessed: ${notes.join('; ')}` }
}
