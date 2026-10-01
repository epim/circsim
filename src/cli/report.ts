/**
 * src/cli/report.ts
 *
 * Output shapes for the headless CLI (issue #28): the JSON documents (schema
 * version 1) and the plain-text renderings. Pure functions; no I/O.
 *
 * JSON schema changes that remove or rename a field bump SCHEMA_VERSION.
 */

import type { CriticReport, Finding } from '../core/critic/types'
import type { SolveResult } from '../core/solve'
import type { Session } from './session'

export const SCHEMA_VERSION = 1

export interface SolveSummary {
  /** False when no operating point was produced (skipped, or failed). */
  ran: boolean
  /** Why it did not run or failed; absent when it ran. */
  reason?: string
  method?: string
  pass2?: SolveResult['pass2']
  measuredRails?: { net: string; volts: number }[]
  gatedOff?: { ref: string; net: string }[]
  /** ngspice error lines seen during a failed solve (at most the last five). */
  ngspiceErrors?: string[]
}

export function solveSummary(
  session: Session,
  solved: SolveResult | null,
  reason?: string,
  ngspiceErrors: string[] = [],
): SolveSummary {
  if (!solved) {
    return {
      ran: false,
      reason,
      ...(ngspiceErrors.length > 0 ? { ngspiceErrors: ngspiceErrors.slice(-5) } : {}),
    }
  }
  const nameOf = new Map(session.circuit.nets.map((n) => [n.id, n.kicadName]))
  return {
    ran: true,
    method: solved.op.method ?? 'direct',
    pass2: solved.pass2,
    measuredRails: [...solved.measuredRails].map(([id, volts]) => ({ net: nameOf.get(id) ?? String(id), volts })),
    gatedOff: solved.gatedOff.map((g) => ({ ref: g.ref, net: g.kicadName })),
  }
}

function header(session: Session) {
  const ground = session.groundNetId !== null ? session.circuit.nets.find((n) => n.id === session.groundNetId) : undefined
  return {
    board: session.boardName,
    schematic: session.schematicPath,
    ground: ground?.kicadName ?? null,
    supplies: session.supplies.map((s) => ({ net: s.net, volts: s.volts, source: s.source })),
  }
}

function modelSummary(session: Session) {
  const counts = { ok: 0, stubbed: 0, unresolved: 0, documentedOpen: 0 }
  const parts: { ref: string; status: string; warnings: string[] }[] = []
  for (const r of session.resolutions) {
    if (r.status === 'ok') counts.ok++
    else if (r.status === 'stubbed') counts.stubbed++
    else if (r.status === 'unresolved') counts.unresolved++
    else counts.documentedOpen++
    if (r.status !== 'ok') parts.push({ ref: r.ref, status: r.status, warnings: r.warnings })
  }
  return { ...counts, attention: parts }
}

export function auditJson(
  session: Session,
  solve: SolveSummary,
  critic: CriticReport,
  exitCode: number,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command: 'audit',
    ...header(session),
    parts: session.circuit.parts.length,
    nets: session.circuit.nets.length,
    models: modelSummary(session),
    solve,
    critic,
    exitCode,
  }
}

export function opJson(session: Session, solve: SolveSummary, solved: SolveResult | null) {
  const nets = session.circuit.nets.map((n) => {
    const v = solved?.netVoltages.get(n.id)
    return { id: n.id, name: n.kicadName, spiceNode: n.spiceNode, volts: v !== undefined && Number.isFinite(v) ? v : null }
  })
  return { schemaVersion: SCHEMA_VERSION, command: 'op', ...header(session), solve, nets }
}

export function deckJson(session: Session, solve: SolveSummary, files: string[]) {
  return { schemaVersion: SCHEMA_VERSION, command: 'deck', ...header(session), solve, files }
}

// ─── plain text ───────────────────────────────────────────────────────────────

export function formatVolts(v: number): string {
  return String(Number(v.toPrecision(6)))
}

function headerLines(session: Session, solve: SolveSummary): string[] {
  const h = header(session)
  const lines = [`board: ${h.board}`]
  if (h.schematic) lines.push(`schematic: ${h.schematic}`)
  lines.push(`ground: ${h.ground ?? 'none'}`)
  lines.push(
    h.supplies.length > 0
      ? `supplies: ${h.supplies.map((s) => `${s.net} = ${formatVolts(s.volts)} V${s.source === 'auto' ? ' (default)' : ''}`).join(', ')}`
      : 'supplies: none',
  )
  lines.push(solveLine(solve))
  return lines
}

function solveLine(solve: SolveSummary): string {
  if (!solve.ran) return `solve: not run (${solve.reason ?? 'unknown'})`
  const pass2 =
    solve.pass2 === 'solved'
      ? 'pass 2 solved with measured rails'
      : solve.pass2 === 'failed'
        ? 'pass 2 failed, pass 1 result kept'
        : 'single pass'
  const caveat =
    solve.method !== 'direct'
      ? ' (the operating point needed a numerical fallback; double-check the voltages)'
      : ''
  return `solve: ${solve.method}, ${pass2}${caveat}`
}

export function auditText(session: Session, solve: SolveSummary, critic: CriticReport): string {
  const lines = ['circsim audit', ...headerLines(session, solve)]
  const m = modelSummary(session)
  lines.push(`models: ${m.ok} ok, ${m.stubbed} stubbed, ${m.unresolved} unresolved, ${m.documentedOpen} documented-open`)
  if (solve.gatedOff && solve.gatedOff.length > 0) {
    lines.push(`gated off (rail near 0 V, family default kept): ${solve.gatedOff.map((g) => `${g.ref} on ${g.net}`).join(', ')}`)
  }
  lines.push('')
  lines.push(`${critic.summary.error} error, ${critic.summary.warn} warn, ${critic.summary.info} info`)
  const order: Finding['severity'][] = ['error', 'warn', 'info']
  for (const sev of order) {
    for (const f of critic.findings.filter((x) => x.severity === sev)) {
      lines.push('')
      lines.push(`[${sev}] ${f.title}`)
      lines.push(`  check: ${f.check}${f.refs && f.refs.length > 0 ? `  refs: ${f.refs.join(', ')}` : ''}`)
      lines.push(`  ${f.detail}`)
      if (f.assumption) lines.push(`  assumes: ${f.assumption}`)
      if (f.suggestion) lines.push(`  suggestion: ${f.suggestion}`)
    }
  }
  if (critic.findings.length === 0) lines.push('No risks flagged. Findings are checks, not verdicts.')
  if (critic.skipped.length > 0) {
    lines.push('')
    lines.push('not assessed:')
    for (const s of critic.skipped) lines.push(`  ${s.check}: ${s.reason}`)
  }
  return lines.join('\n') + '\n'
}

export function opText(session: Session, solve: SolveSummary, solved: SolveResult): string {
  const lines = ['circsim op', ...headerLines(session, solve), '']
  const rows = session.circuit.nets.map((n) => {
    const v = solved.netVoltages.get(n.id)
    return { name: n.kicadName, volts: v !== undefined && Number.isFinite(v) ? `${formatVolts(v)} V` : 'n/a' }
  })
  const width = Math.max(3, ...rows.map((r) => r.name.length))
  for (const r of rows) lines.push(`${r.name.padEnd(width)}  ${r.volts}`)
  return lines.join('\n') + '\n'
}
