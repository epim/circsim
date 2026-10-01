/**
 * renderer/boardOpen/runner.ts (issue #55)
 *
 * How the store runs the open pipeline. A runner takes an OpenRequest and calls
 * a sink as the work progresses: stage changes, then the opened board, then the
 * audit report. The store never imports a Worker; it is handed a runner.
 *
 *   - createInlineRunner: runs the pipeline on the calling thread, yielding to
 *     the event loop between stages. Used by tests and as the fallback when a
 *     Worker cannot start. It keeps the UI responsive between stages but not
 *     during one.
 *   - createWorkerOpenRunner (workerRunner.ts): runs it in a Worker.
 *
 * The audit is delivered after the board, so the board can be on screen while
 * the slow check runs.
 */

import {
  auditOpenedBoard,
  openBoardPipeline,
  type OpenOutcome,
  type OpenRequest,
  type OpenStage,
} from './pipeline'
import type { CriticReport } from '../../../core/critic/types'
import type { StaticOutputs } from '../../../core/critic/run'

export interface OpenSink {
  /** A stage began. Fires for parsing, extracting, resolving, then auditing. */
  onStage(stage: OpenStage): void
  /** The board is ready (or failed to parse). On failure no audit follows. */
  onOpened(outcome: OpenOutcome): void
  /**
   * The audit finished. Always after a successful onOpened. `staticOutputs` is
   * present when the audit ran on another thread: the receiver primes its own
   * critic cache with it (primeStaticOutputs).
   */
  onAudit(report: CriticReport, staticOutputs?: StaticOutputs | null): void
}

export interface BoardOpenRunner {
  /**
   * Run one open. Resolves when the run is over: audit delivered, parse failure
   * delivered, or the run was cancelled. Rejects only for an unexpected failure
   * (a bug in the pipeline); the sink has seen nothing for that case.
   */
  run(req: OpenRequest, sink: OpenSink): Promise<void>
  /**
   * Abandon the run in flight, if any. A cancelled run delivers nothing more to
   * its sink. Safe to call when idle.
   */
  cancel(): void
}

/** Let the event loop turn (and a frame paint, where there are frames). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    const turn = (): void => {
      setTimeout(resolve, 0)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(turn)
    else turn()
  })
}

export function createInlineRunner(): BoardOpenRunner {
  let generation = 0

  return {
    async run(req, sink) {
      const mine = ++generation
      const live = (): boolean => mine === generation

      // Let the caller's "opening" state paint before the first synchronous slice.
      await yieldToEventLoop()
      if (!live()) return

      // The pipeline reports stages synchronously from inside one call, so the
      // stage text cannot paint between them; only the audit is a separate
      // step that can follow a yield.
      const outcome = openBoardPipeline(req, stage => {
        if (live()) sink.onStage(stage)
      })
      if (!live()) return
      sink.onOpened(outcome)
      if (!outcome.ok) return

      sink.onStage('auditing')
      await yieldToEventLoop()
      if (!live()) return
      const report = auditOpenedBoard(outcome.opened)
      if (!live()) return
      sink.onAudit(report)
    },
    cancel() {
      generation++
    },
  }
}
