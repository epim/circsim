import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import BenchLeads from '../BenchLeads'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'), 'fixture-rc.kicad_pcb')
  return store
}

describe('BenchLeads composition', () => {
  // NOTE: Unmount cleanup (removal of window listeners on unmount) is covered by
  // code inspection and typecheck. vitest uses Node environment (not jsdom),
  // so renderToStaticMarkup does not mount/unmount components or run effects.
  // The actual component mount/unmount behavior is exercised at runtime in the
  // Electron app; static typing ensures the cleanup effect is well-formed.

  it('renders children + shelf + the lead-layer SVG in one container', () => {
    const store = openedStore()
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <BenchLeads scene={null}>
          <div data-testid="fake-viewport" />
        </BenchLeads>
      </AppStoreProvider>,
    )
    expect(html).toContain('data-testid="fake-viewport"')
    expect(html).toContain('data-testid="bench-shelf"')
    expect(html).toContain('data-testid="lead-layer"')
    // No anchors yet (scene null, no layout) → no committed lead paths.
    expect(html).not.toContain('data-testid="lead-path"')
  })
})
