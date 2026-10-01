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

import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import SetupBar from './panels/SetupBar'
import ExportReport from './panels/ExportReport'
import { NoBoardState } from './panels/EmptyStates'
import GuidedStateHost from './panels/GuidedStateHost'
import { AppStoreProvider, useApp, useAppStoreApi } from './store/storeContext'
import type { AppStore } from './store/appStore'
import { resolutionSummary } from './store/appStore'
import { openProjectFromPath, classifyFile } from './ipc/fileOpen'
import type { PickEvent } from './viewport/picking'
import type { SceneManager } from './viewport/scene'
import type { OverlayMode } from './viewport/overlay'
import { showNetsTabCue } from './ui/tabCues'
import VoltageLegend from './ui/VoltageLegend'
import { openDocsPage } from './ui/docsLink'
import { termTitle } from './ui/glossary'
import {
  APP_MIN_HEIGHT, APP_MIN_WIDTH, DOCK_COLLAPSED_H, DOCK_HEIGHT, MIN_VIEWPORT_H, useCollapsed,
} from './ui/layoutPrefs'

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
  // Bottom dock collapse (issue #33): remembered across launches.
  const [dockCollapsed, setDockCollapsed] = useCollapsed('dock')

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

  // Recent boards (issue #27): loaded once from userData, pruned of files that
  // no longer exist, updated on every successful open.
  const [recent, setRecent] = useState<string[]>([])
  const [recentNotice, setRecentNotice] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.circsim.getRecentBoards()
        const present: string[] = []
        for (const path of list) {
          if (await window.circsim.fileExists(path)) present.push(path)
        }
        if (!cancelled) setRecent(present)
      } catch {
        // A missing or unreadable recent list just means an empty one.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Open a board by path: board + sibling schematic + the saved setup beside it
   * (restored by the store, with a visible note), then remember it as recent.
   * Every open path (dialog, recent list, drag-drop) goes through here, so a
   * reopen after editing the board in KiCad restores the bench (issue #27).
   */
  const openBoardPath = useCallback(
    async (path: string) => {
      const opened = await openProjectFromPath(
        path,
        window.circsim.readFile,
        undefined,
        window.circsim.fileExists,
        window.circsim.readSidecar,
      )
      store.getState().openBoardFromText(opened.boardText, opened.boardFileName, {
        schematicText: opened.schematicText,
        schematicFileName: opened.schematicFileName,
        bomText: opened.bomText,
        boardPath: opened.boardPath,
        sidecarText: opened.sidecarText,
        sidecarError: opened.sidecarError,
      })
      setRecentNotice(null)
      void window.circsim.addRecentBoard(path).then(setRecent).catch(() => undefined)
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
    await openBoardPath(res.filePaths[0])
  }, [openBoardPath])

  const handleOpenRecent = useCallback(
    async (path: string) => {
      try {
        await openBoardPath(path)
      } catch (err) {
        // The file moved or was deleted: say so and drop it from the list.
        const msg = err instanceof Error ? err.message : String(err)
        setRecentNotice(`Could not open ${path}: ${msg}`)
        void window.circsim.removeRecentBoard(path).then(setRecent).catch(() => undefined)
      }
    },
    [openBoardPath],
  )

  const handleClearRecent = useCallback(() => {
    void window.circsim.clearRecentBoards().then(setRecent).catch(() => undefined)
  }, [])

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
          await openBoardPath(path)
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
    [store, openBoardPath],
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
        <ExportReport />
        {board && (
          <span style={{ fontSize: 12, color: '#9ab' }}>
            {summary.total} parts · {summary.ok} ok
            {summary.stubbed > 0 && (
              <span title={termTitle('stub')} data-testid="header-stubbed">
                {` · ${summary.stubbed} ${summary.stubbed === 1 ? 'placeholder' : 'placeholders'}`}
              </span>
            )}
            {summary.documentedOpen > 0 && ` · ${summary.documentedOpen} open by design`}
            {summary.unresolved > 0 && (
              <span title={termTitle('unresolved')} data-testid="header-unresolved">
                {` · ${summary.unresolved} with no model`}
              </span>
            )}
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
          onClick={() => void openDocsPage('')}
          data-testid="docs-btn"
          title="Open the circsim documentation (guides, glossary, and what the results mean) in your browser"
        >
          Docs
        </button>
        <button
          style={toolbarBtn}
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

      {/* Per-board setup file: restored note, save offer, autosave status (issue #27). */}
      <SetupBar />

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
            <div data-testid="viewport-region" style={viewportRegionStyle}>
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
                  recent={recent}
                  onOpenRecent={path => void handleOpenRecent(path)}
                  onClearRecent={handleClearRecent}
                  notice={recentNotice}
                />
              )}
              {/* Voltage legend (issue #70): the scale for the copper tint, with
                  min/max volts, whenever the Voltage overlay is showing results.
                  The 0..5 V fallback mirrors the tint effect in Viewport. */}
              {board && overlay === 'voltage' && opVoltages && (
                <VoltageLegend
                  min={(voltageRange ?? { min: 0, max: 5 }).min}
                  max={(voltageRange ?? { min: 0, max: 5 }).max}
                />
              )}
              {/* Plain-language dark-LED coach (non-blocking overlay). */}
              {board && <CoachNotes />}
              {/* Spec section 12 guided states: blocked Energize / Power On / Run. */}
              {board && <GuidedStateHost />}
              {selectedRef && (
                <div style={selectionBadge}>Selected: {selectedRef}</div>
              )}
            </div>
          </BenchLeads>
          {/* Bottom dock: Oscilloscope + Sim log (Spec §11). */}
          {board && dockCollapsed && (
            <div style={bottomDockCollapsedStyle} data-testid="bottom-dock-collapsed">
              <span>Scope and sim log</span>
              <button
                style={bottomTabBtn}
                onClick={() => setDockCollapsed(false)}
                data-testid="dock-toggle"
                title="Show the oscilloscope and sim log"
                aria-expanded={false}
              >
                Show
              </button>
            </div>
          )}
          {board && !dockCollapsed && (
            <div style={bottomDockStyle} data-testid="bottom-dock">
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
                  <button
                    style={{ ...bottomTabBtn, marginLeft: 'auto' }}
                    onClick={() => setDockCollapsed(true)}
                    data-testid="dock-toggle"
                    title="Hide the oscilloscope and sim log"
                    aria-expanded={true}
                  >
                    Hide
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
  height: '100%',
  minWidth: APP_MIN_WIDTH,
  minHeight: APP_MIN_HEIGHT,
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
// The viewport owns a hard minimum height (issue #33): the shelf and dock yield
// to it, never the other way round.
const viewportRegionStyle: React.CSSProperties = {
  flex: '1 1 0',
  position: 'relative',
  minHeight: MIN_VIEWPORT_H,
}
const bottomDockStyle: React.CSSProperties = {
  height: DOCK_HEIGHT,
  flexShrink: 0,
  display: 'flex',
  borderTop: '1px solid #2a2a3a',
  minHeight: 0,
}
const bottomDockCollapsedStyle: React.CSSProperties = {
  height: DOCK_COLLAPSED_H,
  flexShrink: 0,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 8px',
  borderTop: '1px solid #2a2a3a',
  background: '#0d1117',
  color: '#99a',
  fontSize: 11,
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
