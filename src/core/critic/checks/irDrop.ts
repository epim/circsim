/**
 * core/critic/checks/irDrop.ts
 *
 * IR-drop (rail-sag) audit (spec §5 item 4). For each power rail it solves the
 * rail's copper (railGraph.ts: tracks, vias, copper pours and pads as a
 * resistive graph) with the operating point's branch currents injected at the
 * load pads, and reports the worst supply-entry-to-load sag as a percentage of
 * the rail's op-solved nominal voltage. The ground return is solved the same
 * way: each load's return current enters the ground copper at its ground pad
 * and the shift from the return entry is the ground shift. A load's round-trip
 * drop is its supply sag plus its ground shift toward the rail.
 *
 * Polarity: sag is toward 0 V. A positive rail falls at its loads and their
 * ground pads rise; a negative rail's load current flows from ground through the
 * part back into the rail, so the rail rises toward 0 V at the load and the
 * ground there falls. A rail on which every current-carrying pad other than the
 * entry feeds the rail (pushes current into a positive rail or pulls it out of a
 * negative one) has no load to measure a sag at; it is named in the
 * not-assessed line instead of passing silently.
 *
 * Needs an operating-point sim (registry `needs:'op'`) that carries branch
 * currents (OpResult.padCurrents, built by deriveSolvedCurrents from the solve;
 * a bare partCurrents map is still read, drawing each part's current from a
 * positive rail's pads, returning it into a negative rail's pads and returning
 * it on its ground pads). With no currents at all the
 * check reports "not assessed". Parts whose current the solve could not resolve
 * and pads the copper model does not connect to the supply entry are named in
 * the not-assessed line: they are never silently counted as zero. A rail whose
 * pads carry current but which could not be solved at all (no copper on the net,
 * no pad on any copper, a solve that did not converge) is named there too.
 *
 * Supply entry (issue #47): the pad nearest the bench lead's copper position
 * (OpResult.supplyEntries, from the lead position the store and the sidecar
 * keep). Only a rail with no attached lead, or a lead with no recorded position,
 * falls back to a guess, and the finding's assumption then says it guessed:
 *   1. a pad on the rail belonging to a connector-like ref (J1/P1/CN1/CON1/X1);
 *   2. else the pad attached to the rail's widest incident track;
 *   3. else the first pad in (ref, pad-number) order that touches copper.
 *
 * Never throws: a rail whose copper cannot be solved yields no finding for that
 * rail, and says so in the not-assessed line when it carries current. Pure core; deterministic (rails and parts iterated in sorted order).
 */

