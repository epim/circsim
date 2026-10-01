/**
 * renderer/boardOpen/workerRunner.ts (issue #55)
 *
 * A BoardOpenRunner over a Worker. The Worker itself is injected (`spawn`) so
 * this file has no bundler-specific import and tests can pass a loopback;
 * createRendererStore.ts supplies the real one.
 *
 * Cancellation terminates the worker: the audit is one long synchronous loop in
 * there and cannot be interrupted any other way. The next run spawns a fresh
 * worker, which costs a few milliseconds and no state (the worker keeps none).
 *
 * If the worker cannot start, or dies before it delivered the board, the run is
 * handed to the fallback runner (inline), so a CSP or packaging problem costs
 * responsiveness but never the ability to open a board.
 */

import type { BoardOpenRunner, OpenSink } from './runner'
import type { OpenRequest } from './pipeline'
import type { OpenWorkerReply, OpenWorkerRequest } from './workerProtocol'

/** The slice of the Worker API this runner uses. */
export interface WorkerLike {
  postMessage(msg: OpenWorkerRequest): void
  terminate(): void
  onmessage: ((e: { data: OpenWorkerReply }) => void) | null
  onerror: ((e: unknown) => void) | null
}

interface ActiveRun {
  id: number
  req: OpenRequest
  sink: OpenSink
  openedDelivered: boolean
  done: () => void
  fail: (err: Error) => void
}

export function createWorkerOpenRunner(
  spawn: () => WorkerLike,
  fallback: BoardOpenRunner,
): BoardOpenRunner {
  let worker: WorkerLike | null = null
  let active: ActiveRun | null = null
  let nextId = 0

  function dropWorker(): void {
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      worker = null
    }
  }

  function onReply(reply: OpenWorkerReply): void {
    const run = active
    if (!run || reply.id !== run.id) return // a cancelled run's late reply
    switch (reply.type) {
      case 'stage':
        run.sink.onStage(reply.stage)
        return
      case 'opened':
        run.openedDelivered = true
        run.sink.onOpened(reply.outcome)
        if (!reply.outcome.ok) finish(run)
        return
      case 'audit':
        run.sink.onAudit(reply.report, reply.staticOutputs)
        finish(run)
        return
      case 'fatal':
        active = null
        dropWorker()
        run.fail(new Error(reply.message))
        return
    }
  }

  function finish(run: ActiveRun): void {
    if (active === run) active = null
    run.done()
  }

  function onWorkerError(): void {
    const run = active
    active = null
    dropWorker()
    if (!run) return
    if (run.openedDelivered) {
      // The board is already on screen; only the audit is lost. The store
      // notices the missing report and runs it itself.
      run.done()
      return
    }
    // Never produced a board: hand the whole run to the fallback.
    fallback.run(run.req, run.sink).then(run.done, run.fail)
  }

  function cancelRun(): void {
    const run = active
    if (!run) return
    active = null
    dropWorker()
    // A cancelled run delivers nothing more; settle its promise.
    run.done()
  }

  return {
    run(req, sink) {
      // One run at a time: a new run supersedes the old one.
      cancelRun()

      return new Promise<void>((resolve, reject) => {
        let w: WorkerLike
        try {
          w = worker ?? spawn()
        } catch {
          fallback.run(req, sink).then(resolve, reject)
          return
        }
        worker = w
        w.onmessage = e => onReply(e.data)
        w.onerror = () => onWorkerError()
        const run: ActiveRun = {
          id: ++nextId,
          req,
          sink,
          openedDelivered: false,
          done: resolve,
          fail: reject,
        }
        active = run
        try {
          w.postMessage({ type: 'open', id: run.id, req })
        } catch {
          // The request could not be cloned or posted.
          active = null
          dropWorker()
          fallback.run(req, sink).then(resolve, reject)
        }
      })
    },

    cancel: cancelRun,
  }
}
