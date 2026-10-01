/**
 * listPanelsScale.test.tsx: list panels on a large board (issue #72).
 *
 * PartsPanel, NetVoltages, ModelDoctor and CriticPanel each mapped their whole
 * array into the DOM, and the Ground & Power pickers listed every net in board
 * order. The bundled boards (4 and 8 nets) hide this, so these tests render a
 * generated 200-part, 300-net board (bigBoardFixture) and assert on what
 * reaches the DOM, which is the measurable part of "scale".
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PartsPanel from '../PartsPanel'
import NetVoltages from '../NetVoltages'
import ModelDoctor, { DOCTOR_COLLAPSE_AFTER } from '../ModelDoctor'
import GroundSetup, { SupplyPicker } from '../GroundSetup'
import { CriticPanelView, CRITIC_GROUP_CAP } from '../CriticPanel'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { makeBigBoard } from './bigBoardFixture'
import type { CriticReport, Finding } from '../../../../core/critic/types'

function storeWith(state: Partial<AppState>): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState(state)
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return store
}

function render(store: ReturnType<typeof createAppStore>, node: React.ReactElement): string {
  return renderToStaticMarkup(<AppStoreProvider store={store}>{node}</AppStoreProvider>)
}

const big = makeBigBoard(200, 300)

describe('fixture sanity', () => {
  it('builds the advertised board', () => {
    expect(big.circuit.parts).toHaveLength(200)
    expect(big.circuit.nets.length).toBe(301)
    expect(big.unresolved.length + big.stubbed.length).toBe(20)
  })
})

describe('PartsPanel on a 200-part board', () => {
  const html = render(
    storeWith({ circuit: big.circuit, resolutions: big.resolutions }),
    <PartsPanel />,
  )
  const rowRefs = [...html.matchAll(/data-ref="([^"]+)"/g)].map(m => m[1])

  it('mounts a bounded number of rows, not all 200', () => {
    expect(rowRefs.length).toBeGreaterThan(0)
    expect(rowRefs.length).toBeLessThan(80)
    expect(html).toContain('data-windowed="true"')
  })

  it('lists needs-attention parts first, with a count in the heading', () => {
    expect(html).toContain('Needs attention (20)')
    // The first rendered rows are the unresolved parts, then stubbed, in order.
    const attention = new Set([...big.unresolved, ...big.stubbed])
    expect(rowRefs.slice(0, 20).every(r => attention.has(r))).toBe(true)
    expect(rowRefs.slice(0, 10)).toEqual(big.unresolved)
  })

  it('shows group headings for the other groups once scrolled to them (counts in the model)', () => {
    // Headings for later groups are outside the first window; the full model is
    // covered directly in buildPartItems below.
    expect(html).toContain('data-testid="parts-group-heading"')
  })
})

describe('PartsPanel group model', () => {
  it('groups: attention (red then amber), open by design, then ok; counts per heading', async () => {
    const { buildPartItems } = await import('../PartsPanel')
    const resByRef = new Map(big.resolutions.map(r => [r.ref, r]))
    const items = buildPartItems(big.circuit.parts, resByRef)
    const headings = items.filter(i => i.kind === 'heading')
    expect(headings.map(h => (h.kind === 'heading' ? `${h.title} (${h.count})` : ''))).toEqual([
      'Needs attention (20)',
      'Open by design (6)',
      'OK (174)',
    ])
    expect(items.filter(i => i.kind === 'part')).toHaveLength(200)
  })

  it('a board where every part is ok shows no headings at all', async () => {
    const { buildPartItems } = await import('../PartsPanel')
    const parts = big.circuit.parts.filter(p => big.ok.includes(p.ref)).slice(0, 5)
    const resByRef = new Map(big.resolutions.map(r => [r.ref, r]))
    const items = buildPartItems(parts, resByRef)
    expect(items.every(i => i.kind === 'part')).toBe(true)
  })
})

describe('NetVoltages on a 300-net board', () => {
  const opVoltages = new Map<number, number>()
  for (const n of big.circuit.nets) if (n.kicadName) opVoltages.set(n.id, n.id * 0.01)
  const html = render(storeWith({ circuit: big.circuit, opVoltages }), <NetVoltages />)

  it('mounts a bounded number of rows', () => {
    const rows = html.match(/data-testid="net-voltage-row"/g) ?? []
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(80)
  })

  it('still reports the full count in the toolbar', () => {
    expect(html).toContain('>300<')
  })
})

describe('ModelDoctor on a board with many problem parts', () => {
  const problems = big.resolutions.filter(r => r.status !== 'ok')

  it('there are more problems than the collapse threshold', () => {
    expect(problems.length).toBeGreaterThan(DOCTOR_COLLAPSE_AFTER)
  })

  it('collapses unselected cards to one line: no action buttons until one is selected', () => {
    const html = render(
      storeWith({ circuit: big.circuit, resolutions: big.resolutions, selectedRef: null }),
      <ModelDoctor />,
    )
    expect((html.match(/data-collapsed="true"/g) ?? []).length).toBe(problems.length)
    expect(html).not.toContain('Import .lib')
    expect(html).not.toContain('Stub open')
  })

  it('the selected card is expanded; the rest stay collapsed', () => {
    const target = problems[3].ref
    const html = render(
      storeWith({ circuit: big.circuit, resolutions: big.resolutions, selectedRef: target }),
      <ModelDoctor />,
    )
    expect((html.match(/data-collapsed="true"/g) ?? []).length).toBe(problems.length - 1)
    expect((html.match(/Import \.lib/g) ?? []).length).toBe(1)
    expect(html).toMatch(new RegExp(`data-ref="${target}"[^>]*data-selected="true"`))
  })
})

function finding(i: number, severity: Finding['severity']): Finding {
  return {
    id: `f${i}`,
    check: 'floating',
    severity,
    title: `Finding ${i}`,
    detail: 'detail',
  } as Finding
}

describe('CriticPanel with many findings', () => {
  const findings = Array.from({ length: 100 }, (_, i) => finding(i, 'info'))
  const report: CriticReport = {
    findings,
    ranBy: ['floating'],
    skipped: [],
    summary: { error: 0, warn: 0, info: 100 },
  }

  it('caps a group and offers the rest behind a button that states the count', () => {
    const html = renderToStaticMarkup(
      <CriticPanelView report={report} selectedFindingId={null} onSelect={() => {}} />,
    )
    expect((html.match(/data-testid="critic-finding"/g) ?? []).length).toBe(CRITIC_GROUP_CAP)
    expect(html).toContain(`Show ${100 - CRITIC_GROUP_CAP} more`)
  })

  it('a selected finding beyond the cap is still rendered', () => {
    const html = renderToStaticMarkup(
      <CriticPanelView report={report} selectedFindingId="f90" onSelect={() => {}} />,
    )
    expect(html).toContain('data-finding-id="f90"')
  })

  it('a group at or under the cap shows no more-button', () => {
    const small: CriticReport = {
      ...report,
      findings: findings.slice(0, CRITIC_GROUP_CAP),
      summary: { error: 0, warn: 0, info: CRITIC_GROUP_CAP },
    }
    const html = renderToStaticMarkup(
      <CriticPanelView report={small} selectedFindingId={null} onSelect={() => {}} />,
    )
    expect(html).not.toContain('Show ')
  })
})

describe('Supply picker (Choose...) on a 300-net board', () => {
  const nets = big.circuit.nets
  const groundNetId = 1
  const render1 = (initialFilter?: string): string =>
    renderToStaticMarkup(
      <SupplyPicker
        nets={nets}
        groundNetId={groundNetId}
        attachedNetIds={new Set<number>()}
        onPick={() => {}}
        initialFilter={initialFilter}
      />,
    )

  it('has a filter input and caps the rows it renders', () => {
    const html = render1()
    expect(html).toContain('data-testid="supply-filter"')
    const rows = html.match(/data-testid="supply-pick"/g) ?? []
    expect(rows.length).toBeLessThanOrEqual(50)
    expect(html).toContain('data-testid="supply-pick-more"')
  })

  it('ranks suggested rails first (VCC before NET noise)', () => {
    const html = render1()
    const names = [...html.matchAll(/data-testid="supply-pick"[^>]*>(?:✓ )?([^<]*)</g)].map(m => m[1])
    expect(names[0]).toBe('VCC')
    expect(names).not.toContain('GND')
  })

  it('the filter narrows the list', () => {
    const html = render1('vbus')
    const names = [...html.matchAll(/data-testid="supply-pick"[^>]*>(?:✓ )?([^<]*)</g)].map(m => m[1])
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(n => n.toLowerCase().includes('vbus'))).toBe(true)
    expect(html).not.toContain('data-testid="supply-pick-more"')
  })
})

describe('Ground "Change..." quick-picks are ranked', () => {
  it('a ground-named net far down the board order still makes the four quick-picks', () => {
    // GND is the current ground; AGND sits last in board order with few pads.
    const nets = [
      { id: 1, kicadName: 'GND', spiceNode: 'n1', padRefs: [] },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: i + 2,
        kicadName: `/sig/N${i}`,
        spiceNode: `n${i + 2}`,
        padRefs: [{ ref: 'R1', pad: '1' }],
      })),
      { id: 99, kicadName: 'AGND', spiceNode: 'n99', padRefs: [] },
    ]
    const store = storeWith({
      circuit: { nets, parts: [], warnings: [] },
      groundNetId: 1,
      suggestedSupplyNetIds: [],
    })
    const html = render(store, <GroundSetup />)
    const picks = [...html.matchAll(/data-testid="ground-quickpick"[^>]*>([^<]*)</g)].map(m => m[1])
    expect(picks).toHaveLength(4)
    expect(picks[0]).toBe('AGND')
  })
})
