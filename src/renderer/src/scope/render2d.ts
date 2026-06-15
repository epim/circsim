/**
 * src/renderer/src/scope/render2d.ts — Task 23
 *
 * Pure (no DOM / no canvas) rendering math for the oscilloscope panel.
 * All functions are unit-testable in Node with synthetic data.
 *
 * Responsibilities:
 *   1. minMaxDecimate — collapse dense data into min/max per pixel column
 *   2. measureVpp / measureMean / measureFrequency — waveform measurements
 *   3. computeCursorDelta — ΔV / Δt / 1/Δt for two placed cursors
 *   4. autoScale — compute a nice voltage range for a trace
 *   5. timeToPixel — time → canvas X coordinate
 *   6. computeVisibleWindow — follow mode vs pause/scrub
 *   7. drawScope (optional canvas draw, used by Scope.tsx at runtime)
 *
 * Spec §11; plan Task 23.
 */

// ─── types ────────────────────────────────────────────────────────────────────

export interface DecimatedColumn {
  /** Per-pixel-column min values. Length = pixelWidth. */
  mins: Float64Array
  /** Per-pixel-column max values. Length = pixelWidth. */
  maxs: Float64Array
  /** Center time of each pixel column. Length = pixelWidth. */
  times: Float64Array
}

export interface CursorPoint {
  time: number
  value: number
}

export interface CursorDelta {
  deltaTime: number
  deltaValue: number
  /** 1/deltaTime, or null when deltaTime is 0. */
  frequency: number | null
}

export interface ScaleRange {
  vMin: number
  vMax: number
}

export interface VisibleWindowInput {
  mode: 'follow' | 'pause'
  /** Latest sim-time in the ring buffer (seconds). Used in follow mode. */
  latestTime?: number
  /** Scroll offset for pause mode (seconds from t=0). */
  scrollOffset?: number
  /** Seconds per division. */
  timePerDiv: number
  /** Number of horizontal divisions visible. */
  divCount: number
}

export interface VisibleWindow {
  tStart: number
  tEnd: number
}

// ─── minMaxDecimate ──────────────────────────────────────────────────────────

/**
 * Min/max decimation: collapse `times` + `values` arrays (dense, sorted by time)
 * into `pixelWidth` columns covering [tStart, tEnd].
 *
 * For each pixel column the output carries the minimum and maximum value seen
 * among all samples whose timestamp maps to that column. Rendering both creates
 * the "filled" waveform look without missing transients.
 *
 * If a column has no samples: min = max = NaN (caller may skip drawing).
 *
 * O(N) where N = number of input samples.
 */
export function minMaxDecimate(
  times: Float64Array,
  values: Float64Array,
  tStart: number,
  tEnd: number,
  pixelWidth: number,
): DecimatedColumn {
  const mins = new Float64Array(pixelWidth).fill(NaN)
  const maxs = new Float64Array(pixelWidth).fill(NaN)
  const colTimes = new Float64Array(pixelWidth)
  const tRange = tEnd - tStart

  // Precompute column center times.
  for (let c = 0; c < pixelWidth; c++) {
    colTimes[c] = tStart + (c + 0.5) * (tRange / pixelWidth)
  }

  if (tRange <= 0 || pixelWidth <= 0) return { mins, maxs, times: colTimes }

  const n = Math.min(times.length, values.length)
  for (let i = 0; i < n; i++) {
    const t = times[i]
    if (t < tStart || t > tEnd) continue
    // Map t → pixel column index
    const colF = ((t - tStart) / tRange) * pixelWidth
    const col = Math.min(Math.floor(colF), pixelWidth - 1)
    const v = values[i]
    if (isNaN(mins[col])) {
      mins[col] = v
      maxs[col] = v
    } else {
      if (v < mins[col]) mins[col] = v
      if (v > maxs[col]) maxs[col] = v
    }
  }

  return { mins, maxs, times: colTimes }
}

// ─── measurements ────────────────────────────────────────────────────────────

/**
 * Peak-to-peak voltage: max(values) - min(values).
 */
