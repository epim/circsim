/**
 * ModelDoctor.test.tsx — F4: the Doctor drawer follows the store selection.
 *
 * Clicking a part row (or a board part) sets `selectedRef`; the Doctor must
 * highlight that part's card and scroll it into view. Follows the CriticPanel
 * pattern: render against a real store via react-dom/server (node test env —
 * no jsdom), asserting on the static HTML for the highlight, plus direct unit
 * tests of the exported `_revealDoctorCard` scroll helper (effects don't run
 * under renderToStaticMarkup, and jsdom/detached nodes may lack scrollIntoView
 * — the helper is defensive about both).
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import ModelDoctor, { _revealDoctorCard, DoctorMoreMenu } from '../ModelDoctor'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Circuit, Part } from '../../../../core/netlist/extract'
import type { LibraryEntry, Resolution } from '../../../../core/models/types'
import type { AppState } from '../../store/appStore'

function part(ref: string, value: string): Part {
  return {
    ref,
    value,
    libId: 'test:lib',
    layer: 'F',
    padNet: new Map([
      ['1', 1],
      ['2', 2],
    ]),
    properties: {},
  }
}

function unresolved(ref: string): Resolution {
  return { ref, status: 'unresolved', tier: 6, warnings: [] }
}

function renderDoctor(selectedRef: string | null): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  const circuit: Circuit = {
    nets: [],
    parts: [part('U1', 'NCE4012S'), part('U2', 'TL431')],
    warnings: [],
  }
  store.setState({
    circuit,
    resolutions: [unresolved('U1'), unresolved('U2')],
    selectedRef,
  })
  // renderToStaticMarkup takes React's SERVER snapshot, which zustand 4.5 reads
  // from `getServerState || getInitialState` — i.e. the state at store creation,
  // not the setState above. Point getServerState at the live state so the
  // static render sees the injected circuit/resolutions/selection.
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <ModelDoctor />
    </AppStoreProvider>,
  )
}

describe('ModelDoctor — selection sync (F4)', () => {
  it('highlights the selected part card (data-selected + outline)', () => {
    const html = renderDoctor('U1')
    // The U1 card carries the selected marker…
    expect(html).toMatch(/data-ref="U1"[^>]*data-selected="true"|data-selected="true"[^>]*data-ref="U1"/)
    // …and the highlight outline style.
    expect(html).toContain('outline:2px solid')
    // Exactly ONE selected card.
    expect(html.match(/data-selected="true"/g)).toHaveLength(1)
  })

  it('no selection → no card highlighted', () => {
    const html = renderDoctor(null)
    expect(html).not.toContain('data-selected')
    expect(html).not.toContain('outline:2px solid')
  })

  it('selecting a part that is not in the Doctor list highlights nothing (no crash)', () => {
    const html = renderDoctor('R99')
    expect(html).toContain('data-ref="U1"') // drawer still renders
    expect(html).not.toContain('data-selected')
  })
})

// ─── M9: documented-open cards — informational note + full override actions ───

function renderDoctorWith(resolutions: Resolution[], parts: Part[]): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  const circuit: Circuit = { nets: [], parts, warnings: [] }
  store.setState({ circuit, resolutions, selectedRef: null })
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <ModelDoctor />
    </AppStoreProvider>,
  )
}

describe('ModelDoctor — documented-open cards (M9)', () => {
  const openRes: Resolution = {
    ref: 'U1',
    status: 'documented-open',
    tier: 3,
    warnings: [],
    model: { kind: 'stub', mode: 'open' },
    note: 'USB Type-C PD sink controller — electrically passive at a fixed 5 V bench supply. Intentionally left open.',
  }

  it('shows the note prominently as informational (not an error pill)', () => {
    const html = renderDoctorWith([openRes], [part('U1', 'CH224K')])
    expect(html).toContain('data-testid="doctor-note"')
    expect(html).toContain('Intentionally left open.')
    // Pill reads "open by design", not "no model" / "stubbed".
    expect(html).toContain('open by design')
    expect(html).not.toContain('no model')
  })

  it('still offers every override action (stub / interactive / import / pin map)', () => {
    // Gemini finding 1 (Task 2) moved Stub short / Interactive pins / Ask your
    // LLM into the ⋮ overflow menu (DoctorMoreMenu), closed by default — see
    // "Doctor card action hierarchy" below, which asserts those three render
    // as menuitems when the menu is open. Here we only assert the card still
    // surfaces every override path: the 3 primary actions directly, plus the
    // overflow trigger for the rest.
    const html = renderDoctorWith([openRes], [part('U1', 'CH224K')])
    for (const label of ['Stub open', 'Import .lib…', 'Pin map']) {
      expect(html, `action "${label}" must stay available`).toContain(label)
    }
    expect(html, 'overflow menu trigger must stay available').toContain(
      'data-testid="doctor-more"',
    )
  })

  it('an unresolved card keeps the red "no model" pill and shows no note block', () => {
    const html = renderDoctorWith([unresolved('U2')], [part('U2', 'MYSTERY99')])
    expect(html).toContain('no model')
    expect(html).not.toContain('data-testid="doctor-note"')
  })

  it('a pin-map override on a documented-open card is clearable: override → Reset visible → clears', () => {
    // A Pin map edit on a documented-open part stores a pinMapOverrides entry
    // that has NO effect on the open stub — legitimate prep for a later import,
    // but it must surface as resettable state, never uncleanable silent state
    // that ambushes that import. Uses the REAL library so U1 (CH224K) resolves
    // documented-open at tier 3 throughout (a tier-6 card shows Reset anyway).
    const realLibrary = (
      JSON.parse(
        readFileSync(join(process.cwd(), 'resources', 'models', 'index.json'), 'utf8'),
      ) as { entries: LibraryEntry[] }
    ).entries
    const store = createAppStore({ simClient: createMockSimClient() })
    const circuit: Circuit = { nets: [], parts: [part('U1', 'CH224K')], warnings: [] }
    store.setState({ circuit })
    store.getState().setModelLibrary(realLibrary, {})
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    const render = (): string =>
      renderToStaticMarkup(
        <AppStoreProvider store={store}>
          <ModelDoctor />
        </AppStoreProvider>,
      )

    expect(store.getState().resolutions[0].status).toBe('documented-open')
    // No override yet → nothing to reset.
    expect(render()).not.toContain('>Reset<')

    store.getState().setPinMap('U1', { '1': 'vdd' })
    expect(store.getState().resolutions[0].status).toBe('documented-open')
    expect(render()).toContain('>Reset<')

    store.getState().clearPartOverride('U1')
    expect(store.getState().pinMapOverrides.has('U1')).toBe(false)
    expect(render()).not.toContain('>Reset<')
  })
})

// ─── Gemini finding 1: action hierarchy — 3 primary + ⋮ overflow menu ─────────

describe('Doctor card action hierarchy (Gemini finding 1)', () => {
  it('card shows exactly the 3 primary actions + the ⋮ trigger; menu closed', () => {
    const html = renderDoctor(null)
    expect(html).toContain('Import .lib')
    expect(html).toContain('Pin map')
    expect(html).toContain('Stub open')
    expect(html).toContain('data-testid="doctor-more"')
    // secondary actions are NOT in the closed-state DOM
    expect(html).not.toContain('Stub short')
    expect(html).not.toContain('Interactive pins')
    expect(html).not.toContain('Ask your LLM')
    expect(html).not.toContain('data-testid="doctor-more-menu"')
  })

  it('DoctorMoreMenu open renders the three secondary actions as menuitems', () => {
    const items = [
      { label: 'Stub short', onSelect: () => {} },
      { label: 'Interactive pins', onSelect: () => {} },
      { label: 'Ask your LLM', onSelect: () => {} },
    ]
    const html = renderToStaticMarkup(
      <DoctorMoreMenu items={items} open={true} onToggle={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="doctor-more-menu"')
    expect(html).toContain('role="menu"')
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(3)
    for (const it_ of items) expect(html).toContain(it_.label)
    expect(html).toContain('aria-expanded="true"')
  })

  it('DoctorMoreMenu closed renders only the trigger', () => {
    const html = renderToStaticMarkup(
      <DoctorMoreMenu
        items={[{ label: 'Stub short', onSelect: () => {} }]}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="doctor-more"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-testid="doctor-more-menu"')
    expect(html).not.toContain('Stub short')
  })
})

describe('_revealDoctorCard — scroll helper', () => {
  it('calls scrollIntoView with block:"nearest"', () => {
    const scrollIntoView = vi.fn()
    _revealDoctorCard({ scrollIntoView })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('tolerates a null element (ref not yet attached)', () => {
    expect(() => _revealDoctorCard(null)).not.toThrow()
  })

  it('tolerates an element without scrollIntoView (jsdom-style stub)', () => {
    expect(() => _revealDoctorCard({} as { scrollIntoView?: () => void })).not.toThrow()
  })
})
