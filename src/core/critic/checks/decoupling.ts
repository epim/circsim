/**
 * core/critic/checks/decoupling.ts
 *
 * Decoupling-proximity audit (spec §5 item 5). Every IC power pin wants a small
 * bypass cap on the same rail placed close by; a missing or distant cap lets the
 * rail sag during fast current transients. For each (IC, power-net) pair this
 * measures the distance from the IC's power pin(s) to the nearest qualifying
 * bypass cap and emits at most one finding:
 *
 *   - no qualifying cap            → error  ("…has no decoupling capacitor")
 *   - nearest cap > decouplingFarMm  → error  ("…is <d>mm away (>15mm)")
 *   - nearest cap > decouplingNearMm → warn   ("…is <d>mm away (>5mm)")
 *   - otherwise                    → no finding (good)
 *
 * Net classification reuses suggestSupplies/suggestGround. A "bypass cap" is a
 * C-ref part of ≤ 1 µF connected to BOTH the rail and a ground net. No sim
 * needed. Findings carry the measured numbers and the parsing/proximity caveat.
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { Part } from '../../netlist/extract'
import { suggestSupplies, suggestGround } from '../../netlist/extract'
import { padWorldPos, dist } from '../geom'
import { parseValue } from '../../values/parseValue'

/** A bypass cap is small-signal: ≤ 1 µF. Bulk/electrolytics are not bypass caps. */
const BYPASS_MAX_FARAD = 1e-6
/** A part with this many pads is treated as an IC even without a U-prefix ref. */
const IC_MIN_PADS = 8

/** Capacitance of a part's value in farads, or undefined if it can't be parsed. */
function capFarads(part: Part): number | undefined {
  return parseValue(part.value, 'C')
}

