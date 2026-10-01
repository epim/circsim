/**
 * core/solve/inputs.ts
 *
 * The single place deck inputs are assembled (issue #53). buildSolveInputs
 * snapshots the board, circuit, resolutions, instruments and bench overrides
 * once; buildDeck is the only place in the app that calls generateDeck. Before
 * this seam the renderer store rebuilt GenerateOptions by hand in powerOn, run
 * and replayAfterCrash.
 */

import type { BoardModel } from '../kicad/types'
import type { Resolution } from '../models/types'
import type { Circuit } from '../netlist/extract'
import { generateDeckWithDiagnostics, type GenerateOptions } from '../spicegen/generate'
import { wiredInstruments, type Instrument } from '../spicegen/instruments'
import type { SolveInputs, SolveOverrides, UndrivenNet, UserModelText } from './types'

/**
 * Snapshot every deck input. Rail overrides are resolved against this circuit,
 * user models are merged into the model texts, unwired instruments are dropped,
 * and maps are copied, so later edits to the caller's state cannot change a
 * solve that is already running.
 */
export function buildSolveInputs(
  board: BoardModel | null,
  circuit: Circuit,
  resolutions: Resolution[],
  instruments: Instrument[],
  groundNetId: number,
  overrides: SolveOverrides = {},
): SolveInputs {
  return {
    board,
    circuit,
    resolutions,
    instruments: wiredInstruments(instruments),
    groundNetId,
    title: overrides.title,
    modelTexts: mergeModelTexts(overrides.modelTexts, overrides.userModels),
    railOverrides: railOverridesByNetId(circuit, overrides.railOverrides),
    measuredRails: overrides.measuredRails ? new Map(overrides.measuredRails) : undefined,
  }
}

/**
 * The deck for a snapshot. Seeds the snapshot's cached tier-3 rails, which is
 * what a transient run or a crash replay wants; runSolvePlan builds its pass-1
 * baseline by clearing them first.
 */
export function buildDeck(inputs: SolveInputs): string[] {
  return buildDeckWithUndriven(inputs).deck
}

/**
 * buildDeck plus the circuit nets the deck bled to ground because nothing
 * drives them (issue #43). Still the only place in the app that calls the deck
 * generator.
 */
export function buildDeckWithUndriven(inputs: SolveInputs): { deck: string[]; undrivenNets: UndrivenNet[] } {
  const { lines, diagnostics } = generateDeckWithDiagnostics(generateOptions(inputs))
  return { deck: lines, undrivenNets: undrivenNetsOf(diagnostics.undrivenIslands, inputs.circuit) }
}

/**
 * Map undriven-island spice nodes back to circuit nets, in the generator's
 * deterministic first-seen order. Nodes that are not a circuit net (a
 * synthetic or expansion-internal node) have no KiCad name to show and are
 * skipped; ground is never in an island.
 */
export function undrivenNetsOf(islands: readonly (readonly string[])[], circuit: Circuit): UndrivenNet[] {
  const byNode = new Map<string, UndrivenNet>()
  for (const net of circuit.nets) {
    if (net.spiceNode === '0') continue
    byNode.set(net.spiceNode, { netId: net.id, kicadName: net.kicadName, spiceNode: net.spiceNode })
  }
  const out: UndrivenNet[] = []
  const seen = new Set<number>()
  for (const island of islands) {
    for (const node of island) {
      const net = byNode.get(node)
      if (net && !seen.has(net.netId)) {
        seen.add(net.netId)
        out.push(net)
      }
    }
  }
  return out
}

function generateOptions(inputs: SolveInputs): GenerateOptions {
  return {
    circuit: inputs.circuit,
    resolutions: inputs.resolutions,
    instruments: inputs.instruments,
    groundNetId: inputs.groundNetId,
    title: inputs.title,
    modelTexts: inputs.modelTexts,
    railOverrides: inputs.railOverrides,
    measuredRailVHigh: inputs.measuredRails,
  }
}

/**
 * The file-name to text map the deck generator inlines definitions from:
 * bundled texts first, then user models under the virtual path
 * `__user_model__:<mpn>` that their library entries reference. User entries
 * are added last, so they win on key collision.
 */
export function mergeModelTexts(
  modelTexts: Record<string, string> | undefined,
  userModels: Iterable<UserModelText> | undefined,
): Record<string, string> {
  const texts: Record<string, string> = { ...modelTexts }
  for (const um of userModels ?? []) {
    texts[`__user_model__:${um.mpn}`] = um.subcktText
  }
  return texts
}

/**
 * Resolve kicadName-keyed rail overrides to the netId-keyed map the deck
 * generator consumes. Names with no net in this circuit are dropped.
 */
export function railOverridesByNetId(
  circuit: Circuit,
  byName: ReadonlyMap<string, number> | undefined,
): Map<number, number> {
  const map = new Map<number, number>()
  if (!byName) return map
  for (const net of circuit.nets) {
    const v = byName.get(net.kicadName)
    if (v !== undefined) map.set(net.id, v)
  }
  return map
}
