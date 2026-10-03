/**
 * core/solve/plan.ts
 *
 * The operating-point solve plan with op-informed rail sensing (issue #53).
 * This was appStore.powerOn's body; it now runs the same way in the renderer,
 * in tests against real ngspice, and in a headless caller.
 *
 * Pass 1 solves the family-default baseline (tiers 1, 2 and 4: a direct bench
 * supply, a manual override, or the family default for each digital chip's
 * rail). Tier-3 sensing then reads each switched or derived VDD rail off that
 * op. If a measured rail changes the deck, pass 2 re-solves exactly once with
 * the measured rails, then re-senses that op and re-solves while the sensed rail
 * still moves by more than RAIL_SETTLE_TOLERANCE, up to MAX_SOLVE_PASSES solves
 * in all (issue #44: an output that loads its own VDD biases the pass-1 rail).
 * Sensing is skipped only when pass 1 failed outright; gmin, source-stepping
 * and tran-fallback ops still sense. Comparing against the baseline is what
 * makes "did the measured rail change the circuit" decidable, which is why
 * pass 1 never seeds cached measured rails: a measured rail equal to the family
 * default leaves the deck unchanged and costs no second solve.
 *
 * After each pass, settleBistableOpAmps (bistable.ts) moves any op-amp left
 * balanced on an unstable point (a Schmitt trigger inside its hysteresis band)
 * to its power-up state before rail sensing reads the op, so neither the sensed
 * rails nor the committed op carry a mid-rail latch output.
 */

import type { Circuit } from '../netlist/extract'
import { deriveMeasuredRailVHigh } from '../spicegen/generate'
import { hasLinearOpAmp, settleBistableOpAmps, type LatchedOpAmp } from './bistable'
import { buildDeckWithUndriven } from './inputs'
import { loadAndRunOp } from './loadAndRunOp'
import { copperResult } from './copperResult'
import type { OpResult, SolveEngine, SolveInputs, SolveResult, UndrivenNet } from './types'

/**
 * Pass 1 did not produce an op (engine timeout, lost transport). Nothing was
 * solved; `cause` is the engine's error. A pass-2 failure is not an error: the
 * result keeps pass 1's op and says so in `pass2`.
 */
