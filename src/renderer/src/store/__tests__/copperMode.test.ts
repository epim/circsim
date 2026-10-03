import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { CopperOp } from '../../../../core/copper'

function bench(physicalMethod?: 'failed' | 'gmin' | 'source' | 'tran-fallback', options: { board?: '555'; holdPhysical?: boolean; primaryFailed?: boolean; primaryFallback?: boolean; throwPhysicalLoad?: boolean; loadError?: boolean } = {}) {
  const mock = createMockSimClient()
  const send = mock.send.bind(mock)
  let physical = false
  mock.send = command => {
    send(command)
    if (command.type === 'loadCircuit') {
      physical = command.deckLines.some(line => /^vpad_/i.test(line))
      if (physical && options.throwPhysicalLoad) throw new Error('physical load failed')
      if (!physical && options.loadError) mock.emit({ type: 'log', level: 'error', text: 'Error: unknown subckt: x_u1 half555' })
    }
    if (command.type === 'runOp' && !(physical && options.holdPhysical)) queueMicrotask(() => mock.emit({
      type: 'opResult', values: { vin: 5, vcc: 5, out: 2.5 }, method: physical ? physicalMethod : options.primaryFailed ? 'failed' : options.primaryFallback ? 'tran-fallback' : undefined,
    }))
  }
  const restartSimhost = vi.fn(async () => {})
  const store = createAppStore({ simClient: mock, restartSimhost })
  store.getState().openBoardFromText(
    readFileSync(join(__dirname, options.board === '555' ? '../../../../../resources/sample/blinker-555.kicad_pcb' : '../../../../../fixtures/fixture-rc.kicad_pcb'), 'utf8'),
    'rc.kicad_pcb',
  )
  const vin = store.getState().circuit!.nets.find(n => n.kicadName === (options.board === '555' ? 'VCC' : 'VIN'))!
  store.getState().addInstrument({ kind: 'dc-supply', id: 'psu', netId: vin.id, volts: 5, seriesOhms: 0.1 })
  return { store, mock, restartSimhost }
}

