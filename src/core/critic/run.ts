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
import type { CheckId, CriticOptions, CriticReport, Finding, OpResult } from './types'
import { DEFAULT_CRITIC_OPTIONS } from './types'
import { buildContext, type CriticContext } from './context'
import { checkFloating } from './checks/floating'
import { checkClearance } from './checks/clearance'
import { checkDecoupling } from './checks/decoupling'
import { checkAmpacity } from './checks/ampacity'
import { checkThermal } from './checks/thermal'

type Check = (ctx: CriticContext) => Finding[]

/** Registry of checks. Each entry may declare what it needs; missing inputs → skipped. */
const CHECKS: { id: CheckId; run: Check; needs?: 'op' }[] = [
  { id: 'floating', run: checkFloating },
  { id: 'clearance', run: checkClearance },
  { id: 'decoupling', run: checkDecoupling },
  { id: 'ampacity', run: checkAmpacity, needs: 'op' },
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

  for (const check of CHECKS) {
    if (check.needs === 'op' && !opResult) {
      skipped.push({ check: check.id, reason: 'needs an operating-point simulation' })
      continue
    }
    findings.push(...check.run(ctx))
    ranBy.push(check.id)
  }

  const summary = { error: 0, warn: 0, info: 0 }
  for (const f of findings) summary[f.severity]++

  return { findings, ranBy, skipped, summary }
}
