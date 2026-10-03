import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../main'

vi.mock('../../simhost/ngspiceFfi', () => ({ ngspiceResourcesAvailable: () => true }))
vi.mock('../../simhost/solveEngine', () => ({ createInProcessSolveEngine: async () => ({
  loadCircuit: async () => {}, runOp: async () => ({ values: {}, method: 'failed' }), dispose: async () => {},
}) }))

describe('failed native operating point', () => {
  it.each(['op', 'audit'])('%s exits 3 with solve.ran false after nonconvergence', async command => {
    let output = ''
    const code = await runCli([command, 'fixtures/fixture-555.kicad_pcb', '--json'], {
      stdout: text => { output += text }, stderr() {}, env: {}, cwd: process.cwd(),
    })
    expect(code).toBe(3)
    const report = JSON.parse(output)
    expect(report.solve).toMatchObject({ ran: false, method: 'failed', reason: 'operating point did not converge' })
    if (command === 'op') expect(report.copper).toBeUndefined()
  })
})
