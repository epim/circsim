/**
 * renderer/App.tsx — Task 21
 *
 * App shell: toolbar (Open), left dock (Parts + Model Doctor), 3D viewport.
 * Bidirectional selection sync: PartsPanel ↔ store.selectedRef ↔ viewport picks.
 *
 * Later tasks (22–24) add the instrument rack, scope, and run controls; this
 * shell leaves room (right/bottom docks) for them.
 */

import React, { useCallback, useState } from 'react'
import Viewport from './viewport/Viewport'
import PartsPanel from './panels/PartsPanel'
import ModelDoctor from './panels/ModelDoctor'
import GroundSetup from './panels/GroundSetup'
import InstrumentRack from './panels/InstrumentRack'
import Toolbar from './panels/Toolbar'
import WarningsBar from './panels/WarningsBar'
import CoachNotes from './panels/CoachNotes'
import SimLog from './panels/SimLog'
import Scope from './panels/Scope'
import About from './panels/About'
import { AppStoreProvider, useApp, useAppStoreApi } from './store/storeContext'
import type { AppStore } from './store/appStore'
import { resolutionSummary } from './store/appStore'
import { openProjectFromPath } from './ipc/fileOpen'
import type { PickEvent } from './viewport/picking'
import type { SceneManager } from './viewport/scene'
import type { OverlayMode } from './viewport/overlay'

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

  // Overlay mode: App owns the UI selection; the scene is imperative. Defaults to
  // voltage once an op result is in, so the primary scenario lights up the copper.
  const [overlay, setOverlay] = useState<OverlayMode>('realistic')

  // About dialog (licensing surfacing — Task 27, Spec §14).
  const [aboutOpen, setAboutOpen] = useState(false)

  // When an op result first arrives, snap the overlay to voltage (Spec §4 step 4).
  // Intentionally keyed only on opVoltages so manual overlay changes stick after.
  const overlayRef = React.useRef(overlay)
  overlayRef.current = overlay
  React.useEffect(() => {
    if (opVoltages && overlayRef.current === 'realistic') setOverlay('voltage')
  }, [opVoltages])

  // Wire the store's imperative BoardHooks to the live SceneManager so transient
  // samples tint copper without re-rendering React at sample rate (Task 24).
  const handleSceneReady = useCallback(
    (scene: SceneManager | null) => {
      store.getState().setBoardHooks(scene)
    },
    [store],
  )

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

  /** Open the bundled sample project (first-run CTA — Spec §11, Task 26). */
  const handleOpenSample = useCallback(async () => {
    try {
      const samplePath = await window.circsim.getSampleProjectPath()
      const opened = await openProjectFromPath(samplePath, window.circsim.readFile)
      store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
        schematicText: opened.schematicText,
        schematicFileName: opened.schematicFileName,
        bomText: opened.bomText,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[circsim] Failed to open sample project:', err)
    }
  }, [store])

  /** Open the bundled "First Light" demo (minimal DC LED dimmer — First Light L1). */
  const handleOpenFirstLight = useCallback(async () => {
    try {
      const demoPath = await window.circsim.getFirstLightDemoPath()
      const opened = await openProjectFromPath(demoPath, window.circsim.readFile)
      store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
        schematicText: opened.schematicText,
        schematicFileName: opened.schematicFileName,
        bomText: opened.bomText,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[circsim] Failed to open First Light demo:', err)
    }
  }, [store])

  const handlePick = useCallback(
    (event: PickEvent) => {
      const st = store.getState()
      if (event.type === 'clickComponent') {
        st.selectComponent(event.ref)
      } else if (event.type === 'clickNet') {
        // Task 22: clicking a net on the board while GroundSetup is shown also
        // confirms the ground (GroundSetup handles this via its own UI; here we
        // just keep the selection sync).
        st.selectNet(event.netId)
      } else if (event.type === 'hoverNet') {
        // hover handled by the scene's emissive boost; no store change needed
      } else if (event.type === 'clearHover') {
        // no-op
      }
    },
    [store],
  )

  // Task 22: instrument chip dropped onto a net on the 3D board
  const handleNetDrop = useCallback(
    (netId: number, kind: string) => {
      const st = store.getState()
      // Generate a unique id
      const id = `${kind.replace(/-/g, '_')}_${Date.now()}`
      switch (kind) {
        case 'dc-supply':
          st.addInstrument({ kind: 'dc-supply', id, netId, volts: 5, seriesOhms: 0.1 })
          break
        case 'function-gen':
          st.addInstrument({
            kind: 'function-gen', id, netId,
            wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50,
          })
          break
        case 'logic-input':
          st.addInstrument({ kind: 'logic-input', id, netId, level: 0, vHigh: 3.3 })
          break
        case 'voltage-probe':
          st.addInstrument({ kind: 'voltage-probe', id, netId, color: '#6f6' })
          break
        case 'current-probe':
          // Current probes need a component ref — can't resolve from a net drop alone.
          // Add as a voltage-probe fallback; the rack panel lets the user switch.
          st.addInstrument({ kind: 'voltage-probe', id, netId, color: '#f6f' })
          break
        default:
          break
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
        <button
          style={{ ...toolbarBtn, marginLeft: 'auto' }}
          onClick={() => setAboutOpen(true)}
          data-testid="about-btn"
          title="Licenses & provenance"
        >
          About
        </button>
      </header>

      <About open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* Simulation toolbar: Power On · Run/Pause · pace · overlay (Spec §11). */}
      <Toolbar overlay={overlay} onOverlay={setOverlay} />

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

      {/* Honesty surfaces: fidelity banner + convergence card + bench/crash toasts. */}
      <WarningsBar />

      <main style={mainStyle}>
        <aside style={leftDockStyle}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <PartsPanel />
          </div>
          <ModelDoctor />
        </aside>
        <div style={centerColStyle}>
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {board ? (
              <Viewport
                board={board}
                onPick={handlePick}
                onNetDrop={handleNetDrop}
                onSceneReady={handleSceneReady}
                netVoltages={opVoltages ?? undefined}
                voltageRange={voltageRange}
                overlay={overlay}
              />
            ) : (
              <EmptyState
                onOpen={handleOpen}
                onOpenSample={handleOpenSample}
                onOpenFirstLight={handleOpenFirstLight}
              />
            )}
            {/* Plain-language dark-LED coach (non-blocking overlay). */}
            {board && <CoachNotes />}
            {selectedRef && (
              <div style={selectionBadge}>Selected: {selectedRef}</div>
            )}
          </div>
          {/* Bottom dock: Oscilloscope + Sim log (Spec §11). */}
          {board && (
            <div style={bottomDockStyle}>
              <div style={{ flex: 2, minWidth: 0, borderRight: '1px solid #2a2a3a' }}>
                <Scope />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SimLog />
              </div>
            </div>
          )}
        </div>
        {/* Right dock: GroundSetup + InstrumentRack */}
        <aside style={rightDockStyle}>
          <GroundSetup />
          <InstrumentRack />
        </aside>
      </main>
    </div>
  )
}

