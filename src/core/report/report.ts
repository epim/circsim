/**
 * core/report/report.ts
 *
 * The shareable report: what circsim knows about one board at one moment, as a
 * structured document that renders to markdown (paste into a forum thread or an
 * LLM chat) and to standalone HTML (print to PDF).
 *
 * The report is a record of a setup and what it produced, not a verdict. It
 * names the board file and its sha256 so a result can be tied to the exact file,
 * lists the bench and every override so the run is reproducible from the saved
 * setup, shows per-part resolution with tier and provenance, states the fidelity
 * caveats, tabulates the operating point, and lists Board Critic findings with
 * their assumption lines. The headless CLI (issue #28) is meant to print this
 * same document, so everything here is pure data in, text out.
 *
 * No imports from electron, react, or three. No clock and no randomness: the
 * caller passes `generatedAt`, so the same input always renders the same text.
 */

import type { PinMap, Resolution } from '../models/types'
import type { CriticReport, Finding } from '../critic/types'

// --- input ----------------------------------------------------------------------

export interface ReportInstrument {
  id: string
  kind: string
  /** e.g. "net /VCC", "A /IN, W /MID". Empty when unwired. */
  connections: string
  /** e.g. "5 V, 0.1 ohm". */
  settings: string
  /** Where each lead was clipped, e.g. "net lead at (12.5, 30.1) mm". Empty when unknown. */
  leadPositions: string
}

export interface ReportPart {
  ref: string
  value: string
  resolution: Resolution
}

export interface ReportUserModel {
  ref: string
  mpn: string
  subcktName: string
  provenance: string
}

export interface ReportInput {
  /** ISO 8601 timestamp supplied by the caller. */
  generatedAt: string
  appVersion: string
  board: {
    fileName: string | null
    sha256: string | null
    /** KiCad file-format version string from the board header, when present. */
    kicadVersion: string | null
  }
  schematicFileName: string | null
  groundNet: string | null
  instruments: ReportInstrument[]
  stubOverrides: [string, string][]
  pinMapOverrides: [string, PinMap][]
  railOverrides: [string, number][]
  userModels: ReportUserModel[]
  parts: ReportPart[]
  /** Operating point rows, or null when none has been solved. */
  op: {
    rows: { net: string; volts: number }[]
    /** Caveat text when the op converged only via a fallback, else null. */
    caveat: string | null
    /** True when the numbers are from a previous run. */
    stale: boolean
  } | null
  critic: CriticReport | null
}

// --- document model -------------------------------------------------------------

export type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'kv'; items: [string, string][] }
  | { type: 'table'; header: string[]; rows: string[][] }

export interface Section {
  heading: string
  blocks: Block[]
}

export interface ReportDoc {
  title: string
  sections: Section[]
}

// --- helpers --------------------------------------------------------------------

/**
 * The KiCad format version from a board's header, e.g. "20240108 (pcbnew 8.0)".
 * null when the header carries no version.
 */
export function kicadFormatVersion(boardText: string): string | null {
  const head = boardText.slice(0, 4000)
  const v = /\(version\s+(\d+)\)/.exec(head)
  if (!v) return null
  const gen = /\(generator\s+"?([A-Za-z0-9_.-]+)"?\)/.exec(head)
  const genVer = /\(generator_version\s+"?([A-Za-z0-9_.-]+)"?\)/.exec(head)
  const tool = gen ? `${gen[1]}${genVer ? ' ' + genVer[1] : ''}` : null
  return tool ? `${v[1]} (${tool})` : v[1]
}

function fmtVolts(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : 'n/a'
}

const TIER_LABEL: Record<number, string> = {
  1: 'schematic Sim.* fields',
  2: 'inferred from reference and value',
  3: 'bundled library',
  4: 'user .lib import',
  5: 'LLM-assisted model',
  6: 'fallback stub',
}

