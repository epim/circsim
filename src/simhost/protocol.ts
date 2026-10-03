/**
 * src/simhost/protocol.ts
 *
 * SimHost ⇄ Renderer wire protocol — the most important interface in the app.
 * The SimCommand / SimEvent unions below are copied VERBATIM from Spec §6.1
 * (docs/superpowers/specs/2026-06-10-circsim-design.md). Do not "improve" them
 * here; this file is the single source of truth that both the renderer
 * (src/renderer) and SimHost (src/simhost) import.
 *
 * All messages are JSON-serializable EXCEPT sample payloads, which use
 * transferable Float64Array buffers.
 *
 * NOTE on `crashed`: a SimHost crash is NOT a SimEvent. When SimHost dies, its
 * MessagePort dies with it, so the crash notification cannot travel on this
 * channel — Main detects the process exit and notifies the renderer through the
 * contextBridge preload API (`onSimhostCrashed`, handled in Task 11). Do not add
 * a `crashed` member to SimEvent.
 */

// ─── renderer → simhost ──────────────────────────────────────────────────────

export type SimCommand =
  | { type: 'loadCircuit'; deckLines: string[] } // full SPICE deck, one card per line
  | { type: 'runTransient'; tstepSeconds: number; tstopSeconds: number }
  | { type: 'runOp' } // DC operating point
  | { type: 'runAc'; fStart: number; fStop: number; pointsPerDecade: number }
  | { type: 'alter'; device: string; param?: string; value: number | string }
  // device MUST be lowercased by sender; see §8.4 gotchas
  | { type: 'halt' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'setPace'; realtimeFactor: number | 'max' }
  // ADDITIVE (issue #25). `watch` names the vectors the renderer wants as a full
  // time series in every `samples` batch (the scope probes' nets, by ngspice
  // vector name). Every other saved vector is reported only as its newest value
  // in the batch's `latest` snapshot at display rate. Until the first `watch`,
  // every vector is watched (full series), which is what a finite-run consumer
  // such as SolveEngine.runTran needs; every `loadCircuit` resets it to that.
  // Sticky across bench-window restarts; send it after the deck is loaded and
  // again whenever the probe set changes.
  | { type: 'watch'; vectors: string[] }

// ─── simhost → renderer ──────────────────────────────────────────────────────

export type SimEvent =
  | { type: 'ready'; ngspiceVersion: string }
  // A rejected deck is not loaded. Pending solves fail cleanly; the next valid
  // load resets native state first when parsing left a partial circuit (#163).
  | { type: 'loadFailed'; detail: string }
  | { type: 'vectors'; names: string[] } // vector list after run starts
  | {
      type: 'samples'
      vectorNames: string[]
      columns: Float64Array[]
      simTime: Float64Array
      latest?: LatestSnapshot
    }
  // One batch per 16 ms sample tick (at most 4096 points per batch, extra ticks
  // run back to back while the plot is ahead). `vectorNames`/`columns` carry the
  // watched vectors' new points, all the same length as `simTime`.
  // `latest` (ADDITIVE, optional) carries the newest value of every other saved
  // vector, refreshed about every 33 ms while the run advances; absent on the
  // batches in between. Consumers that only tint or read a value need nothing else.
  | { type: 'opResult'; values: Record<string, number>; method?: OpSolveMethod }
  // KEY FORMAT (normative): node voltages keyed by the bare lowercase SPICE node name
  // ("out", never "v(out)" or "OUT"); source/device currents keyed "i(<device>)".
  // SimHost normalizes whatever vector names ngspice returns into this format.
  // `method` (ADDITIVE, optional for backward compatibility) names how the
  // operating point was obtained — see OpSolveMethod. Absent ⇒ unknown (treated
  // as a direct solve by consumers).
  | {
      type: 'acResult'
      freq: Float64Array
      vectors: Record<string, { mag: Float64Array; phaseDeg: Float64Array }>
    }
  // `running`: the run is live (false: finished, paused by the user, or ended on its own).
  // Pacing and alter halts of the ngspice thread do not make it false.
  | { type: 'status'; running: boolean; simTimeSeconds: number; realtimeFactor: number }
  | { type: 'benchRestarted'; reason: 'window-elapsed' | 'memory' } // see §7.5 bench windows
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string } // ngspice stdout/stderr lines
  | { type: 'convergenceFailure'; detail: string }

