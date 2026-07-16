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
import WarningsBar, { _applyRailOverride, FidelityBadge } from '../WarningsBar'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'
import { SCHEMATIC_PINMAP_NOTE } from '../../../../core/models/libraryMatch'

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

// ─── Gemini finding 4: minimizable fidelity banner + header badge ─────────────

/** renderBar variant that also seeds fidelityMinimizedSig and renders the badge too. */
function renderBarAndBadge(resolutions: Resolution[], minimize: boolean): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState({ resolutions })
  if (minimize) store.getState().minimizeFidelityBanner()
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <WarningsBar />
      <FidelityBadge />
    </AppStoreProvider>,
  )
}

describe('Gemini finding 4 — minimizable fidelity banner', () => {
  it('expanded: banner shows the minimize control, badge absent', () => {
    const html = renderBarAndBadge([unresolved('U1')], false)
    expect(html).toContain('Results approximate')
    expect(html).toContain('data-testid="fidelity-minimize"')
    expect(html).not.toContain('data-testid="fidelity-badge"')
  })

  it('minimized: banner hidden, amber badge with count shown', () => {
    const html = renderBarAndBadge([unresolved('U1'), unresolved('Q7')], true)
    expect(html).not.toContain('Results approximate')
    expect(html).toContain('data-testid="fidelity-badge"')
    expect(html).toContain('⚠ 2 approximate')
    expect(html).toContain('role="button"')
  })

  it('minimized + problem set changes → banner re-expands, badge gone', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.setState({ resolutions: [unresolved('U1')] })
    store.getState().minimizeFidelityBanner()
    // a NEW problem appears after the user minimized
    store.setState({ resolutions: [unresolved('U1'), unresolved('Q7')] })
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <WarningsBar />
        <FidelityBadge />
      </AppStoreProvider>,
    )
    expect(html).toContain('Results approximate')
    expect(html).not.toContain('data-testid="fidelity-badge"')
  })

  it('only documented opens minimized → grey-blue info badge wording', () => {
    const html = renderBarAndBadge([documentedOpen('J1'), documentedOpen('J2')], true)
    expect(html).toContain('data-testid="fidelity-badge"')
    expect(html).toContain('ⓘ 2 open by design')
    expect(html).not.toContain('⚠')
  })

  it('badge title lists the refs so hover reveals detail without expanding', () => {
    const html = renderBarAndBadge([unresolved('U1'), unresolved('Q7')], true)
    expect(html).toMatch(/title="[^"]*U1[^"]*Q7[^"]*"/)
  })
})

// ─── Schematic pin-map correction notes (spec 2026-07-15) ────────────────────

function schematicCorrected(ref: string): Resolution {
  return {
    ref,
    status: 'ok',
    tier: 3,
    warnings: [SCHEMATIC_PINMAP_NOTE],
    model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'DSS54', pinMap: { '1': '1', '2': '2' } },
  }
}

describe('schematic pin-map notes — informational row per corrected ref', () => {
  it('a resolution carrying the schematic-pinmap warning → note row with ref + copy', () => {
    const html = renderBar([schematicCorrected('D7')])
    expect(html).toContain('data-testid="schematic-pinmap-note"')
    expect(html).toContain('data-ref="D7"')
    expect(html).toContain('D7')
    expect(html).toContain('pin map corrected from schematic (A/K)')
    expect(html).toContain('footprint convention was reversed')
    expect(html).toContain('Override in Model Doctor if the schematic is stale')
  })

  it('two corrected refs → two rows', () => {
    const html = renderBar([schematicCorrected('D7'), schematicCorrected('D8')])
    expect(html.match(/data-testid="schematic-pinmap-note"/g)).toHaveLength(2)
    expect(html).toContain('data-ref="D7"')
    expect(html).toContain('data-ref="D8"')
  })

  it('no schematic-pinmap warnings → no rows (and bar stays hidden when nothing else)', () => {
    const ok: Resolution = {
      ref: 'D1',
      status: 'ok',
      tier: 3,
      warnings: [],
      model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'DSS54', pinMap: { '1': '2', '2': '1' } },
    }
    const html = renderBar([ok])
    expect(html).not.toContain('schematic-pinmap-note')
    expect(html).toBe('') // nothing else to show → component returns null
  })

  it('note is NOT counted by the fidelity banner/badge (accuracy upgrade, not approximation)', () => {
    const html = renderBar([schematicCorrected('D7')])
    expect(html).not.toContain('Results approximate')
    expect(html).not.toContain('approximate')
  })
})
