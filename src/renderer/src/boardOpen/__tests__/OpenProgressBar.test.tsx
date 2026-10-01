/**
 * OpenProgressBar.test.tsx (issue #55): the strip names the file and stage while
 * a board opens, changes wording once the board is on screen, and is absent
 * when idle. Static render against a real store (the PartsPanel.test pattern).
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import OpenProgressBar from '../OpenProgressBar'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { OpenStage } from '../pipeline'

function render(progress: { fileName: string; stage: OpenStage } | null): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState({ openProgress: progress })
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <OpenProgressBar />
    </AppStoreProvider>,
  )
}

describe('OpenProgressBar', () => {
  it('renders nothing when no board is opening', () => {
    expect(render(null)).toBe('')
  })

  it('names the file and the stage while opening', () => {
    const html = render({ fileName: 'big.kicad_pcb', stage: 'resolving' })
    expect(html).toContain('data-testid="open-progress"')
    expect(html).toContain('data-stage="resolving"')
    expect(html).toContain('Opening big.kicad_pcb')
    expect(html).toContain('Resolving parts')
  })

  it('says the board is loaded once only the audit remains', () => {
    const html = render({ fileName: 'big.kicad_pcb', stage: 'auditing' })
    expect(html).toContain('Board loaded.')
    expect(html).toContain('Running Board Critic')
    expect(html).not.toContain('Opening big.kicad_pcb')
  })
})
