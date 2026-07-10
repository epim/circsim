/**
 * PartsPanel.test.tsx — M9: documented-open parts get a distinct badge.
 *
 * A part the library knows and intentionally doesn't model ("documented open")
 * must NOT wear the red no-model badge — it gets a grey "Open by design" dot,
 * visually distinct from both ok-green and stubbed-amber. Static render against
 * a real store (the ModelDoctor.test.tsx pattern).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PartsPanel from '../PartsPanel'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Circuit, Part } from '../../../../core/netlist/extract'
import type { Resolution } from '../../../../core/models/types'

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

function renderPanel(parts: Part[], resolutions: Resolution[]): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  const circuit: Circuit = { nets: [], parts, warnings: [] }
  store.setState({ circuit, resolutions })
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <PartsPanel />
    </AppStoreProvider>,
  )
}

describe('PartsPanel — documented-open badge (M9)', () => {
  const resolutions: Resolution[] = [
    {
      ref: 'R1',
      status: 'ok',
      tier: 2,
      warnings: [],
      model: { kind: 'primitive', card: 'r_r1 a b 10k' },
    },
    {
      ref: 'U1',
      status: 'documented-open',
      tier: 3,
      warnings: [],
      model: { kind: 'stub', mode: 'open' },
      note: 'USB Type-C PD sink controller — intentionally left open.',
    },
    { ref: 'U9', status: 'unresolved', tier: 6, warnings: [] },
  ]
  const parts = [part('R1', '10k'), part('U1', 'CH224K'), part('U9', 'MYSTERY99')]

  it('documented-open rows wear the grey "Open by design" badge, not red', () => {
    const html = renderPanel(parts, resolutions)
    expect(html).toContain('data-testid="status-badge-grey"')
    expect(html).toContain('Open by design')
    // The genuinely unknown part still shows red; ok stays green.
    expect(html).toContain('data-testid="status-badge-red"')
    expect(html).toContain('data-testid="status-badge-ok"')
    // Exactly one grey badge (only U1 is a documented open).
    expect(html.match(/status-badge-grey/g)).toHaveLength(1)
  })
})
