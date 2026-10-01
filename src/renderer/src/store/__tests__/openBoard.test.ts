/**
 * openBoard.test.ts (issue #55)
 *
 * The async open path: the store hands the pipeline to an injected runner
 * (a Worker in the app), shows progress while it runs, puts the board on screen
 * before the audit lands, and drops anything a newer open or a newer audit has
 * superseded. openBoardFromText (the synchronous path) must produce the same
 * state, since the two share one pipeline.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore, type BoardHooks } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import {
  auditOpenedBoard,
  openBoardPipeline,
  type OpenOutcome,
  type OpenRequest,
} from '../../boardOpen/pipeline'
import { createInlineRunner, type BoardOpenRunner, type OpenSink } from '../../boardOpen/runner'

const fixturesDir = join(__dirname, '../../../../../fixtures')
const rc = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')
const f555 = readFileSync(join(fixturesDir, 'fixture-555.kicad_pcb'), 'utf-8')
const f555Sch = readFileSync(join(fixturesDir, 'fixture-555.kicad_sch'), 'utf-8')

/** A runner the test drives by hand: it records the request and exposes the sink. */
function manualRunner(): BoardOpenRunner & {
  requests: OpenRequest[]
  sinks: OpenSink[]
  cancels: number
  finish(): void
} {
  const requests: OpenRequest[] = []
  const sinks: OpenSink[] = []
  const finishers: Array<() => void> = []
  const runner = {
    requests,
    sinks,
    cancels: 0,
    run(req: OpenRequest, sink: OpenSink): Promise<void> {
      requests.push(req)
      sinks.push(sink)
      return new Promise<void>(resolve => finishers.push(resolve))
    },
    cancel(): void {
      runner.cancels++
    },
    finish(): void {
      finishers.splice(0).forEach(f => f())
    },
  }
  return runner
}

function outcomeFor(boardText: string): OpenOutcome {
  return openBoardPipeline({ boardText, library: [] })
}

describe('openBoard: progress and ordering', () => {
  it('shows progress at once, then the board before the audit, then the audit', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    const hooks: BoardHooks = { setCriticFindings: vi.fn() } as unknown as BoardHooks
    store.getState().setBoardHooks(hooks)

    const done = store.getState().openBoard(rc, 'rc.kicad_pcb')
    // Before the runner has produced anything: nothing but the progress state.
    expect(store.getState().openProgress).toEqual({ fileName: 'rc.kicad_pcb', stage: 'parsing' })
    expect(store.getState().board).toBeNull()
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0].boardText).toBe(rc)

    const sink = runner.sinks[0]
    sink.onStage('resolving')
    expect(store.getState().openProgress?.stage).toBe('resolving')

    const outcome = outcomeFor(rc)
    sink.onOpened(outcome)
    // The board is on screen, the audit has not landed.
    expect(store.getState().board).not.toBeNull()
    expect(store.getState().circuit?.parts.length).toBeGreaterThan(0)
    expect(store.getState().resolutions.length).toBeGreaterThan(0)
    expect(store.getState().criticReport).toBeNull()
    expect(store.getState().project.boardFileName).toBe('rc.kicad_pcb')
    expect(store.getState().openProgress).toEqual({ fileName: 'rc.kicad_pcb', stage: 'auditing' })

    if (!outcome.ok) throw new Error('fixture must parse')
    sink.onAudit(auditOpenedBoard(outcome.opened))
    expect(store.getState().criticReport).not.toBeNull()
    expect(store.getState().openProgress).toBeNull()
    expect(hooks.setCriticFindings).toHaveBeenCalledTimes(1)

    runner.finish()
    await done
  })

  it('hands the runner the effective library (user models first, then bundled)', async () => {
    const runner = manualRunner()
    const bundled = [
      {
        id: 'bundled-1',
        match: { mpn: ['X'] },
        model: { type: 'subckt' as const, file: 'x.lib', name: 'X' },
        pinMaps: {},
        defaultPinMap: {},
        provenance: { source: 'test' },
      },
    ]
    const store = createAppStore({
      simClient: createMockSimClient(),
      openRunner: runner,
      library: bundled as never,
    })
    void store.getState().openBoard(rc, 'rc.kicad_pcb')
    expect(runner.requests[0].library.map(e => e.id)).toEqual(['bundled-1'])
  })

  it('a parse failure surfaces parseError and clears progress; no audit is expected', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    const done = store.getState().openBoard('(kicad_pcb (version 1', 'broken.kicad_pcb')
    runner.sinks[0].onOpened(outcomeFor('(kicad_pcb (version 1'))
    const s = store.getState()
    expect(s.parseError).not.toBeNull()
    expect(s.parseError?.fileName).toBe('broken.kicad_pcb')
    expect(s.board).toBeNull()
    expect(s.openProgress).toBeNull()
    expect(s.project.boardFileName).toBe('broken.kicad_pcb')
    runner.finish()
    await done
  })

  it('a runner that rejects reports the failure as a parse error and clears progress', async () => {
    const failing: BoardOpenRunner = {
      run: () => Promise.reject(new Error('worker exploded')),
      cancel: () => {},
    }
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: failing })
    await store.getState().openBoard(rc, 'rc.kicad_pcb')
    expect(store.getState().openProgress).toBeNull()
    expect(store.getState().parseError?.message).toContain('worker exploded')
  })
})

