/**
 * renderer/panels/SetupBar.tsx - the per-board setup file surface (issue #27).
 *
 * One slim bar under the toolbar that says, in plain language, what circsim did
 * with the setup saved beside the board:
 *   - restored N settings (and what could not be restored), dismissable
 *   - nothing is saved yet: offers "Save setup" (writing is opt-in per board)
 *   - the file could not be used (damaged, or from a newer circsim)
 *   - autosave is on (muted), or the last save failed
 *
 * Renders nothing when the board has no path to save beside (the bundled
 * samples) or when there is nothing to say. The model (setupBarModel) is a pure
 * function of the store's SidecarState so the wording is unit-tested.
 *
 * data-testid hooks: setup-bar, setup-restored-note, setup-save-btn,
 * setup-dismiss-btn, setup-error, setup-autosave-status
 */

import React from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { SidecarState } from '../store/appStore'
import { btnSecondary } from '../ui/buttonStyles'

export interface SetupBarModel {
  /** Restored-or-skipped note, when one is showing. */
  note: { text: string; details: string[] } | null
  /** The offer to start saving, when saving is off. */
  offer: { text: string; button: string } | null
  /** Plain status line when autosave is on and healthy. */
  status: string | null
  /** Last save failure. */
  error: string | null
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Pure: what the bar should say for a given sidecar state. null = render nothing. */
export function setupBarModel(sc: SidecarState, fileName: string): SetupBarModel | null {
  if (!sc.path) return null

  let note: SetupBarModel['note'] = null
  if (sc.note) {
    const n = sc.note
    let text: string
    if (n.status === 'unreadable') {
      text = `${n.fileName} could not be read, so this board opened without its saved setup.`
    } else if (n.restored === 0) {
      text = `${n.fileName} had nothing circsim could restore on this board.`
    } else {
      text = `Restored ${plural(n.restored, 'saved setting', 'saved settings')} from ${n.fileName}.`
    }
    if (n.status === 'newer') text += ' It was saved by a newer circsim, so this version will not change it.'
    note = { text, details: n.messages }
  }

  let offer: SetupBarModel['offer'] = null
  if (!sc.autosave) {
    if (sc.diskStatus === 'absent') {
      offer = {
        text: `Your ground, bench, overrides and models are not saved. Save them beside the board as ${fileName} and a reopen or restart restores them.`,
        button: 'Save setup',
      }
    } else if (sc.diskStatus === 'unreadable') {
      offer = {
        text: `Changes are not being saved because ${fileName} could not be read. Saving replaces it and keeps the old file as ${fileName}.bak.`,
        button: 'Replace and save',
      }
    } else if (sc.diskStatus === 'newer') {
      offer = {
        text: `Changes are not being saved because ${fileName} came from a newer circsim. Saving replaces it and keeps the old file as ${fileName}.bak.`,
        button: 'Replace and save',
      }
    }
  }

  const status = sc.autosave && !sc.error ? `Setup autosaves to ${fileName}` : null
  const error = sc.error

  if (!note && !offer && !status && !error) return null
  return { note, offer, status, error }
}

export default function SetupBar(): React.ReactElement | null {
  const store = useAppStoreApi()
  const sidecar = useApp(s => s.sidecar)
  const board = useApp(s => s.board)
  if (!board) return null
  return (
    <SetupBarView
      sidecar={sidecar}
      onSave={() => store.getState().enableAutosave()}
      onDismiss={() => store.getState().dismissSidecarNote()}
    />
  )
}

export function SetupBarView({
  sidecar,
  onSave,
  onDismiss,
}: {
  sidecar: SidecarState
  onSave: () => void
  onDismiss: () => void
}): React.ReactElement | null {
  const fileName = sidecar.path ? sidecar.path.split(/[\\/]/).pop() ?? '' : ''
  const model = setupBarModel(sidecar, fileName)
  if (!model) return null
  return (
    <div style={barStyle} data-testid="setup-bar">
      {model.note && (
        <div style={rowStyle} data-testid="setup-restored-note">
          <span style={{ flex: 1 }}>
            {model.note.text}
            {model.note.details.length > 0 && (
              <details style={{ display: 'inline', marginLeft: 8 }}>
                <summary style={{ display: 'inline', cursor: 'pointer', color: '#9ab' }}>
                  {plural(model.note.details.length, 'note', 'notes')}
                </summary>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#bcd' }}>
                  {model.note.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </details>
            )}
          </span>
          <button style={miniBtn} onClick={onDismiss} data-testid="setup-dismiss-btn">
            Dismiss
          </button>
        </div>
      )}
      {model.offer && (
        <div style={rowStyle}>
          <span style={{ flex: 1, color: '#bcd' }}>{model.offer.text}</span>
          <button style={miniBtn} onClick={onSave} data-testid="setup-save-btn">
            {model.offer.button}
          </button>
        </div>
      )}
      {model.error && (
        <div style={{ ...rowStyle, color: '#fbb' }} data-testid="setup-error">
          {model.error}
        </div>
      )}
      {model.status && (
        <div style={{ ...rowStyle, color: '#789' }} data-testid="setup-autosave-status">
          {model.status}
        </div>
      )}
    </div>
  )
}

const barStyle: React.CSSProperties = {
  background: '#141a2a',
  borderBottom: '1px solid #26304a',
  color: '#cde',
  fontSize: 12,
  padding: '4px 16px',
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  padding: '2px 0',
}
const miniBtn: React.CSSProperties = {
  ...btnSecondary,
  padding: '2px 10px',
  fontSize: 11,
}
