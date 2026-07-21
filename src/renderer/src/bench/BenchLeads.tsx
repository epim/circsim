/**
 * bench/BenchLeads.tsx — the lead overlay + drag controller.
 *
 * Owns: the jack element registry, the projected anchor cache, and the
 * drag-in-progress state. Children = the viewport region; the shelf and the
 * SVG LeadLayer are rendered by this component so all three share one
 * coordinate space (this component's relative container).
 *
 * Coordinates: everything in container-relative px. Jack anchors come from
 * getBoundingClientRect (cheap at <20 jacks); clip anchors come from
 * scene.projectAnchors + the canvas's offset within the container.
 * Recompute triggers: scene frame render (notifyFrame via ref), window
 * resize, shelf scroll (capture-phase), instruments/ground change.
 *
 * Drag: pointerdown on a jack (shelf DOM) or clip (pointerEvents:auto SVG) —
 * so it never reaches the canvas/OrbitControls — adds window listeners;
 * window pointermove updates the dashed lead + throttled (50 ms) candidate
 * highlight via scene.highlightAttachTarget → pointerup resolves:
 *   over canvas + valid hit  → assignTerminal
 *   anywhere else            → wired jack: detachTerminalWire; unwired: cancel
 * Escape cancels. Highlight always cleared on end.
 */

import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { SceneManager } from '../viewport/scene'
import BenchShelf from './BenchShelf'
import type { JackHandlers } from './JackView'
import {
  computeLeads, jacksFor, resolveDrop, GROUND_INST_ID,
  type JackDef, type LeadRender,
} from './leads'
import { leadPath, type Pt } from './leadGeometry'

export interface BenchLeadsHandle { notifyFrame(): void }

interface DragState { jack: JackDef; cursor: Pt }