export function checkDecoupling(ctx: CriticContext): Finding[] {
  const { circuit, refToFootprint, opts } = ctx
  const findings: Finding[] = []

  // ── classify nets ───────────────────────────────────────────────────────────
  const powerNetIds = new Set(suggestSupplies(circuit.nets).map((n) => n.id))
  // A net counts as ground if suggestGround returns it when asked about it alone.
  const groundNetIds = new Set(
    circuit.nets.filter((n) => suggestGround([n])).map((n) => n.id),
  )

  // ── collect bypass caps (C-ref parts ≤ 1 µF) with their net memberships ──────
  // Each cap records which nets it touches so we can ask "does it bridge P↔GND?".
  interface CapInfo {
    part: Part
    nets: Set<number>
    /** True when the value parsed and was ≤ 1 µF; false when it parsed and was larger. */
    smallEnough: boolean
    /** True when the value string could not be parsed (treated as a candidate). */
    valueUnparsed: boolean
  }
  const caps: CapInfo[] = []
  for (const part of circuit.parts) {
    if (!/^C/i.test(part.ref)) continue
    const farads = capFarads(part)
    const valueUnparsed = farads === undefined
    // Unparseable values are still treated as candidates (per spec) — the finding
    // notes the value couldn't be read.
    const smallEnough = valueUnparsed ? true : farads <= BYPASS_MAX_FARAD
    if (!smallEnough) continue
    caps.push({
      part,
      nets: new Set(part.padNet.values()),
      smallEnough,
      valueUnparsed,
    })
  }

  // ── identify ICs (need decoupling): U-ref OR a footprint with ≥ 8 pads ───────
  const ics = circuit.parts.filter((part) => {
    if (/^U/i.test(part.ref)) return true
    const fp = refToFootprint.get(part.ref)
    return fp !== undefined && fp.pads.length >= IC_MIN_PADS
  })

  for (const ic of ics) {
    const icFp = refToFootprint.get(ic.ref)
    if (!icFp) continue

    // Distinct power nets this IC connects to.
    const icPowerNets = new Set<number>()
    for (const netId of ic.padNet.values()) {
      if (powerNetIds.has(netId)) icPowerNets.add(netId)
    }
    // Stable iteration order → deterministic findings.
    for (const P of [...icPowerNets].sort((a, b) => a - b)) {
      const netName = ctx.board.netById.get(P)?.name ?? `net ${P}`

      // IC power-pin world positions on net P (pad.number → netId via padNet).
      const icPinPositions = icFp.pads
        .filter((pad) => ic.padNet.get(pad.number) === P)
        .map((pad) => padWorldPos(icFp, pad))
      if (icPinPositions.length === 0) continue // no geometry for this pin
      // The representative power-pin location is the first such pad (deterministic).
      const pinLocation = icPinPositions[0]

      // Qualifying caps: bypass caps that connect to BOTH P and a ground net.
      const qualifying = caps.filter(
        (c) => c.nets.has(P) && [...c.nets].some((n) => groundNetIds.has(n)),
      )

      const id = `decoupling:${ic.ref}:${P}`

      if (qualifying.length === 0) {
        // No bypass cap on this rail at all.
        findings.push({
          id,
          check: 'decoupling',
          severity: 'error',
          title: `${ic.ref} power pin on ${netName} has no decoupling capacitor`,
          detail:
            `No bypass capacitor (≤1µF) bridges ${netName} to ground near ${ic.ref}. ` +
            `Without local decoupling the rail can sag during the IC's fast current transients.`,
          assumption:
            'A "bypass cap" is a C-ref part ≤1µF connected to both this rail and a ground net; ' +
            'classification reuses the supply/ground name heuristics.',
          refs: [ic.ref],
          netId: P,
          location: pinLocation,
          suggestion: 'Place a 0.1µF cap within a few mm of this power pin.',
        })
        continue
      }

      // Nearest qualifying cap: min over (IC pins on P) × (cap pads on P).
      let bestDist = Infinity
      let nearestCap: CapInfo | undefined
      for (const c of qualifying) {
        const capFp = refToFootprint.get(c.part.ref)
        if (!capFp) continue
        const capPinsOnP = capFp.pads
          .filter((pad) => c.part.padNet.get(pad.number) === P)
          .map((pad) => padWorldPos(capFp, pad))
        for (const icPos of icPinPositions) {
          for (const capPos of capPinsOnP) {
            const d = dist(icPos, capPos)
            if (d < bestDist) {
              bestDist = d
              nearestCap = c
            }
          }
        }
      }

      if (!nearestCap || !isFinite(bestDist)) continue // no measurable geometry

      const cref = nearestCap.part.ref
      const dStr = bestDist.toFixed(1)
      // Note when the nearest cap's value couldn't be parsed (still treated as a candidate).
      const valueCaveat = nearestCap.valueUnparsed
        ? ` ${cref}'s value "${nearestCap.part.value}" couldn't be parsed, so it was assumed to be a bypass cap.`
        : ''

      if (bestDist > opts.decouplingFarMm) {
        findings.push({
          id,
          check: 'decoupling',
          severity: 'error',
          title: `${ic.ref} decoupling cap ${cref} is ${dStr}mm away (>${opts.decouplingFarMm}mm)`,
          detail:
            `The nearest bypass cap on ${netName} (${cref}) is ${dStr} mm from ${ic.ref}'s power pin — ` +
            `beyond ${opts.decouplingFarMm} mm its decoupling is largely ineffective at high frequency.`,
          assumption:
            'Distance is pin-to-pin in board coordinates; effective decoupling distance also ' +
            'depends on layer stack and via inductance, which are not modeled here.' + valueCaveat,
          refs: [ic.ref, cref],
          netId: P,
          location: pinLocation,
          suggestion: 'Place a 0.1µF cap within a few mm of this power pin.',
          metrics: { distanceMm: bestDist },
        })
      } else if (bestDist > opts.decouplingNearMm) {
        findings.push({
          id,
          check: 'decoupling',
          severity: 'warn',
          title: `${ic.ref} decoupling cap ${cref} is ${dStr}mm away (>${opts.decouplingNearMm}mm)`,
          detail:
            `The nearest bypass cap on ${netName} (${cref}) is ${dStr} mm from ${ic.ref}'s power pin. ` +
            `Bypass caps work best within ${opts.decouplingNearMm} mm of the pin they serve.`,
          assumption:
            'Distance is pin-to-pin in board coordinates; effective decoupling distance also ' +
            'depends on layer stack and via inductance, which are not modeled here.' + valueCaveat,
          refs: [ic.ref, cref],
          netId: P,
          location: pinLocation,
          suggestion: 'Place a 0.1µF cap within a few mm of this power pin.',
          metrics: { distanceMm: bestDist },
        })
      }
      // otherwise within decouplingNearMm → good, no finding.
    }
  }

  return findings
}
