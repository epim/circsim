/**
 * src/cli/__tests__/cli.test.ts
 *
 * The headless CLI without ngspice (issue #28): the model-library loader, the
 * static-only audit, the pass-1 deck, and the input-error paths and exit codes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildCriticOpFromSolve } from '../criticOp'
import { loadModelLibrary, resolveModelsDir } from '../modelLibrary'
import { runCli, type CliIo } from '../main'
import type { SolveResult } from '../../core/solve'

const FIXTURES = join(process.cwd(), 'fixtures')
const BOARD = join(FIXTURES, 'fixture-555.kicad_pcb')

const tmp = mkdtempSync(join(tmpdir(), 'circsim-cli-unit-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function capture(env: NodeJS.ProcessEnv = {}): { io: CliIo; out: () => string; err: () => string } {
  let out = ''
  let err = ''
  return {
    io: { stdout: (s) => (out += s), stderr: (s) => (err += s), env, cwd: process.cwd() },
    out: () => out,
    err: () => err,
  }
}

describe('model library loader', () => {
  it('loads the bundled index and every file its entries reference', () => {
    const lib = loadModelLibrary(resolveModelsDir(undefined, {}, __dirname))
    expect(lib.entries.length).toBeGreaterThan(10)
    const files = new Set(lib.entries.map((e) => e.model.file).filter((f): f is string => !!f))
    for (const f of files) expect(lib.texts[f], f).toBeTypeOf('string')
  })

  it('honors CIRCSIM_MODELS_DIR over the package default', () => {
    expect(resolveModelsDir(undefined, { CIRCSIM_MODELS_DIR: 'X' }, __dirname)).toBe('X')
    expect(resolveModelsDir('Y', { CIRCSIM_MODELS_DIR: 'X' }, __dirname)).toBe('Y')
  })

  it('fails loudly on a missing or malformed index instead of auditing with no library', () => {
    expect(() => loadModelLibrary(join(tmp, 'nope'))).toThrow(/cannot read model library index/)
    writeFileSync(join(tmp, 'index.json'), '{not json', 'utf8')
    expect(() => loadModelLibrary(tmp)).toThrow(/not valid JSON/)
  })
})

describe('buildCriticOpFromSolve', () => {
  it('keys voltages by spice node and omits an empty current map', () => {
    const circuit = {
      parts: [],
      nets: [
        { id: 1, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
        { id: 2, kicadName: 'GND', spiceNode: '0', padRefs: [] },
      ],
    }
    const solved = {
      netVoltages: new Map([
        [1, 5],
        [2, 0],
      ]),
      op: { values: { vcc: 5 } },
    } as unknown as SolveResult
    const op = buildCriticOpFromSolve(circuit as never, [], solved)
    expect(op).toEqual({ nodeVoltages: { vcc: 5, '0': 0 }, partCurrents: undefined })
  })

  it('returns undefined when nothing was solved', () => {
    const solved = { netVoltages: new Map(), op: { values: {} } } as unknown as SolveResult
    expect(buildCriticOpFromSolve({ parts: [], nets: [] } as never, [], solved)).toBeUndefined()
  })
})

describe('circsim CLI without ngspice', () => {
  it('audit --no-op runs only the static checks and skips the sim-dependent ones', async () => {
    const c = capture()
    const code = await runCli(['audit', BOARD, '--no-op', '--json'], c.io)
    const report = JSON.parse(c.out())
    expect(report.solve.ran).toBe(false)
    expect(report.critic.ranBy).not.toContain('ir-drop')
    expect(report.critic.skipped.map((s: { check: string }) => s.check)).toContain('ir-drop')
    // Static error findings still gate: the fixture has a clearance error.
    expect(code).toBe(report.critic.summary.error > 0 ? 1 : 0)
    expect(report.exitCode).toBe(code)
  })

  it('audit reports a missing ngspice as exit 3 with the static report, not a clean pass', async () => {
    const c = capture()
    const code = await runCli(['audit', BOARD, '--json', '--ngspice-dir', join(tmp, 'no-ngspice')], c.io)
    const report = JSON.parse(c.out())
    expect(report.solve.ran).toBe(false)
    expect(report.solve.reason).toMatch(/ngspice library not found/)
    expect(code).toBe(report.critic.summary.error > 0 ? 1 : 3)
  })

  it('deck --pass1-only writes the family-default deck without ngspice', async () => {
    const dir = join(tmp, 'deck')
    const c = capture()
    const code = await runCli(['deck', BOARD, '--schematic', '--pass1-only', '--out', dir], c.io)
    expect(code).toBe(0)
    const deck = readFileSync(join(dir, 'fixture-555.pass1.cir'), 'utf8')
    expect(deck).toContain('NE555')
    expect(deck).toMatch(/\.end/i)
  })

  it('--supply overrides the default 5 V supply in the deck', async () => {
    const dir = join(tmp, 'deck12')
    const c = capture()
    const code = await runCli(['deck', BOARD, '--pass1-only', '--supply', 'VCC=12', '--out', dir], c.io)
    expect(code).toBe(0)
    expect(readFileSync(join(dir, 'fixture-555.pass1.cir'), 'utf8')).toMatch(/vpsu_cli_supply_1 \S+ 0 DC 12/)
  })

  it('exits 2 for a missing board, an unparseable board, and unknown nets', async () => {
    let c = capture()
    expect(await runCli(['op', join(tmp, 'missing.kicad_pcb')], c.io)).toBe(2)
    expect(c.err()).toMatch(/cannot read board/)

    const bad = join(tmp, 'bad.kicad_pcb')
    writeFileSync(bad, '(kicad_pcb (version 1', 'utf8')
    c = capture()
    expect(await runCli(['op', bad], c.io)).toBe(2)
    expect(c.err()).toMatch(/cannot parse/)

    c = capture()
    expect(await runCli(['op', BOARD, '--ground', 'NOSUCHNET'], c.io)).toBe(2)
    expect(c.err()).toMatch(/--ground NOSUCHNET: no such net/)

    c = capture()
    expect(await runCli(['op', BOARD, '--supply', 'GND=5'], c.io)).toBe(2)
    expect(c.err()).toMatch(/ground net/)

    c = capture()
    expect(await runCli(['op', BOARD, '--schematic', join(tmp, 'x.kicad_sch')], c.io)).toBe(2)
    expect(c.err()).toMatch(/schematic not found/)
  })

  it('op on a board with nothing to solve exits 2 and says why', async () => {
    const empty = join(tmp, 'empty.kicad_pcb')
    writeFileSync(empty, '(kicad_pcb (version 20221018) (generator pcbnew))', 'utf8')
    const c = capture()
    expect(await runCli(['op', empty], c.io)).toBe(2)
    expect(c.err()).toMatch(/no ground net found/)
  })

  it('prints help and version', async () => {
    let c = capture()
    expect(await runCli(['--help'], c.io)).toBe(0)
    expect(c.out()).toMatch(/circsim audit <board/)
    c = capture()
    expect(await runCli(['--version'], c.io)).toBe(0)
    expect(c.out().trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('never writes next to or over the board file', async () => {
    const before = readFileSync(BOARD, 'utf8')
    const c = capture()
    await runCli(['audit', BOARD, '--no-op'], c.io)
    expect(readFileSync(BOARD, 'utf8')).toBe(before)
  })
})
