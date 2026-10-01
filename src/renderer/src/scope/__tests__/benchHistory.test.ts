/**
 * src/renderer/src/scope/__tests__/benchHistory.test.ts: issue #59, Spec 7.5
 *
 * Scope history across bench-window restarts, through the real store path:
 * SimEvents from a mock simClient, `ingestSamples` feeding the store-owned
 * probe rings, and the scope reading them back with `getProbeRingBuffer`.
 *
 * Spec 7.5: when SimHost restarts the bench window (ngspice restarts the
 * transient at t = 0), scope history survives. The rings keep it, and every
 * ring on the run shares one continuous time axis, including a ring created
 * after the restart (a probe added mid-run). A fresh Run starts at zero again.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, type AppStore } from '../../store/appStore'
import { createMockSimClient, type MockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('scope rings across bench-window restarts (store path)', () => {
  let store: AppStore
  let mock: MockSimClient
  let outId: number
  let vinId: number

  /** One samples batch: OUT reads 1 V per second of raw time, VIN 5 V. */
  function emitBatch(times: number[], order: ('out' | 'vin')[] = ['out', 'vin']): void {
    const simTime = new Float64Array(times)
    const column = (name: 'out' | 'vin'): Float64Array =>
      new Float64Array(times.map(t => (name === 'out' ? t : 5)))
    mock.emit({
      type: 'samples',
      vectorNames: order,
      columns: order.map(column),
      simTime,
    })
  }

  function storedTimes(probeId: string): number[] {
    const ring = store.getState().getProbeRingBuffer(probeId)
    expect(ring).not.toBeNull()
    return Array.from(ring!.read(0, ring!.length).times)
  }

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vinId, volts: 5, seriesOhms: 0.1 })
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp1', netId: outId, color: '#6f6' })
    store.getState().run()
    mock.emit({ type: 'vectors', names: ['time', 'out', 'vin'] })
  })

  it('keeps history across a restart and continues the time axis', () => {
    emitBatch([0, 10, 20, 30])
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 5])

    expect(storedTimes('vp1')).toEqual([0, 10, 20, 30, 30, 35])
    const ring = store.getState().getProbeRingBuffer('vp1')!
    // The pre-restart window is still readable (scroll mode can reach it).
    expect(Array.from(ring.readWindow(0, 20).values)).toEqual([0, 10, 20])
    // Values after the restart are the new window's raw readings.
    expect(Array.from(ring.readWindow(31, 40).values)).toEqual([5])
    expect(ring.newestTime).toBe(35)
  })

  it('keeps history across two restarts', () => {
    emitBatch([0, 30])
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 30])
    mock.emit({ type: 'benchRestarted', reason: 'memory' })
    emitBatch([0, 2])
    expect(storedTimes('vp1')).toEqual([0, 30, 30, 60, 60, 62])
  })

  it('a probe added after a restart shares the run time axis', () => {
    emitBatch([0, 10, 20, 30])
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 5])
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp2', netId: vinId, color: '#f66' })
    emitBatch([6, 7])

    expect(storedTimes('vp2')).toEqual([36, 37])
    const a = store.getState().getProbeRingBuffer('vp1')!
    const b = store.getState().getProbeRingBuffer('vp2')!
    expect(b.newestTime).toBe(a.newestTime)
    // A follow window anchored on the shared latest time shows both traces.
    const latest = Math.max(a.newestTime, b.newestTime)
    expect(Array.from(a.readWindow(latest - 1, latest).times)).toEqual([36, 37])
    expect(Array.from(b.readWindow(latest - 1, latest).times)).toEqual([36, 37])
  })

  it('a ring fed before the surviving ring in the restart batch still joins the run', () => {
    emitBatch([0, 10, 20, 30])
    // vp2 is created between the last pre-restart batch and the restart, and
    // its column comes first in the restart batch, so it is fed before vp1.
    store.getState().addInstrument({ kind: 'voltage-probe', id: 'vp2', netId: vinId, color: '#f66' })
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 5], ['vin', 'out'])

    expect(storedTimes('vp1')).toEqual([0, 10, 20, 30, 30, 35])
    expect(storedTimes('vp2')).toEqual([30, 35])
  })

  it('a fresh Run starts the time axis at zero again', () => {
    emitBatch([0, 10, 20, 30])
    mock.emit({ type: 'benchRestarted', reason: 'window-elapsed' })
    emitBatch([0, 5])
    // Run again: the store resets the rings and ngspice starts at t = 0.
    store.getState().run()
    emitBatch([0, 1])
    expect(storedTimes('vp1')).toEqual([0, 1])
  })
})
