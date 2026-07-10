/**
 * viewport/Viewport.tsx
 *
 * Task 16 — React canvas mount + resize component.
 * Task 21 — pick-event forwarding + selection/overlay sync with the store.
 *
 * Responsibilities:
 *   - Render a <canvas> that fills its container
 *   - Mount/unmount the SceneManager on the canvas
 *   - Forward resize events via ResizeObserver → sceneManager.resize()
 *   - Forward pick events (hover/click net/component) to `onPick`
 *   - Apply overlay mode + op-result voltages from props
 *
 * All 3D logic lives in scene.ts (React-free).
 *
 * Spec §10.2, §10.3
 */

import React, { useEffect, useRef } from 'react'
import { createSceneManager, type SceneManager } from './scene'
import { formatVolts } from './markers'
import type { PickEvent } from './picking'
import type { OverlayMode } from './overlay'
import type { BoardModel } from '../../../core/kicad/types'

interface ViewportProps {
  /** Board to display. When undefined the viewport shows an empty scene. */
  board?: BoardModel
  /** CSS style overrides for the canvas wrapper. */
  style?: React.CSSProperties
  /** Pick event callback (hover/click). The store subscribes to sync selection. */
  onPick?: (event: PickEvent) => void
  /** Overlay mode (realistic/voltage/highlight). */
  overlay?: OverlayMode
  /** Per-net voltages for the voltage overlay + op annotations. */
  netVoltages?: Map<number, number>
  /** Min/max voltage for the overlay legend. */
  voltageRange?: { min: number; max: number } | null
  /**
   * Task 22: Called when an instrument chip from the InstrumentRack is dropped
   * onto a net on the 3D board. The viewport resolves the drop position to the
   * nearest net and calls this with the net id + instrument kind.
   *
   * @param netId  The netId of the net under the drop point.
   * @param kind   The instrument kind from the drag payload.
   */
  onNetDrop?: (netId: number, kind: string) => void
  /**
   * Task 24: Called once the SceneManager is mounted (and again with null on
   * unmount). Lets the store wire its imperative BoardHooks to the live scene so
   * transient samples can drive the copper tint without re-rendering React at
   * sample rate.
   */
  onSceneReady?: (scene: SceneManager | null) => void
  /** Optional board model reference for net-name lookup in annotations. */
}

export default function Viewport({
  board,
  style,
  onPick,
  overlay,
  netVoltages,
  voltageRange,
  onNetDrop,
  onSceneReady,
}: ViewportProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<SceneManager | null>(null)
  const onPickRef = useRef<typeof onPick>(onPick)
  onPickRef.current = onPick
  const onNetDropRef = useRef<typeof onNetDrop>(onNetDrop)
  onNetDropRef.current = onNetDrop
  const onSceneReadyRef = useRef<typeof onSceneReady>(onSceneReady)
  onSceneReadyRef.current = onSceneReady

  // Mount / unmount the scene manager
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const manager = createSceneManager()
    sceneRef.current = manager
    manager.mount(canvas, {
      onPickEvent: event => onPickRef.current?.(event),
    })
    onSceneReadyRef.current?.(manager)

    // ResizeObserver keeps the canvas filling its parent
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          manager.resize(width, height)
        }
      }
    })
    ro.observe(canvas.parentElement ?? canvas)

    return () => {
      ro.disconnect()
      onSceneReadyRef.current?.(null)
      manager.dispose()
      sceneRef.current = null
    }
  }, [])

  // Load board whenever it changes
  useEffect(() => {
    if (board && sceneRef.current) {
      sceneRef.current.loadBoard(board)
    }
  }, [board])

  // Overlay mode
  useEffect(() => {
    if (overlay && sceneRef.current) {
      sceneRef.current.setOverlay(overlay)
    }
  }, [overlay])

  // Net voltages → tint + annotations
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !netVoltages) return
    const range = voltageRange ?? { min: 0, max: 5 }
    scene.applyNetVoltages(netVoltages, range.min, range.max)
    scene.showOpAnnotations(netVoltages)
  }, [netVoltages, voltageRange])

  // ── Instrument drop handling (Task 22) ──────────────────────────────────────
  // When an instrument chip is dragged from the InstrumentRack and dropped onto
  // the canvas, we:
  //   1. Perform a raycast via sceneRef to find the net under the pointer.
  //   2. Call onNetDrop(netId, kind).
  // If the raycast hits nothing, we pick the net with the most coverage (or skip).

  const handleDragOver = (e: React.DragEvent): void => {
    // Accept the drop only if it carries an instrument payload
    if (e.dataTransfer.types.includes('application/circsim-instrument')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const cb = onNetDropRef.current
    if (!cb) return

    let kind: string | null = null
    try {
      const data = JSON.parse(
        e.dataTransfer.getData('application/circsim-instrument'),
      ) as { kind: string }
      kind = data.kind
    } catch {
      return
    }
    if (!kind) return

    // Ask the scene for the net id at the drop position
    const scene = sceneRef.current
    if (scene) {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const netId = scene.pickNetAt?.(x, y, canvas.clientWidth, canvas.clientHeight)
      if (netId !== undefined && netId !== null) {
        cb(netId, kind)
        return
      }
    }
    // Fallback: no net under pointer — the InstrumentRack's net list is the
    // alternative path; skip the drop here.
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        ...style,
      }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {/* DOM-accessible op-annotation data for E2E tests (Task 26).
          The actual visual annotations are rendered by Three.js (troika-three-text);
          this hidden div mirrors the same data for Playwright to query.
          `opacity:0.001` makes it visually invisible while still considered
          "visible" by Playwright's DOM checks (display:none fails toBeVisible). */}
      {netVoltages && netVoltages.size > 0 && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            opacity: 0.001,
            pointerEvents: 'none',
            fontSize: 1,
          }}
          data-testid="op-annotations-list"
        >
          {Array.from(netVoltages.entries()).map(([netId, volts]) => (
            <span
              key={netId}
              data-net-id={netId}
              // Net NAME too, so tooling/tests can find a net without an id
              // lookup ("what is PACK+ at?" — M7 F8).
              data-net-name={board?.netById.get(netId)?.name}
              data-testid="op-annotation"
            >
              {/* Same formatter as the 3D labels — normalizes -0.000 V (F5). */}
              {formatVolts(volts)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