/** What model a part resolved to, in a few plain words. */
export function describeModel(r: Resolution): string {
  const m = r.model
  if (!m) return r.status === 'documented-open' ? 'none (open by design)' : 'none'
  switch (m.kind) {
    case 'primitive':
      return 'primitive'
    case 'subckt':
      return m.libFile.startsWith('__user_model__:') ? `subckt ${m.subcktName}` : `subckt ${m.subcktName} (${m.libFile})`
    case 'xspice-digital':
      return `digital template ${m.templateId}`
    case 'stub':
      return `stub (${m.mode})`
  }
}

/** Where a part's model came from. */
export function describeProvenance(p: ReportPart, userModels: ReportUserModel[]): string {
  const r = p.resolution
  const user = userModels.find(u => u.ref === p.ref)
  if (r.model?.kind === 'subckt' && r.model.libFile.startsWith('__user_model__:') && user) {
    return `user model (${user.provenance})`
  }
  return TIER_LABEL[r.tier] ?? `tier ${r.tier}`
}

function nonEmpty(s: string | null | undefined, fallback: string): string {
  return s && s.length > 0 ? s : fallback
}

const SEVERITY_ORDER: Finding['severity'][] = ['error', 'warn', 'info']

// --- build ----------------------------------------------------------------------

export function buildReport(input: ReportInput): ReportDoc {
  const title = `circsim report: ${nonEmpty(input.board.fileName, 'untitled board')}`
  const sections: Section[] = []

  // 1. Provenance of the result.
  sections.push({
    heading: 'Board and tool',
    blocks: [
      {
        type: 'kv',
        items: [
          ['Board file', nonEmpty(input.board.fileName, 'unknown')],
          ['Board sha256', nonEmpty(input.board.sha256, 'not computed')],
          ['KiCad format version', nonEmpty(input.board.kicadVersion, 'not stated in the file')],
          ['Schematic', nonEmpty(input.schematicFileName, 'none attached')],
          ['circsim version', input.appVersion],
          ['Generated', input.generatedAt],
        ],
      },
      {
        type: 'paragraph',
        text:
          'This report records a simulation setup and what it produced. Findings are risks to check, ' +
          'not verdicts, and the simulation is only as faithful as the models listed below.',
      },
    ],
  })

  // 2. The bench.
  const setup: Block[] = [
    { type: 'kv', items: [['Ground net', nonEmpty(input.groundNet, 'none designated')]] },
  ]
  if (input.instruments.length > 0) {
    setup.push({
      type: 'table',
      header: ['Instrument', 'Kind', 'Connected to', 'Settings', 'Lead position'],
      rows: input.instruments.map(i => [
        i.id,
        i.kind,
        nonEmpty(i.connections, 'unwired'),
        nonEmpty(i.settings, '-'),
        nonEmpty(i.leadPositions, '-'),
      ]),
    })
  } else {
    setup.push({ type: 'paragraph', text: 'No instruments on the bench.' })
  }
  const overrides: string[] = []
  for (const [ref, mode] of input.stubOverrides) overrides.push(`${ref}: stubbed as ${mode}`)
  for (const [ref, pm] of input.pinMapOverrides) {
    overrides.push(`${ref}: pin map ${Object.entries(pm).map(([pad, node]) => `${pad}=${node}`).join(', ')}`)
  }
  for (const [net, v] of input.railOverrides) overrides.push(`${net}: rail set to ${fmtVolts(v)} V`)
  for (const u of input.userModels) overrides.push(`${u.ref}: user model ${u.subcktName} for ${u.mpn} (${u.provenance})`)
  if (overrides.length > 0) {
    setup.push({ type: 'paragraph', text: 'Overrides applied by the user:' })
    setup.push({ type: 'list', items: overrides })
  }
  sections.push({ heading: 'Bench and overrides', blocks: setup })

  // 3. Resolution table.
  sections.push({
    heading: 'Part models',
    blocks: [
      {
        type: 'table',
        header: ['Ref', 'Value', 'Status', 'Tier', 'Model', 'Provenance', 'Notes'],
        rows: input.parts.map(p => [
          p.ref,
          nonEmpty(p.value, '-'),
          p.resolution.status,
          String(p.resolution.tier),
          describeModel(p.resolution),
          describeProvenance(p, input.userModels),
          [p.resolution.note, ...p.resolution.warnings].filter(Boolean).join('; ') || '-',
        ]),
      },
    ],
  })

  // 4. Fidelity caveats.
  const caveats: string[] = []
  for (const p of input.parts) {
    const r = p.resolution
    if (r.status === 'ok') continue
    if (r.status === 'stubbed') caveats.push(`${p.ref} is stubbed (${r.model?.kind === 'stub' ? r.model.mode : 'open'}), not modeled.`)
    else if (r.status === 'documented-open') caveats.push(`${p.ref} is open by design${r.note ? `: ${r.note}` : ''}.`)
    else caveats.push(`${p.ref} is unresolved and is not part of the simulation.`)
  }
  if (input.parts.some(p => p.resolution.model?.kind === 'xspice-digital')) {
    caveats.push('Digital parts use simplified XSPICE templates; sequential state is not preserved when the bench restarts.')
  }
  if (input.parts.some(p => p.resolution.status === 'ok' && p.resolution.warnings.length > 0)) {
    caveats.push('Some resolved parts carry warnings (see the Notes column above), for example an unverified pin map.')
  }
  if (input.op?.caveat) caveats.push(input.op.caveat)
  if (input.op?.stale) caveats.push('The operating-point numbers below are from a previous run and may not match the current setup.')
  sections.push({
    heading: 'Fidelity caveats',
    blocks:
      caveats.length > 0
        ? [{ type: 'list', items: caveats }]
        : [{ type: 'paragraph', text: 'Every part resolved to a model. See "what circsim can tell you" for the limits of the models themselves.' }],
  })

  // 5. Operating point.
  if (input.op && input.op.rows.length > 0) {
    sections.push({
      heading: 'Operating point',
      blocks: [
        {
          type: 'table',
          header: ['Net', 'Volts'],
          rows: [...input.op.rows].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0)).map(r => [r.net, fmtVolts(r.volts)]),
        },
      ],
    })
  } else {
    sections.push({
      heading: 'Operating point',
      blocks: [{ type: 'paragraph', text: 'No operating point has been solved for this setup.' }],
    })
  }

  // 6. Board Critic.
  const critic: Block[] = []
  if (!input.critic) {
    critic.push({ type: 'paragraph', text: 'The Board Critic has not run.' })
  } else {
    const c = input.critic
    critic.push({
      type: 'paragraph',
      text: `${c.summary.error} error, ${c.summary.warn} warn, ${c.summary.info} info. Checks run: ${c.ranBy.join(', ') || 'none'}.`,
    })
    for (const sev of SEVERITY_ORDER) {
      const group = c.findings.filter(f => f.severity === sev)
      if (group.length === 0) continue
      critic.push({
        type: 'list',
        items: group.map(f => {
          const parts = [`[${sev}] ${f.title}`, f.detail]
          if (f.assumption) parts.push(`Assumes: ${f.assumption}`)
          if (f.refs && f.refs.length > 0) parts.push(`Parts: ${f.refs.join(', ')}`)
          if (f.location) parts.push(`Location: (${f.location.x.toFixed(2)}, ${f.location.y.toFixed(2)}) mm`)
          if (f.suggestion) parts.push(`Suggestion: ${f.suggestion}`)
          return parts.join(' ')
        }),
      })
    }
    if (c.findings.length === 0) critic.push({ type: 'paragraph', text: 'No risks flagged. Findings are checks, not verdicts.' })
    if (c.skipped.length > 0) {
      critic.push({ type: 'paragraph', text: 'Not assessed:' })
      critic.push({ type: 'list', items: c.skipped.map(s => `${s.check}: ${s.reason}`) })
    }
  }
  sections.push({ heading: 'Board Critic findings', blocks: critic })

  return tidyDoc({ title, sections })
}

