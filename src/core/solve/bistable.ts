/**
 * core/solve/bistable.ts
 *
 * An op-amp wired with positive feedback (a Schmitt trigger: a thermostat, a
 * battery monitor) whose input sits inside its hysteresis band has three DC
 * solutions: output at the low limit, output at the high limit, and a balance
 * point in between where the feedback exactly cancels the input. That middle
 * point is unstable; a real circuit never rests there. Newton iteration lands
 * on whichever solution its start leads to, and the op-amp core in
 * resources/models/opamp.lib is written so the first Newton pass sees a linear
 * amplifier (that is what keeps followers and gain stages on a direct solve), so
 * from ngspice's all-zero start it lands on the middle one. Reported as is, a
 * mid-rail output would read as a trusted value.
 *
 * settleBistableOpAmps checks every op-amp core whose pole node sits inside its
 * output limits at the op. It pins the pole node 10 mV off its solved value with
 * a voltage source and reads the current the rest of the circuit then pushes into
 * that node. A stable point pushes back (current against the displacement); an
 * unstable one pushes further (current with it). This is the sign of the DC
 * driving-point resistance at a node with capacitance to ground, so it is exact
 * for a latch-type (non-oscillating) instability, and it holds for a loop that
 * runs through other op-amps too, because they stay free while one is pinned.
 *
 * Each unstable op-amp is then moved to the state it powers up in. The live
 * bench starts a run from 0 V on every capacitor, which puts the pole node at the
 * low output limit, so a `.nodeset` there re-solves the op on that branch and
 * Energize agrees with what Run settles to. The re-solved op is a true DC
 * solution, so it keeps whatever method ngspice reports for it.
 *
 * The probe relies on opamp_core's internal node names (vpole, clo, chi, vmid);
 * src/core/models/__tests__/library-content.test.ts pins them.
 */

import { loadAndRunOp } from './loadAndRunOp'
import type { OpResult, SolveEngine } from './types'

/** An op-amp core found in an op: its pole node against its output limits. */
export interface OpAmpPole {
  /** The core's instance path as ngspice names it, e.g. `xu1.xa`. */
  instance: string
  /** The pole node, which the output buffer copies (volts). */
  vpole: number
  /** The low and high output limits at this op (volts). */
  lo: number
  hi: number
}

/** An op-amp the solve found balanced on an unstable operating point. */
export interface LatchedOpAmp {
  /** The op-amp core's instance path in the deck, e.g. `xu1.xa`. */
  instance: string
  /** Its pole voltage at the unstable point the first op found. */
  unstableVolts: number
  /**
   * Its pole voltage in the committed op, or null when no re-solve could move it
   * off the unstable point (the committed op then still holds that point).
   */
  settledVolts: number | null
}

export interface SettleResult {
  /** The op to commit: the re-solved one when an op-amp was moved, else the input op. */
  op: OpResult
  /** The deck that produced `op`: the input deck, plus `.nodeset` lines when an op-amp was moved. */
  deck: string[]
  latched: LatchedOpAmp[]
}

/**
 * A pole within this distance of a limit counts as parked there. A saturated
 * op-amp parks a few millivolts inside its limit, or up to the 30 mV clamp knee
 * beyond it when overdriven.
 */
export const LINEAR_MARGIN_V = 0.02
/** How far the probe pins the pole node off its solved value. */
export const PROBE_STEP_V = 0.01
/**
 * The smallest probe current read as "pushes further". A real hysteresis loop
 * gives milliamps at a 10 mV step (the core's drive is 1 A/V); this floor only
 * keeps solver round-off from deciding.
 */
export const PROBE_CURRENT_FLOOR_A = 1e-9
/** A re-solve that leaves a pole linear must move it at least this far to count. */
export const SETTLE_MOVE_V = 0.05
/** At most this many op-amps are settled per op; a board with more latches keeps the rest. */
const MAX_SETTLES = 16

/** The voltage source the probe adds. Lowercase, as ngspice reports it. */
export const PROBE_SOURCE = 'vcircsim_probe'

/** Every op-amp core in an op, sorted by instance path. */
export function findOpAmpPoles(values: Record<string, number>): OpAmpPole[] {
  const poles: OpAmpPole[] = []
  for (const [key, vpole] of Object.entries(values)) {
    if (!key.endsWith('.vpole')) continue
    const instance = key.slice(0, -'.vpole'.length)
    const lo = values[`${instance}.clo`]
    const hi = values[`${instance}.chi`]
    const mid = values[`${instance}.vmid`]
    if (![vpole, lo, hi, mid].every(Number.isFinite)) continue
    poles.push({ instance, vpole, lo, hi })
  }
  return poles.sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0))
}

/** True when the pole sits inside both output limits: the amplifier is in its linear region. */
export function isLinear(p: OpAmpPole): boolean {
  return p.vpole > p.lo + LINEAR_MARGIN_V && p.vpole < p.hi - LINEAR_MARGIN_V
}

/**
 * True when some op-amp in the op is in its linear region, the only case
 * settleBistableOpAmps has anything to check. Synchronous, so a caller can skip
 * the async step (and its extra solves) for every other board.
 */
