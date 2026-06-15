/**
 * Unit tests for SampleBatcher (Task 10 / Spec §6.1).
 *
 * Verifies the flush policy (16 ms OR 4096 points), the time/column split, the
 * Float64Array payload shape, transfer-list correctness, and run-reset behavior.
 */

import { describe, expect, it } from 'vitest'

import { SampleBatcher } from '../sampleBatcher'

describe('SampleBatcher', () => {
  it('splits the scale vector out of columns', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'out', 'in', 'v1#branch'])
    expect(b.getVectorNames()).toEqual(['out', 'in', 'v1#branch'])
  })

  it('flush returns Float64Array columns with matching simTime length', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'out', 'in'])
    b.push({ time: 0, out: 0, in: 5 })
    b.push({ time: 1e-6, out: 0.1, in: 5 })
    b.push({ time: 2e-6, out: 0.2, in: 5 })

    const flush = b.flush()
    expect(flush).not.toBeNull()
    const ev = flush!.event
    expect(ev.type).toBe('samples')
    expect(ev.simTime).toBeInstanceOf(Float64Array)
    expect(ev.simTime.length).toBe(3)
    expect(ev.columns).toHaveLength(2)
    for (const col of ev.columns) {
      expect(col).toBeInstanceOf(Float64Array)
      expect(col.length).toBe(ev.simTime.length)
    }
    expect(ev.vectorNames).toEqual(['out', 'in'])
    expect(Array.from(ev.simTime)).toEqual([0, 1e-6, 2e-6])
    expect(Array.from(ev.columns[0])).toEqual([0, 0.1, 0.2])
    expect(Array.from(ev.columns[1])).toEqual([5, 5, 5])
  })

  it('transfer list contains every buffer exactly once', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'a', 'b'])
    b.push({ time: 0, a: 1, b: 2 })
    const flush = b.flush()!
    // simTime + 2 columns = 3 buffers.
    expect(flush.transfer).toHaveLength(3)
    expect(flush.transfer).toContain(flush.event.simTime.buffer)
    expect(flush.transfer).toContain(flush.event.columns[0].buffer)
    expect(flush.transfer).toContain(flush.event.columns[1].buffer)
  })

  it('size-based flush fires at maxPoints', () => {
    const b = new SampleBatcher({ maxPoints: 4 })
    b.setVectors(['time', 'out'])
    expect(b.push({ time: 0, out: 0 })).toBeNull()
    expect(b.push({ time: 1, out: 1 })).toBeNull()
    expect(b.push({ time: 2, out: 2 })).toBeNull()
    const flush = b.push({ time: 3, out: 3 }) // 4th row → flush
    expect(flush).not.toBeNull()
    expect(flush!.event.simTime.length).toBe(4)
    // After a size flush the batch is empty again.
    expect(b.pending).toBe(0)
  })

  it('age-based flush threshold respects injected clock', () => {
    let t = 1000
    const b = new SampleBatcher({ maxAgeMs: 16, now: () => t })
    b.setVectors(['time', 'out'])
    b.push({ time: 0, out: 0 })
    expect(b.shouldFlushByAge()).toBe(false)
    t += 10
    expect(b.shouldFlushByAge()).toBe(false)
    t += 6 // now 16 ms elapsed
    expect(b.shouldFlushByAge()).toBe(true)
  })

  it('shouldFlushByAge is false when nothing is pending', () => {
    let t = 0
    const b = new SampleBatcher({ maxAgeMs: 16, now: () => t })
    b.setVectors(['time', 'out'])
    t += 100
    expect(b.shouldFlushByAge()).toBe(false)
    expect(b.flush()).toBeNull()
  })

  it('missing vector values push NaN, not undefined', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'out', 'in'])
    b.push({ time: 0, out: 1 }) // "in" missing
    const ev = b.flush()!.event
    expect(Number.isNaN(ev.columns[1][0])).toBe(true)
  })

  it('setVectors discards pending rows from a previous run', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'out'])
    b.push({ time: 0, out: 1 })
    expect(b.pending).toBe(1)
    b.setVectors(['time', 'out', 'extra']) // new run
    expect(b.pending).toBe(0)
    expect(b.getVectorNames()).toEqual(['out', 'extra'])
  })

  it('reset clears pending rows', () => {
    const b = new SampleBatcher()
    b.setVectors(['time', 'out'])
    b.push({ time: 0, out: 1 })
    b.reset()
    expect(b.pending).toBe(0)
    expect(b.flush()).toBeNull()
  })
})
