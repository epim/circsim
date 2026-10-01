/**
 * src/renderer/src/scope/__tests__/scopePanel.test.tsx: issue #59
 *
 * The Scope panel only reads the store-owned probe rings. It creates no ring
 * of its own (no second 1M-point ring per probe), registers no 'samples'
 * listener (so no per-batch, per-column net search), and each frame draws
 * from `getProbeRingBuffer`, with the follow window anchored on the newest
 * stored run time.
 *
 * This suite runs without a DOM (vitest environment 'node'). The panel is
 * rendered with react-dom/server, and its effects, which the server renderer
 * drops, are run by hand: `react` is mocked so useEffect and useLayoutEffect
 * record their callbacks, and the one null-initialised ref (the canvas ref)
 * gets a fake canvas. requestAnimationFrame and ResizeObserver are stubbed, and
 * drawScope, createRingBuffer and feedSamples are spied on.
 */

import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import Scope from '../../panels/Scope'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState, type AppStore } from '../../store/appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'
import { createRingBuffer, feedSamples, type RingBuffer } from '../ringBuffer'
import { drawScope, type ScopeDrawInput } from '../render2d'
import { scopeSamplesEmitter } from '../sampleEmitter'

// ─── headless effect harness ─────────────────────────────────────────────────

const harness = vi.hoisted(() => ({
  /** Effect callbacks recorded during the last render, in call order. */
  effects: [] as (() => unknown)[],
  /** Handed to a ref created with `null` (the canvas ref) while mounting. */
  canvas: null as unknown,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const actualDefault = (actual as unknown as { default: Record<string, unknown> }).default
  const recordEffect = (effect: () => unknown): void => {
    harness.effects.push(effect)
  }
  function useRef<T>(initial: T): { current: T } {
    const ref = actual.useRef(initial)
    if (initial === null && ref.current === null && harness.canvas !== null) {
      ref.current = harness.canvas as T
    }
    return ref
  }
  const patched = { useEffect: recordEffect, useLayoutEffect: recordEffect, useRef }
  return { ...actual, ...patched, default: { ...actualDefault, ...patched } }
})

vi.mock('../ringBuffer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ringBuffer')>()
  return {
    ...actual,
    createRingBuffer: vi.fn(actual.createRingBuffer),
    feedSamples: vi.fn(actual.feedSamples),
  }
})

vi.mock('../render2d', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render2d')>()
  return { ...actual, drawScope: vi.fn() }
})

const createRingSpy = vi.mocked(createRingBuffer)
const feedSpy = vi.mocked(feedSamples)
const drawSpy = vi.mocked(drawScope)

/** Animation-frame callbacks the panel has scheduled and not yet run. */
let frames: FrameRequestCallback[] = []

function fakeCanvas(): unknown {
  return {
    width: 0,
    height: 0,
    offsetWidth: 800,
    offsetHeight: 200,
    getContext: () => ({}),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  }
}

/** Render the panel and run its effects. Returns the markup and an unmount. */
function mountScope(store: AppStore): { html: string; unmount: () => void } {
  harness.effects.length = 0
  harness.canvas = fakeCanvas()
  const html = renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <Scope />
    </AppStoreProvider>,
  )
  harness.canvas = null
  const cleanups: (() => void)[] = []
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
  }
  return { html, unmount: () => cleanups.forEach(c => c()) }
}

/** Run the next scheduled animation frame (one drawFrame). */
function runFrame(): void {
  const frame = frames.shift()
  expect(frame).toBeDefined()
  frame!(0)
}

function lastDraw(): ScopeDrawInput {
  expect(drawSpy).toHaveBeenCalled()
  return drawSpy.mock.calls[drawSpy.mock.calls.length - 1][0]
}

// ─── fixture ─────────────────────────────────────────────────────────────────

const fixturesDir = join(__dirname, '../../../../../fixtures')

describe('Scope panel reads the store-owned probe rings (issue #59)', () => {
  let store: AppStore
  let mock: MockSimClient
  let vinId: number
  let unmount: (() => void) | null = null
  let addListenerSpy: MockInstance<Parameters<EventTarget['addEventListener']>, void>

  /** One samples batch: OUT reads 1 V per second of raw time, VIN 5 V. */
  function emitBatch(times: number[]): void {
    mock.emit({
      type: 'samples',
      vectorNames: ['out', 'vin'],
      columns: [new Float64Array(times), new Float64Array(times.map(() => 5))],
      simTime: new Float64Array(times),
    })
  }

  function storeRing(probeId: string): RingBuffer {
    const ring = store.getState().getProbeRingBuffer(probeId)
    expect(ring).not.toBeNull()
    return ring!
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (): void => {})
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    )

    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#6f6' })
    store.getState().run()
    mock.emit({ type: 'vectors', names: ['time', 'out', 'vin'] })

    createRingSpy.mockClear()
    feedSpy.mockClear()
    drawSpy.mockClear()
    addListenerSpy = vi.spyOn(scopeSamplesEmitter, 'addEventListener')
  })

  afterEach(() => {
    unmount?.()
    unmount = null
    addListenerSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('creates no ring and registers no samples listener of its own', () => {
    unmount = mountScope(store).unmount

    emitBatch([0, 1e-3])
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp2', netId: vinId, color: '#f66' })
    emitBatch([2e-3, 3e-3])
    runFrame()

    // No 'samples' listener: the per-batch handler (and its per-column
    // nets.find / probes.find) is gone.
    expect(addListenerSpy.mock.calls.filter(call => call[0] === 'samples')).toEqual([])

    // The only ring created after mount is the store's ring for vp2.
    expect(createRingSpy).toHaveBeenCalledTimes(1)
    expect(createRingSpy.mock.results[0].value).toBe(storeRing('vp2'))

    // One feedSamples pass per probe per batch, always into a store ring.
    const storeRings = new Set([storeRing('vp1'), storeRing('vp2')])
    expect(feedSpy).toHaveBeenCalledTimes(3) // batch 1: vp1; batch 2: vp1, vp2
    for (const call of feedSpy.mock.calls) expect(storeRings.has(call[0])).toBe(true)
  })

  it('a panel mounted mid-run draws the history already in the store ring', () => {
    emitBatch([0, 1e-3, 2e-3, 3e-3])
    const ring = storeRing('vp1')
    const readWindowSpy = vi.spyOn(ring, 'readWindow')

    const mounted = mountScope(store)
    unmount = mounted.unmount
    // The trace-list measurements read the store ring during render.
    expect(mounted.html).toContain('Vpp:')
    expect(mounted.html).not.toContain('Waiting for data')

    runFrame()
    const draw = lastDraw()
    expect(draw.width).toBe(800)
    expect(draw.traces.map(t => t.spec.probeId)).toEqual(['vp1'])
    expect(readWindowSpy).toHaveBeenCalledTimes(1)
    expect(readWindowSpy).toHaveBeenCalledWith(draw.tStart, draw.tEnd)
  })

  it('the follow window ends at the newest stored run time across a bench restart', () => {
    unmount = mountScope(store).unmount

    emitBatch([0, 10, 20, 30])
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 5])
    runFrame()

    // Run time continues past the restart (30 s + 5 s), so the window ends at
    // 35 s and shows the newest sample, not at raw 5 s or at the old 30 s.
    const ring = storeRing('vp1')
    expect(ring.newestTime).toBe(35)
    const draw = lastDraw()
    expect(draw.tEnd).toBe(35)
    expect(draw.traces.map(t => t.spec.probeId)).toEqual(['vp1'])
  })
})
