/**
 * src/cli/__tests__/cli.integration.test.ts
 *
 * The headless CLI (issue #28) end to end against real ngspice and the 555
 * fixture: `audit`, `deck` and `op` run through runCli with captured output.
 * Skipped when the bundled ngspice resources for this platform are missing.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
    // The supplied fixture is unrouted. A physical audit must name its missing
    // contacts rather than passing ideal connectivity off as routed copper.
    const irDrop = report.critic.skipped.find((s: { check: string }) => s.check === 'ir-drop')
    expect(report.critic.ranBy).not.toContain('ir-drop')
    expect(irDrop?.reason).toContain('no modelled copper touches pads')
    expect(irDrop?.reason).not.toContain('ideal-net')
    expect(report.critic.findings.some((f: { id: string }) => f.id.startsWith('floating:copper-gap:'))).toBe(true)
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
    expect(op.copper).toBeUndefined()
  }, T)

  it('op --copper exposes per-pad readings and routing gaps', async () => {
    const c = capture()
    expect(await runCli(['op', BOARD, '--schematic', '--copper', '--json'], c.io)).toBe(0)
    const op = JSON.parse(c.out())
    expect(op.copper.padVoltages).toBeDefined()
    expect(op.copper.unreachedPads.length).toBeGreaterThan(0)
  }, T)

  it('audit assesses copper checks on a routed divider and meters resistor power', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circsim-cli-copper-'))
    tmpDirs.push(dir)
    const board = join(dir, 'divider.kicad_pcb')
    const rc = readFileSync(join(process.cwd(), 'fixtures', 'fixture-rc.kicad_pcb'), 'utf8')
    writeFileSync(board, rc.replace(/\)\s*$/, `
      (segment (start 5 10) (end 9.0875 10) (width 0.5) (layer "F.Cu") (net 1))
      (segment (start 20.9125 10) (end 25 10) (width 0.5) (layer "F.Cu") (net 3))
    )`))
    const c = capture()
    await runCli(['audit', board, '--supply', 'VIN=5', '--json'], c.io)
    const report = JSON.parse(c.out())
    expect(report.solve.ran).toBe(true)
    expect(report.critic.ranBy).toEqual(expect.arrayContaining(['ampacity', 'ir-drop', 'thermal']))
    expect(report.critic.findings.filter((f: { id: string }) => f.id.startsWith('floating:copper-gap:'))).toEqual([])
    const op = capture()
    expect(await runCli(['op', board, '--supply', 'VIN=5', '--copper', '--json'], op.io)).toBe(0)
    const result = JSON.parse(op.out())
    expect(result.copper.unreachedPads).toEqual([])
    expect(result.copper.padVoltages.R1['1']).toBeCloseTo(5, 3)
    expect(result.copper.padVoltages.R2['1']).toBeCloseTo(2.5, 3)
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