/** Newest values of the saved vectors that are not watched (see the `watch` command). */
export interface LatestSnapshot {
  /** Raw ngspice vector names, same spelling as `samples.vectorNames`. */
  vectorNames: string[]
  /** values[i] is the newest point of vectorNames[i]; NaN when it could not be read. */
  values: Float64Array
}

// ─── bench tstep ─────────────────────────────────────────────────────────────

/**
 * Upper bound requested by the live bench (issue #25). Source bandwidth and
 * recognised timing/feedback RC nodes can make the effective step finer;
 * ngspice refines further around edges. Shared so renderer requests and the
 * real-time tests agree, not a guarantee for opaque oscillator dynamics.
 */
export const BENCH_TSTEP_MAX_SECONDS = 5e-3

// ─── op solve method (Spec §8.8 retry ladder — additive extension) ───────────

/**
 * How a DC operating point was obtained (Spec §8.8 retry ladder + ngspice's own
 * internal fallbacks):
 *   - 'direct'        plain `op` converged with no fallback chatter
 *   - 'gmin'          converged only via gmin stepping
 *   - 'source'        converged only via source stepping (gmin failed first)
 *   - 'tran-fallback' converged only via ngspice's transient-op fallback
 *                     (OPTRAN — both gmin and source stepping failed)
 *   - 'failed'        no rung converged; the reported values are the last
 *                     attempt's and are NOT trustworthy
 * Anything but 'direct' means the voltages may be unreliable (a fallback solve
 * frequently reports 0.000 V on nets it could not really resolve) — the
 * renderer surfaces a visible caveat for those.
 */
export type OpSolveMethod = 'direct' | 'gmin' | 'source' | 'tran-fallback' | 'failed'

// ─── opResult key normalization helpers (Spec §6.1) ──────────────────────────

/**
 * Normalize a raw ngspice vector name into the canonical opResult key form
 * required by Spec §6.1:
 *   - node voltages → bare lowercase node name: "V(OUT)" / "out" / "OUT"  ⇒ "out"
 *   - device/source currents → "i(<device>)":
 *       ngspice exposes source branch currents as "<dev>#branch" (e.g. "v1#branch")
 *       and device-internal currents as "@<dev>[i]"; both map to "i(<dev>)".
 *   - the implicit "time" / "frequency" scale vectors are passed through lowercased.
 *
 * Returns `undefined` for vectors that should not appear in opResult
 * (e.g. internal scale-only vectors callers want to drop). Currently we keep
 * everything but the scale vectors are filtered by the caller.
 */
export function normalizeVectorKey(rawName: string): string {
  const name = rawName.trim()
  const lower = name.toLowerCase()

  // Source branch current: "v1#branch" → "i(v1)"
  const branchMatch = lower.match(/^(.+)#branch(?:_\d+_\d+)?$/)
  if (branchMatch) {
    return `i(${branchMatch[1]})`
  }

  // Device-internal current vector: "@r_r1[i]" → "i(r_r1)"
  const devCurrentMatch = lower.match(/^@(.+)\[i\]$/)
  if (devCurrentMatch) {
    return `i(${devCurrentMatch[1]})`
  }

  // Voltage wrapper: "v(out)" → "out"
  const vMatch = lower.match(/^v\((.+)\)$/)
  if (vMatch) {
    return vMatch[1]
  }

  // Bare node name (already a voltage) — just lowercase it.
  return lower
}

/**
 * True for the implicit independent-variable ("scale") vectors that op/ac/tran
 * runs always carry but which should not be reported as result values.
 */
export function isScaleVectorName(rawName: string): boolean {
  const lower = rawName.trim().toLowerCase()
  return lower === 'time' || lower === 'frequency' || lower === 'sweep'
}
