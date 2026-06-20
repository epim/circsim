/**
 * critic.test.ts — Board Critic store slice (C4)
 *
 * Verifies the auto-trigger wiring (no live ngspice — injected mock simClient):
 *   - opening a board populates criticReport with the no-sim findings and SKIPS
 *     the sim-dependent checks (ampacity / thermal)
 *   - after an operating-point solve the report includes (no longer skips)
 *     ampacity / thermal — they run with the real op result
 *   - selectFinding stores the id and forwards focusFinding to the board hooks
 *   - buildCriticOpResult maps netId voltages → spiceNode + ref currents
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createAppStore,
  buildCriticOpResult,
  type BoardHooks,
} from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { extract } from '../../../../core/netlist/extract'
import { parseBoard } from '../../../../core/kicad/board'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('appStore — critic auto-trigger on board open', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
  })

  it('populates criticReport with the no-sim findings on open', () => {
    const report = store.getState().criticReport
    expect(report).not.toBeNull()
    // The no-sim checks ran.
    expect(report!.ranBy).toContain('floating')
    expect(report!.ranBy).toContain('clearance')
    expect(report!.ranBy).toContain('decoupling')
    // Some findings were produced (fixture-rc has single-pad nets → info findings).
    expect(report!.findings.length).toBeGreaterThan(0)
    // Summary matches the findings array.
    const counted = { error: 0, warn: 0, info: 0 }
    for (const f of report!.findings) counted[f.severity]++
    expect(report!.summary).toEqual(counted)
  })

  it('SKIPS ampacity + thermal before any simulation', () => {
    const report = store.getState().criticReport!
    const skippedChecks = report.skipped.map(s => s.check)
    expect(skippedChecks).toContain('ampacity')
    expect(skippedChecks).toContain('thermal')
    expect(report.ranBy).not.toContain('ampacity')
    expect(report.ranBy).not.toContain('thermal')
  })
})

describe('appStore — critic re-audits after an operating-point solve', () => {
  let store: ReturnType<typeof createAppStore>
  let mock: ReturnType<typeof createMockSimClient>

  beforeEach(() => {
    mock = createMockSimClient()
    store = createAppStore({ simClient: mock })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    // Attach a 5V supply on VIN so the op produces a meaningful result.
    const vin = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!
    store.getState().addInstrument({ kind: 'dc-supply', id: 'psu1', netId: vin.id, volts: 5, seriesOhms: 0.1 })
  })

  it('report no longer skips ampacity/thermal once an op result lands', async () => {
    // sanity: skipped before the solve
    expect(store.getState().criticReport!.skipped.map(s => s.check)).toContain('ampacity')

    const p = store.getState().powerOn()
    mock.emit({ type: 'opResult', values: { vin: 5, out: 2.5 } })
    await p

    const report = store.getState().criticReport!
    expect(report.ranBy).toContain('ampacity')
    expect(report.ranBy).toContain('thermal')
    const skippedChecks = report.skipped.map(s => s.check)
    expect(skippedChecks).not.toContain('ampacity')
    expect(skippedChecks).not.toContain('thermal')
  })
})

describe('appStore — selectFinding forwards to the viewport hooks', () => {
  it('stores the id and calls focusFinding with the finding', () => {
    const focused: string[] = []
    const setCalls: number[] = []
    const hooks: BoardHooks = {
      applyNetVoltages() {},
      showOpAnnotations() {},
      setCriticFindings(findings) { setCalls.push(findings.length) },
      focusFinding(f) { focused.push(f.id) },
    }
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().setBoardHooks(hooks)
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')

    // open pushed findings to the overlay
    expect(setCalls.length).toBeGreaterThan(0)

    const firstId = store.getState().criticReport!.findings[0].id
    store.getState().selectFinding(firstId)
    expect(store.getState().selectedFindingId).toBe(firstId)
    expect(focused).toEqual([firstId])
  })
})

describe('buildCriticOpResult', () => {
  it('returns undefined when not energized (no op voltages)', () => {
    const board = parseBoard(readFixture('fixture-rc.kicad_pcb'))
    const circuit = extract(board)
    expect(buildCriticOpResult(circuit, null, new Map())).toBeUndefined()
    expect(buildCriticOpResult(circuit, new Map(), new Map())).toBeUndefined()
  })

  it('maps netId voltages → spiceNode and ref currents through', () => {
    const board = parseBoard(readFixture('fixture-rc.kicad_pcb'))
    const circuit = extract(board, {
      groundNetId: circuitGnd(board),
    })
    const vin = circuit.nets.find(n => n.kicadName === 'VIN')!
    const op = buildCriticOpResult(
      circuit,
      new Map([[vin.id, 5]]),
      new Map([['D1', 0.012]]),
    )
    expect(op).toBeDefined()
    expect(op!.nodeVoltages[vin.spiceNode]).toBeCloseTo(5)
    expect(op!.partCurrents!['D1']).toBeCloseTo(0.012)
  })
})

function circuitGnd(board: ReturnType<typeof parseBoard>): number {
  const circuit = extract(board)
  return circuit.nets.find(n => n.kicadName === 'GND')!.id
}
