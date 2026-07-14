/**
 * WarningsBar.test.tsx — M7 (F9)
 *
 * The "Results approximate" fidelity banner must not be a wall of refs on a
 * real board: with more than 3 problem parts it collapses to a count + an
 * "open Model Doctor" action; with 1–3 it keeps listing the refs (useful) but
 * still links to the Doctor. Static render against a real store (the
 * ModelDoctor.test.tsx pattern); the collapse threshold logic itself is
 * unit-tested in store/__tests__/errorStates.test.ts (collapsedFidelitySummary).
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import WarningsBar, { _applyRailOverride } from '../WarningsBar'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

function unresolved(ref: string): Resolution {
  return { ref, status: 'unresolved', tier: 6, warnings: [] }
}

function renderBar(resolutions: Resolution[]): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState({ resolutions })
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <WarningsBar />
    </AppStoreProvider>,
  )
}

describe('M7 F9 — fidelity banner collapses a wall of refs', () => {
  it('>3 unresolved parts → count + "open Model Doctor", no per-ref list', () => {
    const refs = ['U1', 'Q7', 'D3', 'J2', 'U9', 'Q12']
    const html = renderBar(refs.map(unresolved))
    expect(html).toContain('Results approximate')
    expect(html).toContain('6 parts unresolved')
    expect(html).toContain('open Model Doctor')
    expect(html).toContain('data-testid="open-model-doctor"')
    // The individual refs are NOT listed inline any more.
    for (const ref of refs) expect(html).not.toContain(`>${ref}<`)
  })

  it('1–3 unresolved parts → refs stay listed AND the Doctor link is present', () => {
    const html = renderBar([unresolved('U1'), unresolved('Q7')])
    expect(html).toContain('U1')
    expect(html).toContain('Q7')
    expect(html).toContain('unresolved')
    expect(html).toContain('data-testid="open-model-doctor"')
    expect(html).toContain('open Model Doctor')
  })

  it('no problem parts → no banner at all', () => {
    const html = renderBar([
      { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 a b 10k' } },
    ])
    expect(html).not.toContain('Results approximate')
  })
})

// ─── M9: documented opens are informational, never "unresolved" ────────────────

function documentedOpen(ref: string): Resolution {
  return {
    ref,
    status: 'documented-open',
    tier: 3,
    warnings: [],
    model: { kind: 'stub', mode: 'open' },
    note: 'Known part, intentionally left open.',
  }
}

describe('M9 — documented opens in the fidelity banner', () => {
  it('only documented opens → informational banner that still carries the consequence', () => {
    const html = renderBar([documentedOpen('U1'), documentedOpen('U6')])
    expect(html).not.toContain('Results approximate')
    expect(html).toContain('Open by design')
    expect(html).toContain('U1')
    expect(html).toContain('U6')
    // Calm tone, honest content: the user must learn their results are affected.
    expect(html).toContain('these parts are not simulated')
    expect(html).toContain('circuits they drive')
    // No redundant per-ref "open by design" repetition after the header.
    expect(html.match(/open by design/gi)).toHaveLength(1)
    expect(html).toContain('open Model Doctor')
    expect(html).toContain('data-testid="open-model-doctor"')
  })

  it('>3 items, all documented opens → collapsed informational count + consequence', () => {
    const html = renderBar(['U1', 'U2', 'U3', 'U6'].map(documentedOpen))
    expect(html).toContain('Open by design')
    expect(html).toContain('4 parts')
    expect(html).toContain('these parts are not simulated')
    // The header already says it — no "4 parts open by design" repetition.
    expect(html.match(/open by design/gi)).toHaveLength(1)
    expect(html).not.toContain('unresolved')
  })

  it('mixed: documented opens do not count toward the "unresolved" number', () => {
    const html = renderBar([
      ...['Q1', 'Q2', 'Q3', 'Q4'].map(unresolved),
      documentedOpen('U1'),
      documentedOpen('U6'),
    ])
    // Real problems keep the honest error tone…
    expect(html).toContain('Results approximate')
    // …and the count separates the two populations.
    expect(html).toContain('4 parts unresolved · 2 open by design')
    expect(html).not.toContain('6 parts unresolved')
  })
})

// ─── Op-informed rail sensing: gated-off warning + override action (Task 6) ────

describe('WarningsBar — gated-off rail note (Task 6)', () => {
  function renderWithRailNotes(): string {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.setState({ railNotes: [{ ref: 'U7', kicadName: '/VGATED' }] })
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    return renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <WarningsBar />
      </AppStoreProvider>,
    )
  }

  it('renders a gated-off note naming the net with a set-rail-voltage action', () => {
    const html = renderWithRailNotes()
    expect(html).toContain('data-testid="rail-note"')
    // Names the offending net and the ~0 V op measurement.
    expect(html).toMatch(/VGATED.*0 V at the operating point/i)
    expect(html).toMatch(/logic thresholds may be inaccurate/i)
    // A working "set rail voltage" affordance (input + button).
    expect(html).toContain('data-testid="rail-note-input"')
    expect(html).toContain('data-testid="rail-note-apply"')
    expect(html).toMatch(/Set rail voltage/i)
  })

  it('no rail notes → no rail-note surface', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <WarningsBar />
      </AppStoreProvider>,
    )
    expect(html).not.toContain('data-testid="rail-note"')
  })

  it('_applyRailOverride sets the override by kicadName and re-runs powerOn', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    const setRailOverride = vi.fn()
    const powerOn = vi.fn()
    store.setState({ setRailOverride, powerOn } as unknown as Partial<AppState>)
    _applyRailOverride(store, '/VGATED', '3.3')
    expect(setRailOverride).toHaveBeenCalledWith('/VGATED', 3.3)
    expect(powerOn).toHaveBeenCalledTimes(1)
  })

  it('_applyRailOverride ignores a non-positive / non-finite value (no re-run)', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    const setRailOverride = vi.fn()
    const powerOn = vi.fn()
    store.setState({ setRailOverride, powerOn } as unknown as Partial<AppState>)
    _applyRailOverride(store, '/VGATED', '0')
    _applyRailOverride(store, '/VGATED', 'abc')
    expect(setRailOverride).not.toHaveBeenCalled()
    expect(powerOn).not.toHaveBeenCalled()
  })
})