describe('bench copper mode and independent critic operating point', () => {
  it('publishes the ideal result and idle UI before the physical critic finishes', async () => {
    const { store, mock } = bench(undefined, { holdPhysical: true })
    const pending = store.getState().powerOn()
    try {
      await vi.waitFor(() => expect(mock.sent.filter(command => command.type === 'runOp')).toHaveLength(2))
      expect(store.getState().simState).toBe('idle')
      expect(store.getState().opVoltages?.get(1)).toBe(5)
      expect(store.getState().opVoltagesStale).toBe(false)
      expect(store.getState().criticOp?.copper?.method).toBe('failed')
    } finally {
      mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
      await pending
    }
  })

  it.each([{ primaryFailed: true }, { loadError: true }, { primaryFallback: true }])('does not load a physical critic circuit after a rejected or fallback primary solve: %j', async options => {
    const { store, mock } = bench(undefined, options)
    await store.getState().powerOn()
    expect(mock.sent.filter(command => command.type === 'runOp')).toHaveLength(1)
    expect(mock.sent.filter(command => command.type === 'loadCircuit')).toHaveLength(1)
    expect(store.getState().criticOp?.copper?.method).toBe('failed')
    expect(store.getState().criticReport?.ranBy).not.toContain('ampacity')
  })

  it.each(['failed', 'gmin', 'source', 'tran-fallback'] as const)('restarts before restoring the ideal deck after a physical %s result', async method => {
    const { store, mock, restartSimhost } = bench(method)
    let held!: () => void
    restartSimhost.mockImplementationOnce(() => new Promise<void>(resolve => { held = resolve }))
    const pending = store.getState().powerOn()
    await vi.waitFor(() => expect(restartSimhost).toHaveBeenCalledOnce())
    expect(mock.sent.filter(c => c.type === 'loadCircuit')).toHaveLength(2)
    store.getState().run()
    expect(mock.sent.some(c => c.type === 'runTransient')).toBe(false)
    held()
    await pending
    store.getState().run()
    expect(mock.sent.filter(c => c.type === 'loadCircuit')[2].deckLines.some(line => /^vpad_/i.test(line))).toBe(false)
    expect(mock.sent.some(c => c.type === 'runTransient')).toBe(true)
  })

  it.each([undefined, '555'] as const)('a thrown physical load preserves the ideal result, restores its deck and permits Run (%s)', async board => {
    const { store, mock, restartSimhost } = bench(undefined, { board, throwPhysicalLoad: true })
    await store.getState().powerOn()
    expect(store.getState().simState).toBe('idle')
    expect(restartSimhost).toHaveBeenCalledOnce()
    expect(store.getState().opVoltages?.get(1)).toBe(5)
    expect(store.getState().criticOp?.copper?.method).toBe('failed')
    expect(store.getState().criticReport?.findings.some(f => f.id.startsWith('floating:copper-gap:'))).toBe(true)
    if (board === '555') expect(store.getState().criticOp?.copper?.unreachedPads).toHaveLength(6)
    const loads = mock.sent.filter(command => command.type === 'loadCircuit')
    expect(loads.at(-1)!.deckLines.some(line => /^vpad_/i.test(line))).toBe(false)
    store.getState().run()
    expect(mock.sent.some(command => command.type === 'runTransient')).toBe(true)
  })

  it('coalesces knob bench ops before one physical refresh, without waiting for that refresh', async () => {
    const options = { holdPhysical: false }
    const { store, mock } = bench(undefined, options)
    await store.getState().powerOn()
    options.holdPhysical = true
    mock.clearSent()
    store.getState().updateInstrument('psu', { kind: 'dc-supply', id: 'psu', netId: 1, volts: 4, seriesOhms: 0.1 })
    store.getState().updateInstrument('psu', { kind: 'dc-supply', id: 'psu', netId: 1, volts: 3, seriesOhms: 0.1 })
    await store.getState().whenReopSettled()
    try {
      expect(store.getState().simState).toBe('idle')
      expect(store.getState().instruments.find(i => i.kind === 'dc-supply' && i.id === 'psu')).toMatchObject({ volts: 3 })
      const loads = mock.sent.filter(c => c.type === 'loadCircuit')
      expect(loads.filter(c => c.deckLines.some(line => /^vpad_/i.test(line)))).toHaveLength(1)
      expect(mock.sent.filter(c => c.type === 'runOp')).toHaveLength(3)
    } finally {
      mock.emit({ type: 'opResult', values: { vin: 3, out: 1.5 } })
      await vi.waitFor(() => expect(store.getState().criticOp?.copper?.method).not.toBe('failed'))
    }
  })

  it('queues Run behind the active critic and restores the bench before starting transient', async () => {
    const { store, mock } = bench(undefined, { holdPhysical: true })
    const pending = store.getState().powerOn()
    await vi.waitFor(() => expect(mock.sent.filter(c => c.type === 'runOp')).toHaveLength(2))
    store.getState().run()
    expect(mock.sent.some(c => c.type === 'runTransient')).toBe(false)
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await pending
    await vi.waitFor(() => expect(mock.sent.some(c => c.type === 'runTransient')).toBe(true))
    expect(store.getState().simState).toBe('running')
    const last = mock.sent.filter(c => c.type === 'loadCircuit').at(-1)!
    expect(last.deckLines.some(line => /^vpad_/i.test(line))).toBe(false)
  })

  it.each(['run-then-knob', 'knob-then-run'] as const)('keeps Run and the latest knob value during a held critic: %s', async order => {
    const options = { holdPhysical: true }
    const { store, mock } = bench(undefined, options)
    const pending = store.getState().powerOn()
    await vi.waitFor(() => expect(mock.sent.filter(c => c.type === 'runOp')).toHaveLength(2))
    const knob = () => store.getState().updateInstrument('psu', { kind: 'dc-supply', id: 'psu', netId: 1, volts: 4, seriesOhms: 0.1 })
    if (order === 'run-then-knob') { store.getState().run(); knob() }
    else { knob(); store.getState().run() }
    options.holdPhysical = false
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await pending
    await store.getState().whenReopSettled()
    await vi.waitFor(() => expect(mock.sent.filter(c => c.type === 'runTransient')).toHaveLength(1))
    expect(store.getState().simState).toBe('running')
    expect(store.getState().instruments.find(i => i.kind === 'dc-supply' && i.id === 'psu')).toMatchObject({ volts: 4 })
    const transient = mock.sent.findIndex(c => c.type === 'runTransient')
    expect(mock.sent.slice(transient + 1).filter(c => c.type === 'loadCircuit' || c.type === 'runOp')).toEqual([])
    if (order === 'run-then-knob') expect(mock.sent.some(c => c.type === 'alter' && c.value === '4')).toBe(true)
  })

  it('surfaces a failed planned restart instead of leaving silent Power On and Run', async () => {
    const { store, mock, restartSimhost } = bench('failed')
    restartSimhost.mockRejectedValueOnce(new Error('supervisor fatal'))
    await store.getState().powerOn()
    expect(store.getState().convergenceCard?.plainLanguage).toContain('Restart the app')
    const sent = mock.sent.length
    store.getState().run()
    await store.getState().powerOn()
    expect(mock.sent).toHaveLength(sent)
    expect(store.getState().convergenceCard).not.toBeNull()
  })
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