export function measureVpp(values: Float64Array): number {
  if (values.length === 0) return 0
  let min = values[0]
  let max = values[0]
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i]
    if (values[i] > max) max = values[i]
  }
  return max - min
}

/**
 * Arithmetic mean voltage.
 */
export function measureMean(values: Float64Array): number {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

/**
 * Frequency estimate using upward zero-crossing detection.
 *
 * Algorithm:
 *   1. Compute mean as the crossing reference (handles DC offset).
 *   2. Find all upward crossings: sample[i-1] < mean && sample[i] >= mean.
 *   3. Linearly interpolate each crossing time.
 *   4. Average period = (last crossing - first crossing) / (count - 1).
 *   5. Return 1/period.
 *
 * Returns null if fewer than 2 upward crossings are found (DC, too few samples,
 * or monotonic window).
 *
 * Accuracy: within 1% for synthetic sine waves at reasonable sample densities
 * (≥ 10 samples/period).
 */
export function measureFrequency(
  times: Float64Array,
  values: Float64Array,
): number | null {
  if (times.length < 2 || values.length < 2) return null
  const n = Math.min(times.length, values.length)
  const mean = measureMean(values.subarray(0, n))

  const crossingTimes: number[] = []

  for (let i = 1; i < n; i++) {
    const v0 = values[i - 1]
    const v1 = values[i]
    // Upward crossing: was below mean, now at or above
    if (v0 < mean && v1 >= mean) {
      // Linear interpolation for sub-sample accuracy
      const t0 = times[i - 1]
      const t1 = times[i]
      const frac = (mean - v0) / (v1 - v0)
      crossingTimes.push(t0 + frac * (t1 - t0))
    }
  }

  if (crossingTimes.length < 2) return null

  const firstCrossing = crossingTimes[0]
  const lastCrossing = crossingTimes[crossingTimes.length - 1]
  const nPeriods = crossingTimes.length - 1
  const period = (lastCrossing - firstCrossing) / nPeriods
  if (period <= 0) return null
  return 1 / period
}

// ─── cursor ───────────────────────────────────────────────────────────────────

/**
 * Compute ΔV / Δt / frequency between two cursor positions.
 */
export function computeCursorDelta(c1: CursorPoint, c2: CursorPoint): CursorDelta {
  const deltaTime = c2.time - c1.time
  const deltaValue = c2.value - c1.value
  const frequency = deltaTime !== 0 ? 1 / Math.abs(deltaTime) : null
  return { deltaTime, deltaValue, frequency }
}

// ─── autoscale ────────────────────────────────────────────────────────────────

/**
 * Compute a voltage display range for a trace with 10% margin.
 * If values are all equal (DC), adds ±0.5 V margin so the line is visible.
 */
export function autoScale(values: Float64Array): ScaleRange {
  if (values.length === 0) return { vMin: -1, vMax: 1 }
  let min = values[0]
  let max = values[0]
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i]
    if (values[i] > max) max = values[i]
  }
  const span = max - min
  if (span === 0) {
    // DC: add ±0.5 V margin so the line is at center
    return { vMin: min - 0.5, vMax: max + 0.5 }
  }
  const margin = span * 0.1
  return { vMin: min - margin, vMax: max + margin }
}

// ─── coordinate mapping ───────────────────────────────────────────────────────

/**
 * Map a time value to a pixel X coordinate within [0, width].
 */
export function timeToPixel(
  t: number,
  tStart: number,
  tEnd: number,
  width: number,
): number {
  if (tEnd === tStart) return 0
  return ((t - tStart) / (tEnd - tStart)) * width
}

/**
 * Map a voltage to a pixel Y coordinate (top = vMax, bottom = vMin).
 */
export function valueToPixel(
  v: number,
  vMin: number,
  vMax: number,
  height: number,
): number {
  if (vMax === vMin) return height / 2
  return height - ((v - vMin) / (vMax - vMin)) * height
}

// ─── visible window ───────────────────────────────────────────────────────────

/**
 * Compute the time window [tStart, tEnd] that should be displayed.
 *
 * Follow mode: window ends at latestTime; tStart = tEnd - windowDuration.
 *              If tEnd < windowDuration, tStart = 0 (don't go negative).
 * Pause mode:  window starts at scrollOffset, ends at scrollOffset + windowDuration.
 */
