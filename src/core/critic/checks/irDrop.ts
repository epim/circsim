/**
 * core/critic/checks/irDrop.ts
 *
 * IR-drop (rail-sag) audit (spec §5 item 4). For each power rail it solves the
 * rail's copper (railGraph.ts: tracks, vias, copper pours and pads as a
 * resistive graph) with the operating point's branch currents injected at the
 * load pads, and reports the worst supply-entry-to-load sag as a percentage of
 * the rail's op-solved nominal voltage. The ground return is solved the same
 * way: each load's return current enters the ground copper at its ground pad
 * and the rise above the return entry is the ground shift. A load's round-trip
 * drop is its supply sag plus its ground rise.
 *
 * Needs an operating-point sim (registry `needs:'op'`) that carries branch
 * currents (OpResult.padCurrents, built by deriveSolvedCurrents from the solve;
 * a bare partCurrents map is still read, sinking each part's current on its
 * power pads and returning it on its ground pads). With no currents at all the
 * check reports "not assessed". Parts whose current the solve could not resolve
 * and pads the copper model does not connect to the supply entry are named in
 * the not-assessed line: they are never silently counted as zero.
 *
 * Supply-entry heuristic (the OpResult does not identify which pad the bench
 * supply is attached to; see issue #47):
 *   1. a pad on the rail belonging to a connector-like ref (J1/P1/CN1/CON1/X1);
 *   2. else the pad attached to the rail's widest incident track;
 *   3. else the first pad in (ref, pad-number) order that touches copper.
 *
 * Never throws: a rail whose copper cannot be solved yields no finding for that
 * rail. Pure core; deterministic (rails and parts iterated in sorted order).
 */

import type { CheckOutput, Finding, Severity } from '../types'
import type { CriticContext } from '../context'
import { classifyRails } from '../classify'
import {
  hasBranchCurrents,
  minResistancePath,
  solveRail,
  viaResistanceOhms,
  type GraphEdge,
  type RailLoad,
  type RailSolution,
} from '../railGraph'

/** Rails whose |nominal| is below this (V) can't express a % sag, so are skipped. */
const MIN_NOMINAL_V = 0.05

interface Headline {
  /** mm of track and of pour along the worst path, and its narrowest track. */
  trackMm: number
  pourMm: number
  minWidthMm?: number
  across: string
}

function pathHeadline(path: GraphEdge[]): Headline {
  let trackMm = 0
  let pourMm = 0
  let minWidthMm: number | undefined
  for (const e of path) {
    if (e.kind === 'track') {
      trackMm += e.lengthMm
      if (e.widthMm !== undefined) minWidthMm = Math.min(minWidthMm ?? Infinity, e.widthMm)
    } else if (e.kind === 'pour') {
      pourMm += e.lengthMm
    }
  }
  const parts: string[] = []
  if (trackMm > 0 && minWidthMm !== undefined) parts.push(`${trackMm.toFixed(0)} mm of ${minWidthMm} mm track`)
  if (pourMm > 0) parts.push(`${pourMm.toFixed(0)} mm of pour`)
  return { trackMm, pourMm, minWidthMm, across: parts.length > 0 ? ` across ${parts.join(' and ')}` : '' }
}

function padName(l: RailLoad): string {
  return `${l.pad.ref}.${l.pad.padNumber}`
}

