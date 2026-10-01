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
 * the measured rails. Comparing against the baseline is what makes "did the
 * measured rail change the circuit" decidable, which is why pass 1 never seeds
 * cached measured rails: a measured rail equal to the family default leaves the
 * deck unchanged and costs no second solve.
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

  const { rails, gatedOff } = deriveMeasuredRailVHigh({
    opValues: op.values,
    circuit: inputs.circuit,
    resolutions: inputs.resolutions,
    instruments: inputs.instruments,
    groundNetId: inputs.groundNetId,
    railOverrides: inputs.railOverrides,
    modelTexts: inputs.modelTexts,
  })

  // The undriven nets belong to the deck that produced the committed op, so they
  // follow `deck` through pass 2 (settling only re-forces op-amp outputs, it does
  // not change which nets the island analysis bleeds).
  let undrivenNets: UndrivenNet[] = pass1Undriven
  let pass2Deck: string[] | undefined
  let pass2: SolveResult['pass2'] = 'not-needed'
  if (rails.size > 0) {
    const { deck: candidate, undrivenNets: pass2Undriven } = buildDeckWithUndriven({
      ...inputs,
      measuredRails: rails,
    })
    if (circuitText(candidate) !== circuitText(pass1Deck)) {
      pass2Deck = candidate
      let op2: OpResult | undefined
      try {
        op2 = await loadAndRunOp(engine, candidate)
      } catch {
        pass2 = 'failed' // keep pass 1's op, which is still a valid solve of its deck
      }
      if (op2) {
        const settled = hasLinearOpAmp(op2.values)
          ? await settleBistableOpAmps(engine, candidate, op2)
          : { op: op2, deck: candidate, latched: [] }
        op = settled.op
        deck = settled.deck
        latched = settled.latched
        undrivenNets = pass2Undriven
        pass2 = 'solved'
      }
    }
  }

  return {
    op,
    netVoltages: mapOpResultToNetVoltages(op.values, inputs.circuit),
    deck,
    pass1Deck,
    pass2Deck,
    pass2,
    measuredRails: rails,
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
