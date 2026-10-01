/**
 * DiagnosticsButton.test.tsx: issue #26. The crash toast names the cause and
 * offers "Save diagnostics"; so does the bar under any other warning.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import WarningsBar, { crashNoticeMessage, diagnosticsStatusMessage } from '../WarningsBar'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

function render(patch: Partial<AppState>): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState(patch)
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <WarningsBar />
    </AppStoreProvider>,
  )
}

describe('crashNoticeMessage', () => {
  it('says watchdog timeout for exit 86', () => {
    const msg = crashNoticeMessage({ willRespawn: true, at: 0, exitCode: 86, reason: 'watchdog' })
    expect(msg).toContain('watchdog timeout')
    expect(msg).toContain('exit code 86')
    expect(msg).toContain('recovering automatically')
  })
  it('says crashed with the code otherwise', () => {
    const msg = crashNoticeMessage({ willRespawn: false, at: 0, exitCode: 3221225477, reason: 'crashed' })
    expect(msg).toContain('crashed')
    expect(msg).toContain('exit code 3221225477')
    expect(msg).toContain('could not be restarted')
    expect(msg).not.toContain('watchdog')
  })
  it('keeps a generic sentence when the reason is unknown', () => {
    expect(crashNoticeMessage({ willRespawn: true, at: 0 })).toBe(
      'The simulation engine crashed and is recovering automatically.',
    )
  })
})

describe('diagnosticsStatusMessage', () => {
  it('reports saved, error and nothing for a cancel', () => {
    expect(diagnosticsStatusMessage({ saved: true, path: 'C:\\x.zip' })).toBe('Saved diagnostics to C:\\x.zip.')
    expect(diagnosticsStatusMessage({ saved: false, error: 'disk full' })).toContain('disk full')
    expect(diagnosticsStatusMessage({ saved: false })).toBeNull()
    expect(diagnosticsStatusMessage(null)).toBeNull()
  })
})

describe('Save diagnostics button', () => {
  it('is in the crash toast, with the reason', () => {
    const html = render({ crashNotice: { willRespawn: true, at: 1, exitCode: 86, reason: 'watchdog' } })
    expect(html).toContain('data-testid="crash-save-diagnostics"')
    expect(html).toContain('watchdog timeout')
    // The toast carries its own button; the bar does not add a second one.
    expect(html).not.toContain('data-testid="save-diagnostics"')
  })

  it('is in the bar under another warning', () => {
    const unresolved: Resolution = { ref: 'U1', status: 'unresolved', tier: 6, warnings: [] }
    const html = render({ resolutions: [unresolved] })
    expect(html).toContain('data-testid="save-diagnostics"')
    expect(html).not.toContain('data-testid="crash-save-diagnostics"')
  })

  it('does not make the bar appear when there is nothing to warn about', () => {
    expect(render({})).toBe('')
  })
})
