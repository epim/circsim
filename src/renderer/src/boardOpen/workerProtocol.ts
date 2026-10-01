/**
 * renderer/boardOpen/workerProtocol.ts (issue #55)
 *
 * The messages between the renderer and the board-open Worker, plus the
 * worker-side handler as a plain function over a `post` callback. The Worker
 * entry (boardOpen.worker.ts) is glue around serveOpenRequest; tests drive the
 * same function through a loopback that structured-clones every message, which
 * is how the "everything crossing the boundary is clone-safe" property is held.
 */

import type { CriticReport } from '../../../core/critic/types'
import {
  auditOpenedBoard,
  openBoardPipeline,
  type OpenOutcome,
  type OpenRequest,
  type OpenStage,
} from './pipeline'

/** Renderer to worker. */
export interface OpenWorkerRequest {
  type: 'open'
  /** Echoed on every reply so a late reply from a cancelled run is ignorable. */
  id: number
  req: OpenRequest
}

/** Worker to renderer. */
export type OpenWorkerReply =
  | { type: 'stage'; id: number; stage: OpenStage }
  | { type: 'opened'; id: number; outcome: OpenOutcome }
  | { type: 'audit'; id: number; report: CriticReport }
  | { type: 'fatal'; id: number; message: string }

/**
 * Handle one open request: post stage changes, the opened board, then the
 * audit. A parse failure posts `opened` with `ok: false` and stops. An
 * unexpected throw posts `fatal`.
 */
export function serveOpenRequest(msg: OpenWorkerRequest, post: (reply: OpenWorkerReply) => void): void {
  const { id, req } = msg
  try {
    const outcome = openBoardPipeline(req, stage => post({ type: 'stage', id, stage }))
    post({ type: 'opened', id, outcome })
    if (!outcome.ok) return
    post({ type: 'stage', id, stage: 'auditing' })
    const report = auditOpenedBoard(outcome.opened)
    post({ type: 'audit', id, report })
  } catch (err) {
    post({ type: 'fatal', id, message: err instanceof Error ? err.message : String(err) })
  }
}
