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
import { renderToStaticMarkup } from 'react-dom/server'
import ModelDoctor, { _revealDoctorCard } from '../ModelDoctor'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Circuit, Part } from '../../../../core/netlist/extract'
import type { Resolution } from '../../../../core/models/types'
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
