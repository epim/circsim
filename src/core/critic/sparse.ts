/**
 * core/critic/sparse.ts
 *
 * Sparse nodal solver for the copper resistive graph. The conductance matrix of
 * a resistor network with one node held at 0 V is symmetric positive definite,
 * so a Jacobi-preconditioned conjugate gradient over typed arrays solves it in
 * O(iterations x edges) time and O(nodes + edges) memory. The dense
 * Gaussian elimination this replaces cost O(n^3) time and an n x n allocation
 * and was the reason pours could not be meshed into the graph (issue #10).
 *
 * Pure core; deterministic (no randomness, fixed iteration order).
 */

export interface NodalSystem {
  /** Node count. */
  n: number
  /** Edge endpoints (indices into 0..n-1), parallel arrays. */
  a: Int32Array
  b: Int32Array
  /** Edge conductance (siemens), > 0. */
  g: Float64Array
}

/**
 * Solve G v = i for node voltages, node `ref` held at 0 V.
 *
 * `inject[k]` is the current (A) injected INTO node k; the reference node
 * absorbs whatever balances it. Every node must be connected to `ref` through
 * the edges (the caller restricts the system to the reference's component): a
 * floating component makes the matrix singular and the result null.
 *
 * Returns the node voltages (v[ref] = 0), or null when the iteration does not
 * converge or produces a non-finite value. Never throws.
 */
export function solveNodal(sys: NodalSystem, ref: number, inject: Float64Array): Float64Array | null {
  const { n, a, b, g } = sys
  const m = a.length
  if (n === 0) return new Float64Array(0)
  if (ref < 0 || ref >= n) return null

  // Diagonal: sum of incident conductances (edges to the reference count: they
  // ground the node).
  const diag = new Float64Array(n)
  for (let e = 0; e < m; e++) {
    diag[a[e]] += g[e]
    diag[b[e]] += g[e]
  }

  // Work on the reduced system: the reference row and column are dropped, which
  // is the same as forcing x[ref] = 0 through every matvec and dot product.
  const rhs = new Float64Array(inject)
  rhs[ref] = 0
  let bNorm2 = 0
  for (let k = 0; k < n; k++) bNorm2 += rhs[k] * rhs[k]
  const x = new Float64Array(n)
  if (bNorm2 === 0) return x

  const matvec = (p: Float64Array, out: Float64Array): void => {
    for (let k = 0; k < n; k++) out[k] = diag[k] * p[k]
    for (let e = 0; e < m; e++) {
      const i = a[e]
      const j = b[e]
      out[i] -= g[e] * p[j]
      out[j] -= g[e] * p[i]
    }
    out[ref] = 0
  }

  const r = new Float64Array(rhs) // x = 0, so r = b
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const ap = new Float64Array(n)
  const precondition = (src: Float64Array, dst: Float64Array): void => {
    for (let k = 0; k < n; k++) dst[k] = k !== ref && diag[k] > 0 ? src[k] / diag[k] : 0
  }
  precondition(r, z)
  p.set(z)
  let rz = 0
  for (let k = 0; k < n; k++) rz += r[k] * z[k]

  const tol2 = 1e-24 * bNorm2
  const maxIter = Math.min(50000, 10 * n + 200)
  let rNorm2 = bNorm2
  for (let it = 0; it < maxIter && rNorm2 > tol2; it++) {
    matvec(p, ap)
    let pap = 0
    for (let k = 0; k < n; k++) pap += p[k] * ap[k]
    if (!(pap > 0)) return null // not positive definite: floating component
    const alpha = rz / pap
    rNorm2 = 0
    for (let k = 0; k < n; k++) {
      x[k] += alpha * p[k]
      r[k] -= alpha * ap[k]
      rNorm2 += r[k] * r[k]
    }
    precondition(r, z)
    let rzNew = 0
    for (let k = 0; k < n; k++) rzNew += r[k] * z[k]
    const beta = rzNew / rz
    rz = rzNew
    for (let k = 0; k < n; k++) p[k] = z[k] + beta * p[k]
  }
  // Accept a solve within 1e-9 relative residual even if the tight target was
  // not reached (badly scaled meshes); reject anything looser.
  if (!(rNorm2 <= 1e-18 * bNorm2)) return null
  for (let k = 0; k < n; k++) if (!Number.isFinite(x[k])) return null
  return x
}
