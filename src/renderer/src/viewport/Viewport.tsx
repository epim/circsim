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
   * Task 24: Called once the SceneManager is mounted (and again with null on
   * unmount). Lets the store wire its imperative BoardHooks to the live scene so
   * transient samples can drive the copper tint without re-rendering React at
   * sample rate.
   */
  onSceneReady?: (scene: SceneManager | null) => void
  /**
   * Task 5 (Bench Leads): called whenever a scene render frame completes
   * (SceneCallbacks.onRender). BenchLeads uses this to recompute lead anchors
   * in step with the 3D camera instead of polling.
   */
  onRender?: () => void
  /** Optional board model reference for net-name lookup in annotations. */
}

export default function Viewport({
  board,
  style,
  onPick,
  overlay,
  netVoltages,
  voltageRange,
  onSceneReady,
  onRender,
}: ViewportProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<SceneManager | null>(null)
  const onPickRef = useRef<typeof onPick>(onPick)
  onPickRef.current = onPick
  const onSceneReadyRef = useRef<typeof onSceneReady>(onSceneReady)
  onSceneReadyRef.current = onSceneReady
  const onRenderRef = useRef<typeof onRender>(onRender)
  onRenderRef.current = onRender

  // Mount / unmount the scene manager
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const manager = createSceneManager()
    sceneRef.current = manager
    manager.mount(canvas, {
      onPickEvent: event => onPickRef.current?.(event),
      onRender: () => onRenderRef.current?.(),
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

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        position: 'relative',
        ...style,
      }}
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
