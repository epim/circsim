/**
 * core/solve: the solve pipeline seam (issue #53). One place assembles deck
 * inputs (buildSolveInputs, buildDeck), one place runs the two-pass operating
 * point with rail sensing (runSolvePlan), against any SolveEngine. The renderer
 * uses createSimClientEngine; tests and headless callers use the in-process
 * engine in src/simhost/solveEngine.ts.
 */

export { buildDeck, buildSolveInputs, mergeModelTexts, railOverridesByNetId } from './inputs'
export { mapOpResultToNetVoltages, runSolvePlan, SolveFailedError } from './plan'
export {
  createSimClientEngine,
  type SimClientEngineOptions,
  type SimTransport,
} from './simClientEngine'
export type {
  GatedOffRail,
  OpResult,
  SolveEngine,
  SolveInputs,
  SolveOverrides,
  SolveResult,
  TranResult,
  UserModelText,
} from './types'
