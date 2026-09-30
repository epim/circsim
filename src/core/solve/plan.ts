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
 */

import type { Circuit } from '../netlist/extract'
import { deriveMeasuredRailVHigh } from '../spicegen/generate'
import { buildDeckWithUndriven } from './inputs'
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

  const { rails, gatedOff } = deriveMeasuredRailVHigh({
    opValues: op.values,
    circuit: inputs.circuit,
    resolutions: inputs.resolutions,
    instruments: inputs.instruments,
    groundNetId: inputs.groundNetId,
    railOverrides: inputs.railOverrides,
    modelTexts: inputs.modelTexts,
  })

  let deck = pass1Deck
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
      try {
        op = await loadAndRunOp(engine, candidate)
        deck = candidate
        undrivenNets = pass2Undriven
        pass2 = 'solved'
      } catch {
        pass2 = 'failed' // keep pass 1's op, which is still a valid solve of pass1Deck
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
  }
}

/**
 * Queue a load and an op back to back in one synchronous turn (see the
 * SolveEngine ordering contract), then settle the load first so a failed load
 * is reported as such rather than as a bad op.
 */
async function loadAndRunOp(engine: SolveEngine, deck: string[]): Promise<OpResult> {
  const loaded = engine.loadCircuit(deck)
  const op = engine.runOp()
  try {
    await loaded
  } catch (err) {
    op.catch(() => undefined) // the op's own outcome no longer matters
    throw err
  }
  return op
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
