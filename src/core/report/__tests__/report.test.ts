/**
 * core/report tests: the report names the file and its hash, lists the bench,
 * resolution with tier and provenance, fidelity caveats, the op-point table and
 * the critic findings with their assumption lines; markdown and HTML render it
 * safely and deterministically.
 */

import { describe, it, expect } from 'vitest'
import {
  buildReport,
  escapeHtml,
  kicadFormatVersion,
  reportToHtml,
  reportToMarkdown,
  type ReportInput,
} from '../report'
import type { Resolution } from '../../models/types'
import type { CriticReport } from '../../critic/types'

const res = (r: Partial<Resolution> & { ref: string }): Resolution => ({
  status: 'ok',
  tier: 2,
  warnings: [],
  ...r,
})

const CRITIC: CriticReport = {
  findings: [
    {
      id: 'ir-drop:/5V',
      check: 'ir-drop',
      severity: 'warn',
      title: '5V rail sags to 4.62 V at U3',
      detail: 'Drop of 0.38 V across 62 mm of trace.',
      assumption: '1 oz copper; current from op-point sim',
      refs: ['U3'],
      location: { x: 12.345, y: 6.789 },
      suggestion: 'Widen the trace.',
    },
    { id: 'floating:J1', check: 'floating', severity: 'error', title: 'J1 pad 2 floating', detail: 'No copper.' },
  ],
  ranBy: ['floating', 'ir-drop'],
  skipped: [{ check: 'thermal', reason: 'needs-op' }],
  summary: { error: 1, warn: 1, info: 0 },
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    generatedAt: '2026-09-30T12:00:00.000Z',
    appVersion: '0.2.9',
    board: { fileName: 'blinker.kicad_pcb', sha256: 'ab'.repeat(32), kicadVersion: '20240108 (pcbnew 8.0)' },
    schematicFileName: 'blinker.kicad_sch',
    groundNet: 'GND',
    instruments: [
      { id: 'psu', kind: 'dc-supply', connections: 'net VCC', settings: '9 V, 0.1 ohm', leadPositions: 'net lead at (10.50, -20.25) mm' },
      { id: 'probe1', kind: 'voltage-probe', connections: '', settings: '', leadPositions: '' },
    ],
    stubOverrides: [['U2', 'open']],
    pinMapOverrides: [['D1', { '1': 'K', '2': 'A' }]],
    railOverrides: [['/VGATED', 3.3]],
    userModels: [{ ref: 'U1', mpn: 'NE555', subcktName: 'NE555', provenance: 'user-import' }],
    parts: [
      { ref: 'R1', value: '10k', resolution: res({ ref: 'R1', model: { kind: 'primitive', card: 'r_r1 a b 10k' } }) },
      {
        ref: 'U1',
        value: 'NE555',
        resolution: res({ ref: 'U1', tier: 3, model: { kind: 'subckt', libFile: '__user_model__:NE555', subcktName: 'NE555', pinMap: {} } }),
      },
      {
        ref: 'D1',
        value: '1N4148',
        resolution: res({ ref: 'D1', tier: 3, warnings: ['pinmap-unverified'], model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'D1N4148', pinMap: {} } }),
      },
      { ref: 'U2', value: 'MCU', resolution: res({ ref: 'U2', status: 'stubbed', tier: 6, model: { kind: 'stub', mode: 'open' } }) },
      { ref: 'J1', value: 'Conn', resolution: res({ ref: 'J1', status: 'unresolved', tier: 6 }) },
      { ref: 'U4', value: '74HC00', resolution: res({ ref: 'U4', tier: 3, model: { kind: 'xspice-digital', templateId: 'nand2', pinMap: {} } }) },
    ],
    op: {
      rows: [{ net: 'VCC', volts: 9 }, { net: 'GND', volts: 0 }, { net: 'OUT', volts: 3.14159 }],
      caveat: 'Operating point found via fallback (gmin stepping).',
      stale: false,
    },
    critic: CRITIC,
    ...over,
  }
}

