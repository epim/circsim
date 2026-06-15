/**
 * src/renderer/src/scope/ringBuffer.ts — Task 23
 *
 * Per-probe Float64Array ring buffer. Default capacity = 1M points.
 *
 * Design requirements (Spec §11, plan Task 23):
 *   - O(1) append: write to head index, increment, wrap. No allocation per push.
 *   - Windowed read: read(offset, length) returns logical window as Float64Array
 *     copies, handling the wrap-around transparently.
 *   - readWindow(tStart, tEnd): time-based window using a linear scan.
 *   - Fed from SimHost 'samples' events via feedSamples(rb, simTime, valueColumn).
 *
 * Implementation note: Two parallel rings — one for timestamps, one for values.
 * Both share the same head/length state.
 */

// ─── type ────────────────────────────────────────────────────────────────────

export interface RingBuffer {
  /** Backing Float64Array for voltage values (raw, modular indexed). */
  readonly valueRing: Float64Array
  /** Backing Float64Array for timestamps in seconds (raw, modular indexed). */
  readonly timeRing: Float64Array
  /** Total capacity in samples. */
  readonly capacity: number
  /** Number of valid samples currently in the ring (≤ capacity). */
  length: number
  /** Write head: index of NEXT write slot. */
  head: number

  /** Append one (value, time) sample — O(1). */
  append(value: number, time: number): void
  /**
   * Read `length` samples starting at logical `offset` (0 = oldest).
   * Returns copied Float64Arrays; handles wrap-around.
   */
  read(offset: number, length: number): { values: Float64Array; times: Float64Array }
  /** Read all samples with timestamp in [tStart, tEnd] (inclusive). */
  readWindow(tStart: number, tEnd: number): { values: Float64Array; times: Float64Array }
}

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * Create a fully method-equipped ring buffer.
 * @param capacity Max points; defaults to 1 000 000 (Spec §11).
 */
export function createRingBuffer(capacity = 1_000_000): RingBuffer {
  const valueRing = new Float64Array(capacity)
  const timeRing = new Float64Array(capacity)
  let length = 0
  let head = 0

  const rb: RingBuffer = {
    get valueRing() { return valueRing },
    get timeRing() { return timeRing },
    get capacity() { return capacity },
    get length() { return length },
    set length(v) { length = v },
    get head() { return head },
    set head(v) { head = v },

    append(value: number, time: number): void {
      valueRing[head] = value
      timeRing[head] = time
      head = (head + 1) % capacity
      if (length < capacity) length++
    },

    read(offset: number, len: number): { values: Float64Array; times: Float64Array } {
      const clampedLen = Math.min(len, length - offset)
      if (clampedLen <= 0) {
        return { values: new Float64Array(0), times: new Float64Array(0) }
      }
      const out_v = new Float64Array(clampedLen)
      const out_t = new Float64Array(clampedLen)
      // Oldest is at (head - length + capacity) % capacity
      const oldestIdx = (head - length + capacity) % capacity
      for (let i = 0; i < clampedLen; i++) {
        const physIdx = (oldestIdx + offset + i) % capacity
        out_v[i] = valueRing[physIdx]
        out_t[i] = timeRing[physIdx]
      }
      return { values: out_v, times: out_t }
    },

    readWindow(tStart: number, tEnd: number): { values: Float64Array; times: Float64Array } {
      if (length === 0) {
        return { values: new Float64Array(0), times: new Float64Array(0) }
      }
      const oldestIdx = (head - length + capacity) % capacity
      const matchedValues: number[] = []
      const matchedTimes: number[] = []
      for (let i = 0; i < length; i++) {
        const physIdx = (oldestIdx + i) % capacity
        const t = timeRing[physIdx]
        if (t >= tStart && t <= tEnd) {
          matchedTimes.push(t)
          matchedValues.push(valueRing[physIdx])
        }
      }
      return {
        values: new Float64Array(matchedValues),
        times: new Float64Array(matchedTimes),
      }
    },
  }

  return rb
}

// ─── standalone helpers ───────────────────────────────────────────────────────

/**
 * Feed a batch of samples from a SimHost 'samples' event into a ring buffer.
 * `simTime` and `valueColumn` are parallel Float64Arrays from the event.
 * The two arrays are iterated together; shorter one limits the count.
 */
export function feedSamples(
  rb: RingBuffer,
  simTime: Float64Array,
  valueColumn: Float64Array,
): void {
  const n = Math.min(simTime.length, valueColumn.length)
  for (let i = 0; i < n; i++) {
    rb.append(valueColumn[i], simTime[i])
  }
}
