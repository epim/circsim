import { describe, it, expect } from 'vitest'
import {
  buildDiagnosticsFiles,
  bundleFileName,
  kicadFileVersion,
  sha256Hex,
  type DiagnosticsInput,
} from '../diagnostics'

function input(over: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    generatedAt: '2026-09-30T12:00:00.000Z',
    board: {
      fileName: 'blinker.kicad_pcb',
      schematicFileName: null,
      sha256: 'ab'.repeat(32),
      kicadFileVersion: 20240108,
    },
    versions: { app: '0.2.9', ngspice: 'ngspice-46' },
    crash: { willRespawn: true, exitCode: 86, reason: 'watchdog', at: Date.UTC(2026, 8, 30, 12, 0, 0) },
    decks: {
      pass1: ['* title', 'r_r1 a 0 1k', '.end'],
      pass2: ['* title', 'r_r1 a 0 2k', '.end'],
      pass2Status: 'solved',
      run: null,
    },
    op: { values: { a: 1.5 }, method: 'gmin' },
    resolutions: [
      { ref: 'R1', status: 'ok', tier: 1, warnings: [], model: { kind: 'primitive', card: 'r_r1 a 0 1k' } },
      { ref: 'U1', status: 'unresolved', tier: 6, warnings: ['no model'] },
    ],
    instruments: [{ kind: 'ground-ref', netId: 1 }],
    log: [
      { level: 'info', text: 'loaded' },
      { level: 'error', text: 'singular matrix' },
    ],
    ...over,
  }
}

const byName = (files: { name: string; text: string }[], name: string): string => {
  const f = files.find(x => x.name === name)
  if (!f) throw new Error(`missing ${name}`)
  return f.text
}

describe('buildDiagnosticsFiles', () => {
  it('carries the decks, log, board hash, crash reason and versions', () => {
    const files = buildDiagnosticsFiles(input())
    expect(files.map(f => f.name)).toEqual([
      'README.txt',
      'manifest.json',
      'decks/pass1.cir',
      'decks/pass2.cir',
      'ngspice.log',
      'op.json',
      'resolutions.json',
      'instruments.json',
    ])
    expect(byName(files, 'decks/pass1.cir')).toBe('* title\nr_r1 a 0 1k\n.end\n')
    expect(byName(files, 'decks/pass2.cir')).toContain('2k')
    expect(byName(files, 'ngspice.log')).toBe('[info] loaded\n[error] singular matrix\n')

    const manifest = JSON.parse(byName(files, 'manifest.json'))
    expect(manifest.app).toBe('0.2.9')
    expect(manifest.ngspice).toBe('ngspice-46')
    expect(manifest.board.sha256).toBe('ab'.repeat(32))
    expect(manifest.board.kicadFileVersion).toBe(20240108)
    expect(manifest.crash).toMatchObject({ exitCode: 86, reason: 'watchdog', willRespawn: true })
    expect(manifest.crash.at).toBe('2026-09-30T12:00:00.000Z')
    expect(manifest.decks.pass2Status).toBe('solved')
    expect(manifest.opMethod).toBe('gmin')

    expect(JSON.parse(byName(files, 'op.json'))).toEqual({ values: { a: 1.5 }, method: 'gmin' })
    const res = JSON.parse(byName(files, 'resolutions.json'))
    expect(res[0]).toMatchObject({ ref: 'R1', tier: 1, model: { kind: 'primitive' } })
    expect(res[1]).toMatchObject({ ref: 'U1', status: 'unresolved', warnings: ['no model'] })
  })

  it('omits decks that do not exist and reports direct when no method is set', () => {
    const files = buildDiagnosticsFiles(
      input({
        crash: null,
        decks: { pass1: null, pass2: null, pass2Status: null, run: ['* run', '.end'] },
        op: { values: {} },
      }),
    )
    const names = files.map(f => f.name)
    expect(names).not.toContain('decks/pass1.cir')
    expect(names).toContain('decks/run.cir')
    const manifest = JSON.parse(byName(files, 'manifest.json'))
    expect(manifest.crash).toBeNull()
    expect(manifest.opMethod).toBe('direct')
  })

  it('still produces a valid bundle with nothing solved yet', () => {
    const files = buildDiagnosticsFiles(
      input({
        crash: null,
        decks: { pass1: null, pass2: null, pass2Status: null, run: null },
        op: null,
        log: [],
        resolutions: [],
        instruments: [],
      }),
    )
    expect(byName(files, 'ngspice.log')).toBe('')
    expect(JSON.parse(byName(files, 'op.json'))).toBeNull()
    expect(JSON.parse(byName(files, 'manifest.json')).opMethod).toBeNull()
  })

  it('never includes board text, only its hash', () => {
    const files = buildDiagnosticsFiles(input())
    expect(files.some(f => f.name.endsWith('.kicad_pcb'))).toBe(false)
  })
})

describe('kicadFileVersion', () => {
  it('reads the header stamp', () => {
    expect(kicadFileVersion('(kicad_pcb\n  (version 20240108)\n  (generator "pcbnew")')).toBe(20240108)
  })
  it('is null when absent or no board', () => {
    expect(kicadFileVersion('(kicad_pcb)')).toBeNull()
    expect(kicadFileVersion(null)).toBeNull()
  })
})

describe('sha256Hex', () => {
  it('matches the known vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('bundleFileName', () => {
  it('uses the board stem and a timestamp', () => {
    const name = bundleFileName('blinker 555.kicad_pcb', new Date(2026, 8, 30, 16, 57, 3))
    expect(name).toBe('circsim-diagnostics-blinker-555-20260930-165703.zip')
  })
  it('handles no board', () => {
    expect(bundleFileName(null, new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'circsim-diagnostics-no-board-20260102-030405.zip',
    )
  })
})