describe('openBoard: replacing a loaded project', () => {
  it('clears the old board at once, so nothing acts on a half-reset project', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    store.getState().openBoardFromText(rc, 'old.kicad_pcb')
    expect(store.getState().board).not.toBeNull()

    const done = store.getState().openBoard(f555, 'new.kicad_pcb')
    const s = store.getState()
    expect(s.board).toBeNull()
    expect(s.circuit).toBeNull()
    expect(s.resolutions).toEqual([])
    expect(s.criticReport).toBeNull()
    expect(s.instruments).toEqual([])
    expect(s.groundNetId).toBeNull()
    expect(s.openProgress?.fileName).toBe('new.kicad_pcb')
    runner.finish()
    await done
  })

  it('hands an already-computed report to hooks that attach after the audit landed', async () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    await store.getState().openBoard(rc, 'rc.kicad_pcb')
    const hooks = { setCriticFindings: vi.fn() } as unknown as BoardHooks
    store.getState().setBoardHooks(hooks)
    expect(hooks.setCriticFindings).toHaveBeenCalledWith(store.getState().criticReport!.findings)
  })
})

describe('openBoard: supersession', () => {
  it('a newer open cancels the older run and ignores its late replies', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })

    const first = store.getState().openBoard(rc, 'first.kicad_pcb')
    const second = store.getState().openBoard(f555, 'second.kicad_pcb')
    expect(runner.cancels).toBeGreaterThanOrEqual(1)
    expect(store.getState().openProgress?.fileName).toBe('second.kicad_pcb')

    // The first run's board arrives late: it must not land.
    runner.sinks[0].onOpened(outcomeFor(rc))
    expect(store.getState().board).toBeNull()
    expect(store.getState().project.boardFileName).toBeNull()

    const o2 = outcomeFor(f555)
    runner.sinks[1].onOpened(o2)
    if (!o2.ok) throw new Error('fixture must parse')
    // A late audit from the first run is ignored; the second run's lands.
    runner.sinks[0].onAudit(auditOpenedBoard({ ...o2.opened }))
    expect(store.getState().criticReport).toBeNull()
    runner.sinks[1].onAudit(auditOpenedBoard(o2.opened))
    expect(store.getState().criticReport).not.toBeNull()
    expect(store.getState().openProgress).toBeNull()

    runner.finish()
    await Promise.all([first, second])
  })

  it('a synchronous open during an async one cancels it', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    const pending = store.getState().openBoard(rc, 'async.kicad_pcb')
    store.getState().openBoardFromText(f555, 'sync.kicad_pcb')
    expect(runner.cancels).toBeGreaterThanOrEqual(1)
    expect(store.getState().project.boardFileName).toBe('sync.kicad_pcb')
    expect(store.getState().openProgress).toBeNull()
    runner.sinks[0].onOpened(outcomeFor(rc))
    expect(store.getState().project.boardFileName).toBe('sync.kicad_pcb')
    runner.finish()
    await pending
  })

  it('an audit run by someone else while the open audit is pending wins', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    const done = store.getState().openBoard(rc, 'rc.kicad_pcb')
    const outcome = outcomeFor(rc)
    runner.sinks[0].onOpened(outcome)
    if (!outcome.ok) throw new Error('fixture must parse')

    // e.g. an operating point landed first and re-audited with real currents.
    store.getState().runCriticAudit()
    const fresh = store.getState().criticReport
    expect(fresh).not.toBeNull()

    runner.sinks[0].onAudit(auditOpenedBoard(outcome.opened))
    expect(store.getState().criticReport).toBe(fresh)
    expect(store.getState().openProgress).toBeNull()
    runner.finish()
    await done
  })

  it('a ground change while the audit is pending discards the stale audit and audits the new circuit', async () => {
    const runner = manualRunner()
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: runner })
    const done = store.getState().openBoard(rc, 'rc.kicad_pcb')
    const outcome = outcomeFor(rc)
    runner.sinks[0].onOpened(outcome)
    if (!outcome.ok) throw new Error('fixture must parse')

    const other = store.getState().circuit!.nets.find(n => n.id !== store.getState().groundNetId)!
    store.getState().setGround(other.id)
    const circuitAfter = store.getState().circuit

    runner.sinks[0].onAudit(auditOpenedBoard(outcome.opened))
    // The stale report is not kept; a report for the current circuit exists.
    expect(store.getState().circuit).toBe(circuitAfter)
    expect(store.getState().criticReport).not.toBeNull()
    expect(store.getState().openProgress).toBeNull()
    runner.finish()
    await done
  })

  it('a run that ends without an audit still gets one, and progress clears', async () => {
    const lossy: BoardOpenRunner = {
      // Delivers the board, then ends: what a worker that died mid-audit does.
      async run(req, sink) {
        sink.onOpened(openBoardPipeline(req))
      },
      cancel: () => {},
    }
    const store = createAppStore({ simClient: createMockSimClient(), openRunner: lossy })
    await store.getState().openBoard(rc, 'rc.kicad_pcb')
    expect(store.getState().board).not.toBeNull()
    expect(store.getState().criticReport).not.toBeNull()
    expect(store.getState().openProgress).toBeNull()
  })
})