export function hasLinearOpAmp(values: Record<string, number>): boolean {
  return findOpAmpPoles(values).some(isLinear)
}

/** The probe step for a pole: 10 mV away from its nearer limit, so the pinned point stays linear. */
export function probeStep(p: OpAmpPole): number {
  return p.vpole - p.lo <= p.hi - p.vpole ? PROBE_STEP_V : -PROBE_STEP_V
}

/** `deck` with `extra` inserted before its final `.end` (appended when there is none). */
export function withLines(deck: string[], extra: string[]): string[] {
  let end = deck.length
  for (let i = deck.length - 1; i >= 0; i--) {
    if (/^\s*\.end\s*$/i.test(deck[i])) {
      end = i
      break
    }
  }
  return [...deck.slice(0, end), ...extra, ...deck.slice(end)]
}

/** The probe card: pin the pole node `step` volts off its solved value. */
export function probeLine(p: OpAmpPole, step: number): string {
  return `${PROBE_SOURCE} ${p.instance}.vpole 0 dc ${(p.vpole + step).toFixed(6)}`
}

/** The re-solve card: start Newton with this pole node at `v`. */
export function nodesetLine(instance: string, v: number): string {
  return `.nodeset v(${instance}.vpole)=${v.toFixed(6)}`
}

/**
 * Find op-amps balanced on an unstable operating point and re-solve each at its
 * power-up state. `deck` must be the deck that produced `op` and the one the
 * engine holds; on return the engine holds the returned deck again.
 *
 * One op-amp is settled at a time, in instance order, and the rest are probed
 * again on the new op: in a latch that runs through several op-amps, settling
 * the first decides the others, and starting them all low at once would not be
 * a consistent state.
 *
 * Never throws: when the engine rejects a probe or a re-solve, the best op found
 * so far is returned.
 */
export async function settleBistableOpAmps(
  engine: SolveEngine,
  deck: string[],
  op: OpResult,
): Promise<SettleResult> {
  let curOp = op
  let curDeck = deck
  let loaded = deck
  const latched = new Map<string, LatchedOpAmp>()

  try {
    for (let n = 0; n < MAX_SETTLES; n++) {
      let unstable: OpAmpPole | undefined
      for (const pole of findOpAmpPoles(curOp.values)) {
        // Each op-amp is settled at most once, which also bounds the loop.
        if (!isLinear(pole) || latched.has(pole.instance)) continue
        const step = probeStep(pole)
        loaded = withLines(curDeck, [probeLine(pole, step)])
        const probe = await loadAndRunOp(engine, loaded)
        const pushed = probe.method === 'failed' ? NaN : probe.values[`i(${PROBE_SOURCE})`]
        if (Number.isFinite(pushed) && pushed * Math.sign(step) > PROBE_CURRENT_FLOOR_A) {
          unstable = pole
          break
        }
      }
      if (!unstable) break

      const resolved = await resettle(engine, curDeck, unstable)
      loaded = resolved.deck
      latched.set(unstable.instance, {
        instance: unstable.instance,
        unstableVolts: unstable.vpole,
        settledVolts: resolved.op ? poleOf(resolved.op, unstable.instance)!.vpole : null,
      })
      if (resolved.op) {
        curOp = resolved.op
        curDeck = resolved.deck
      }
    }
  } catch {
    // The engine rejected a probe or a re-solve: keep the best op found so far.
  }

  if (loaded !== curDeck) {
    try {
      await engine.loadCircuit(curDeck)
    } catch {
      // The op is already in hand; a failed reload only leaves a probe deck loaded.
    }
  }
  return { op: curOp, deck: curDeck, latched: [...latched.values()] }
}

/**
 * Re-solve with the unstable pole started at its low limit, the power-up state,
 * or, when Newton returns from there to the unstable point, at its high limit.
 * Returns the first re-solve that moved it, or a null op when neither did.
 */
async function resettle(
  engine: SolveEngine,
  deck: string[],
  pole: OpAmpPole,
): Promise<{ op: OpResult | null; deck: string[] }> {
  let tried = deck
  for (const start of [pole.lo, pole.hi]) {
    tried = withLines(deck, [nodesetLine(pole.instance, start)])
    const op = await loadAndRunOp(engine, tried)
    if (op.method !== 'failed' && moved(pole, op)) return { op, deck: tried }
  }
  return { op: null, deck: tried }
}

/** True when `op` has this pole parked at a limit, or well away from where it was unstable. */
function moved(unstableAt: OpAmpPole, op: OpResult): boolean {
  const now = poleOf(op, unstableAt.instance)
  if (!now) return false
  return !isLinear(now) || Math.abs(now.vpole - unstableAt.vpole) > SETTLE_MOVE_V
}

function poleOf(op: OpResult, instance: string): OpAmpPole | undefined {
  const pole = {
    instance,
    vpole: op.values[`${instance}.vpole`],
    lo: op.values[`${instance}.clo`],
    hi: op.values[`${instance}.chi`],
  }
  return [pole.vpole, pole.lo, pole.hi].every(Number.isFinite) ? pole : undefined
}
