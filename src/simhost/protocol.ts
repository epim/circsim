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

// ─── simhost → renderer ──────────────────────────────────────────────────────

export type SimEvent =
  | { type: 'ready'; ngspiceVersion: string }
  | { type: 'vectors'; names: string[] } // vector list after run starts
  | { type: 'samples'; vectorNames: string[]; columns: Float64Array[]; simTime: Float64Array }
  // batched: flushed every 16 ms or 4096 points, whichever first
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
  | { type: 'status'; running: boolean; simTimeSeconds: number; realtimeFactor: number }
  | { type: 'benchRestarted'; reason: 'window-elapsed' | 'memory' } // see §7.5 bench windows
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string } // ngspice stdout/stderr lines
  | { type: 'convergenceFailure'; detail: string }

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
