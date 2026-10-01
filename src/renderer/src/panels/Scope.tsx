/**
 * renderer/panels/Scope.tsx — Task 23
 *
 * Oscilloscope panel — multi-trace, autoscale, follow/pause, cursors.
 *
 * Architecture:
 *   - One RingBuffer per voltage-probe, owned and fed by the store
 *     (getProbeRingBuffer); the scope only reads them. Ring times are run
 *     time, shared by every ring and continuous across bench-window restarts
 *     (scope/benchTimeline.ts); the store resets the rings on a fresh run.
 *   - The latest time for follow mode is the newest stored time across the
 *     probe rings, read each frame (no per-batch listener, no net search).
 *   - Canvas is drawn each animation frame via requestAnimationFrame, calling
 *     drawScope from render2d.ts (pure function, no state).
 *   - Probe colors match the instrument definition in the store.
 *   - Follow mode + pause/scrub, time/div selector, per-trace autoscale.
 *   - Two cursors with ΔV/Δt readout.
 *
 * UI components are not headless-testable (need live DOM + canvas); the math
 * is covered by render2d.test.ts + ringBuffer.test.ts. Spec §11.
 */

import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
  useLayoutEffect,
} from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { AppState } from '../store/appStore'
import type { Instrument } from '../../../core/spicegen/instruments'
import {
  minMaxDecimate,
  measureVpp,
  measureMean,
  measureFrequency,
  computeCursorDelta,
  autoScale,
  computeVisibleWindow,
  drawScope,
  type CursorPoint,
} from '../scope/render2d'
import { TEXT_HINT } from '../ui/palette'

// ─── constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIME_PER_DIV = 0.001 // 1ms/div
const DEFAULT_H_DIVS = 10
const DEFAULT_V_DIVS = 8

const TIME_PER_DIV_OPTIONS = [
  { label: '1µs', value: 1e-6 },
  { label: '5µs', value: 5e-6 },
  { label: '10µs', value: 1e-5 },
  { label: '50µs', value: 5e-5 },
  { label: '100µs', value: 1e-4 },
  { label: '500µs', value: 5e-4 },
  { label: '1ms', value: 1e-3 },
  { label: '5ms', value: 5e-3 },
  { label: '10ms', value: 1e-2 },
  { label: '50ms', value: 5e-2 },
  { label: '100ms', value: 0.1 },
  { label: '500ms', value: 0.5 },
  { label: '1s', value: 1.0 },
  { label: '5s', value: 5.0 },
]

// ─── helpers ─────────────────────────────────────────────────────────────────

function probesFromState(s: AppState): Extract<Instrument, { kind: 'voltage-probe' }>[] {
  return s.instruments.filter(
    (i): i is Extract<Instrument, { kind: 'voltage-probe' }> => i.kind === 'voltage-probe',
  )
}

function formatTime(seconds: number): string {
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(2)} ns`
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(2)} µs`
  if (seconds < 1) return `${(seconds * 1e3).toFixed(2)} ms`
  return `${seconds.toFixed(4)} s`
}

function formatVoltage(v: number): string {
  if (Math.abs(v) < 0.001) return `${(v * 1000).toFixed(2)} mV`
  return `${v.toFixed(4)} V`
}

// ─── Scope component ─────────────────────────────────────────────────────────

interface ScopeState {
  mode: 'follow' | 'pause'
  scrollOffset: number
  timePerDiv: number
  cursors: [CursorPoint | null, CursorPoint | null]
  activeCursor: 0 | 1
}

