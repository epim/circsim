/**
 * core/critic/checks/thermal.ts
 *
 * First-order thermal-proxy audit. HONESTY-SENSITIVE: this produces a RELATIVE
 * heat-spread proxy in arbitrary units — it is NOT an absolute temperature in
 * °C. Titles and details deliberately say "relative thermal proxy" and report
 * watts plus a unitless proxy value, never a fabricated temperature.
 *
 * Model (2D steady-state heat-spread proxy):
 *   - Lay a grid over the board bounding box.
 *   - Deposit each powered part's dissipation P (W) into the cell under its
 *     footprint position as a source field q.
 *   - Relax a field T (init 0) with fixed T=0 boundary using Jacobi iteration:
 *       T_new = (T_up + T_down + T_left + T_right)/4 + k·q,  k = 0.25
 *     for a fixed number of sweeps. This approximates ∇²T ∝ −q; the resulting
 *     values are a relative spreading proxy, NOT °C.
 *   - The warmest part (highest sampled proxy) gets an 'info' finding; nearby
 *     high-power pairs get 'warn' hot-cluster findings.
 *
 * Needs an operating-point sim (registry `needs:'op'`) for `partPower`. Pure
 * core; deterministic (parts iterated in stable order, fixed sweep count).
 */

import type { Finding } from '../types'
import type { CriticContext } from '../context'
import type { Footprint, Vec2 } from '../../kicad/types'

/** Jacobi relaxation sweeps. */
const SWEEPS = 300
/** Source coupling constant in the relaxation update. */
const K = 0.25
/** Target cell size (mm) used to choose the grid resolution. */
const CELL_TARGET_MM = 2
const COLS_MIN = 8
const COLS_MAX = 64
/** A pair counts as a "hot cluster" if combined power exceeds this (W). */
const CLUSTER_MIN_W = 0.5
/** Proximity fraction of the larger board dimension. */
const CLUSTER_FRACTION = 0.15
/** Cap on emitted hot-cluster pairs. */
const MAX_CLUSTERS = 10

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Bounding box of the board outline outer points; falls back to part positions. */
function boardBounds(ctx: CriticContext, positions: Vec2[]): Bounds | undefined {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of ctx.board.outline.outer) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!isFinite(minX)) {
    for (const p of positions) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!isFinite(minX) || maxX <= minX || maxY <= minY) return undefined
  return { minX, minY, maxX, maxY }
}

interface Powered {
  ref: string
  watts: number
  pos: Vec2
  /** Grid cell, or undefined when off-grid. */
  row?: number
  col?: number
  proxy?: number
}

function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export function checkThermal(ctx: CriticContext): Finding[] {
  const powers = ctx.opResult?.partPower
  if (!powers) return []

  // ── powered parts with geometry, in stable (ref-sorted) order ────────────────
  const powered: Powered[] = []
  for (const ref of Object.keys(powers).sort()) {
    const watts = powers[ref]
    if (!(watts > 0)) continue
    const fp: Footprint | undefined = ctx.refToFootprint.get(ref)
    if (!fp) continue
    powered.push({ ref, watts, pos: { x: fp.at.x, y: fp.at.y } })
  }
  if (powered.length === 0) return []

  const bounds = boardBounds(
    ctx,
    powered.map((p) => p.pos),
  )
  if (!bounds) return []

  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const cols = clamp(Math.round(width / CELL_TARGET_MM), COLS_MIN, COLS_MAX)
  const rows = clamp(Math.round(height / CELL_TARGET_MM), COLS_MIN, COLS_MAX)
  const cellW = width / cols
  const cellH = height / rows

  // ── source field q[r][c] ─────────────────────────────────────────────────────
  const q: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (const p of powered) {
    const col = Math.floor((p.pos.x - bounds.minX) / cellW)
    const row = Math.floor((p.pos.y - bounds.minY) / cellH)
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue // off-grid
    p.col = col
    p.row = row
    q[row][col] += p.watts
  }

  // ── Jacobi relaxation with fixed T=0 boundary ───────────────────────────────
  let T: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  let Tn: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let s = 0; s < SWEEPS; s++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Boundary cells stay pinned at 0 (ambient reference).
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
          Tn[r][c] = 0
          continue
        }
        Tn[r][c] = (T[r - 1][c] + T[r + 1][c] + T[r][c - 1] + T[r][c + 1]) / 4 + K * q[r][c]
      }
    }
    const tmp = T
    T = Tn
    Tn = tmp
  }

  // ── sample proxy per powered part ────────────────────────────────────────────
  for (const p of powered) {
    if (p.row === undefined || p.col === undefined) continue
    p.proxy = T[p.row][p.col]
  }

  const findings: Finding[] = []
  const ASSUMPTION = 'first-order 2D heat-spread proxy; relative units, not absolute °C'

  // ── warmest-part info ────────────────────────────────────────────────────────
  let warmest: Powered | undefined
  for (const p of powered) {
    if (p.proxy === undefined) continue
    if (!warmest || p.proxy > (warmest.proxy ?? -Infinity)) warmest = p
  }
  if (warmest && warmest.proxy !== undefined) {
    const w = warmest.watts
    findings.push({
      id: `thermal:warmest:${warmest.ref}`,
      check: 'thermal',
      severity: 'info',
      title: `${warmest.ref} is the warmest part (~${w}W, relative thermal proxy)`,
      detail:
        `${warmest.ref} dissipates about ${w} W and sits at the peak of a first-order 2D ` +
        `heat-spread proxy (value ${warmest.proxy.toFixed(3)}, arbitrary units). This is a ` +
        `relative comparison of where heat concentrates — it is NOT an absolute temperature ` +
        `in °C and does not account for copper pour, layer stack, airflow, or thermal vias.`,
      assumption: ASSUMPTION,
      refs: [warmest.ref],
      location: { x: warmest.pos.x, y: warmest.pos.y },
      metrics: { watts: w, proxy: warmest.proxy },
    })
  }

  // ── hot-cluster warns: powered pairs that are close AND jointly hot ──────────
  const maxDim = Math.max(width, height)
  const proximity = maxDim * CLUSTER_FRACTION
  let clusters = 0
  for (let i = 0; i < powered.length && clusters < MAX_CLUSTERS; i++) {
    for (let j = i + 1; j < powered.length && clusters < MAX_CLUSTERS; j++) {
      const a = powered[i]
      const b = powered[j]
      const combinedW = a.watts + b.watts
      if (combinedW <= CLUSTER_MIN_W) continue
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y)
      if (d > proximity) continue
      const [refA, refB] = [a.ref, b.ref].sort()
      findings.push({
        id: `thermal:cluster:${refA}:${refB}`,
        check: 'thermal',
        severity: 'warn',
        title: `${refA} and ${refB} are hot and close together`,
        detail:
          `${refA} and ${refB} together dissipate about ${combinedW.toFixed(2)} W and sit only ` +
          `${d.toFixed(1)} mm apart (within ${(CLUSTER_FRACTION * 100).toFixed(0)}% of the board's ` +
          `larger dimension). Closely-spaced hot parts reinforce each other in this first-order ` +
          `heat-spread proxy; this is a relative placement concern, not an absolute °C prediction.`,
        assumption: ASSUMPTION,
        refs: [refA, refB],
        location: mid(a.pos, b.pos),
        suggestion: 'Spread high-power parts apart or add copper/thermal relief.',
        metrics: { combinedW },
      })
      clusters++
    }
  }

  return findings
}
