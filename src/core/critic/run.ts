/**
 * core/critic/run.ts
 *
 * Board Critic orchestrator. Runs each check, collects findings, records which
 * checks ran vs were skipped (e.g. needed a simulation that wasn't supplied),
 * and summarizes by severity. Deterministic; no electron/react/three imports.
 *
 * Spec: docs/superpowers/specs/2026-06-19-circsim-board-critic-design.md §6
 */

import type { BoardModel } from '../kicad/types'
import type { Circuit } from '../netlist/extract'
import type { CheckId, CheckOutput, CriticOptions, CriticReport, Finding, OpResult } from './types'
import { DEFAULT_CRITIC_OPTIONS } from './types'
import { buildContext, type CriticContext } from './context'
import { checkFloating } from './checks/floating'
import { checkClearance } from './checks/clearance'
import { checkDecoupling } from './checks/decoupling'
import { checkLoopArea } from './checks/loopArea'
import { checkAmpacity } from './checks/ampacity'
import { checkIrDrop } from './checks/irDrop'
import { checkThermal } from './checks/thermal'

type Check = (ctx: CriticContext) => CheckOutput

/**
 * The no-sim checks (floating, clearance, decoupling, loop-area) depend only on
 * the board, the extracted circuit and the options, never on an operating-point
 * result. Their outputs are memoised per circuit object (the store replaces the
 * board and the circuit wholesale whenever geometry or grounding changes), so a
 * fresh op result re-runs only the op-dependent checks. The cache is keyed on
 * the circuit, verified against the board and the options, and held weakly.
 */
interface StaticEntry {
  board: BoardModel
  opts: CriticOptions
  outputs: Map<CheckId, CheckOutput>
}
const staticCache = new WeakMap<Circuit, StaticEntry>()

function sameOptions(a: CriticOptions, b: CriticOptions): boolean {
  const ka = Object.keys(a) as (keyof CriticOptions)[]
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** Registry of checks. Each entry may declare what it needs; missing inputs → skipped. */
const CHECKS: { id: CheckId; run: Check; needs?: 'op' }[] = [
  { id: 'floating', run: checkFloating },
  { id: 'clearance', run: checkClearance },
  { id: 'decoupling', run: checkDecoupling },
  { id: 'loop-area', run: checkLoopArea },
  { id: 'ampacity', run: checkAmpacity, needs: 'op' },
  { id: 'ir-drop', run: checkIrDrop, needs: 'op' },
  { id: 'thermal', run: checkThermal, needs: 'op' },
]

export function runCritic(
  board: BoardModel,
  circuit: Circuit,
  opResult?: OpResult,
  opts?: Partial<CriticOptions>,
): CriticReport {
  const merged: CriticOptions = { ...DEFAULT_CRITIC_OPTIONS, ...(opts ?? {}) }
  const ctx = buildContext(board, circuit, opResult, merged)

  const findings: Finding[] = []
  const ranBy: CheckId[] = []
  const skipped: { check: CheckId; reason: string }[] = []

  let cached = staticCache.get(circuit)
  if (!cached || cached.board !== board || !sameOptions(cached.opts, merged)) {
    cached = { board, opts: merged, outputs: new Map() }
    staticCache.set(circuit, cached)
  }

  for (const check of CHECKS) {
    if (check.needs === 'op' && !opResult) {
      skipped.push({ check: check.id, reason: 'needs an operating-point simulation' })
      continue
    }
    let out: CheckOutput
    if (check.needs === 'op') {
      out = check.run(ctx)
    } else {
      const hit = cached.outputs.get(check.id)
      if (hit) {
        out = hit
      } else {
        out = check.run(ctx)
        cached.outputs.set(check.id, out)
      }
    }
    if (Array.isArray(out)) {
      findings.push(...out)
      ranBy.push(check.id)
    } else {
      findings.push(...out.findings)
      if (out.notAssessed) {
        // Ran, but a precondition kept it from assessing — record it in skipped
        // so the panel shows "not assessed", not silence-as-clean.
        skipped.push({ check: check.id, reason: out.notAssessed })
      } else {
        ranBy.push(check.id)
      }
    }
  }

  const summary = { error: 0, warn: 0, info: 0 }
  for (const f of findings) summary[f.severity]++

  return { findings, ranBy, skipped, summary }
}
