/**
 * SetupBar.test.tsx - issue #27: the visible note and the opt-in save offer.
 * Static SSR render of the pure view plus direct tests of the wording model.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SetupBarView, setupBarModel } from '../SetupBar'
import { INITIAL_SIDECAR_STATE, type SidecarState } from '../../store/appStore'

const noop = (): void => {}
const PATH = 'C:\\work\\blinker.circsim.json'

function state(over: Partial<SidecarState>): SidecarState {
  return { ...INITIAL_SIDECAR_STATE, path: PATH, diskStatus: 'absent', ...over }
}

function render(sc: SidecarState): string {
  return renderToStaticMarkup(<SetupBarView sidecar={sc} onSave={noop} onDismiss={noop} />)
}

describe('setupBarModel', () => {
  it('says nothing for a board with no setup path (bundled samples)', () => {
    expect(setupBarModel({ ...INITIAL_SIDECAR_STATE }, '')).toBeNull()
  })

  it('offers to save when nothing is on disk, and is explicit about where', () => {
    const m = setupBarModel(state({}), 'blinker.circsim.json')!
    expect(m.offer?.button).toBe('Save setup')
    expect(m.offer?.text).toContain('blinker.circsim.json')
    expect(m.note).toBeNull()
  })

  it('reports a restore with a count', () => {
    const m = setupBarModel(
      state({
        diskStatus: 'ok',
        autosave: true,
        note: { restored: 7, messages: [], status: 'ok', fileName: 'blinker.circsim.json' },
      }),
      'blinker.circsim.json',
    )!
    expect(m.note?.text).toBe('Restored 7 saved settings from blinker.circsim.json.')
    expect(m.offer).toBeNull()
    expect(m.status).toContain('autosaves')
  })

  it('singular count', () => {
    const m = setupBarModel(
      state({ autosave: true, note: { restored: 1, messages: [], status: 'ok', fileName: 'x.circsim.json' } }),
      'x.circsim.json',
    )!
    expect(m.note?.text).toBe('Restored 1 saved setting from x.circsim.json.')
  })

  it('an unreadable file says the board opened without its setup and offers a backed-up replace', () => {
    const m = setupBarModel(
      state({
        diskStatus: 'unreadable',
        note: { restored: 0, messages: ['The setup file is damaged.'], status: 'unreadable', fileName: 'b.circsim.json' },
      }),
      'b.circsim.json',
    )!
    expect(m.note?.text).toContain('could not be read')
    expect(m.offer?.text).toContain('b.circsim.json.bak')
    expect(m.offer?.button).toBe('Replace and save')
  })

  it('a newer-format file is not overwritten without the user choosing to', () => {
    const m = setupBarModel(
      state({
        diskStatus: 'newer',
        note: { restored: 2, messages: [], status: 'newer', fileName: 'b.circsim.json' },
      }),
      'b.circsim.json',
    )!
    expect(m.note?.text).toContain('newer circsim')
    expect(m.offer?.button).toBe('Replace and save')
  })

  it('a save failure is shown', () => {
    const m = setupBarModel(state({ autosave: true, diskStatus: 'ok', error: 'Could not save the setup file: disk full' }), 'a.circsim.json')!
    expect(m.error).toContain('disk full')
    expect(m.status).toBeNull()
  })
})

describe('SetupBarView', () => {
  it('renders the save offer with its testid', () => {
    const html = render(state({}))
    expect(html).toContain('data-testid="setup-bar"')
    expect(html).toContain('data-testid="setup-save-btn"')
    expect(html).not.toContain('setup-restored-note')
  })

  it('renders the restored note, its skipped-item details, and a dismiss button', () => {
    const html = render(
      state({
        diskStatus: 'ok',
        autosave: true,
        note: { restored: 3, messages: ['The saved stub for D9 was dropped: D9 is not on this board.'], status: 'ok', fileName: 'blinker.circsim.json' },
      }),
    )
    expect(html).toContain('data-testid="setup-restored-note"')
    expect(html).toContain('Restored 3 saved settings')
    expect(html).toContain('1 note')
    expect(html).toContain('D9 is not on this board')
    expect(html).toContain('data-testid="setup-dismiss-btn"')
  })

  it('renders nothing when there is nothing to say', () => {
    expect(render({ ...INITIAL_SIDECAR_STATE })).toBe('')
  })
})
