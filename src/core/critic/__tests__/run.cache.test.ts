/**
 * core/critic/__tests__/run.cache.test.ts
 *
 * Issue #56: the no-sim checks (floating, clearance, decoupling, loop-area) do
 * not depend on an operating-point result, so a fresh op result must not re-run
 * them. They re-run when the circuit object, the board object or the options
 * change. The op-dependent checks run on every call that carries an op result.
 */

import { describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseBoard } from '../../kicad/board'
import { extract } from '../../netlist/extract'

const calls = vi.hoisted(() => ({ clearance: 0, ampacity: 0 }))

vi.mock('../checks/clearance', async (importOriginal) => {
  const real = await importOriginal<typeof import('../checks/clearance')>()
  return {
    ...real,
    checkClearance: (ctx: Parameters<typeof real.checkClearance>[0]) => {
      calls.clearance++
      return real.checkClearance(ctx)
    },
  }
})

vi.mock('../checks/ampacity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../checks/ampacity')>()
  return {
    ...real,
    checkAmpacity: (ctx: Parameters<typeof real.checkAmpacity>[0]) => {
      calls.ampacity++
      return real.checkAmpacity(ctx)
    },
  }
})

import { runCritic } from '../run'

const fixturesDir = join(__dirname, '../../../../fixtures')
const load = () => parseBoard(readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'))

describe('runCritic no-sim result reuse', () => {
  it('does not re-run the no-sim checks when only the op result changes', () => {
    const board = load()
    const circuit = extract(board)
    const before = { ...calls }

    const first = runCritic(board, circuit)
    expect(calls.clearance - before.clearance).toBe(1)

    const op = { nodeVoltages: {}, partCurrents: {} }
    const second = runCritic(board, circuit, op)
    const third = runCritic(board, circuit, op)
    expect(calls.clearance - before.clearance).toBe(1)
    // The op-dependent checks run on every call that carries an op result.
    expect(calls.ampacity - before.ampacity).toBe(2)

    expect(second.findings.filter((f) => f.check === 'clearance')).toEqual(
      first.findings.filter((f) => f.check === 'clearance'),
    )
    expect(third.ranBy).toEqual(second.ranBy)
  })

  it('re-runs the no-sim checks for a new circuit, a new board, or new options', () => {
    const board = load()
    const circuit = extract(board)
    const before = calls.clearance

    runCritic(board, circuit)
    runCritic(board, extract(board))
    expect(calls.clearance - before).toBe(2)

    const board2 = load()
    runCritic(board2, extract(board2))
    expect(calls.clearance - before).toBe(3)

    runCritic(board, circuit, undefined, { minClearanceMm: 0.5 })
    expect(calls.clearance - before).toBe(4)
    // Same circuit, same (changed) options: served from the cache.
    runCritic(board, circuit, undefined, { minClearanceMm: 0.5 })
    expect(calls.clearance - before).toBe(4)
  })
})