const BenchLeads = forwardRef<BenchLeadsHandle, {
  scene: SceneManager | null
  children: React.ReactNode
}>(function BenchLeads({ scene, children }, ref): React.ReactElement {
  const store = useAppStoreApi()
  const instruments = useApp(s => s.instruments)
  const groundNetId = useApp(s => s.groundNetId)
  const circuit = useApp(s => s.circuit)

  const containerRef = useRef<HTMLDivElement>(null)
  const jackEls = useRef(new Map<string, HTMLElement>())
  const [leads, setLeads] = useState<LeadRender[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const lastHighlightAt = useRef(0)

  // instruments + the ground singleton, in the shape computeLeads takes.
  const instRows = useCallback(() => {
    const rows: Array<{ inst: (typeof instruments)[number]; instId: string }> = []
    if (groundNetId !== null) {
      rows.push({ inst: { kind: 'ground-ref', netId: groundNetId }, instId: GROUND_INST_ID })
    }
    for (const inst of instruments) {
      if ('id' in inst) rows.push({ inst, instId: inst.id })
    }
    return rows
  }, [instruments, groundNetId])

  const recompute = useCallback(() => {
    const container = containerRef.current
    if (!container || !scene) { setLeads([]); return }
    const cRect = container.getBoundingClientRect()
    const canvas = container.querySelector('canvas')
    const canvasRect = canvas?.getBoundingClientRect()

    // Jack anchors: element centers, container-relative.
    const jackRects = new Map<string, Pt>()
    for (const [key, el] of jackEls.current) {
      const r = el.getBoundingClientRect()
      jackRects.set(key, { px: r.left + r.width / 2 - cRect.left, py: r.top + r.height / 2 - cRect.top })
    }

    // Clip anchors: canvas-px from the scene, shifted into container space.
    const rows = instRows()
    const netIds: number[] = []
    const refs: string[] = []
    for (const { inst, instId } of rows) {
      for (const j of jacksFor(inst, instId)) {
        if (j.target?.kind === 'net') netIds.push(j.target.netId)
        if (j.target?.kind === 'component') refs.push(j.target.ref)
      }
    }
    const raw = scene.projectAnchors(netIds, refs)
    const dx = (canvasRect?.left ?? cRect.left) - cRect.left
    const dy = (canvasRect?.top ?? cRect.top) - cRect.top
    const anchors = {
      nets: new Map([...raw.nets].map(([k, p]) => [k, { px: p.px + dx, py: p.py + dy }])),
      refs: new Map([...raw.refs].map(([k, p]) => [k, { px: p.px + dx, py: p.py + dy }])),
    }
    const liveNetIds = new Set((circuit?.nets ?? []).map(n => n.id))
    setLeads(computeLeads(rows, jackRects, anchors, liveNetIds))
  }, [scene, instRows, circuit])

  useImperativeHandle(ref, () => ({ notifyFrame: recompute }), [recompute])

  // Layout-change triggers beyond scene frames.
  useEffect(() => { recompute() }, [recompute])
  useEffect(() => {
    window.addEventListener('resize', recompute)
    const container = containerRef.current
    container?.addEventListener('scroll', recompute, true) // shelf scroll, capture
    return () => {
      window.removeEventListener('resize', recompute)
      container?.removeEventListener('scroll', recompute, true)
    }
  }, [recompute])

  // ── drag machinery ─────────────────────────────────────────────────────────

  const endDrag = useCallback(() => {
    dragRef.current = null
    setDrag(null)
    scene?.highlightAttachTarget(null)
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('keydown', onDragKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  const canvasHit = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current
    const canvas = container?.querySelector('canvas')
    if (!canvas || !scene) return null
    const r = canvas.getBoundingClientRect()
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null
    return scene.pickAttachTargetAt(clientX - r.left, clientY - r.top, r.width, r.height)
  }, [scene])

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const cRect = containerRef.current!.getBoundingClientRect()
    const next = { ...d, cursor: { px: e.clientX - cRect.left, py: e.clientY - cRect.top } }
    dragRef.current = next
    setDrag(next)
    const now = performance.now()
    if (now - lastHighlightAt.current > 50) {
      lastHighlightAt.current = now
      const hit = canvasHit(e.clientX, e.clientY)
      scene?.highlightAttachTarget(
        hit && 'netId' in hit && d.jack.accepts === 'net' ? { netId: hit.netId }
        : hit && 'ref' in hit && d.jack.accepts === 'component' ? { ref: hit.ref }
        : null)
    }
  }, [canvasHit, scene])

  const onDragUp = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    endDrag()
    if (!d) return
    const hit = canvasHit(e.clientX, e.clientY)
    const target = resolveDrop(hit ?? null, d.jack)
    const st = store.getState()
    if (target) {
      st.assignTerminal(d.jack.instId, d.jack.terminal, target)
    } else if (d.jack.target && !(d.jack.instId === GROUND_INST_ID)) {
      // A wired clip released off-board detaches (ground never detaches, spec §7).
      st.detachTerminalWire(d.jack.instId, d.jack.terminal)
    }
  }, [canvasHit, endDrag, store])

  const onDragKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') endDrag()
  }, [endDrag])

  // Keep a live handle on the current drag listeners so the unmount cleanup
  // removes exactly what beginDrag last added — without re-running on every
  // memoization change (which would tear down an in-progress drag).
  const dragListenersRef = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; key: (e: KeyboardEvent) => void } | null>(null)
  useEffect(() => { dragListenersRef.current = { move: onDragMove, up: onDragUp, key: onDragKey } }, [onDragMove, onDragUp, onDragKey])

  // Remove drag listeners on unmount to prevent leaks if drag is in progress.
  useEffect(() => () => {
    const l = dragListenersRef.current
    if (l) {
      window.removeEventListener('pointermove', l.move)
      window.removeEventListener('pointerup', l.up)
      window.removeEventListener('keydown', l.key)
    }
  }, [])

  const beginDrag = useCallback((jack: JackDef, e: React.PointerEvent) => {
    e.preventDefault()
    const cRect = containerRef.current!.getBoundingClientRect()
    const d = { jack, cursor: { px: e.clientX - cRect.left, py: e.clientY - cRect.top } }
    dragRef.current = d
    setDrag(d)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('keydown', onDragKey)
  }, [onDragMove, onDragUp, onDragKey])

  const jackHandlers: JackHandlers = {
    registerJack: (key, el) => {
      if (el) jackEls.current.set(key, el)
      else jackEls.current.delete(key)
    },
    onJackPointerDown: beginDrag,
  }

  // The dashed drag lead starts from the dragged jack's current anchor.
  const dragOrigin = drag ? (
    leads.find(l => l.jackKey === drag.jack.key)?.jack
      ?? (() => {
        const el = jackEls.current.get(drag.jack.key)
        const cRect = containerRef.current?.getBoundingClientRect()
        if (!el || !cRect) return null
        const r = el.getBoundingClientRect()
        return { px: r.left + r.width / 2 - cRect.left, py: r.top + r.height / 2 - cRect.top }
      })()
  ) : null

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {children}
      <BenchShelf jackHandlers={jackHandlers} />
      <svg
        data-testid="lead-layer"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20, width: '100%', height: '100%' }}
      >
        {leads.map(l => (
          <g key={l.jackKey}>
            {l.path && (
              <path
                data-testid="lead-path"
                data-inst={l.instId}
                data-terminal={l.terminal}
                d={l.path}
                fill="none"
                stroke={l.color}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            )}
            {l.dangling && (
              <circle
                data-testid="lead-dangling"
                cx={l.jack.px} cy={l.jack.py + 10} r={4}
                fill="none" stroke={l.color} strokeDasharray="2 2"
              />
            )}
            {l.clip && (
              <g
                data-testid="lead-clip"
                data-x={l.clip.px}
                data-y={l.clip.py}
                style={{ pointerEvents: 'auto', cursor: 'grab' }}
                onPointerDown={e => {
                  // `leads` is set from a post-render effect, so for one frame
                  // after removeInstrument a clip can still reference a gone
                  // instrument — guard the lookup instead of asserting non-null.
                  const owner = l.instId === GROUND_INST_ID
                    ? ({ kind: 'ground-ref', netId: groundNetId ?? -1 } as const)
                    : instruments.find(i => 'id' in i && i.id === l.instId)
                  if (!owner) return
                  const row = jacksFor(owner, l.instId).find(j => j.terminal === l.terminal)
                  if (row) beginDrag(row, e)
                }}
              >
                {/* invisible hit circle (spec §2) + visible alligator-clip glyph */}
                <circle cx={l.clip.px} cy={l.clip.py} r={10} fill="transparent" />
                <circle cx={l.clip.px} cy={l.clip.py} r={4.5} fill={l.color} stroke="#111" strokeWidth={1} />
                <line x1={l.clip.px - 4} y1={l.clip.py - 6} x2={l.clip.px + 4} y2={l.clip.py - 6}
                  stroke={l.color} strokeWidth={2} />
              </g>
            )}
          </g>
        ))}
        {drag && dragOrigin && (
          <path
            data-testid="lead-drag"
            d={leadPath(dragOrigin, drag.cursor)}
            fill="none"
            stroke={drag.jack.color}
            strokeWidth={2}
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  )
})

export default BenchLeads
