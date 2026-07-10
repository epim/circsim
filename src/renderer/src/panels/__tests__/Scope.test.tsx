/**
 * Scope.test.tsx — M7 (F6.2)
 *
 * The scope's no-probes empty state must teach BOTH probing paths: the
 * drag-a-VP path and the new click-to-probe path ("Probe this net" on a
 * selected net). Static render against a real store (canvas drawing lives in
 * effects, which don't run under renderToStaticMarkup).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import Scope from '../Scope'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

describe('M7 F6.2 — scope empty-state hint mentions both probing paths', () => {
  it('names the drag path AND the click-to-probe path', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <Scope />
      </AppStoreProvider>,
    )
    // No probes on a fresh open → the empty overlay shows…
    expect(html).toContain('No voltage probes attached')
    // …teaching both attach paths.
    expect(html).toMatch(/Drag a V-Probe/i)
    expect(html).toMatch(/Probe this net/i)
  })
})