/**
 * Text that arrives from elsewhere in the app (critic findings, op caveats) may
 * carry em-dashes or arrows; the report is plain ASCII punctuation so it pastes
 * cleanly into a forum or a chat.
 */
export function plainText(s: string): string {
  return s.replace(/\s*\u2014\s*/g, ', ').replace(/\u2192/g, '->').replace(/\u2013/g, '-')
}

function tidyDoc(doc: ReportDoc): ReportDoc {
  const t = plainText
  return {
    title: t(doc.title),
    sections: doc.sections.map(sec => ({
      heading: t(sec.heading),
      blocks: sec.blocks.map((b): Block => {
        switch (b.type) {
          case 'paragraph':
            return { type: 'paragraph', text: t(b.text) }
          case 'list':
            return { type: 'list', items: b.items.map(t) }
          case 'kv':
            return { type: 'kv', items: b.items.map(([k, v]) => [t(k), t(v)] as [string, string]) }
          case 'table':
            return { type: 'table', header: b.header.map(t), rows: b.rows.map(r => r.map(t)) }
        }
      }),
    })),
  }
}

// --- markdown ---------------------------------------------------------------------

function mdCell(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

function mdText(s: string): string {
  return s.replace(/\r?\n/g, ' ')
}

export function reportToMarkdown(doc: ReportDoc): string {
  const out: string[] = [`# ${mdText(doc.title)}`, '']
  for (const section of doc.sections) {
    out.push(`## ${section.heading}`, '')
    for (const b of section.blocks) {
      switch (b.type) {
        case 'paragraph':
          out.push(mdText(b.text), '')
          break
        case 'list':
          for (const item of b.items) out.push(`- ${mdText(item)}`)
          out.push('')
          break
        case 'kv':
          for (const [k, v] of b.items) out.push(`- ${k}: ${mdText(v)}`)
          out.push('')
          break
        case 'table':
          out.push(`| ${b.header.map(mdCell).join(' | ')} |`)
          out.push(`| ${b.header.map(() => '---').join(' | ')} |`)
          for (const row of b.rows) out.push(`| ${row.map(mdCell).join(' | ')} |`)
          out.push('')
          break
      }
    }
  }
  return out.join('\n').replace(/\n+$/, '') + '\n'
}

// --- html (print to PDF) ------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const HTML_CSS = `
body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 24px; }
h1 { font-size: 18px; margin: 0 0 12px; }
h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #999; padding-bottom: 2px; }
p { margin: 4px 0 8px; }
ul { margin: 4px 0 8px; padding-left: 18px; }
li { margin: 2px 0; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 10px; }
th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #eee; }
tr { page-break-inside: avoid; }
`

/** A standalone, script-free HTML page of the report. Everything is escaped. */
export function reportToHtml(doc: ReportDoc): string {
  const out: string[] = []
  out.push('<!doctype html>')
  out.push('<html lang="en"><head><meta charset="utf-8">')
  out.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">')
  out.push(`<title>${escapeHtml(doc.title)}</title>`)
  out.push(`<style>${HTML_CSS}</style></head><body>`)
  out.push(`<h1>${escapeHtml(doc.title)}</h1>`)
  for (const section of doc.sections) {
    out.push(`<h2>${escapeHtml(section.heading)}</h2>`)
    for (const b of section.blocks) {
      switch (b.type) {
        case 'paragraph':
          out.push(`<p>${escapeHtml(b.text)}</p>`)
          break
        case 'list':
          out.push('<ul>' + b.items.map(i => `<li>${escapeHtml(i)}</li>`).join('') + '</ul>')
          break
        case 'kv':
          out.push('<ul>' + b.items.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</li>`).join('') + '</ul>')
          break
        case 'table':
          out.push(
            '<table><thead><tr>' + b.header.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>' +
              b.rows.map(r => '<tr>' + r.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>').join('') +
              '</tbody></table>',
          )
          break
      }
    }
  }
  out.push('</body></html>')
  return out.join('\n') + '\n'
}
