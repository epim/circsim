/**
 * frameCoalescer.test.ts
 *
 * #58: pointermove fires far faster than frames are drawn; hover picking must
 * run once per animation frame on the newest position.
 */

import { describe, it, expect } from 'vitest'
import { createFrameCoalescer, type FrameScheduler } from '../frameCoalescer'

/** A hand-driven frame scheduler. */
function fakeFrames() {
  let nextId = 1
  const queue = new Map<number, () => void>()
  const scheduler: FrameScheduler = {
    request(cb) {
      const id = nextId++
      queue.set(id, cb)
      return id
    },
    cancel(id) {
      queue.delete(id)
    },
  }
  return {
    scheduler,
    /** Run every callback queued for the next frame. */
    frame() {
      const cbs = [...queue.values()]
      queue.clear()
      for (const cb of cbs) cb()
    },
    get queued() {
      return queue.size
    },
  }
}

describe('createFrameCoalescer', () => {
  it('runs nothing until a frame arrives', () => {
    const f = fakeFrames()
    const seen: number[] = []
    const c = createFrameCoalescer<number>(v => seen.push(v), f.scheduler)
    c.push(1)
    expect(seen).toEqual([])
    expect(c.pending).toBe(true)
    f.frame()
    expect(seen).toEqual([1])
    expect(c.pending).toBe(false)
  })

  it('collapses many pushes between frames into one run on the newest value', () => {
    const f = fakeFrames()
    const seen: number[] = []
    const c = createFrameCoalescer<number>(v => seen.push(v), f.scheduler)
    for (let i = 1; i <= 100; i++) c.push(i)
    expect(f.queued).toBe(1)
    f.frame()
    expect(seen).toEqual([100])
  })

  it('schedules a fresh frame for pushes after a run', () => {
    const f = fakeFrames()
    const seen: number[] = []
    const c = createFrameCoalescer<number>(v => seen.push(v), f.scheduler)
    c.push(1)
    f.frame()
    c.push(2)
    c.push(3)
    f.frame()
    expect(seen).toEqual([1, 3])
  })

  it('does not run on an empty frame', () => {
    const f = fakeFrames()
    const seen: number[] = []
    createFrameCoalescer<number>(v => seen.push(v), f.scheduler)
    f.frame()
    expect(seen).toEqual([])
  })

  it('cancel drops the pending value and its frame', () => {
    const f = fakeFrames()
    const seen: number[] = []
    const c = createFrameCoalescer<number>(v => seen.push(v), f.scheduler)
    c.push(1)
    c.cancel()
    expect(c.pending).toBe(false)
    expect(f.queued).toBe(0)
    f.frame()
    expect(seen).toEqual([])
    // and it still works afterwards
    c.push(2)
    f.frame()
    expect(seen).toEqual([2])
  })

  it('can push again from inside the run callback', () => {
    const f = fakeFrames()
    const seen: number[] = []
    const c = createFrameCoalescer<number>(v => {
      seen.push(v)
      if (v === 1) c.push(2)
    }, f.scheduler)
    c.push(1)
    f.frame()
    f.frame()
    expect(seen).toEqual([1, 2])
  })
})
