/**
 * core/critic/solvedCurrents.ts
 *
 * Branch currents for the Board Critic, taken from the solve (issues #9, #45).
 * The operating point ngspice returns holds node voltages and the branch
 * current of every voltage source, but no current for a resistor, a regulator
 * or an IC. Before this module the critic got LED sense currents only, so
 * every other load on a rail was invisible to the copper checks.
 *
 * What is derived, in order:
 *
 *   1. Measured parts, exactly: a resistor's current is (V1 - V2) / R from the
 *      solved node voltages, a capacitor carries nothing at DC, and an LED's
 *      current is its 0 V sense ammeter's branch current (the `vsense_<ref>`
 *      line in the deck names the anode node).
 *   2. Bench and deck elements that touch the board's nets but belong to no part
 *      (supply series resistors, pots, floating-island bleeds) are read off the
 *      top level of the deck, from the same node voltages. They inject or draw
 *      current at a net but are not on any pad.
 *   3. Every other part that can carry current (subcircuit ICs, regulators,
 *      transistors, digital chips) gets its pad currents from Kirchhoff's
 *      current law: at each net the currents into all parts sum to zero, and
 *      each part's own pad currents sum to zero. Where a net has exactly one
 *      unknown part pad, the law fixes it; fixing one can fix the next, so the
 *      pass repeats until nothing more resolves. The ground node's own equation
 *      is left out: it is the sum of all the others, and bench return currents
 *      (voltage sources wired to node 0) enter it.
 *
 * What cannot be resolved (two unknown parts share every net they touch, for
 * example two ICs on one rail with nothing measured between them) is returned in
 * `unresolvedRefs`, never as zero: the critic names those parts in its
 * not-assessed line. Parts the deck does not model (open stubs, documented-open
 * parts, unresolved parts) carry no current by construction.
 *
 * This is the pre-copper-aware solve: the deck still treats each net as one
 * ideal node, so a current here is the current that net would carry if its
 * copper were perfect. W2.1 (#20) puts the copper into the deck; this module is
 * the seam the critic reads until then.
 *
 * Pure core; deterministic.
 */

import type { Part } from '../netlist/extract'
import type { Resolution } from '../models/types'
import type { SolveInputs, SolveResult } from '../solve/types'
import { ledSenseName } from '../spicegen/generate'

export interface SolvedCurrents {
  /** ref to pad number to signed amps drawn from the pad's net into the part. */
  padCurrents: Record<string, Record<string, number>>
  /** ref to the part's through current: the largest pad current magnitude. */
  partCurrents: Record<string, number>
  /** Parts that may carry current but whose pad currents KCL could not resolve. */
  unresolvedRefs: string[]
}

/** |I| below this (A) is numerical noise from the op tolerances and reads as zero. */
const NOISE_A = 1e-12

const SPICE_SUFFIX: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
}

/** A SPICE number ("4.7k", "1e-06", "10meg"), or NaN. */
export function parseSpiceNumber(token: string | undefined): number {
  if (token === undefined) return Number.NaN
  const m = token.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)/i)
  if (!m) return Number.NaN
  const base = Number(m[1])
  const suffix = m[2].toLowerCase()
  if (suffix === '') return base
  for (const key of ['meg', 't', 'g', 'k', 'm', 'u', 'n', 'p', 'f']) {
    if (suffix.startsWith(key)) return base * SPICE_SUFFIX[key]
  }
  return base // unit letters such as "ohm" or "v"
}

type Draws = Map<number, number> // netId to amps drawn from that net into the part