describe('openBoard: same result as the synchronous path', () => {
  it('with the inline runner, state matches openBoardFromText (schematic included)', async () => {
    const opts = { schematicText: f555Sch, schematicFileName: 'fixture-555.kicad_sch' }

    const sync = createAppStore({ simClient: createMockSimClient() })
    sync.getState().openBoardFromText(f555, 'fixture-555.kicad_pcb', opts)

    const async_ = createAppStore({ simClient: createMockSimClient(), openRunner: createInlineRunner() })
    await async_.getState().openBoard(f555, 'fixture-555.kicad_pcb', opts)

    const a = sync.getState()
    const b = async_.getState()
    expect(b.board).toEqual(a.board)
    expect(b.circuit).toEqual(a.circuit)
    expect(b.resolutions).toEqual(a.resolutions)
    expect(b.groundNetId).toBe(a.groundNetId)
    expect(b.suggestedSupplyNetIds).toEqual(a.suggestedSupplyNetIds)
    expect(b.instruments).toEqual(a.instruments)
    expect(b.criticReport).toEqual(a.criticReport)
    expect(b.viewerOnly).toBe(a.viewerOnly)
    expect(b.project).toEqual(a.project)
    expect(b.openProgress).toBeNull()
    expect(a.openProgress).toBeNull()
  })

  it('the default runner (no Worker in node) opens a board end to end', async () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    await store.getState().openBoard(rc, 'rc.kicad_pcb')
    expect(store.getState().board).not.toBeNull()
    expect(store.getState().criticReport).not.toBeNull()
  })
})
