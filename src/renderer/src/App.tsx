/**
 * renderer/App.tsx — Task 21
 *
 * App shell: toolbar (Open), left dock (Parts + Model Doctor), 3D viewport.
 * Bidirectional selection sync: PartsPanel ↔ store.selectedRef ↔ viewport picks.
 *
 * Later tasks (22–24) add the instrument rack, scope, and run controls; this
 * shell leaves room (right/bottom docks) for them.
 */

import React, { useCallback } from 'react'
import Viewport from './viewport/Viewport'
import PartsPanel from './panels/PartsPanel'
import ModelDoctor from './panels/ModelDoctor'
import { AppStoreProvider, useApp, useAppStoreApi } from './store/storeContext'
import type { AppStore } from './store/appStore'
import { resolutionSummary } from './store/appStore'
import { openProjectFromPath } from './ipc/fileOpen'
import type { PickEvent } from './viewport/picking'

export default function App({ store }: { store: AppStore }): React.ReactElement {
  return (
    <AppStoreProvider store={store}>
      <Shell />
    </AppStoreProvider>
  )
}

function Shell(): React.ReactElement {
  const store = useAppStoreApi()
  const board = useApp(s => s.board)
  const selectedRef = useApp(s => s.selectedRef)
  const opVoltages = useApp(s => s.opVoltages)
  const voltageRange = useApp(s => s.voltageRange)
  const parseError = useApp(s => s.parseError)
  const viewerOnly = useApp(s => s.viewerOnly)
  const resolutions = useApp(s => s.resolutions)

  const summary = resolutionSummary(resolutions)

  const handleOpen = useCallback(async () => {
    const res = await window.circsim.openFileDialog({
      title: 'Open KiCad board',
      filters: [{ name: 'KiCad PCB', extensions: ['kicad_pcb'] }],
      properties: ['openFile'],
    })
    if (res.cancelled || res.filePaths.length === 0) return
    const opened = await openProjectFromPath(res.filePaths[0], window.circsim.readFile)
    store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
      schematicText: opened.schematicText,
      schematicFileName: opened.schematicFileName,
      bomText: opened.bomText,
    })
  }, [store])

  const handlePick = useCallback(
    (event: PickEvent) => {
      const st = store.getState()
      if (event.type === 'clickComponent') {
        st.selectComponent(event.ref)
      } else if (event.type === 'clickNet') {
        st.selectNet(event.netId)
      } else if (event.type === 'hoverNet') {
        // hover handled by the scene's emissive boost; no store change needed
      } else if (event.type === 'clearHover') {
        // no-op
      }
    },
    [store],
  )

  // Drag-drop of a .kicad_pcb onto the window.
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const file = [...e.dataTransfer.files].find(f => f.name.endsWith('.kicad_pcb'))
      if (!file) return
      // Electron File objects expose a real path; fall back to text() otherwise.
      const path = (file as File & { path?: string }).path
      if (path) {
        const opened = await openProjectFromPath(path, window.circsim.readFile)
        store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
          schematicText: opened.schematicText,
          schematicFileName: opened.schematicFileName,
          bomText: opened.bomText,
        })
      } else {
        const text = await file.text()
        store.getState().openBoardFromText(text, file.name)
      }
    },
    [store],
  )

  return (
    <div
      style={rootStyle}
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
    >
      <header style={headerStyle}>
        <strong>circsim</strong>
        <span style={{ fontSize: 12, color: '#888' }}>v0.1.0</span>
        <button style={toolbarBtn} onClick={handleOpen}>
          Open…
        </button>
        {board && (
          <span style={{ fontSize: 12, color: '#9ab' }}>
            {summary.total} parts · {summary.ok} ok
            {summary.stubbed > 0 && ` · ${summary.stubbed} stubbed`}
            {summary.unresolved > 0 && ` · ${summary.unresolved} unresolved`}
          </span>
        )}
        {viewerOnly && (
          <span style={viewerBadge} title="Simulation can't proceed; board shown read-only">
            viewer-only
          </span>
        )}
      </header>

      {parseError && (
        <div style={errorCardStyle}>
          <strong>Could not parse {parseError.fileName ?? 'board'}.</strong>{' '}
          {parseError.line !== undefined && (
            <span>
              (line {parseError.line}
              {parseError.col !== undefined ? `, col ${parseError.col}` : ''})
            </span>
          )}{' '}
          {parseError.message}
        </div>
      )}

      <main style={mainStyle}>
        <aside style={leftDockStyle}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <PartsPanel />
          </div>
          <ModelDoctor />
        </aside>
        <div style={{ flex: 1, position: 'relative' }}>
          {board ? (
            <Viewport
              board={board}
              onPick={handlePick}
              netVoltages={opVoltages ?? undefined}
              voltageRange={voltageRange}
              overlay={opVoltages ? 'voltage' : 'realistic'}
            />
          ) : (
            <EmptyState onOpen={handleOpen} />
          )}
          {selectedRef && (
            <div style={selectionBadge}>Selected: {selectedRef}</div>
          )}
        </div>
      </main>
    </div>
  )
}

function EmptyState({ onOpen }: { onOpen: () => void }): React.ReactElement {
  return (
    <div style={emptyStateStyle}>
      <div style={{ fontSize: 18, marginBottom: 8 }}>No board loaded</div>
      <div style={{ color: '#888', marginBottom: 16 }}>
        Open a <code>.kicad_pcb</code> file, or drag one onto the window.
      </div>
      <button style={{ ...toolbarBtn, padding: '8px 16px' }} onClick={onOpen}>
        Open…
      </button>
    </div>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────
const rootStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  fontFamily: 'sans-serif',
  background: '#0c0c14',
}
const headerStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#1a1a2e',
  color: '#eee',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}
const toolbarBtn: React.CSSProperties = {
  background: '#2a2a45',
  color: '#eee',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 13,
}
const viewerBadge: React.CSSProperties = {
  background: '#7a5c1c',
  color: '#ffe',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
}
const errorCardStyle: React.CSSProperties = {
  background: '#3a1a1a',
  color: '#fdd',
  padding: '10px 16px',
  borderBottom: '1px solid #5a2a2a',
  fontSize: 13,
}
const mainStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  overflow: 'hidden',
}
const leftDockStyle: React.CSSProperties = {
  width: 260,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid #2a2a3a',
  minHeight: 0,
}
const selectionBadge: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  background: '#2a3a5a',
  color: '#cde',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
}
const emptyStateStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#ddd',
}
