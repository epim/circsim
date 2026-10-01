/**
 * src/renderer/src/scope/ringBuffer.ts — Task 23
 *
 * Per-probe Float64Array ring buffer. Default capacity = 1M points.
 *
 * Design requirements (Spec §11, plan Task 23):
 *   - O(1) append: write to head index, increment, wrap. No allocation per push.
 *   - Windowed read: read(offset, length) returns logical window as Float64Array
 *     copies, handling the wrap-around transparently.
 *   - readWindow(tStart, tEnd): time-based window, binary search over the
 *     (monotonic) time ring, O(log n + k) for k points in the window. A
 *     bench-window restart (time goes backwards) starts a new acquisition: the
 *     ring is cleared, so every ring on a run shares the raw sim timeline.
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

  /** Stored time of the newest sample, or NaN when empty. */
  readonly newestTime: number

  /**
   * Append one (value, time) sample, O(1). `time` is raw sim seconds and is
   * stored as given. When it goes backwards (bench-window restart: ngspice
   * restarts the transient at t = 0) the ring is cleared first, so stored times
   * are always non-decreasing and agree with every other ring on the run,
   * including rings created after the restart.
   */
  append(value: number, time: number): void
  /**
   * Read `length` samples starting at logical `offset` (0 = oldest).
   * Returns copied Float64Arrays; handles wrap-around.
   */
  read(offset: number, length: number): { values: Float64Array; times: Float64Array }
  /**
   * Read all samples with timestamp in [tStart, tEnd] (inclusive), as copies.
   * Cost is O(log n + k), independent of how many samples the ring holds.
   */
  readWindow(tStart: number, tEnd: number): { values: Float64Array; times: Float64Array }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Smallest logical index in [0, n) whose time satisfies `pred`, or n if none.
 * `pred` must be monotone over the (non-decreasing) times: false then true.
 */
function firstLogicalIndex(
  timeAt: (logical: number) => number,
  n: number,
  pred: (t: number) => boolean,
): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (pred(timeAt(mid))) hi = mid
    else lo = mid + 1
  }
  return lo
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
  // Newest appended time, to detect a bench-window restart (see append).
  let lastTime = 0

  const rb: RingBuffer = {
    get valueRing() { return valueRing },
    get timeRing() { return timeRing },
    get capacity() { return capacity },
    get length() { return length },
    set length(v) { length = v },
    get newestTime() {
      return length === 0 ? Number.NaN : timeRing[(head - 1 + capacity) % capacity]
    },
    get head() { return head },
    set head(v) { head = v },

    append(value: number, time: number): void {
      // A time regression is a new bench window: ngspice restarts the transient
      // at t = 0 (Spec 7.5). Start a new acquisition. Shifting the new epoch
      // instead would need the offset to be shared by every ring on the run
      // (a probe added or rewired after the restart creates its ring with raw
      // times), so the ring is cleared and all rings stay on raw sim time.
      if (length > 0 && time < lastTime) {
        length = 0
        head = 0
      }
      lastTime = time
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
      if (length === 0 || tStart > tEnd) {
        return { values: new Float64Array(0), times: new Float64Array(0) }
      }
      // Times are non-decreasing in logical order (append clears the ring on a
      // regression), so the window is a contiguous logical run [lo, hi).
      const oldestIdx = (head - length + capacity) % capacity
      const timeAt = (logical: number): number => timeRing[(oldestIdx + logical) % capacity]
      const lo = firstLogicalIndex(timeAt, length, (t) => t >= tStart)
      const hi = firstLogicalIndex(timeAt, length, (t) => t > tEnd)
      const count = hi - lo
      if (count <= 0) {
        return { values: new Float64Array(0), times: new Float64Array(0) }
      }
      const out_v = new Float64Array(count)
      const out_t = new Float64Array(count)
      // At most two physical segments (the run may straddle the wrap point).
      const start = (oldestIdx + lo) % capacity
      const firstLen = Math.min(count, capacity - start)
      out_v.set(valueRing.subarray(start, start + firstLen), 0)
      out_t.set(timeRing.subarray(start, start + firstLen), 0)
      if (firstLen < count) {
        out_v.set(valueRing.subarray(0, count - firstLen), firstLen)
        out_t.set(timeRing.subarray(0, count - firstLen), firstLen)
      }
      return { values: out_v, times: out_t }
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