export function checkIrDrop(ctx: CriticContext): CheckOutput {
  const { board, circuit, opResult, opts } = ctx
  if (!hasBranchCurrents(ctx)) {
    return {
      findings: [],
      notAssessed: 'the operating point carries no branch currents to inject into the copper',
    }
  }
  const nodeVoltages = opResult?.nodeVoltages ?? {}
  const { powerNetIds, groundNetIds } = classifyRails(circuit, ctx)
  const netName = (id: number): string => board.netById.get(id)?.name ?? `net ${id}`
  const nominalOf = (id: number): number | undefined => {
    const net = circuit.nets.find((n) => n.id === id)
    const v = net ? nodeVoltages[net.spiceNode] : undefined
    return v !== undefined && Number.isFinite(v) && Math.abs(v) >= MIN_NOMINAL_V ? v : undefined
  }

  const findings: Finding[] = []
  const notes: string[] = []
  const severityFor = (pct: number): Severity | undefined =>
    pct <= opts.irDropWarnPct ? undefined : pct > opts.irDropErrPct ? 'error' : 'warn'

  // The supply scale ground shift is judged against: the highest rail in play.
  let supplyV = 0
  for (const id of powerNetIds) supplyV = Math.max(supplyV, Math.abs(nominalOf(id) ?? 0))

  // ── ground return: rise above the return entry, per load ───────────────────
  const groundRiseByRef = new Map<string, number>()
  for (const gid of [...groundNetIds].sort((a, b) => a - b)) {
    const sol = solveRail(ctx, gid, true)
    if (!sol) continue
    noteGaps(notes, sol, netName(gid))
    let worst: { load: RailLoad; riseV: number } | undefined
    for (const l of sol.loads) {
      const riseV = Math.max(0, sol.volts[l.pad.node])
      if (!Number.isFinite(riseV)) continue
      groundRiseByRef.set(l.pad.ref, Math.max(groundRiseByRef.get(l.pad.ref) ?? 0, riseV))
      if (!worst || riseV > worst.riseV) worst = { load: l, riseV }
    }
    if (!worst || supplyV <= 0) continue
    const pct = (100 * worst.riseV) / supplyV
    const severity = severityFor(pct)
    if (!severity) continue
    const head = pathHeadline(minResistancePath(sol, worst.load.pad.node))
    findings.push({
      id: `ir-drop:${gid}`,
      check: 'ir-drop',
      severity,
      title: `"${netName(gid)}" return rises to ${worst.riseV.toFixed(2)} V at ${worst.load.pad.ref} (${pct.toFixed(1)}% of ${supplyV.toFixed(2)} V${head.across})`,
      detail:
        `The return current of ${worst.load.pad.ref} lifts ${netName(gid)} by about ${worst.riseV.toFixed(3)} V ` +
        `(${pct.toFixed(1)}% of the ${supplyV.toFixed(2)} V supply) between the return entry at ` +
        `${sol.source.ref} pad ${sol.source.padNumber} and ${worst.load.pad.ref} pad ${worst.load.pad.padNumber}` +
        (head.across ? `, over a path${head.across}.` : '.') +
        ' Ground shift moves analog references and logic thresholds by the same amount.',
      assumption: assumptionFor(ctx, sol, 'return'),
      refs: [worst.load.pad.ref],
      netId: gid,
      location: worst.load.pad.pos,
      suggestion: suggestionFor(sol, head),
      metrics: {
        dropV: worst.riseV,
        sagPct: pct,
        nominalV: supplyV,
        totalSinkA: sol.loadAmps,
        pathLengthMm: head.trackMm + head.pourMm,
        ...(head.minWidthMm !== undefined ? { minTrackWidthMm: head.minWidthMm } : {}),
      },
    })
  }

  // ── power rails: supply sag, plus the ground rise at the same load ─────────
  for (const railId of [...powerNetIds].sort((a, b) => a - b)) {
    // Nominal rail voltage from the op solve (the sim treats the whole net as one
    // node, i.e. the voltage at the supply entry). Without it a % sag is
    // undefined: skip rather than invent a number.
    const nominal = nominalOf(railId)
    if (nominal === undefined) continue
    const sol = solveRail(ctx, railId, false)
    if (!sol) continue
    noteGaps(notes, sol, netName(railId))
    if (sol.loadAmps < 1e-9) continue

    // Sag toward 0 V: a +5 V rail falls below the entry, a -12 V rail rises above it.
    const dir = nominal >= 0 ? -1 : 1
    let worst: { load: RailLoad; sagV: number; riseV: number; totalV: number } | undefined
    for (const l of sol.loads) {
      const sagV = Math.max(0, dir * sol.volts[l.pad.node])
      if (!Number.isFinite(sagV)) continue
      const riseV = groundRiseByRef.get(l.pad.ref) ?? 0
      const totalV = sagV + riseV
      if (!worst || totalV > worst.totalV) worst = { load: l, sagV, riseV, totalV }
    }
    if (!worst) continue

    const sagPct = (100 * worst.totalV) / Math.abs(nominal)
    const severity = severityFor(sagPct)
    if (!severity) continue

    const pad = worst.load.pad
    const head = pathHeadline(minResistancePath(sol, pad.node))
    const sinkV = nominal >= 0 ? nominal - worst.totalV : nominal + worst.totalV
    const roundTrip =
      worst.riseV > 0 ? ` (${worst.sagV.toFixed(3)} V on the supply, ${worst.riseV.toFixed(3)} V on the return)` : ''

    findings.push({
      id: `ir-drop:${railId}`,
      check: 'ir-drop',
      severity,
      title: `"${netName(railId)}" rail sags to ${sinkV.toFixed(2)}V at ${pad.ref} (${worst.totalV.toFixed(2)} V drop${head.across})`,
      detail:
        `Copper resistance on ${netName(railId)} drops about ${worst.totalV.toFixed(3)} V ` +
        `(${sagPct.toFixed(1)}% of the ${nominal.toFixed(2)} V rail) between the supply entry ` +
        `at ${sol.source.ref} pad ${sol.source.padNumber} and ${pad.ref} pad ${pad.padNumber}${roundTrip}, ` +
        `with the rail carrying ~${sol.loadAmps.toFixed(2)} A of op-point load` +
        (head.across ? `, and the worst path runs${head.across}.` : '.') +
        ` Sagging rails brown-out ICs and shift analog references.`,
      assumption: assumptionFor(ctx, sol, 'supply', worst.riseV > 0),
      refs: [pad.ref],
      netId: railId,
      location: pad.pos,
      suggestion: suggestionFor(sol, head),
      metrics: {
        dropV: worst.sagV,
        groundRiseV: worst.riseV,
        roundTripV: worst.totalV,
        sagPct,
        nominalV: nominal,
        sinkV,
        totalSinkA: sol.loadAmps,
        pathLengthMm: head.trackMm + head.pourMm,
        ...(head.minWidthMm !== undefined ? { minTrackWidthMm: head.minWidthMm } : {}),
      },
    })
  }

  if (notes.length === 0) return findings
  return { findings, notAssessed: `partly assessed: ${notes.join('; ')}` }
}

