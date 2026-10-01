/**
 * src/renderer/src/scope/benchTimeline.ts: issue #59, Spec 7.5
 *
 * One continuous time axis for a run that spans bench-window restarts.
 *
 * SimHost runs the transient in bounded windows: when a window ends (or the
 * RSS guard trips) it restarts ngspice at t = 0 (Spec 7.5). Scope history must
 * survive that, and the ring buffers need non-decreasing times for their
 * binary search. So the rings store run time, not raw sim time:
 *
 *   run time = raw sim time + the run offset of the current bench window
 *
 * where the offset is the run time at which the window started (the sum of the
 * earlier windows' lengths). The offset belongs to the run, not to a ring: a
 * probe added after a restart gets a fresh ring, and it must land on the same
 * axis as the rings that lived through the restart. Every ring the store feeds
 * therefore goes through one shared timeline (`benchTimeline`), and the
 * timeline sees each samples batch once however many rings it feeds.
 *
 * Restart or fresh Run? Both send raw time back to 0. The store resets the
 * rings for a fresh Run (`resetRingBuffers`), so in the first batch of a fresh
 * Run every ring is empty, while after a bench-window restart the rings that
 * were already running still hold their history. The first batch after a time
 * regression decides: if any ring fed with it holds samples, the run continues
 * (offset advances); if none does, a new run starts at offset 0. A fresh ring
 * fed earlier in that same batch is fed provisionally at offset 0 and shifted
 * onto the run axis when a ring with history shows up later in the batch.
 */

import type { RingBuffer } from './ringBuffer'

export interface BenchTimeline {
  /**
   * The offset to add to this batch's raw sim times before appending them to
   * `ring`. Call once per ring per batch, before feeding the ring. `simTime` is
   * the batch's time column. One batch passed for several rings (the same
   * array, or an equal copy for a ring not yet fed with it) counts once.
   */
  offsetFor(ring: RingBuffer, simTime: Float64Array): number
}

/** Create an independent timeline (tests; the app uses `benchTimeline`). */
export function createBenchTimeline(): BenchTimeline {
  // Run offset of the current bench window.
  let offset = 0
  // Newest raw time seen in the current bench window (-Infinity before any).
  let windowEnd = Number.NEGATIVE_INFINITY

  // The batch being fed: identity plus its shape, so an equal copy matches too.
  let batch: Float64Array | null = null
  let batchLen = -1
  let batchFirst = Number.NaN
  let batchLast = Number.NaN
  // Batch serial, and the serial each ring was last fed with. An equal copy is
  // the current batch only for a ring that has not taken it yet; for a ring
  // that has, equal times are the next batch (e.g. a restart whose first batch
  // repeats the previous window's first batch).
  let serial = 0
  const fedSerial = new WeakMap<RingBuffer, number>()

  // First batch after a time regression, until a ring with history decides it.
  let undecided = false
  // Offset the new window takes if the run continues through the restart.
  let continuedOffset = 0
  // Fresh rings fed at offset 0 while the restart batch is undecided.
  let provisional: RingBuffer[] = []

  function isCurrentBatch(ring: RingBuffer, simTime: Float64Array): boolean {
    if (simTime === batch) return true
    return (
      fedSerial.get(ring) !== serial &&
      simTime.length === batchLen &&
      simTime[0] === batchFirst &&
      simTime[simTime.length - 1] === batchLast
    )
  }

  function beginBatch(simTime: Float64Array): void {
    const first = simTime[0]
    const last = simTime[simTime.length - 1]
    undecided = false
    provisional = []
    if (first < windowEnd) {
      // Raw time went backwards: a bench-window restart or a fresh Run.
      // Provisionally a fresh Run (offset 0) until a ring with history says
      // the run continues.
      continuedOffset = offset + windowEnd
      offset = 0
      windowEnd = Number.NEGATIVE_INFINITY
      undecided = true
    }
    if (last > windowEnd) windowEnd = last
    serial++
    batch = simTime
    batchLen = simTime.length
    batchFirst = first
    batchLast = last
  }

  return {
    offsetFor(ring: RingBuffer, simTime: Float64Array): number {
      if (simTime.length === 0) return offset
      if (!isCurrentBatch(ring, simTime)) beginBatch(simTime)
      fedSerial.set(ring, serial)
      if (undecided) {
        if (ring.length > 0) {
          // This ring lived through the restart: same run, continue the axis.
          undecided = false
          offset = continuedOffset
          for (const r of provisional) r.shiftTimes(offset)
          provisional = []
        } else {
          provisional.push(ring)
        }
      }
      return offset
    },
  }
}

/**
 * The app's timeline. One store and one SimHost sample stream per renderer, so
 * every probe ring shares it (`feedSamples` uses it by default).
 */
export const benchTimeline: BenchTimeline = createBenchTimeline()
