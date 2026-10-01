/**
 * SimHost deck gate (issue #35), unit level: a stub engine records what reaches
 * ngspice. A deck that fails sanitizeDeck must never get to engine.loadCircuit,
 * on either the command path or the promise path.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import type { EngineEvent, EngineEventListener, SpiceEngine } from '../engine'
import type { SimEvent } from '../protocol'

class StubEngine implements SpiceEngine {
  version = '46'
  commands: string[] = []
  loads: string[][] = []
  init(): void {}
  on(_l: EngineEventListener): () => void {
    return () => {}
  }
  emit(_ev: EngineEvent): void {}
  loadCircuit(deckLines: string[]): void {
    this.loads.push([...deckLines])
  }
  command(cmd: string): Promise<void> {
    this.commands.push(cmd)
    return Promise.resolve()
  }
  currentPlot(): string {
    return 'op1'
  }
  allVectors(): string[] {
    return []
  }
  vectorData(): Float64Array | undefined {
    return undefined
  }
  isRunning(): boolean {
    return false
  }
  dispose(): void {}
}

const CLEAN = ['* clean', 'v1 in 0 dc 5', 'r1 in 0 1k', '.end']
const HOSTILE = [
  '* hostile user model',
  '.subckt evil a b',
  '.control',
  'echo COUNCIL_MARKER_EXECUTED',
  '.endc',
  'r1 a b 1000',
  '.ends',
  'x1 in 0 evil',
  '.end'
]

function makeHost(engine: StubEngine): { host: SimHost; events: SimEvent[] } {
  const events: SimEvent[] = []
  const host = new SimHost({
    engine,
    emit: (e) => events.push(e),
    disableWatchdog: true,
    disableTimers: true
  })
  return { host, events }
}

describe('SimHost deck gate', () => {
  it('loads a clean deck', async () => {
    const engine = new StubEngine()
    const { host } = makeHost(engine)
    await host.loadCircuit(CLEAN)
    expect(engine.loads).toEqual([CLEAN])
  })

  it('refuses a hostile deck on the promise path and never calls the engine', async () => {
    const engine = new StubEngine()
    const { host } = makeHost(engine)
    await expect(host.loadCircuit(HOSTILE)).rejects.toThrow(/deck rejected/)
    expect(engine.loads).toEqual([])
  })

  it('refuses a hostile deck on the command path and surfaces an error log', async () => {
    const engine = new StubEngine()
    const { host, events } = makeHost(engine)
    host.handleCommand({ type: 'loadCircuit', deckLines: HOSTILE })
    await host.whenIdle()
    expect(engine.loads).toEqual([])
    const errors = events.filter((e) => e.type === 'log' && e.level === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as Extract<SimEvent, { type: 'log' }>).text).toMatch(
      /loadCircuit.*deck rejected.*\.control/
    )
  })

  it('refuses a deck smuggling cards through an embedded newline', async () => {
    const engine = new StubEngine()
    const { host } = makeHost(engine)
    await expect(
      host.loadCircuit(['* t', 'r1 a 0 1k\n.control\nshell calc\n.endc', '.end'])
    ).rejects.toThrow(/deck rejected/)
    expect(engine.loads).toEqual([])
  })

  it('splits a legitimate multi-line entry (issue #18) and gates the split cards', async () => {
    const engine = new StubEngine()
    const { host } = makeHost(engine)
    await host.loadCircuit(['* t', '.subckt tsub a b\nr1 a b 1000\n.ends', 'r2 a 0 1k\r\nr3 b 0 1k', '.end'])
    expect(engine.loads).toEqual([
      ['* t', '.subckt tsub a b', 'r1 a b 1000', '.ends', 'r2 a 0 1k', 'r3 b 0 1k', '.end']
    ])
  })

  it('refuses a control block hidden behind CRLF, a lone CR, or a NUL', async () => {
    for (const bad of ['r1 a 0 1k\r\n.control\r\nshell calc\r\n.endc', 'r1 a 0 1k\r.control', 'r1 a 0 1k\0.control']) {
      const engine = new StubEngine()
      const { host } = makeHost(engine)
      await expect(host.loadCircuit(['* t', bad, '.end'])).rejects.toThrow(/deck rejected/)
      expect(engine.loads).toEqual([])
    }
  })

  it('a refused reload drops the previously loaded circuit instead of leaving it live', async () => {
    const engine = new StubEngine()
    const { host } = makeHost(engine)
    await host.loadCircuit(CLEAN)
    await expect(host.loadCircuit(HOSTILE)).rejects.toThrow(/deck rejected/)
    expect(engine.loads).toEqual([CLEAN])
    expect(engine.commands).toEqual(['destroy all'])
    // The next good load must not issue a second destroy: nothing is loaded.
    await host.loadCircuit(CLEAN)
    expect(engine.commands).toEqual(['destroy all'])
    expect(engine.loads).toEqual([CLEAN, CLEAN])
  })
})