export function deriveSolvedCurrents(
  inputs: Pick<SolveInputs, 'circuit' | 'resolutions'>,
  solve: Pick<SolveResult, 'op' | 'deck'>,
): SolvedCurrents {
  const { circuit, resolutions } = inputs
  const values = solve.op.values
  const netOfNode = new Map<string, number>()
  for (const net of circuit.nets) netOfNode.set(net.spiceNode, net.id)
  const groundNet = circuit.nets.find((n) => n.spiceNode === '0')?.id

  const volts = (node: string): number | undefined => {
    if (node === '0') return 0
    const v = values[node.toLowerCase()]
    return v !== undefined && Number.isFinite(v) ? v : undefined
  }
  const branch = (name: string): number | undefined => {
    const v = values[`i(${name.toLowerCase()})`]
    return v !== undefined && Number.isFinite(v) ? v : undefined
  }

  const partByRefLc = new Map<string, Part>()
  for (const p of circuit.parts) partByRefLc.set(p.ref.toLowerCase(), p)
  const resByRef = new Map<string, Resolution>()
  for (const r of resolutions) resByRef.set(r.ref, r)

  // ── top level of the deck: LED sense lines and elements owned by no part ───
  const primitiveNames = new Set<string>()
  for (const r of resolutions) {
    if (r.model?.kind === 'primitive') primitiveNames.add(r.model.card.trim().split(/\s+/)[0].toLowerCase())
  }
  const ledAnodeNode = new Map<string, string>() // ref lowercase to the anode deck node
  const external = new Map<number, number>() // netId to amps the deck's own elements draw
  const tainted = new Set<number>() // nets an unreadable external element touches
  const addExternal = (node: string, amps: number): void => {
    const net = netOfNode.get(node)
    if (net !== undefined) external.set(net, (external.get(net) ?? 0) + amps)
  }
  let depth = 0
  for (const raw of solve.deck) {
    const line = raw.trim()
    if (line === '' || line.startsWith('*') || line.startsWith('+')) continue
    const low = line.toLowerCase()
    if (low.startsWith('.subckt')) depth++
    else if (low.startsWith('.ends')) depth = Math.max(0, depth - 1)
    if (depth > 0 || line.startsWith('.')) continue
    const tok = line.split(/\s+/)
    const name = tok[0].toLowerCase()
    const sensePrefix = ledSenseName('')
    if (name.startsWith(sensePrefix)) {
      ledAnodeNode.set(name.slice(sensePrefix.length), tok[1])
      continue
    }
    if (name[0] === 'r' && !primitiveNames.has(name) && !name.startsWith('r_stub_')) {
      const r = parseSpiceNumber(tok[3])
      const v1 = volts(tok[1])
      const v2 = volts(tok[2])
      if (!(r > 0) || v1 === undefined || v2 === undefined) {
        for (const node of [tok[1], tok[2]]) {
          const net = netOfNode.get(node)
          if (net !== undefined) tainted.add(net)
        }
        continue
      }
      const amps = (v1 - v2) / r
      addExternal(tok[1], amps)
      addExternal(tok[2], -amps)
    }
  }

  // ── per part: measured draws, or an unknown to solve ───────────────────────
  const known = new Map<string, Draws>() // ref to measured draws per net
  const unknown: Part[] = []
  for (const part of circuit.parts) {
    const res = resByRef.get(part.ref)
    const model = res?.model
    if (!res || !model || res.status === 'unresolved' || res.status === 'documented-open') continue
    if (model.kind === 'stub') {
      if (model.mode === 'short') unknown.push(part)
      continue // open and interactive-pins emit nothing, so they carry nothing
    }
    if (model.kind === 'primitive') {
      const tok = model.card.trim().split(/\s+/)
      const letter = tok[0][0]?.toLowerCase()
      if (letter === 'c') {
        known.set(part.ref, new Map([...new Set(part.padNet.values())].map((n) => [n, 0] as [number, number])))
        continue
      }
      if (letter === 'r') {
        const r = parseSpiceNumber(tok[3])
        const v1 = volts(tok[1])
        const v2 = volts(tok[2])
        const n1 = netOfNode.get(tok[1])
        const n2 = netOfNode.get(tok[2])
        if (r > 0 && v1 !== undefined && v2 !== undefined && n1 !== undefined && n2 !== undefined) {
          const amps = (v1 - v2) / r
          const d: Draws = new Map()
          d.set(n1, (d.get(n1) ?? 0) + amps)
          d.set(n2, (d.get(n2) ?? 0) - amps)
          known.set(part.ref, d)
          continue
        }
      }
      unknown.push(part)
      continue
    }
    // subckt or xspice-digital. An LED's sense ammeter measures it exactly.
    const anodeNode = ledAnodeNode.get(part.ref.toLowerCase())
    const iBr = branch(ledSenseName(part.ref))
    const anodeNet = anodeNode !== undefined ? netOfNode.get(anodeNode) : undefined
    if (anodeNet !== undefined && iBr !== undefined) {
      const others = [...new Set(part.padNet.values())].filter((n) => n !== anodeNet)
      if (others.length <= 1) {
        const d: Draws = new Map()
        d.set(anodeNet, iBr)
        if (others.length === 1) d.set(others[0], -iBr)
        known.set(part.ref, d)
        continue
      }
    }
    unknown.push(part)
  }

  // ── KCL by elimination for the parts no ammeter measures ───────────────────
  const solved = new Map<string, Draws>() // unknown part ref to resolved per-net draws
  const padNetsOf = (part: Part): number[] => [...new Set(part.padNet.values())]
  for (const p of unknown) solved.set(p.ref, new Map())
  const knownOnNet = new Map<number, number>()
  for (const d of known.values()) for (const [n, a] of d) knownOnNet.set(n, (knownOnNet.get(n) ?? 0) + a)
  const unknownsOnNet = new Map<number, Part[]>()
  for (const p of unknown) {
    for (const n of padNetsOf(p)) {
      const list = unknownsOnNet.get(n) ?? []
      list.push(p)
      unknownsOnNet.set(n, list)
    }
  }
  const isResolved = (p: Part, n: number): boolean => solved.get(p.ref)?.has(n) ?? false
  let progress = true
  while (progress) {
    progress = false
    // Net equation: one unresolved pad on a net is fixed by the rest of it.
    for (const [net, parts] of unknownsOnNet) {
      if (net === groundNet || tainted.has(net)) continue
      const open = parts.filter((p) => !isResolved(p, net))
      if (open.length !== 1) continue
      let sum = (knownOnNet.get(net) ?? 0) + (external.get(net) ?? 0)
      for (const p of parts) if (p !== open[0]) sum += solved.get(p.ref)?.get(net) ?? 0
      solved.get(open[0].ref)?.set(net, -sum)
      progress = true
    }
    // Part equation: a part's pad currents sum to zero.
    for (const p of unknown) {
      const nets = padNetsOf(p)
      const open = nets.filter((n) => !isResolved(p, n))
      if (open.length !== 1) continue
      let sum = 0
      for (const n of nets) if (n !== open[0]) sum += solved.get(p.ref)?.get(n) ?? 0
      solved.get(p.ref)?.set(open[0], -sum)
      progress = true
    }
  }

  // ── assemble ───────────────────────────────────────────────────────────────
  const padCurrents: Record<string, Record<string, number>> = {}
  const partCurrents: Record<string, number> = {}
  const unresolvedRefs: string[] = []
  const emit = (part: Part, draws: Draws, measured: boolean): void => {
    const padsOnNet = new Map<number, number>()
    for (const n of part.padNet.values()) padsOnNet.set(n, (padsOnNet.get(n) ?? 0) + 1)
    const pads: Record<string, number> = {}
    let through = 0
    for (const [pad, net] of part.padNet) {
      const d = draws.get(net)
      if (d === undefined) continue
      const share = d / (padsOnNet.get(net) ?? 1)
      const val = Math.abs(share) < NOISE_A ? 0 : share
      pads[pad] = val
      through = Math.max(through, Math.abs(val))
    }
    if (Object.keys(pads).length === 0 && !measured) return
    padCurrents[part.ref] = pads
    partCurrents[part.ref] = through
  }
  for (const part of circuit.parts) {
    const k = known.get(part.ref)
    if (k) {
      emit(part, k, true)
      continue
    }
    const s = solved.get(part.ref)
    if (!s) continue
    emit(part, s, false)
    if (padNetsOf(part).some((n) => !s.has(n))) unresolvedRefs.push(part.ref)
  }
  unresolvedRefs.sort()
  return { padCurrents, partCurrents, unresolvedRefs }
}
