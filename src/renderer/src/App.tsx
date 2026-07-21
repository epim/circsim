/**
 * renderer/App.tsx — Task 21
 *
 * App shell: toolbar (Open), left dock (Parts + Model Doctor), 3D viewport.
 * Bidirectional selection sync: PartsPanel ↔ store.selectedRef ↔ viewport picks.
 *
 * Bench Leads (Task 5): the center column wraps the viewport in BenchLeads,
 * which renders the bench shelf + the SVG lead overlay above the bottom dock.
 * The old InstrumentRack/InstrumentProps right-dock panel is retired; only
 * the MCU interactive-pins panel (McuPinsPanel) still lives in the right dock.
 */

import React, { useCallback, useRef, useState } from 'react'
import Viewport from './viewport/Viewport'
import PartsPanel from './panels/PartsPanel'
import ModelDoctor from './panels/ModelDoctor'
import GroundSetup from './panels/GroundSetup'
import McuPinsPanel from './panels/McuPinsPanel'
import BenchLeads, { type BenchLeadsHandle } from './bench/BenchLeads'
import Toolbar from './panels/Toolbar'
import WarningsBar, { FidelityBadge } from './panels/WarningsBar'
import CoachNotes from './panels/CoachNotes'
import SimLog from './panels/SimLog'
import NetVoltages from './panels/NetVoltages'
import Scope from './panels/Scope'
import CriticPanel from './panels/CriticPanel'
import About from './panels/About'
import { NoBoardState } from './panels/EmptyStates'
import { AppStoreProvider, useApp, useAppStoreApi } from './store/storeContext'
import type { AppStore } from './store/appStore'
import { resolutionSummary } from './store/appStore'
import { openProjectFromPath, classifyFile } from './ipc/fileOpen'
import type { PickEvent } from './viewport/picking'
import type { SceneManager } from './viewport/scene'
import type { OverlayMode } from './viewport/overlay'
import { showNetsTabCue } from './ui/tabCues'

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

  // Bench Leads (Task 5): the live SceneManager, shared with BenchLeads so it
  // can project net/component anchors; the handle lets Viewport's onRender
  // trigger a lead recompute without re-rendering React at frame rate.
  const [sceneMgr, setSceneMgr] = useState<SceneManager | null>(null)
  const benchRef = useRef<BenchLeadsHandle>(null)

  // Overlay mode: App owns the UI selection; the scene is imperative. Defaults to
  // voltage once an op result is in, so the primary scenario lights up the copper.
  const [overlay, setOverlay] = useState<OverlayMode>('realistic')

  // About dialog (licensing surfacing — Task 27, Spec §14).
  const [aboutOpen, setAboutOpen] = useState(false)

  // Bottom-dock right pane: Sim log ↔ Net voltages readout (M7 F8).
  const [bottomTab, setBottomTab] = useState<'log' | 'nets'>('log')
  const [netsTabSeen, setNetsTabSeen] = useState(false)

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
      setSceneMgr(scene)
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
    const opened = await openProjectFromPath(
      res.filePaths[0],
      window.circsim.readFile,
      undefined,
      window.circsim.fileExists,
    )
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
      const opened = await openProjectFromPath(
        samplePath,
        window.circsim.readFile,
        undefined,
        window.circsim.fileExists,
      )
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
      const opened = await openProjectFromPath(
        demoPath,
        window.circsim.readFile,
        undefined,
        window.circsim.fileExists,
      )
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
        // Select AND explicitly reveal the part's Model Doctor card (nonce-based
        // — re-clicking the selected part still re-reveals; M7 review fix).
        st.revealInDoctor(event.ref)
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

  // MCU interactive-pins panel gating (lifted from the retired InstrumentRack,
  // InstrumentRack.tsx:323-328): shown in the right dock when the part
  // selected in Parts resolves to an 'interactive-pins' stub.
  const selectedMcuRef = selectedRef
  const isMcuSelected =
    selectedMcuRef !== null &&
    resolutions.some(
      r => r.ref === selectedMcuRef && r.model?.kind === 'stub' && r.model.mode === 'interactive-pins',
    )

  // Drag-drop onto the window: a .kicad_pcb opens a board; a .kicad_sch dropped
  // while a board is loaded ATTACHES to it (M3 — the manual-attach drag path for
  // schematics that aren't a same-basename sibling of the board).
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const files = [...e.dataTransfer.files]

      // A board file always takes priority (opens/replaces the project).
      const boardFile = files.find(f => f.name.endsWith('.kicad_pcb'))
      if (boardFile) {
        // Electron File objects expose a real path; fall back to text() otherwise.
        const path = (boardFile as File & { path?: string }).path
        if (path) {
          const opened = await openProjectFromPath(
            path,
            window.circsim.readFile,
            undefined,
            window.circsim.fileExists,
          )
          store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
            schematicText: opened.schematicText,
            schematicFileName: opened.schematicFileName,
            bomText: opened.bomText,
          })
        } else {
          const text = await boardFile.text()
          store.getState().openBoardFromText(text, boardFile.name)
        }
        return
      }

      // No board file: a dropped .kicad_sch attaches to the already-loaded board.
      const schFile = files.find(f => classifyFile(f.name) === 'schematic')
      if (schFile && store.getState().board) {
        const path = (schFile as File & { path?: string }).path
        if (path) {
          await store.getState().attachSchematicFromPath(path)
        } else {
          const text = await schFile.text()
          store.getState().setSchematicFromText(text, schFile.name)
        }
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
        <span style={{ fontSize: 12, color: '#888' }}>v{__APP_VERSION__}</span>
        <button style={toolbarBtn} onClick={handleOpen} data-testid="open-board-header-btn">
          Open…
        </button>
        {board && (
          <span style={{ fontSize: 12, color: '#9ab' }}>
            {summary.total} parts · {summary.ok} ok
            {summary.stubbed > 0 && ` · ${summary.stubbed} stubbed`}
            {summary.documentedOpen > 0 && ` · ${summary.documentedOpen} open by design`}
            {summary.unresolved > 0 && ` · ${summary.unresolved} unresolved`}
          </span>
        )}
        <FidelityBadge />
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
          <BenchLeads ref={benchRef} scene={sceneMgr}>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              {board ? (
                <Viewport
                  board={board}
                  onPick={handlePick}
                  onSceneReady={handleSceneReady}
                  onRender={() => benchRef.current?.notifyFrame()}
                  netVoltages={opVoltages ?? undefined}
                  voltageRange={voltageRange}
                  overlay={overlay}
                />
              ) : (
                <NoBoardState
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
          </BenchLeads>
          {/* Bottom dock: Oscilloscope + Sim log (Spec §11). */}
          {board && (
            <div style={bottomDockStyle}>
              <div style={{ flex: 2, minWidth: 0, borderRight: '1px solid #2a2a3a' }}>
                <Scope />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {/* Sim log ↔ Net voltages tab (M7 F8): the per-net readout for
                    the latest op lives next to the log in the results dock. */}
                <div style={bottomTabRowStyle}>
                  <button
                    style={bottomTab === 'log' ? bottomTabActive : bottomTabBtn}
                    onClick={() => setBottomTab('log')}
                    data-testid="bottom-tab-log"
                  >
                    Sim log
                  </button>
                  <button
                    style={bottomTab === 'nets' ? bottomTabActive : bottomTabBtn}
                    onClick={() => {
                      setBottomTab('nets')
                      setNetsTabSeen(true)
                    }}
                    data-testid="bottom-tab-nets"
                  >
                    Net voltages
                    {showNetsTabCue(opVoltages != null, netsTabSeen, bottomTab) && (
                      <span data-testid="nets-tab-cue" style={{ color: '#f1c40f', marginLeft: 4 }}>
                        ●
                      </span>
                    )}
                  </button>
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  {bottomTab === 'log' ? <SimLog /> : <NetVoltages />}
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Right dock: GroundSetup + MCU pins (when selected) + Board Critic.
            The bench shelf itself now lives between the viewport and the
            bottom dock (see BenchLeads above) — the rack is retired. */}
        <aside style={rightDockStyle}>
          <GroundSetup />
          {isMcuSelected && selectedMcuRef && <McuPinsPanel ref_={selectedMcuRef} />}
          {board && <CriticPanel />}
        </aside>
      </main>
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
// Sim log ↔ Net voltages tab strip (M7 F8).
const bottomTabRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  padding: '2px 6px',
  background: '#0d1117',
  borderBottom: '1px solid #21262d',
}
const bottomTabBtn: React.CSSProperties = {
  background: '#1e1e2c',
  border: '1px solid #33334a',
  color: '#99a',
  fontSize: 10,
  padding: '2px 8px',
  cursor: 'pointer',
}
const bottomTabActive: React.CSSProperties = {
  ...bottomTabBtn,
  background: '#34406a',
  borderColor: '#4a5a8a',
  color: '#dde',
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
