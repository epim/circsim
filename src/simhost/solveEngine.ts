/**
 * src/simhost/solveEngine.ts
 *
 * The in-process SolveEngine (issue #53): src/core/solve running directly on
 * ngspice in this process, for tests and the CLI. It wraps a SimHost so an op
 * goes through the same retry ladder and reports the same method as the live
 * app's utility process does; there is no MessagePort and no Electron.
 *
 * libngspice is process-global: hold one engine per process at a time, and
 * dispose() it before creating another.
 */

import type { OpResult, SolveEngine, TranResult } from '../core/solve/types'
import { SimHost } from './index'
import type { OpSolveMethod, SimEvent } from './protocol'

export interface InProcessSolveEngineOptions {
  /** Every SimEvent the embedded SimHost emits (ngspice logs, opResult, convergenceFailure). */
  onEvent?: (event: SimEvent) => void
  /** Override the ngspice resources base dir (defaults to resources/ngspice/<platform>). */
  resourcesBaseDir?: string
}

export interface InProcessSolveEngine extends SolveEngine {
  /** Drain and release ngspice. The engine is unusable afterwards. */
  dispose(): Promise<void>
}

/** Start ngspice in this process (including the XSPICE code-model smoke check). */
export async function createInProcessSolveEngine(
  opts: InProcessSolveEngineOptions = {}
): Promise<InProcessSolveEngine> {
  let lastOpMethod: OpSolveMethod | undefined
  let tranFailure: string | null = null
  let tranInFlight = false

  const host = new SimHost({
    emit: (ev) => {
      if (ev.type === 'opResult') lastOpMethod = ev.method
      if (ev.type === 'convergenceFailure' && tranInFlight) tranFailure ??= ev.detail
      opts.onEvent?.(ev)
    },
    // The watchdog exits the process on a stall: right for the utility process,
    // wrong for a test runner or a CLI that owns its own process.
    disableWatchdog: true,
    // No streaming transient runs here, so no pacing or flush timers.
    disableTimers: true,
    resourcesBaseDir: opts.resourcesBaseDir
  })
  await host.start()

  return {
    loadCircuit: (deckLines) => host.loadCircuit(deckLines),

    async runOp(): Promise<OpResult> {
      lastOpMethod = undefined
      const values = await host.runOp()
      // SimHost emits the op's opResult (carrying the method) just before runOp resolves.
      return { values, method: lastOpMethod }
    },

    async runTran(tstep, tstop): Promise<TranResult> {
      if (!(tstep > 0) || !(tstop > 0)) {
        throw new RangeError(`runTran needs positive tstep and tstop; got tstep=${tstep}, tstop=${tstop}`)
      }
      tranFailure = null
      tranInFlight = true
      try {
        const result = await host.runTran(tstep, tstop)
        if (tranFailure !== null) throw new Error(`transient did not converge: ${tranFailure}`)
        return result
      } finally {
        tranInFlight = false
      }
    },

    dispose: () => host.dispose()
  }
}
