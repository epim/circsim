/**
 * workerRunner.test.ts (issue #55)
 *
 * The Worker-backed runner and the worker-side protocol, driven through a
 * loopback that structured-clones every message in both directions, exactly as a
 * real Worker boundary does. That is what holds the property the whole fix
 * rests on: BoardModel, Circuit, Resolution and CriticReport survive the clone
 * with Maps, Sets and shared structure intact.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createWorkerOpenRunner, type WorkerLike } from '../workerRunner'
import { createInlineRunner, type BoardOpenRunner, type OpenSink } from '../runner'
import { serveOpenRequest, type OpenWorkerReply, type OpenWorkerRequest } from '../workerProtocol'
import { auditOpenedBoard, openBoardPipeline, type OpenOutcome, type OpenStage } from '../pipeline'
import type { CriticReport } from '../../../../core/critic/types'

const fixturesDir = join(__dirname, '../../../../../fixtures')
const rc = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')
const f555 = readFileSync(join(fixturesDir, 'fixture-555.kicad_pcb'), 'utf-8')

/** A Worker stand-in: runs serveOpenRequest, cloning every message each way. */
class LoopbackWorker implements WorkerLike {
  onmessage: ((e: { data: OpenWorkerReply }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  terminated = false
  received: OpenWorkerRequest[] = []

  postMessage(msg: OpenWorkerRequest): void {
    const cloned = structuredClone(msg)
    this.received.push(cloned)
    // Asynchronous, like a real worker.
    queueMicrotask(() => {
      if (this.terminated) return
      serveOpenRequest(cloned, reply => {
        if (this.terminated) return
        this.onmessage?.({ data: structuredClone(reply) })
      })
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

function recordingSink(): {
  sink: OpenSink
  stages: OpenStage[]
  outcomes: OpenOutcome[]
  reports: CriticReport[]
  order: string[]
} {
  const stages: OpenStage[] = []
  const outcomes: OpenOutcome[] = []
  const reports: CriticReport[] = []
  const order: string[] = []
  return {
    stages,
    outcomes,
    reports,
    order,
    sink: {
      onStage: s => {
        stages.push(s)
        order.push(`stage:${s}`)
      },
      onOpened: o => {
        outcomes.push(o)
        order.push('opened')
      },
      onAudit: r => {
        reports.push(r)
        order.push('audit')
      },
    },
  }
}

describe('serveOpenRequest', () => {
  it('posts stages in order, then the board, then the audit', () => {
    const replies: OpenWorkerReply[] = []
    serveOpenRequest({ type: 'open', id: 7, req: { boardText: rc, library: [] } }, r => replies.push(r))
    expect(replies.every(r => r.id === 7)).toBe(true)
    expect(replies.map(r => (r.type === 'stage' ? `stage:${r.stage}` : r.type))).toEqual([
      'stage:parsing',
      'stage:extracting',
      'stage:resolving',
      'opened',
      'stage:auditing',
      'audit',
    ])
  })

  it('posts the parse failure as a value and stops (no audit)', () => {
    const replies: OpenWorkerReply[] = []
    serveOpenRequest({ type: 'open', id: 1, req: { boardText: '(kicad_pcb (version', library: [] } }, r =>
      replies.push(r),
    )
    const opened = replies.find(r => r.type === 'opened')
    expect(opened).toBeDefined()
    if (opened?.type !== 'opened') throw new Error('unreachable')
    expect(opened.outcome.ok).toBe(false)
    expect(replies.some(r => r.type === 'audit')).toBe(false)
  })
})

describe('createWorkerOpenRunner over a cloning loopback', () => {
  it('delivers what the inline pipeline produces, after a structured clone', async () => {
    const worker = new LoopbackWorker()
    const runner = createWorkerOpenRunner(() => worker, createInlineRunner())
    const rec = recordingSink()
    await runner.run({ boardText: f555, library: [] }, rec.sink)

    expect(rec.order).toEqual([
      'stage:parsing',
      'stage:extracting',
      'stage:resolving',
      'opened',
      'stage:auditing',
      'audit',
    ])

    const direct = openBoardPipeline({ boardText: f555, library: [] })
    if (!direct.ok || !rec.outcomes[0].ok) throw new Error('fixture must parse')
    const viaWorker = rec.outcomes[0].opened
    expect(viaWorker.circuit).toEqual(direct.opened.circuit)
    expect(viaWorker.resolutions).toEqual(direct.opened.resolutions)
    expect(viaWorker.board).toEqual(direct.opened.board)
    // Lookup maps the checks depend on survive the clone as Maps.
    expect(viaWorker.board.netById).toBeInstanceOf(Map)
    expect(rec.reports[0]).toEqual(auditOpenedBoard(direct.opened))
  })

  it('a parse failure ends the run without an audit', async () => {
    const runner = createWorkerOpenRunner(() => new LoopbackWorker(), createInlineRunner())
    const rec = recordingSink()
    await runner.run({ boardText: '(kicad_pcb (version', library: [] }, rec.sink)
    expect(rec.outcomes).toHaveLength(1)
    expect(rec.outcomes[0].ok).toBe(false)
    expect(rec.reports).toHaveLength(0)
  })

  it('cancel terminates the worker, settles the run, and delivers nothing more', async () => {
    const worker = new LoopbackWorker()
    const runner = createWorkerOpenRunner(() => worker, createInlineRunner())
    const rec = recordingSink()
    const run = runner.run({ boardText: rc, library: [] }, rec.sink)
    runner.cancel()
    await run
    expect(worker.terminated).toBe(true)
    // Let any queued microtask run; the terminated worker must stay silent.
    await Promise.resolve()
    expect(rec.order).toEqual([])
  })

  it('a new run after a cancel gets a fresh worker', async () => {
    const spawned: LoopbackWorker[] = []
    const runner = createWorkerOpenRunner(() => {
      const w = new LoopbackWorker()
      spawned.push(w)
      return w
    }, createInlineRunner())
    const first = runner.run({ boardText: rc, library: [] }, recordingSink().sink)
    runner.cancel()
    await first

    const rec = recordingSink()
    await runner.run({ boardText: rc, library: [] }, rec.sink)
    expect(spawned).toHaveLength(2)
    expect(rec.reports).toHaveLength(1)
  })

  it('reuses one worker across sequential runs', async () => {
    const spawned: LoopbackWorker[] = []
    const runner = createWorkerOpenRunner(() => {
      const w = new LoopbackWorker()
      spawned.push(w)
      return w
    }, createInlineRunner())
    await runner.run({ boardText: rc, library: [] }, recordingSink().sink)
    await runner.run({ boardText: f555, library: [] }, recordingSink().sink)
    expect(spawned).toHaveLength(1)
  })

  it('ignores a late reply from a superseded run', async () => {
    const workers: LoopbackWorker[] = []
    const runner = createWorkerOpenRunner(() => {
      const w = new LoopbackWorker()
      workers.push(w)
      return w
    }, createInlineRunner())
    const stale = recordingSink()
    const first = runner.run({ boardText: rc, library: [] }, stale.sink)
    const fresh = recordingSink()
    const second = runner.run({ boardText: f555, library: [] }, fresh.sink)
    // Replay a reply for the first request id after the second started.
    workers[1].onmessage?.({ data: { type: 'stage', id: 1, stage: 'parsing' } })
    await Promise.all([first, second])
    expect(stale.order).toEqual([])
    expect(fresh.reports).toHaveLength(1)
  })

  it('falls back to the inline runner when the worker cannot be spawned', async () => {
    const runner = createWorkerOpenRunner(() => {
      throw new Error('worker blocked by CSP')
    }, createInlineRunner())
    const rec = recordingSink()
    await runner.run({ boardText: rc, library: [] }, rec.sink)
    expect(rec.outcomes[0]?.ok).toBe(true)
    expect(rec.reports).toHaveLength(1)
  })

  it('falls back to the inline runner when the worker errors before delivering a board', async () => {
    class DeadWorker extends LoopbackWorker {
      override postMessage(): void {
        queueMicrotask(() => this.onerror?.(new Error('script failed to load')))
      }
    }
    const worker = new DeadWorker()
    const runner = createWorkerOpenRunner(() => worker, createInlineRunner())
    const rec = recordingSink()
    await runner.run({ boardText: rc, library: [] }, rec.sink)
    expect(worker.terminated).toBe(true)
    expect(rec.outcomes[0]?.ok).toBe(true)
    expect(rec.reports).toHaveLength(1)
  })

  it('a worker error after the board was delivered ends the run without an audit', async () => {
    class DiesDuringAudit extends LoopbackWorker {
      override postMessage(msg: OpenWorkerRequest): void {
        queueMicrotask(() => {
          const outcome = openBoardPipeline(msg.req)
          this.onmessage?.({ data: { type: 'opened', id: msg.id, outcome: structuredClone(outcome) } })
          this.onerror?.(new Error('out of memory'))
        })
      }
    }
    const runner = createWorkerOpenRunner(() => new DiesDuringAudit(), createInlineRunner())
    const rec = recordingSink()
    await runner.run({ boardText: rc, library: [] }, rec.sink)
    expect(rec.outcomes).toHaveLength(1)
    expect(rec.reports).toHaveLength(0)
  })

  it('a fatal reply rejects the run', async () => {
    class Fatal extends LoopbackWorker {
      override postMessage(msg: OpenWorkerRequest): void {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'fatal', id: msg.id, message: 'boom' } }))
      }
    }
    const runner: BoardOpenRunner = createWorkerOpenRunner(() => new Fatal(), createInlineRunner())
    await expect(runner.run({ boardText: rc, library: [] }, recordingSink().sink)).rejects.toThrow('boom')
  })
})
