import { describe, expect, it } from 'vitest'

import { parseArgs, type CliOptions } from '../args'

function run(argv: string[]): CliOptions {
  const p = parseArgs(argv)
  if (p.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(p)}`)
  return p.options
}

function err(argv: string[]): string {
  const p = parseArgs(argv)
  if (p.kind !== 'error') throw new Error(`expected error, got ${p.kind}`)
  return p.message
}

describe('parseArgs', () => {
  it('parses audit with --schematic and --json', () => {
    const o = run(['audit', 'b.kicad_pcb', '--schematic', '--json'])
    expect(o.command).toBe('audit')
    expect(o.board).toBe('b.kicad_pcb')
    expect(o.schematic).toEqual({})
    expect(o.json).toBe(true)
  })

  it('takes an explicit schematic path as --schematic=PATH or --schematic PATH.kicad_sch', () => {
    expect(run(['op', 'b.kicad_pcb', '--schematic=x/s.kicad_sch']).schematic).toEqual({ path: 'x/s.kicad_sch' })
    expect(run(['op', '--schematic', 's.kicad_sch', 'b.kicad_pcb']).schematic).toEqual({ path: 's.kicad_sch' })
  })

  it('does not swallow the board path after a bare --schematic', () => {
    const o = run(['audit', '--schematic', 'b.kicad_pcb'])
    expect(o.schematic).toEqual({})
    expect(o.board).toBe('b.kicad_pcb')
  })

  it('collects repeated --supply flags', () => {
    const o = run(['op', 'b.kicad_pcb', '--supply', 'VCC=3.3', '--supply=/Power/VIN=12'])
    expect(o.supplies).toEqual([
      { net: 'VCC', volts: 3.3 },
      { net: '/Power/VIN', volts: 12 },
    ])
  })

  it('rejects a malformed --supply', () => {
    expect(err(['op', 'b.kicad_pcb', '--supply', 'VCC'])).toMatch(/NET=VOLTS/)
    expect(err(['op', 'b.kicad_pcb', '--supply', 'VCC=abc'])).toMatch(/nonzero number/)
  })

  it('rejects flags that do not apply to the command', () => {
    expect(err(['op', 'b.kicad_pcb', '--out', 'd'])).toMatch(/does not apply/)
    expect(err(['deck', 'b.kicad_pcb', '--no-op'])).toMatch(/does not apply/)
  })

  it('rejects unknown commands, unknown options, and a missing or extra board', () => {
    expect(err(['frob', 'b.kicad_pcb'])).toMatch(/unknown command/)
    expect(err(['audit', 'b.kicad_pcb', '--wat'])).toMatch(/unknown option/)
    expect(err(['audit'])).toMatch(/needs a board/)
    expect(err(['audit', 'a.kicad_pcb', 'b.kicad_pcb'])).toMatch(/one board/)
    expect(err([])).toMatch(/missing command/)
  })

  it('rejects --supply together with --no-op', () => {
    expect(err(['audit', 'b.kicad_pcb', '--no-op', '--supply', 'VCC=5'])).toMatch(/no effect/)
  })

  it('answers help and version', () => {
    expect(parseArgs(['--help']).kind).toBe('help')
    expect(parseArgs(['audit', '-h']).kind).toBe('help')
    expect(parseArgs(['--version']).kind).toBe('version')
  })

  it('parses deck options', () => {
    const o = run(['deck', 'b.kicad_pcb', '--out', 'dir', '--pass1-only', '--ngspice-dir=n', '--models-dir', 'm'])
    expect(o.outDir).toBe('dir')
    expect(o.pass1Only).toBe(true)
    expect(o.ngspiceDir).toBe('n')
    expect(o.modelsDir).toBe('m')
  })
})
