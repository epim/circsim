/**
 * renderer/boardOpen/boardOpen.worker.ts (issue #55)
 *
 * Worker entry: parse, extract, resolve and audit a board off the UI thread.
 * Imported as `?worker&inline` (see createRendererStore.ts), which bundles it
 * into a blob so the existing `worker-src blob:` CSP covers it.
 *
 * One request at a time. A superseded request is cancelled by the renderer
 * terminating this worker, since a running audit cannot be interrupted.
 */

import { serveOpenRequest, type OpenWorkerReply, type OpenWorkerRequest } from './workerProtocol'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<OpenWorkerRequest>) => void) | null
  postMessage(reply: OpenWorkerReply): void
}

scope.onmessage = (e: MessageEvent<OpenWorkerRequest>): void => {
  if (e.data?.type !== 'open') return
  serveOpenRequest(e.data, reply => scope.postMessage(reply))
}