export class SolveFailedError extends Error {
  constructor(cause: unknown) {
    super(`operating point did not complete: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
    this.name = 'SolveFailedError'
  }
}

/**
 * Most op solves one plan may run, pass 1 included. The reconciliation loop
 * contracts quickly because each pass moves the driven swing toward the rail it
 * was sensed from: on the loaded-VDD fixture (#44) the sensed rail goes 6.58,
 * 5.36, 5.06, 5.003 V against a true fixpoint of 5.0 V.
 */
export const MAX_SOLVE_PASSES = 4

/** A re-sensed rail within this fraction of the rail its deck used counts as settled. */
export const RAIL_SETTLE_TOLERANCE = 0.02

function railsSettled(used: ReadonlyMap<number, number>, sensed: ReadonlyMap<number, number>): boolean {
  for (const [netId, v] of sensed) {
    const u = used.get(netId)
    if (u === undefined) return false
    if (Math.abs(v - u) > RAIL_SETTLE_TOLERANCE * Math.abs(u)) return false
  }
  return true
}

export async function runSolvePlan(inputs: SolveInputs, engine: SolveEngine): Promise<SolveResult> {
  const { deck: pass1Deck, undrivenNets: pass1Undriven } = buildDeckWithUndriven({
    ...inputs,
    measuredRails: undefined,
  })
  let op: OpResult
  try {
    op = await loadAndRunOp(engine, pass1Deck)
  } catch (cause) {
    throw new SolveFailedError(cause)
  }
  // Checked synchronously, here and after pass 2, so a board with no op-amp in
  // its linear region costs no extra solve and no extra await.
  const settled1 = hasLinearOpAmp(op.values)
    ? await settleBistableOpAmps(engine, pass1Deck, op)
    : { op, deck: pass1Deck, latched: [] }
  op = settled1.op
  let deck = settled1.deck
  let latched: LatchedOpAmp[] = settled1.latched

  const sense = (values: Record<string, number>): ReturnType<typeof deriveMeasuredRailVHigh> =>
    deriveMeasuredRailVHigh({
      opValues: values,
      circuit: inputs.circuit,
      resolutions: inputs.resolutions,
      instruments: inputs.instruments,
      groundNetId: inputs.groundNetId,
      railOverrides: inputs.railOverrides,
      modelTexts: inputs.modelTexts,
    })

  // A failed op still carries whatever the last ladder rung left behind. Those
  // values are not a solution, so no rail is read off them and pass 1 stands.
  // gmin, source-stepping and tran-fallback ops are normal on 555 and op-amp
  // boards and their values were correct in every measured case, so they sense.
  const sensed1 =
    op.method === 'failed'
      ? { rails: new Map<number, number>(), gatedOff: [] as SolveResult['gatedOff'] }
      : sense(op.values)
  let { gatedOff } = sensed1
  const measured = sensed1.rails

  // The undriven nets belong to the deck that produced the committed op, so they
  // follow `deck` through pass 2 (settling only re-forces op-amp outputs, it does
  // not change which nets the island analysis bleeds).
  let undrivenNets: UndrivenNet[] = pass1Undriven
  let pass2Deck: string[] | undefined
  let pass2: SolveResult['pass2'] = 'not-needed'
  let passes = 1
  // The rails the committed deck was built from. After a failed pass 2 this is
  // still pass 1's sensed set, which is what a later transient deck should reuse.
  let committedRails = measured
  // The deck as buildDeckWithUndriven made it, before any settling nodesets. The
  // "did the rail change the circuit" test compares built decks with each other,
  // since a settled deck differs from its built deck by its .nodeset lines.
  let built = pass1Deck

  if (measured.size > 0) {
    // Pass 2 and the reconciliation after it. A chip output that loads its own
    // VDD (an LED pull-up, a feedback resistor) injects current from pass 1's
    // ideal family-default swing into a soft rail and biases the first sensed
    // value, so one correction is not enough there. Each landed op is settled,
    // then re-sensed; once the rail it reads agrees with the rail its deck used,
    // the deck is self-consistent and the loop stops.
    let used = measured
    for (let pass = 2; pass <= MAX_SOLVE_PASSES; pass++) {
      const { deck: candidate, undrivenNets: candidateUndriven } = buildDeckWithUndriven({
        ...inputs,
        measuredRails: used,
      })
      // Comparing against the deck last solved is what makes "did the measured
      // rail change the circuit" decidable: equal to the family default, or
      // equal to the previous pass, costs no solve.
      if (circuitText(candidate) === circuitText(built)) break
      passes = pass
      let next: OpResult
      try {
        next = await loadAndRunOp(engine, candidate)
        if (next.method === 'failed') throw new Error('operating point did not converge')
      } catch {
        // Keep the last landed op and deck, which are still a valid solve.
        if (pass === 2) {
          pass2 = 'failed'
          pass2Deck = candidate
        }
        break
      }
      const settled = hasLinearOpAmp(next.values)
        ? await settleBistableOpAmps(engine, candidate, next)
        : { op: next, deck: candidate, latched: [] }
      op = settled.op
      deck = settled.deck
      latched = settled.latched
      undrivenNets = candidateUndriven
      built = candidate
      pass2Deck = candidate
      committedRails = used
      pass2 = 'solved'

      const resensed = sense(op.values)
      gatedOff = resensed.gatedOff
      if (railsSettled(used, resensed.rails)) break
      // A rail that dropped out (now gated off or over the cap) keeps its last value.
      used = new Map([...used, ...resensed.rails])
    }
  }

  return {
    op,
    copper: copperResult(inputs, op, deck),
    netVoltages: mapOpResultToNetVoltages(op.values, inputs.circuit),
    deck,
    pass1Deck,
    pass2Deck,
    pass2,
    passes,
    measuredRails: committedRails,
    gatedOff,
    undrivenNets,
    latched,
  }
}

/**
 * A deck's circuit, without `*` comment lines: the measured-rail provenance
 * comment differs even when the numeric rail matches the family default.
 */
function circuitText(deck: string[]): string {
  return deck.filter(line => !line.trimStart().startsWith('*')).join('\n')
}

/**
 * Map op values (bare lowercase SPICE node names) onto netId to volts using the
 * circuit's spiceNode mapping. Currents (`i(...)`) and unknown nodes are
 * skipped; ground nets read 0 V even when ngspice omits node "0".
 */
export function mapOpResultToNetVoltages(
  values: Record<string, number>,
  circuit: Circuit,
): Map<number, number> {
  const out = new Map<number, number>()
  const nodeToNet = new Map<string, number>()
  for (const net of circuit.nets) {
    nodeToNet.set(net.spiceNode, net.id)
  }
  for (const [key, volts] of Object.entries(values)) {
    if (key.startsWith('i(')) continue
    const netId = nodeToNet.get(key)
    if (netId !== undefined) out.set(netId, volts)
  }
  for (const net of circuit.nets) {
    if (net.spiceNode === '0' && !out.has(net.id)) out.set(net.id, 0)
  }
  return out
}