import type { CheckOutput, Finding, Severity } from '../types'
import type { CriticContext } from '../context'
import { classifyRails } from '../classify'
import {
  hasBranchCurrents,
  minResistancePath,
  padList,
  railGapNotes,
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

export function checkIrDrop(ctx: CriticContext): CheckOutput {
  const { board, circuit, opResult, opts } = ctx
  if (opResult && !opResult.copper) {
    return { findings: [], notAssessed: 'ideal-net operating point; enable copperAware: true for copper-aware voltages and segment currents' }
  }
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

  // ── ground return: shift from the return entry, per load ───────────────────
  // A positive rail's load returns its current into ground and lifts it there; a
  // negative rail's load draws its current out of ground and pulls it down. Each
  // is a ground shift; a rail's round trip counts the one toward that rail.
  const groundRiseByRef = new Map<string, number>()
  const groundFallByRef = new Map<string, number>()
  const noteShift = (byRef: Map<string, number>, ref: string, v: number): void => {
    byRef.set(ref, Math.max(byRef.get(ref) ?? 0, v))
  }
  for (const gid of [...groundNetIds].sort((a, b) => a - b)) {
    notes.push(...railGapNotes(ctx, gid, true, netName(gid)))
    const sol = solveRail(ctx, gid, true)
    if (!sol) continue
    let worst: { load: RailLoad; shiftV: number } | undefined
    for (const l of sol.loads) {
      const shiftV = sol.volts[l.pad.node]
      if (!Number.isFinite(shiftV)) continue
      if (shiftV > 0) noteShift(groundRiseByRef, l.pad.ref, shiftV)
      else if (shiftV < 0) noteShift(groundFallByRef, l.pad.ref, -shiftV)
      if (!worst || Math.abs(shiftV) > Math.abs(worst.shiftV)) worst = { load: l, shiftV }
    }
    if (!worst || supplyV <= 0) continue
    const shiftV = Math.abs(worst.shiftV)
    const pct = (100 * shiftV) / supplyV
    const severity = severityFor(pct)
    if (!severity) continue
    const rises = worst.shiftV > 0
    // The current that moves the ground this way: returned into it, or drawn out.
    const towardA = sol.loads.reduce((s, l) => s + Math.max(0, (rises ? -1 : 1) * l.amps), 0)
    const head = pathHeadline(minResistancePath(sol, worst.load.pad.node))
    const ref = worst.load.pad.ref
    findings.push({
      id: `ir-drop:${gid}`,
      check: 'ir-drop',
      severity,
      title:
        `"${netName(gid)}" return ${rises ? 'rises' : 'falls'} to ${worst.shiftV.toFixed(2)} V at ${ref} ` +
        `(${pct.toFixed(1)}% of ${supplyV.toFixed(2)} V${head.across})`,
      detail:
        (rises
          ? `The return current of ${ref} lifts ${netName(gid)} by about ${shiftV.toFixed(3)} V `
          : `The current ${ref} draws out of ${netName(gid)} pulls it down by about ${shiftV.toFixed(3)} V `) +
        `(${pct.toFixed(1)}% of the ${supplyV.toFixed(2)} V supply) between the return entry at ` +
        `${sol.source.ref} pad ${sol.source.padNumber} and ${ref} pad ${worst.load.pad.padNumber}` +
        (head.across ? `, over a path${head.across}.` : '.') +
        ' Ground shift moves analog references and logic thresholds by the same amount.',
      assumption: assumptionFor(ctx, sol, 'return'),
      refs: [ref],
      netId: gid,
      location: worst.load.pad.pos,
      suggestion: suggestionFor(sol, head),
      metrics: {
        dropV: shiftV,
        sagPct: pct,
        nominalV: supplyV,
        totalSinkA: towardA,
        pathLengthMm: head.trackMm + head.pourMm,
        ...(head.minWidthMm !== undefined ? { minTrackWidthMm: head.minWidthMm } : {}),
      },
    })
  }

  // ── power rails: supply sag, plus the ground shift at the same load ────────
  for (const railId of [...powerNetIds].sort((a, b) => a - b)) {
    notes.push(...railGapNotes(ctx, railId, false, netName(railId)))
    // Nominal rail voltage from the op solve (the sim treats the whole net as one
    // node, i.e. the voltage at the supply entry). Without it a % sag is
    // undefined: skip rather than invent a number.
    const nominal = nominalOf(railId)
    if (nominal === undefined) continue
    const sol = solveRail(ctx, railId, false)
    if (!sol) continue
    if (sol.loadAmps < 1e-9) {
      // Current on the rail, but every pad carrying it feeds the rail the way a
      // supply does: nothing draws from the entry, so no sag to measure.
      if (sol.loads.length > 0) {
        notes.push(
          `${netName(railId)}: ${padList(sol.loads)} ${sol.loadSign > 0 ? 'push current into' : 'pull current out of'} ` +
            `the rail as a supply would, and no load draws from the supply entry ` +
            `${sol.entry.kind === 'lead' ? 'taken from the bench lead' : 'guessed'} at ` +
            `${sol.source.ref} pad ${sol.source.padNumber}, so its sag was not measured`,
        )
      }
      continue
    }

    // Sag toward 0 V: a +5 V rail falls below the entry, a -12 V rail rises above
    // it. The ground shift that adds to it is the one toward the rail: the
    // return's rise under a positive rail's load, its fall under a negative one's.
    const dir = -sol.loadSign
    const groundShiftByRef = sol.loadSign > 0 ? groundRiseByRef : groundFallByRef
    let worst: { load: RailLoad; sagV: number; shiftV: number; totalV: number } | undefined
    for (const l of sol.loads) {
      const sagV = Math.max(0, dir * sol.volts[l.pad.node])
      if (!Number.isFinite(sagV)) continue
      const shiftV = groundShiftByRef.get(l.pad.ref) ?? 0
      const totalV = sagV + shiftV
      if (!worst || totalV > worst.totalV) worst = { load: l, sagV, shiftV, totalV }
    }
    if (!worst) continue

    const sagPct = (100 * worst.totalV) / Math.abs(nominal)
    const severity = severityFor(sagPct)
    if (!severity) continue

    const pad = worst.load.pad
    const head = pathHeadline(minResistancePath(sol, pad.node))
    const sinkV = nominal >= 0 ? nominal - worst.totalV : nominal + worst.totalV
    const roundTrip =
      worst.shiftV > 0 ? ` (${worst.sagV.toFixed(3)} V on the supply, ${worst.shiftV.toFixed(3)} V on the return)` : ''

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
      assumption: assumptionFor(ctx, sol, 'supply', worst.shiftV > 0),
      refs: [pad.ref],
      netId: railId,
      location: pad.pos,
      suggestion: suggestionFor(sol, head),
      metrics: {
        dropV: worst.sagV,
        groundShiftV: worst.shiftV,
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

function assumptionFor(ctx: CriticContext, sol: RailSolution, kind: 'supply' | 'return', withReturn = false): string {
  const via = ctx.board.vias[0]
  const viaMohm = via ? viaResistanceOhms(via, ctx.board.boardThicknessMm) * 1000 : 1.4
  const pour = sol.graph.hasPour
    ? `; pours meshed at ~${ctx.opts.zoneMeshMm} mm with the outline taken as the fill (no thermal reliefs, clearance islands or keepouts)`
    : ''
  return (
    `${ctx.opts.copperOz} oz copper; vias ≈ ${viaMohm.toFixed(1)} mΩ each (20 µm plating)${pour}; ` +
    `${entryText(sol, kind)}; ` +
    `pad voltages and segment currents from the same copper-aware ngspice operating point` +
    (kind === 'supply' && !withReturn ? '; ground return not included' : '')
  )
}

/** Where the entry came from: the bench lead, or a guess and why it had to guess. */
function entryText(sol: RailSolution, kind: 'supply' | 'return'): string {
  const what = kind === 'return' ? 'return' : 'supply'
  const at = `${sol.source.ref} pad ${sol.source.padNumber}`
  const e = sol.entry
  if (e.kind === 'lead') {
    const snap = e.snapMm < 0.05 ? 'on' : `snapped ${e.snapMm.toFixed(1)} mm to`
    return `${what} entry taken from the bench lead clipped at (${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)}) mm, ${snap} ${at}`
  }
  const why =
    e.why === 'no-position'
      ? `the bench lead on this rail has no recorded position`
      : `no bench ${what === 'return' ? 'ground clip' : 'supply lead'} is attached to this rail`
  return `${what} entry is a guess: ${why}, so it was assumed at ${at} (connector/widest-copper heuristic)`
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
