/**
 * core/solve/loadAndRunOp.ts
 *
 * Queue a load and an op back to back in one synchronous turn (see the
 * SolveEngine ordering contract in types.ts), then settle the load first so a
 * failed load is reported as such rather than as a bad op.
 */

import type { OpResult, SolveEngine } from './types'

export async function loadAndRunOp(engine: SolveEngine, deck: string[]): Promise<OpResult> {
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
