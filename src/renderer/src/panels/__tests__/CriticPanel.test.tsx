/**
 * CriticPanel.test.tsx — presentational unit test (C4)
 *
 * Renders the panel from a FAKE CriticReport injected into a real store and
 * asserts on the static HTML (react-dom/server — no jsdom needed in the node
 * test env). Verifies: grouped-by-severity rendering, per-group counts, the
 * summary badges, finding text (title/detail/assumption/suggestion), and the
 * subtle skipped-checks line.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CriticPanelView, _criticPanelGroups, formatCriticReport } from '../CriticPanel'
import type { CriticReport } from '../../../../core/critic/types'

const FAKE_REPORT: CriticReport = {
  findings: [
    {
      id: 'ampacity:/5V', check: 'ampacity', severity: 'error',
      title: '5V trace undersized at U3',
      detail: 'carries 1.2 A but rated for 0.8 A',
      assumption: '1 oz copper; current from op-point sim',
      suggestion: 'widen to >=0.4 mm',
      location: { x: 10, y: 12 }, netId: 3, refs: ['U3'],
    },
    {
      id: 'decoupling:U1', check: 'decoupling', severity: 'warn',
      title: 'U1 bypass cap is far',
      detail: 'nearest 100 nF is 9.2 mm away',
      location: { x: 4, y: 4 },
    },
    {
      id: 'floating:/NC', check: 'floating', severity: 'info',
      title: 'NC reaches one pad',
      detail: 'single-pad net',
    },
    {
      id: 'floating:/NC2', check: 'floating', severity: 'info',
      title: 'NC2 reaches one pad',
      detail: 'single-pad net',
    },
  ],
  ranBy: ['floating', 'clearance', 'decoupling', 'ampacity'],
  skipped: [{ check: 'thermal', reason: 'needs an operating-point simulation' }],
  summary: { error: 1, warn: 1, info: 2 },
}

function renderPanel(report: CriticReport | null): string {
  return renderToStaticMarkup(
    <CriticPanelView report={report} selectedFindingId={null} onSelect={() => {}} />,
  )
}

describe('CriticPanel', () => {
  it('renders nothing when there is no report', () => {
    expect(renderPanel(null)).toBe('')
  })

  it('renders the panel container + summary badges with counts', () => {
    const html = renderPanel(FAKE_REPORT)
    expect(html).toContain('data-testid="critic-panel"')
    expect(html).toContain('data-testid="critic-summary-error"')
    expect(html).toContain('data-testid="critic-summary-warn"')
    expect(html).toContain('data-testid="critic-summary-info"')
    // counts surfaced
    expect(html).toContain('1 error')
    expect(html).toContain('1 warn')
    expect(html).toContain('2 info')
  })

  it('renders one critic-finding row per finding, grouped by severity', () => {
    const html = renderPanel(FAKE_REPORT)
    const rows = html.match(/data-testid="critic-finding"/g) ?? []
    expect(rows).toHaveLength(4)
    // error group appears before info group (grouping order error→warn→info)
    expect(html.indexOf('5V trace undersized')).toBeLessThan(html.indexOf('NC reaches one pad'))
  })

  it('shows title + detail + assumption + suggestion for a finding', () => {
    const html = renderPanel(FAKE_REPORT)
    expect(html).toContain('5V trace undersized at U3')
    expect(html).toContain('carries 1.2 A but rated for 0.8 A')
    expect(html).toContain('1 oz copper; current from op-point sim')
    expect(html).toContain('widen to')
  })

  it('shows skipped checks subtly ("thermal: needs simulation")', () => {
    const html = renderPanel(FAKE_REPORT)
    expect(html).toContain('data-testid="critic-skipped"')
    expect(html).toContain('thermal: needs simulation')
  })

  it('_criticPanelGroups groups by severity', () => {
    const groups = _criticPanelGroups(FAKE_REPORT)
    expect(groups.error).toHaveLength(1)
    expect(groups.warn).toHaveLength(1)
    expect(groups.info).toHaveLength(2)
  })

  it('shows a not-assessed skip with its own reason (not "needs simulation")', () => {
    const report: CriticReport = {
      ...FAKE_REPORT,
      skipped: [
        { check: 'thermal', reason: 'needs an operating-point simulation' },
        { check: 'loop-area', reason: 'not assessed (no ground copper on this board to measure loops against)' },
      ],
    }
    const html = renderPanel(report)
    expect(html).toContain('thermal: needs simulation')
    expect(html).toContain('loop area: not assessed (no ground copper')
    // the loop-area line must NOT be mislabeled as needing a simulation
    expect(html).not.toContain('loop area: needs simulation')
  })

  it('offers a Copy button when there are findings, and hides it when empty', () => {
    expect(renderPanel(FAKE_REPORT)).toContain('data-testid="critic-copy-btn"')
    const empty: CriticReport = { findings: [], ranBy: [], skipped: [], summary: { error: 0, warn: 0, info: 0 } }
    expect(renderPanel(empty)).not.toContain('data-testid="critic-copy-btn"')
  })

  it('formatCriticReport renders a shareable summary + findings + not-assessed', () => {
    const report: CriticReport = {
      ...FAKE_REPORT,
      skipped: [{ check: 'loop-area', reason: 'not assessed (no ground copper on this board to measure loops against)' }],
    }
    const text = formatCriticReport(report)
    expect(text).toContain('Board Critic — 1 error, 1 warn, 2 info')
    expect(text).toContain('ERROR')
    expect(text).toContain('- 5V trace undersized at U3')
    expect(text).toContain('Assumes: 1 oz copper')
    expect(text).toContain('→ widen to')
    expect(text).toContain('Not assessed:')
    expect(text).toContain('loop area: not assessed (no ground copper')
  })
})