describe('buildReport', () => {
  const md = reportToMarkdown(buildReport(input()))

  it('names the board file, its sha256 and the KiCad format version', () => {
    expect(md).toContain('# circsim report: blinker.kicad_pcb')
    expect(md).toContain('Board sha256: ' + 'ab'.repeat(32))
    expect(md).toContain('KiCad format version: 20240108 (pcbnew 8.0)')
    expect(md).toContain('Generated: 2026-09-30T12:00:00.000Z')
  })

  it('lists ground, supply choice with lead position, and every override', () => {
    expect(md).toContain('Ground net: GND')
    expect(md).toMatch(/\| psu \| dc-supply \| net VCC \| 9 V, 0.1 ohm \| net lead at \(10.50, -20.25\) mm \|/)
    expect(md).toContain('U2: stubbed as open')
    expect(md).toContain('D1: pin map 1=K, 2=A')
    expect(md).toContain('/VGATED: rail set to 3.300 V')
    expect(md).toContain('U1: user model NE555 for NE555 (user-import)')
  })

  it('resolution table carries tier and provenance per part', () => {
    expect(md).toMatch(/\| R1 \| 10k \| ok \| 2 \| primitive \| inferred from reference and value \| - \|/)
    expect(md).toMatch(/\| U1 \| NE555 \| ok \| 3 \| subckt NE555 \| user model \(user-import\) \| - \|/)
    expect(md).toMatch(/\| D1 \| 1N4148 \| ok \| 3 \| subckt D1N4148 \(diodes.lib\) \| bundled library \| pinmap-unverified \|/)
    expect(md).toMatch(/\| U2 \| MCU \| stubbed \| 6 \| stub \(open\) \| fallback stub \|/)
    expect(md).toMatch(/\| U4 \| 74HC00 \| ok \| 3 \| digital template nand2 \|/)
  })

  it('states fidelity caveats', () => {
    expect(md).toContain('U2 is stubbed (open), not modeled.')
    expect(md).toContain('J1 is unresolved and is not part of the simulation.')
    expect(md).toContain('Digital parts use simplified XSPICE templates')
    expect(md).toContain('Operating point found via fallback (gmin stepping).')
    expect(md).toContain('carry warnings')
  })

  it('tabulates the operating point sorted by net', () => {
    const i = md.indexOf('## Operating point')
    const table = md.slice(i, md.indexOf('## Board Critic findings'))
    expect(table.indexOf('GND')).toBeLessThan(table.indexOf('OUT'))
    expect(table.indexOf('OUT')).toBeLessThan(table.indexOf('VCC'))
    expect(table).toContain('| OUT | 3.142 |')
  })

  it('lists critic findings by severity with assumption lines and skipped checks', () => {
    expect(md).toContain('1 error, 1 warn, 0 info.')
    expect(md.indexOf('[error] J1 pad 2 floating')).toBeLessThan(md.indexOf('[warn] 5V rail sags'))
    expect(md).toContain('Assumes: 1 oz copper; current from op-point sim')
    expect(md).toContain('Location: (12.35, 6.79) mm')
    expect(md).toContain('Suggestion: Widen the trace.')
    expect(md).toContain('thermal: needs-op')
  })

  it('has no em-dashes and no emoji', () => {
    expect(md).not.toMatch(/\u2014/)
    // The whole report is plain ASCII punctuation: nothing outside printable ASCII and newlines.
    expect(md).not.toMatch(/[^\x20-\x7E\n]/)
  })

  it('replaces em-dashes and arrows that arrive from other text', () => {
    const out = reportToMarkdown(
      buildReport(input({ op: { rows: [], caveat: 'fallback (gmin \u2014 did not converge)', stale: false } })),
    )
    expect(out).toContain('fallback (gmin, did not converge)')
    expect(out).not.toMatch(/\u2014/)
  })

  it('is deterministic', () => {
    expect(reportToMarkdown(buildReport(input()))).toBe(md)
  })

  it('handles a bare board: no op, no critic, no instruments, no hash', () => {
    const bare = reportToMarkdown(
      buildReport(
        input({
          board: { fileName: null, sha256: null, kicadVersion: null },
          schematicFileName: null,
          groundNet: null,
          instruments: [],
          stubOverrides: [],
          pinMapOverrides: [],
          railOverrides: [],
          userModels: [],
          parts: [],
          op: null,
          critic: null,
        }),
      ),
    )
    expect(bare).toContain('untitled board')
    expect(bare).toContain('Board sha256: not computed')
    expect(bare).toContain('No operating point has been solved')
    expect(bare).toContain('The Board Critic has not run.')
    expect(bare).toContain('No instruments on the bench.')
  })

  it('flags stale op numbers', () => {
    const stale = reportToMarkdown(buildReport(input({ op: { rows: [{ net: 'A', volts: 1 }], caveat: null, stale: true } })))
    expect(stale).toContain('from a previous run')
  })

  it('escapes table pipes and newlines in markdown', () => {
    const doc = buildReport(input({ parts: [{ ref: 'R9', value: 'a|b\nc', resolution: res({ ref: 'R9' }) }] }))
    const out = reportToMarkdown(doc)
    expect(out).toContain('| R9 | a\\|b c |')
  })
})

describe('html', () => {
  it('is a standalone page with no script and escapes everything', () => {
    const html = reportToHtml(
      buildReport(input({ board: { fileName: '<img src=x onerror=alert(1)>.kicad_pcb', sha256: null, kicadVersion: null } })),
    )
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.kicad_pcb')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('<table>')
  })
  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })
})

describe('kicadFormatVersion', () => {
  it('reads version and generator from the header', () => {
    expect(kicadFormatVersion('(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0")\n')).toBe('20240108 (pcbnew 8.0)')
    expect(kicadFormatVersion('(kicad_pcb (version 20221018) (generator pcbnew)\n')).toBe('20221018 (pcbnew)')
    expect(kicadFormatVersion('(kicad_pcb (version 20221018)\n')).toBe('20221018')
    expect(kicadFormatVersion('nothing here')).toBeNull()
  })
})
