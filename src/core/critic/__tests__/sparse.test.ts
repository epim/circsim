/**
 * core/critic/__tests__/sparse.test.ts
 *
 * The sparse nodal solver that replaced the dense Gaussian elimination in the
 * IR-drop check (issue #10). Checked against closed forms and against a small
 * dense solve written here, then for scale.
 */

import { describe, it, expect } from 'vitest'
import { solveNodal, type NodalSystem } from '../sparse'

function system(n: number, edges: [number, number, number][]): NodalSystem {
  return {
    n,
    a: Int32Array.from(edges.map((e) => e[0])),
    b: Int32Array.from(edges.map((e) => e[1])),
    g: Float64Array.from(edges.map((e) => e[2])),
  }
}

/** Reference: dense Gaussian elimination on the reduced system. */
function denseSolve(n: number, edges: [number, number, number][], ref: number, inject: number[]): number[] {
  const idx = [...Array(n).keys()].filter((k) => k !== ref)
  const pos = new Map(idx.map((k, i) => [k, i]))
  const m = idx.length
  const A = Array.from({ length: m }, () => new Array<number>(m + 1).fill(0))
  for (const [a, b, g] of edges) {
    const ia = pos.get(a)
    const ib = pos.get(b)
    if (ia !== undefined) A[ia][ia] += g
    if (ib !== undefined) A[ib][ib] += g
    if (ia !== undefined && ib !== undefined) {
      A[ia][ib] -= g
      A[ib][ia] -= g
    }
  }
  idx.forEach((k, i) => (A[i][m] = inject[k]))
  for (let c = 0; c < m; c++) {
    let p = c
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k]
    }
  }
  const x = new Array<number>(m).fill(0)
  for (let r = m - 1; r >= 0; r--) {
    let s = A[r][m]
    for (let k = r + 1; k < m; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  const out = new Array<number>(n).fill(0)
  idx.forEach((k, i) => (out[k] = x[i]))
  return out
}

describe('solveNodal', () => {
  it('solves one resistor: 2 A injected through 1 ohm to the reference is 2 V', () => {
    const v = solveNodal(system(2, [[0, 1, 1]]), 0, Float64Array.from([0, 2]))
    expect(v).not.toBeNull()
    expect(v![0]).toBe(0)
    expect(v![1]).toBeCloseTo(2, 12)
  })

  it('solves a divider: a 1 A injection into the middle of 1 + 3 ohms', () => {
    // ref - 1 ohm - n1 - 3 ohm - n2 ; 1 A into n2: v(n1) = 1, v(n2) = 4
    const v = solveNodal(system(3, [[0, 1, 1], [1, 2, 1 / 3]]), 0, Float64Array.from([0, 0, 1]))
    expect(v![1]).toBeCloseTo(1, 10)
    expect(v![2]).toBeCloseTo(4, 10)
  })

  it('takes a negative injection (a source on the net) as the opposite sign', () => {
    const v = solveNodal(system(2, [[0, 1, 2]]), 0, Float64Array.from([0, -1]))
    expect(v![1]).toBeCloseTo(-0.5, 12)
  })

  it('agrees with a dense solve on a 7 x 7 grid with mixed conductances', () => {
    const W = 7
    const edges: [number, number, number][] = []
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x
        if (x + 1 < W) edges.push([k, k + 1, 10 ** (rnd() * 4 - 1)])
        if (y + 1 < W) edges.push([k, k + W, 10 ** (rnd() * 4 - 1)])
      }
    }
    const inject = new Array<number>(W * W).fill(0)
    inject[W * W - 1] = 3
    inject[W + 2] = -1.5
    inject[20] = 0.25
    const want = denseSolve(W * W, edges, 0, inject)
    const got = solveNodal(system(W * W, edges), 0, Float64Array.from(inject))!
    for (let k = 0; k < W * W; k++) expect(got[k]).toBeCloseTo(want[k], 9)
  })

  it('is exact on a resistor chain (V = I x R for every prefix)', () => {
    const n = 500
    const edges: [number, number, number][] = []
    for (let k = 0; k + 1 < n; k++) edges.push([k, k + 1, 1 / 0.002]) // 2 mOhm each
    const inject = new Float64Array(n)
    inject[n - 1] = 5
    const v = solveNodal(system(n, edges), 0, inject)!
    expect(v[n - 1]).toBeCloseTo(5 * 0.002 * (n - 1), 9)
    expect(v[250]).toBeCloseTo(5 * 0.002 * 250, 9)
  })

  it('returns null, not garbage, for a component with no path to the reference', () => {
    // node 2 and 3 are joined to each other but not to the reference
    const v = solveNodal(system(4, [[0, 1, 1], [2, 3, 1]]), 0, Float64Array.from([0, 0, 1, 0]))
    expect(v).toBeNull()
  })

  /** Build a W x W sheet: left column tied to node 0, 1 mA drawn from every right-column node. */
  function sheet(W: number) {
    const edges: [number, number, number][] = []
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x
        if (x + 1 < W) edges.push([k, k + 1, 2000])
        if (y + 1 < W) edges.push([k, k + W, 2000])
      }
    }
    // Reference: the whole left column, tied together by stiff links to node 0.
    for (let y = 1; y < W; y++) edges.push([0, y * W, 1e6])
    // Load: the whole right column, each node drawing 1 mA. By symmetry every row
    // carries its own 1 mA and no current crosses rows, so the drop along a row is
    // 1 mA x (W - 1) links / 2000 S.
    const inject = new Float64Array(W * W)
    for (let y = 0; y < W; y++) inject[y * W + W - 1] = 0.001
    return { sys: system(W * W, edges), inject }
  }

  /** Best-of-N wall time (ms) for one solve, plus the last result. */
  function timeSolve(W: number, reps: number) {
    const { sys, inject } = sheet(W)
    let best = Infinity
    let v: Float64Array | null = null
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now()
      v = solveNodal(sys, 0, inject)
      best = Math.min(best, performance.now() - t0)
    }
    return { best, v: v! }
  }

  it('solves a 200 x 200 sheet (40 000 nodes) to the closed form, scaling far below dense elimination', () => {
    const W = 200
    const small = timeSolve(50, 5)
    const big = timeSolve(W, 1)
    const v = big.v
    expect(v[W - 1]).toBeCloseTo((0.001 * (W - 1)) / 2000, 7)
    expect(v[(W - 1) * W + W - 1]).toBeCloseTo((0.001 * (W - 1)) / 2000, 7)
    // No absolute millisecond bound: CI runners are up to 5x slower than a dev
    // machine, so the test compares two sizes on the same machine instead. Going
    // from 50 x 50 to 200 x 200 multiplies nodes by 16. The conjugate gradient
    // here needs about W iterations of W^2 edges each, so about 4^3 = 64x the
    // time; the dense elimination this replaced is n^3 = 16^3 = 4096x. A ratio
    // under 600 passes with roughly 10x headroom over the expected scaling and
    // still fails on cubic-in-nodes (or even quadratic-in-nodes plus overhead
    // growth) regressions. Both sides run on the same runner, so its speed cancels.
    const ratio = big.best / Math.max(small.best, 0.05)
    expect(ratio).toBeLessThan(600)
  })
})
