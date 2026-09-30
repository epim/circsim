/**
 * core/solve/simClientEngine.ts
 *
 * The SolveEngine the renderer uses: it speaks the SimHost message protocol
 * through anything shaped like the store's SimClient (src/renderer/src/ipc/
 * simClient.ts satisfies SimTransport structurally). Pure TS on top of the
 * protocol types; no Electron and no MessagePort in here.
 */

import {
  normalizeVectorKey,
  type SimCommand,
  type SimEvent,
} from '../../simhost/protocol'
import type { OpResult, SolveEngine, TranResult } from './types'

/** The slice of the renderer's SimClient this engine needs. */
export interface SimTransport {
  send(command: SimCommand): void
  onEvent(listener: (event: SimEvent) => void): () => void
  waitFor<T extends SimEvent['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<SimEvent, { type: T }>>
}

export interface SimClientEngineOptions {
  /** How long an op may take before runOp rejects. Default 30 s. */
  opTimeoutMs?: number
  /** How long a transient may take before runTran rejects. Default 120 s. */
  tranTimeoutMs?: number
  /**
   * SimHost's bench window in sim-seconds (default 30). A run past it restarts
   * continuously instead of finishing, so runTran refuses one.
   */
  benchWindowSeconds?: number
}

const DEFAULT_OP_TIMEOUT_MS = 30_000
const DEFAULT_TRAN_TIMEOUT_MS = 120_000
const DEFAULT_BENCH_WINDOW_S = 30

export function createSimClientEngine(
  client: SimTransport,
  opts: SimClientEngineOptions = {},
): SolveEngine {
  const opTimeoutMs = opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS
  const tranTimeoutMs = opts.tranTimeoutMs ?? DEFAULT_TRAN_TIMEOUT_MS
  const benchWindowSeconds = opts.benchWindowSeconds ?? DEFAULT_BENCH_WINDOW_S

  return {
    loadCircuit(deckLines) {
      // Fire-and-forget: SimHost applies commands in the order sent, and a load
      // error arrives as a log event on the same channel.
      client.send({ type: 'loadCircuit', deckLines })
      return Promise.resolve()
    },

    async runOp(): Promise<OpResult> {
      // Arm the reply listener before sending, so no reply can slip past it.
      const reply = client.waitFor('opResult', opTimeoutMs)
      client.send({ type: 'runOp' })
      const ev = await reply
      return { values: ev.values, method: ev.method }
    },

    runTran(tstep, tstop): Promise<TranResult> {
      if (!(tstep > 0) || !(tstop > 0) || tstop > benchWindowSeconds) {
        return Promise.reject(
          new RangeError(
            `runTran needs 0 < tstep and 0 < tstop <= ${benchWindowSeconds} s; got tstep=${tstep}, tstop=${tstop}`,
          ),
        )
      }
      return new Promise<TranResult>((resolve, reject) => {
        const time: number[] = []
        const columns = new Map<string, number[]>()
        const finish = (err?: Error): void => {
          clearTimeout(timer)
          unsubscribe()
          if (err) reject(err)
          else resolve(assemble(time, columns))
        }
        const timer = setTimeout(
          () => finish(new Error(`runTran timed out after ${tranTimeoutMs} ms`)),
          tranTimeoutMs,
        )
        const unsubscribe = client.onEvent(ev => {
          switch (ev.type) {
            case 'samples':
              for (let i = 0; i < ev.simTime.length; i++) time.push(ev.simTime[i])
              ev.vectorNames.forEach((name, c) => {
                const key = normalizeVectorKey(name)
                let col = columns.get(key)
                if (!col) columns.set(key, (col = []))
                for (let i = 0; i < ev.columns[c].length; i++) col.push(ev.columns[c][i])
              })
              break
            case 'status':
              // A finite run's final status: stopped at (or past) tstop. A pacing
              // halt also reports running=false, but short of tstop.
              if (!ev.running && ev.simTimeSeconds >= tstop) finish()
              break
            case 'convergenceFailure':
              finish(new Error(`transient did not converge: ${ev.detail}`))
              break
            default:
              break
          }
        })
        client.send({ type: 'runTransient', tstepSeconds: tstep, tstopSeconds: tstop })
        client.send({ type: 'setPace', realtimeFactor: 'max' })
      })
    },
  }
}

function assemble(time: number[], columns: Map<string, number[]>): TranResult {
  const vectors: Record<string, Float64Array> = {}
  for (const [key, col] of columns) vectors[key] = Float64Array.from(col)
  return { time: Float64Array.from(time), vectors }
}
