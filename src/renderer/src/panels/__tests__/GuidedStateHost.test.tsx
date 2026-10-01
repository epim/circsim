/**
 * GuidedStateHost.test.tsx -- issue #32 (Spec section 12).
 *
 * Static-render tests against a real store (mock simClient): a blocked
 * Energize / Power On mounts the guided card, and the toolbar shows the
 * blocked reason as visible text on focusable (aria-disabled) buttons.
 */

import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import GuidedStateHost, { currentBlock } from '../GuidedStateHost'
import Toolbar from '../Toolbar'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { AUTO_NAMED_BOARD } from '../../store/__tests__/autoNamedBoard'

const fixturesDir = join(__dirname, '../../../../../fixtures')

type Store = ReturnType<typeof createAppStore>

// zustand renders from getServerState ?? getInitialState under react-dom/server,
// which would show the pre-open (empty) state. Point it at the live state.
function live(store: Store): Store {
  const withServer = store as unknown as { getServerState?: () => unknown }
  withServer.getServerState = store.getState
  return store
}

function renderHost(store: Store): string {
  live(store)
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <GuidedStateHost />
    </AppStoreProvider>,
  )
}

function renderToolbar(store: Store): string {
  live(store)
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <Toolbar overlay="realistic" onOverlay={() => {}} />
    </AppStoreProvider>,
  )
}

describe('GuidedStateHost (#32)', () => {
  let store: Store

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
  })

  it('renders nothing before any blocked attempt', () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    expect(renderHost(store)).toBe('')
  })

  it('Energize on an auto-named board mounts the no-ground card', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    await store.getState().energize()

    const html = renderHost(store)
    expect(html).toContain('data-testid="no-ground-state"')
    expect(html).toContain('Designate a ground net first')
    expect(html).not.toContain('data-testid="no-source-state"')
  })

  it('Power On with ground but no wired source mounts the no-source card', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    store.getState().setGround(3)
    await store.getState().powerOn()

    const html = renderHost(store)
    expect(html).toContain('data-testid="no-source-state"')
    expect(html).not.toContain('data-testid="no-ground-state"')
  })

  it('the card goes away once the block is resolved', async () => {
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')
    await store.getState().powerOn()
    expect(renderHost(store)).toContain('data-testid="no-ground-state"')

    // Ground set and a supply attached: nothing blocks any more.
    store.getState().setGround(3)
    store.getState().attachSupplyToNet(1)
    expect(renderHost(store)).toBe('')
  })

  it('currentBlock prefers ground over source', () => {
    expect(currentBlock(null, false)).toBe('no-ground')
    expect(currentBlock(null, true)).toBe('no-ground')
    expect(currentBlock(3, false)).toBe('no-source')
    expect(currentBlock(3, true)).toBeNull()
  })
})

describe('Toolbar blocked state (#32)', () => {
  it('shows the reason as visible text and keeps the buttons focusable', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(AUTO_NAMED_BOARD, 'auto.kicad_pcb')

    const html = renderToolbar(store)
    expect(html).toContain('data-testid="toolbar-blocked-reason"')
    expect(html).toContain('Designate a ground net first')
    // aria-disabled, never the native `disabled` attribute (which is unfocusable)
    expect(html).toMatch(/aria-disabled="true"[^>]*data-testid="power-on-btn"/)
    expect(html).toMatch(/aria-disabled="true"[^>]*data-testid="run-btn"/)
    expect(html).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/)
  })

  it('shows no blocked reason when ground and a wired source exist', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-555.kicad_pcb'), 'utf-8'),
        'fixture-555.kicad_pcb',
      )
    const html = renderToolbar(store)
    expect(html).not.toContain('toolbar-blocked-reason')
    expect(html).toMatch(/aria-disabled="false"[^>]*data-testid="power-on-btn"/)
  })
})
