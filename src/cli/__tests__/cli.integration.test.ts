/**
 * src/cli/__tests__/cli.integration.test.ts
 *
 * The headless CLI (issue #28) end to end against real ngspice and the 555
 * fixture: `audit`, `deck` and `op` run through runCli with captured output.
 * Skipped when the bundled ngspice resources for this platform are missing.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { ngspiceResourcesAvailable } from '../../simhost/ngspiceFfi'
import { runCli, type CliIo } from '../main'

const haveNgspice = ngspiceResourcesAvailable()
const BOARD = join(process.cwd(), 'fixtures', 'fixture-555.kicad_pcb')

function capture(env: NodeJS.ProcessEnv = {}): { io: CliIo; out: () => string; err: () => string } {
  let out = ''
  let err = ''
  return {
    io: {
      stdout: (s) => {
        out += s
      },
      stderr: (s) => {
        err += s
      },
      env,
      cwd: process.cwd(),
    },
    out: () => out,
    err: () => err,
  }
}

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const T = 60_000

describe.skipIf(!haveNgspice)('circsim CLI against real ngspice', () => {
  it('audit --json prints a critic report and exits nonzero on error-severity findings', async () => {
    const c = capture()
    const code = await runCli(['audit', BOARD, '--schematic', '--json'], c.io)
    const report = JSON.parse(c.out())
    expect(report.schemaVersion).toBe(1)
    expect(report.solve.ran).toBe(true)
    expect(Array.isArray(report.critic.findings)).toBe(true)
    // The solve's branch currents reached the copper checks: ir-drop either ran
    // or, on this sparse fixture (no copper on GND), reported what it could not
    // assess ("partly assessed"), never the "no operating point" skip.
    const irDrop = report.critic.skipped.find((s: { check: string }) => s.check === 'ir-drop')
    if (!report.critic.ranBy.includes('ir-drop')) expect(irDrop?.reason).toMatch(/partly assessed/)
    // The 555 sample has real clearance errors (run-critic guide): the gate must trip.
    expect(report.critic.summary.error).toBeGreaterThan(0)
    expect(code).toBe(1)
  }, T)

  it('op --json prints net voltages and the solve method', async () => {
    const c = capture()
    const code = await runCli(['op', BOARD, '--schematic', '--json'], c.io)
    expect(code).toBe(0)
    const op = JSON.parse(c.out())
    expect(op.solve.method).toMatch(/^(direct|gmin|source|tran-fallback)$/)
    const vcc = op.nets.find((n: { name: string }) => n.name === 'VCC')
    expect(vcc.volts).toBeCloseTo(5, 1)
    const gnd = op.nets.find((n: { name: string }) => n.name === 'GND')
    expect(gnd.volts).toBe(0)
  }, T)

  it('CIRCSIM_NGSPICE_DIR points the engine at an explicit ngspice base dir', async () => {
    const c = capture({ CIRCSIM_NGSPICE_DIR: join(process.cwd(), 'resources', 'ngspice') })
    const code = await runCli(['op', BOARD, '--json'], c.io)
    expect(code).toBe(0)
    expect(JSON.parse(c.out()).solve.ran).toBe(true)
  }, T)

  it('deck writes the pass-1 deck to --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circsim-cli-'))
    tmpDirs.push(dir)
    const c = capture()
    const code = await runCli(['deck', BOARD, '--schematic', '--out', dir], c.io)
    expect(code).toBe(0)
    const files = readdirSync(dir)
    expect(files).toContain('fixture-555.pass1.cir')
    const deck = readFileSync(join(dir, 'fixture-555.pass1.cir'), 'utf8')
    expect(deck).toMatch(/\.end/i)
  }, T)
})

describe('circsim CLI usage errors', () => {
  it('exits 2 with a message on an unknown command', async () => {
    const c = capture()
    expect(await runCli(['frobnicate'], c.io)).toBe(2)
    expect(c.err()).toMatch(/unknown command/i)
  }, T)
})
