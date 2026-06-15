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
}

export default function Viewport({
  board,
  style,
  onPick,
  overlay,
  netVoltages,
  voltageRange,
}: ViewportProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<SceneManager | null>(null)
  const onPickRef = useRef<typeof onPick>(onPick)
  onPickRef.current = onPick

  // Mount / unmount the scene manager
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const manager = createSceneManager()
    sceneRef.current = manager
    manager.mount(canvas, {
      onPickEvent: event => onPickRef.current?.(event),
    })

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
    </div>
  )
}