export function computeVisibleWindow(input: VisibleWindowInput): VisibleWindow {
  const windowDuration = input.timePerDiv * input.divCount

  if (input.mode === 'follow') {
    const latest = input.latestTime ?? 0
    const tEnd = latest
    const tStart = Math.max(0, tEnd - windowDuration)
    // If latest time is less than one window, show from 0 to windowDuration
    if (latest <= windowDuration) {
      return { tStart: 0, tEnd: windowDuration }
    }
    return { tStart, tEnd }
  } else {
    const tStart = input.scrollOffset ?? 0
    return { tStart, tEnd: tStart + windowDuration }
  }
}

// ─── 2D canvas draw (runtime only — not unit-tested) ─────────────────────────

export interface TraceSpec {
  /** Probe ID string (for keying ring buffers). */
  probeId: string
  /** CSS color string. */
  color: string
  /** Min voltage for Y scale. */
  vMin: number
  /** Max voltage for Y scale. */
  vMax: number
}

export interface ScopeDrawInput {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  tStart: number
  tEnd: number
  traces: {
    spec: TraceSpec
    decimated: DecimatedColumn
  }[]
  /** Cursor positions, if any (up to 2). */
  cursors?: CursorPoint[]
  /** If true, draw grid lines. */
  showGrid?: boolean
  /** Number of vertical divisions. Default 8. */
  vDivCount?: number
  /** Number of horizontal divisions. Default 10. */
  hDivCount?: number
}

/**
 * Draw all traces onto a 2D canvas context.
 * Called from Scope.tsx's requestAnimationFrame loop.
 * Pure rendering: no state mutation.
 */
export function drawScope(input: ScopeDrawInput): void {
  const {
    ctx,
    width,
    height,
    tStart,
    tEnd,
    traces,
    cursors = [],
    showGrid = true,
    vDivCount = 8,
    hDivCount = 10,
  } = input

  // ── background ────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0d1117'
  ctx.fillRect(0, 0, width, height)

  // ── grid ──────────────────────────────────────────────────────────────────
  if (showGrid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 1
    // Horizontal grid lines
    for (let d = 0; d <= vDivCount; d++) {
      const y = (d / vDivCount) * height
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    // Vertical grid lines
    for (let d = 0; d <= hDivCount; d++) {
      const x = (d / hDivCount) * width
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }
    // Center lines (slightly brighter)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    const cx = width / 2
    const cy = height / 2
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke()
  }

  // ── traces ────────────────────────────────────────────────────────────────
  for (const { spec, decimated } of traces) {
    const { mins, maxs } = decimated
    const pixelWidth = mins.length

    ctx.strokeStyle = spec.color
    ctx.lineWidth = 1.5
    ctx.beginPath()

    let pathStarted = false
    for (let col = 0; col < pixelWidth; col++) {
      if (isNaN(mins[col])) {
        pathStarted = false
        continue
      }
      const x = (col / pixelWidth) * width
      const yMin = valueToPixel(mins[col], spec.vMin, spec.vMax, height)
      const yMax = valueToPixel(maxs[col], spec.vMin, spec.vMax, height)
      if (!pathStarted) {
        ctx.moveTo(x, (yMin + yMax) / 2)
        pathStarted = true
      }
      if (Math.abs(yMax - yMin) < 1.5) {
        // Single-pixel height — just lineTo center
        ctx.lineTo(x, (yMin + yMax) / 2)
      } else {
        // Draw vertical line for min/max spread
        ctx.moveTo(x, yMin)
        ctx.lineTo(x, yMax)
      }
    }
    ctx.stroke()
  }

  // ── cursors ───────────────────────────────────────────────────────────────
  for (let ci = 0; ci < Math.min(cursors.length, 2); ci++) {
    const cursor = cursors[ci]
    const x = timeToPixel(cursor.time, tStart, tEnd, width)
    const cursorColor = ci === 0 ? '#f0c040' : '#40c0f0'
    ctx.strokeStyle = cursorColor
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.setLineDash([])
  }
}
