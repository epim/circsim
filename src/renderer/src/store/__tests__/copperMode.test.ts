import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { CopperOp } from '../../../../core/copper'

function bench(physicalMethod?: 'failed') {
  const mock = createMockSimClient()
  const send = mock.send.bind(mock)
  let physical = false
  mock.send = command => {
    send(command)
    if (command.type === 'loadCircuit') physical = command.deckLines.some(line => /^vpad_/i.test(line))
    if (command.type === 'runOp') queueMicrotask(() => mock.emit({
      type: 'opResult', values: { vin: 5, out: 2.5 }, method: physical ? physicalMethod : undefined,
    }))
  }
  const store = createAppStore({ simClient: mock })
  store.getState().openBoardFromText(
    readFileSync(join(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb'), 'utf8'),
    'rc.kicad_pcb',
  )
  const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
  store.getState().addInstrument({ kind: 'dc-supply', id: 'psu', netId: vin.id, volts: 5, seriesOhms: 0.1 })
  return { store, mock }
}

describe('bench copper mode and independent critic operating point', () => {
  it('a failed critic op retains geometry, keeps the ideal bench result and reports missing assessment', async () => {
    const { store } = bench('failed')
    await store.getState().powerOn()
    expect(store.getState().convergenceCard).toBeNull()
    expect(store.getState().opVoltages?.get(1)).toBe(5)
    expect(store.getState().criticOp?.copper?.method).toBe('failed')
    expect(store.getState().criticReport?.findings.some(f => f.id.startsWith('floating:copper-gap:'))).toBe(true)
    expect(store.getState().criticReport?.ranBy).not.toContain('ampacity')
  })
  it('blocks overlapping Power On and Run while the shared engine is solving', async () => {
    const { store, mock } = bench()
    const first = store.getState().powerOn()
    const duplicate = store.getState().powerOn()
    store.getState().run()
    expect(await duplicate).toBeNull()
    expect(mock.sent.filter(c => c.type === 'runTransient')).toEqual([])
    await first
    expect(mock.sent.filter(c => c.type === 'runOp')).toHaveLength(2)
  })
  it('updates physical pad labels from latest transient node samples without changing the critic op', async () => {
    const { store, mock } = bench()
    await store.getState().setCopperAware(true)
    await store.getState().powerOn()
    const snapshot = store.getState().copperOp!
    const node = snapshot.network.padNode('R1', '1')!
    let painted: CopperOp | null = null
    store.getState().setBoardHooks({ applyNetVoltages() {}, showOpAnnotations() {},
      applyPadVoltages(copper) { painted = copper },
    })
    mock.emit({ type: 'samples', vectorNames: [], columns: [], simTime: new Float64Array(),
      latest: { vectorNames: [node], values: new Float64Array([4.7]) },
    })
    expect((painted as CopperOp | null)?.padVoltages.R1['1']).toBe(4.7)
    expect(store.getState().criticOp?.copper).toBe(snapshot)
  })
  it('keeps the bench ideal by default, audits copper, and restores the ideal deck', async () => {
    const { store, mock } = bench()
    expect(store.getState().copperAware).toBe(false)
    await store.getState().powerOn()
    expect(store.getState().copperOp).toBeNull()
    expect(store.getState().criticOp?.copper).toBeDefined()
    expect(store.getState().criticOp?.copper?.unreachedPads.length).toBeGreaterThan(0)
    const loads = mock.sent.filter(c => c.type === 'loadCircuit')
    expect(loads.some(c => c.deckLines.some(line => /^vpad_/i.test(line)))).toBe(true)
    expect(loads.at(-1)!.deckLines.some(line => /^vpad_/i.test(line))).toBe(false)
    expect(store.getState().simState).toBe('idle')
  })

  it('reruns an energized bench when mode changes and reuses the physical op for the critic', async () => {
    const { store, mock } = bench()
    await store.getState().powerOn()
    mock.clearSent()
    await store.getState().setCopperAware(true)
    expect(store.getState().copperOp).not.toBeNull()
    expect(store.getState().criticOp?.copper).toBe(store.getState().copperOp)
    expect(mock.sent.filter(c => c.type === 'runOp')).toHaveLength(1)
    await store.getState().setCopperAware(false)
    expect(store.getState().copperOp).toBeNull()
    expect(store.getState().criticOp?.copper).toBeDefined()
  })
})