const Scope: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const storeApi = useAppStoreApi()

  // Latest stored time across the probe rings (for follow mode). Updated each
  // frame. Mutable ref.
  const latestTimeRef = useRef<number>(0)
  // Animation frame handle
  const rafRef = useRef<number>(0)

  const [scopeState, setScopeState] = useState<ScopeState>({
    mode: 'follow',
    scrollOffset: 0,
    timePerDiv: DEFAULT_TIME_PER_DIV,
    cursors: [null, null],
    activeCursor: 0,
  })

  // Keep a ref for the scope state inside the RAF closure.
  const scopeStateRef = useRef(scopeState)
  useEffect(() => { scopeStateRef.current = scopeState }, [scopeState])

  // ── Canvas rendering loop ──────────────────────────────────────────────────
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { mode, timePerDiv, scrollOffset, cursors } = scopeStateRef.current
    const state = storeApi.getState()
    const probes = probesFromState(state)
    const width = canvas.width
    const height = canvas.height

    // Latest stored time across the probe rings. Rings hold run time, so this
    // keeps moving forward across bench-window restarts and returns to ~0 only
    // when the store resets the rings for a fresh run.
    let latest = 0
    for (const probe of probes) {
      const ring = state.getProbeRingBuffer(probe.id)
      if (ring && ring.length > 0 && ring.newestTime > latest) latest = ring.newestTime
    }
    latestTimeRef.current = latest

    // Compute visible window
    const win = computeVisibleWindow({
      mode,
      latestTime: latest,
      scrollOffset,
      timePerDiv,
      divCount: DEFAULT_H_DIVS,
    })

    // Build per-trace decimated data
    const tracesToDraw: {
      spec: { probeId: string; color: string; vMin: number; vMax: number }
      decimated: ReturnType<typeof minMaxDecimate>
    }[] = []

    for (const probe of probes) {
      const ring = state.getProbeRingBuffer(probe.id)
      if (!ring || ring.length === 0) continue

      // Read the visible window
      const { values, times } = ring.readWindow(win.tStart, win.tEnd)
      if (times.length === 0) continue

      // Per-trace autoscale
      const { vMin, vMax } = autoScale(values)

      const decimated = minMaxDecimate(times, values, win.tStart, win.tEnd, width)
      tracesToDraw.push({
        spec: { probeId: probe.id, color: probe.color, vMin, vMax },
        decimated,
      })
    }

    // Draw
    drawScope({
      ctx,
      width,
      height,
      tStart: win.tStart,
      tEnd: win.tEnd,
      traces: tracesToDraw,
      cursors: cursors.filter((c): c is CursorPoint => c !== null),
      showGrid: true,
      vDivCount: DEFAULT_V_DIVS,
      hDivCount: DEFAULT_H_DIVS,
    })

    rafRef.current = requestAnimationFrame(drawFrame)
  }, [storeApi])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(drawFrame)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [drawFrame])

  // ── Canvas sizing ──────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    })
    observer.observe(canvas)
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
    return () => observer.disconnect()
  }, [])

  // ── Probe info from store (reactive) ──────────────────────────────────────
  const probes = useApp(probesFromState)
  const circuit = useApp(s => s.circuit)

  // ── Measurements (computed once per frame in the RAF, exposed via state) ───
  // We compute measurements synchronously here since they're cheap.
  const measurements = React.useMemo(() => {
    const result: Record<string, { vpp: number; mean: number; freq: number | null }> = {}
    for (const probe of probes) {
      const ring = storeApi.getState().getProbeRingBuffer(probe.id)
      if (!ring || ring.length === 0) continue
      // Read all available data (up to last 1000 for quick measurement)
      const readLen = Math.min(ring.length, 1000)
      const { values, times } = ring.read(ring.length - readLen, readLen)
      result[probe.id] = {
        vpp: measureVpp(values),
        mean: measureMean(values),
        freq: measureFrequency(times, values),
      }
    }
    return result
  }, [probes, storeApi]) // re-compute when probes change; each frame measurement happens in RAF

  // ── Cursor handlers ────────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const { mode, timePerDiv, scrollOffset } = scopeStateRef.current

    const win = computeVisibleWindow({
      mode,
      latestTime: latestTimeRef.current,
      scrollOffset,
      timePerDiv,
      divCount: DEFAULT_H_DIVS,
    })

    const t = win.tStart + (x / canvas.width) * (win.tEnd - win.tStart)

    // Find a voltage at this time from the first probe
    let value = 0
    for (const probe of probes) {
      const ring = storeApi.getState().getProbeRingBuffer(probe.id)
      if (!ring || ring.length === 0) continue
      const { values: _wv } = ring.readWindow(t - 1e-6, t + 1e-6)
      if (_wv.length > 0) { value = _wv[0]; break }
    }

    setScopeState(prev => {
      const cursors: [CursorPoint | null, CursorPoint | null] = [...prev.cursors] as [CursorPoint | null, CursorPoint | null]
      cursors[prev.activeCursor] = { time: t, value }
      return {
        ...prev,
        cursors,
        activeCursor: prev.activeCursor === 0 ? 1 : 0,
      }
    })
  }, [probes, storeApi])

  // ── Cursor delta display ───────────────────────────────────────────────────
  const cursorDelta = React.useMemo(() => {
    const [c1, c2] = scopeState.cursors
    if (c1 && c2) return computeCursorDelta(c1, c2)
    return null
  }, [scopeState.cursors])

  // ── Render ─────────────────────────────────────────────────────────────────
  const noProbes = probes.length === 0

  return (
    <div style={styles.container}>
      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div style={styles.toolbar}>
        {/* Mode toggle */}
        <button
          style={{ ...styles.btn, ...(scopeState.mode === 'follow' ? styles.btnActive : {}) }}
          onClick={() => setScopeState(s => ({ ...s, mode: 'follow' }))}
          title="Follow latest data"
        >
          Follow
        </button>
        <button
          style={{ ...styles.btn, ...(scopeState.mode === 'pause' ? styles.btnActive : {}) }}
          onClick={() => setScopeState(s => ({ ...s, mode: 'pause' }))}
          title="Pause and scrub"
        >
          Pause
        </button>

        {/* Time/div selector */}
        <label style={styles.label}>Time/div:</label>
        <select
          style={styles.select}
          value={scopeState.timePerDiv}
          onChange={e => setScopeState(s => ({ ...s, timePerDiv: Number(e.target.value) }))}
        >
          {TIME_PER_DIV_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Scroll for pause mode */}
        {scopeState.mode === 'pause' && (
          <>
            <label style={styles.label}>Scroll:</label>
            <input
              type="range"
              min={0}
              max={Math.max(0, latestTimeRef.current - scopeState.timePerDiv * DEFAULT_H_DIVS)}
              step={scopeState.timePerDiv}
              value={scopeState.scrollOffset}
              onChange={e => setScopeState(s => ({ ...s, scrollOffset: Number(e.target.value) }))}
              style={{ width: 120 }}
            />
          </>
        )}

        {/* Cursor delta readout */}
        {cursorDelta && (
          <span style={styles.cursorReadout}>
            ΔT: {formatTime(Math.abs(cursorDelta.deltaTime))}
            {' | '}
            ΔV: {formatVoltage(cursorDelta.deltaValue)}
            {cursorDelta.frequency !== null && (
              <>{' | '}f: {cursorDelta.frequency < 1000
                ? `${cursorDelta.frequency.toFixed(1)} Hz`
                : `${(cursorDelta.frequency / 1000).toFixed(2)} kHz`}
              </>
            )}
          </span>
        )}

        {/* Clear cursors */}
        {(scopeState.cursors[0] || scopeState.cursors[1]) && (
          <button
            style={styles.btn}
            onClick={() => setScopeState(s => ({ ...s, cursors: [null, null], activeCursor: 0 }))}
          >
            Clear Cursors
          </button>
        )}

        <span style={styles.hint}>
          {noProbes ? 'Add voltage probes to see traces' : `${probes.length} trace${probes.length !== 1 ? 's' : ''} · Click to place cursor`}
        </span>
      </div>

      {/* ── Canvas ─────────────────────────────────────────────────────────── */}
      <div style={styles.canvasWrap}>
        <canvas
          ref={canvasRef}
          style={styles.canvas}
          onClick={handleCanvasClick}
          data-testid="scope-canvas"
        />
        {noProbes && (
          <div style={styles.emptyOverlay}>
            <span>No voltage probes attached.</span>
            <span>
              Add a V-Probe from the bench and drop its lead on a net, or click a
              net and press &ldquo;Probe this net&rdquo; in the bench.
            </span>
          </div>
        )}
      </div>

      {/* ── Trace list + measurements ────────────────────────────────────────── */}
      {!noProbes && (
        <div style={styles.traceList}>
          {probes.map(probe => {
            const m = measurements[probe.id]
            const netName = circuit?.nets.find(n => n.id === probe.netId)?.kicadName ?? String(probe.netId)
            return (
              <div key={probe.id} style={styles.traceRow}>
                <span style={{ ...styles.traceColor, background: probe.color }} />
                <span style={styles.traceName}>{netName}</span>
                {m ? (
                  <span style={styles.traceMeasurements}>
                    Vpp: {formatVoltage(m.vpp)} · Mean: {formatVoltage(m.mean)}
                    {m.freq !== null && <> · f: {m.freq < 1000 ? `${m.freq.toFixed(1)} Hz` : `${(m.freq / 1000).toFixed(2)} kHz`}</>}
                  </span>
                ) : (
                  <span style={styles.traceMeasurements}>Waiting for data…</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Module-level samples event emitter ──────────────────────────────────────
//
// As of Task 24 the store's `ingestSamples` dispatches raw 'samples' batches on
// this emitter. The Scope no longer subscribes (it reads the store-owned rings
// directly, issue #59); the emitter stays for other consumers. It lives in its own React-free
// module so the store can import it without pulling React into the store core. Re-exported here for existing import sites.

export { scopeSamplesEmitter } from '../scope/sampleEmitter'

// ─── styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#0d1117',
    color: '#c9d1d9',
    fontFamily: 'monospace',
    fontSize: 12,
    userSelect: 'none',
  },
  toolbar: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderBottom: '1px solid #30363d',
    background: '#161b22',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  btn: {
    padding: '2px 10px',
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
  },
  btnActive: {
    background: '#1f6feb',
    borderColor: '#388bfd',
    color: '#fff',
  },
  label: {
    color: '#8b949e',
    fontSize: 11,
  },
  select: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '1px 4px',
    fontSize: 11,
  },
  cursorReadout: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '2px 8px',
    color: '#f0c040',
    fontSize: 11,
  },
  hint: {
    marginLeft: 'auto',
    color: TEXT_HINT,
    fontSize: 11,
  },
  canvasWrap: {
    position: 'relative',
    flex: '1 1 auto',
    overflow: 'hidden',
    minHeight: 0,
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
    cursor: 'crosshair',
  },
  emptyOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    color: TEXT_HINT,
    fontSize: 13,
    pointerEvents: 'none',
  },
  traceList: {
    flexShrink: 0,
    borderTop: '1px solid #30363d',
    background: '#161b22',
    padding: '4px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 80,
    overflowY: 'auto',
  },
  traceRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 20,
  },
  traceColor: {
    width: 12,
    height: 12,
    borderRadius: 2,
    flexShrink: 0,
    border: '1px solid rgba(255,255,255,0.15)',
  },
  traceName: {
    fontWeight: 'bold',
    color: '#c9d1d9',
    minWidth: 60,
  },
  traceMeasurements: {
    color: '#8b949e',
    fontSize: 11,
  },
}

export default Scope