/** Name what the solve could not place on this rail: stranded pads and unresolved parts. */
function noteGaps(notes: string[], sol: RailSolution, name: string): void {
  if (sol.stranded.length > 0) {
    const shown = sol.stranded.slice(0, 4).map(padName).join(', ')
    const more = sol.stranded.length > 4 ? ` and ${sol.stranded.length - 4} more` : ''
    notes.push(`${name}: ${shown}${more} carry current but no modelled copper reaches them from the supply entry`)
  }
  if (sol.unresolved.length > 0) {
    notes.push(`${name}: the solve could not resolve the current of ${sol.unresolved.join(', ')}`)
  }
}

function assumptionFor(ctx: CriticContext, sol: RailSolution, kind: 'supply' | 'return', withReturn = false): string {
  const via = ctx.board.vias[0]
  const viaMohm = via ? viaResistanceOhms(via, ctx.board.boardThicknessMm) * 1000 : 1.4
  const pour = sol.graph.hasPour
    ? `; pours meshed at ~${ctx.opts.zoneMeshMm} mm with the outline taken as the fill (no thermal reliefs, clearance islands or keepouts)`
    : ''
  return (
    `${ctx.opts.copperOz} oz copper; vias ≈ ${viaMohm.toFixed(1)} mΩ each (20 µm plating)${pour}; ` +
    `${kind === 'return' ? 'return' : 'supply'} entry inferred at ${sol.source.ref} (connector/widest-copper heuristic); ` +
    `currents from the operating-point solve (LEDs, resistors and bench sources measured, other parts by KCL at the nets)` +
    (kind === 'supply' && !withReturn ? '; ground return not included' : '')
  )
}

function suggestionFor(sol: RailSolution, head: Headline): string {
  if (head.pourMm > 0) {
    return 'The path runs through a copper pour: widen its narrowest section (a neck, or the gap between slots and cutouts), stitch it to a second layer with vias, or move the load closer to the supply entry.'
  }
  if (sol.graph.hasPour) {
    return 'Widen or shorten the trace, connect the load to the copper pour on this net, or move it closer to the supply entry.'
  }
  return 'Widen or shorten the trace, add a copper pour or a second feed, or move the load closer to the supply entry.'
}
