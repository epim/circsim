import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import type { SimEvent } from '../protocol'
import { StubEngine } from './stubEngine'

const BAD = ['* bad', 'x1 out 0 missing', '.end']
const GOOD = ['* good', 'v1 out 0 dc 2.5', '.end']

class ReloadEngine extends StubEngine {
  trace: string[] = []
  fallback = false

  init(): void { this.trace.push('init') }
  dispose(): void { this.trace.push('dispose') }
  loadCircuit(deck: string[] = []): void {
    this.trace.push(deck[0])
    if (deck[0] === BAD[0]) throw new Error('unknown subckt: x1 out 0 missing')
  }
  command(cmd: string): Promise<void> {
    this.trace.push(cmd)
    if (cmd === 'op' && this.fallback) this.emit({ type: 'char', text: 'Transient op started' })
    return super.command(cmd)
  }
  allVectors(): string[] { return ['out'] }
  vectorData(): Float64Array { return Float64Array.of(2.5) }
}

function setup() {
  const engine = new ReloadEngine()
  const events: SimEvent[] = []
  const host = new SimHost({ engine, emit: event => events.push(event), disableTimers: true, disableWatchdog: true, resumeGapMs: 0 })
  return { engine, events, host }
}

describe('native circuit state recovery (issue #163)', () => {
  it('reinitializes after a rejected native load before accepting another deck', async () => {
    const { engine, events, host } = setup()
    await expect(host.loadCircuit(BAD)).rejects.toThrow(/unknown subckt/)
    await host.loadCircuit(GOOD)
    expect(engine.trace.indexOf('dispose')).toBeGreaterThan(engine.trace.indexOf(BAD[0]))
    expect(engine.trace.indexOf('init')).toBeGreaterThan(engine.trace.indexOf('dispose'))
    expect(engine.trace.indexOf(GOOD[0])).toBeGreaterThan(engine.trace.indexOf('init'))
    expect(events).toContainEqual(expect.objectContaining({ type: 'loadFailed', detail: expect.stringMatching(/unknown subckt/) }))
  })

  it('answers an OP queued after a rejected load as failed without entering the corrupted engine', async () => {
    const { engine, events, host } = setup()
    host.handleCommand({ type: 'loadCircuit', deckLines: BAD })
    host.handleCommand({ type: 'runOp' })
    await host.whenIdle()
    expect(engine.commands).not.toContain('op')
    expect(events).toContainEqual({ type: 'opResult', values: {}, method: 'failed' })
  })

  it('reinitializes after a transient OP fallback before loading the next deck', async () => {
    const { engine, host } = setup()
    await host.loadCircuit(GOOD)
    engine.fallback = true
    await host.runOp()
    engine.trace = []
    await host.loadCircuit(GOOD)
    expect(engine.trace).toContain('dispose')
    expect(engine.trace.indexOf('init')).toBeLessThan(engine.trace.indexOf(GOOD[0]))
  })

  it('keeps a healthy direct OP reload on the normal destroy-all path', async () => {
    const { engine, host } = setup()
    await host.loadCircuit(GOOD)
    await host.runOp()
    await host.loadCircuit(GOOD)
    expect(engine.commands).toContain('destroy all')
    expect(engine.trace).not.toContain('dispose')
  })
})
