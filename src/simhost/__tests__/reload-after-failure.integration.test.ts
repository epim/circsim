import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const VALID_DECK = ['* valid divider', 'v1 in 0 dc 5', 'r1 in out 1k', 'r2 out 0 1k', '.end']

describe.skipIf(!ngspiceResourcesAvailable())('reload after native failure (issue #163)', () => {
  it('retains the informative stderr continuation in loadFailed.detail', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: event => events.push(event), disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: ['* bad resistor value', 'v1 in 0 5', 'r1 in 0 bogus', '.end'] })
      await host.whenIdle()
      const failure = events.find(event => event.type === 'loadFailed')
      console.log(`[reload] multiline parse failure: ${JSON.stringify(failure)}`)
      expect(failure).toEqual(expect.objectContaining({ detail: expect.stringMatching(/unknown parameter/i) }))
    } finally { await host.dispose() }
  })

  it('reports an unknown subcircuit load failure and then solves a valid second deck', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (event) => events.push(event), disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: ['* incomplete imported model', 'v1 vcc 0 dc 5', 'x_u1 0 thres out vcc ctrl thres disch vcc half555', '.end']
      })
      await host.whenIdle()
      host.handleCommand({ type: 'loadCircuit', deckLines: VALID_DECK })
      const values = await host.runOp()
      console.log(`[reload] unknown-subckt then valid: out=${values.out}, errors=${JSON.stringify(events.filter((e) => e.type === 'log' && e.level === 'error'))}`)
      expect(values.out).toBeCloseTo(2.5, 9)
      expect(events).toContainEqual(expect.objectContaining({ type: 'loadFailed', detail: expect.stringMatching(/unknown subckt/i) }))
      expect(await host.runStartupSmokeCheck()).toBe(true)
    } finally {
      await host.dispose()
    }
  }, 30_000)

  it('survives a singular transient operating-point fallback followed by a valid second deck', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (event) => events.push(event), disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: ['* floating source, capacitor supplies only a transient ground path', 'vfloat a b dc 5', 'rfloat a b 1k', 'cground b 0 1u ic=0', '.options gminsteps=0 srcsteps=0', '.end']
      })
      await host.runOp()
      const fallback = events.find((event) => event.type === 'opResult')
      console.log(`[reload] singular OP: ${JSON.stringify(fallback)}`)
      host.handleCommand({ type: 'loadCircuit', deckLines: VALID_DECK })
      const values = await host.runOp()
      expect(fallback).toMatchObject({ type: 'opResult', method: 'tran-fallback' })
      expect(values.out).toBeCloseTo(2.5, 9)
    } finally {
      await host.dispose()
    }
  }, 30_000)
})