function EmptyState({
  onOpen,
  onOpenSample,
  onOpenFirstLight,
}: {
  onOpen: () => void
  onOpenSample: () => void
  onOpenFirstLight: () => void
}): React.ReactElement {
  return (
    <div style={emptyStateStyle}>
      <div style={{ fontSize: 18, marginBottom: 8 }}>No board loaded</div>
      <div style={{ color: '#888', marginBottom: 16 }}>
        Open a <code>.kicad_pcb</code> file, or drag one onto the window.
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={{ ...toolbarBtn, padding: '8px 16px' }} onClick={onOpen}>
          Open…
        </button>
        <button
          style={{ ...toolbarBtn, padding: '8px 16px', background: '#3a2e12', borderColor: '#5a4a22' }}
          onClick={onOpenFirstLight}
          data-testid="open-first-light-btn"
        >
          Open First Light demo
        </button>
        <button
          style={{ ...toolbarBtn, padding: '8px 16px', background: '#1e3a2e', borderColor: '#2a5a3a' }}
          onClick={onOpenSample}
          data-testid="open-sample-btn"
        >
          Open sample project
        </button>
      </div>
      <div style={{ color: '#555', marginTop: 10, fontSize: 12 }}>
        First Light is a one-LED dimmer — press Energize to watch it glow. Or try the
        555 blinker for the full simulation flow.
      </div>
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
  minHeight: 0,
}
const centerColStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
}
const bottomDockStyle: React.CSSProperties = {
  height: 260,
  display: 'flex',
  borderTop: '1px solid #2a2a3a',
  minHeight: 0,
}
const leftDockStyle: React.CSSProperties = {
  width: 260,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid #2a2a3a',
  minHeight: 0,
}
const rightDockStyle: React.CSSProperties = {
  width: 240,
  display: 'flex',
  flexDirection: 'column',
  borderLeft: '1px solid #2a2a3a',
  minHeight: 0,
  overflowY: 'auto',
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
