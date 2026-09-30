/**
 * test/corpus/synthetic.corpus.test.ts
 *
 * Checks the synthetic boards (scripts/gen-synthetic-board.mjs) against KiCad
 * itself. The committed fixtures under fixtures/synthetic are only trustworthy
 * because these tests prove, with kicad-cli, that
 *
 *   - every fixture is byte-identical to a regeneration (no hand edits);
 *   - KiCad loads it (all five syntax dialects, KiCad 6 to 10);
 *   - KiCad puts every pad at the position the generator claims (this is where
 *     the pad rotation convention is pinned to KiCad's, including rotated and
 *     back-side footprints) and on the net the generator assigned;
 *   - the routed board is fully connected in KiCad's own connectivity engine
 *     (kicad-cli pcb drc reports zero unconnected items).
 *
 * The KiCad-derived pad centres of the routed board are stored in
 * fixtures/synthetic/routed-rotated-kicad10.kicad-pads.json so the unit suites
 * (which run everywhere, without KiCad) can assert against KiCad's numbers.
 *
 * CIRCSIM_CORPUS_UPDATE_ORACLE=1 rewrites that JSON from live kicad-cli.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FIXTURES, generatePreset, padWorld, PRESETS } from '../../scripts/gen-synthetic-board.mjs'
import { exportIpc2581, findKicadCli, parseIpc2581Pads, runDrc } from './helpers/kicadOracle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const kicad = findKicadCli()
const updateGolden = process.env.CIRCSIM_CORPUS_UPDATE_ORACLE === '1'
const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'synthetic')

if (!kicad) {
  console.warn('[corpus] kicad-cli not found: the synthetic-board KiCad checks are SKIPPED (set CIRCSIM_KICAD_CLI)')
}

/** Write text to a scratch .kicad_pcb and return its path plus a cleanup. */
function scratchBoard(text: string): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'circsim-synth-'))
  const file = join(dir, 'board.kicad_pcb')
  writeFileSync(file, text)
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('synthetic fixtures are generator output', () => {
  it.each(FIXTURES)('%s', (file: string, preset: string, kicadMajor: number) => {
    // git may check the file out with CRLF on Windows; the content is what matters.
    const onDisk = readFileSync(join(FIXTURE_DIR, file), 'utf8').replace(/\r\n/g, '\n')
    expect(onDisk, `run: node scripts/gen-synthetic-board.mjs --write-fixtures`).toBe(generatePreset(preset, kicadMajor))
  })
})

describe.skipIf(!kicad)('KiCad agrees with the synthetic boards', () => {
  const cases: [string, string, number][] = [
    ...FIXTURES.map(([file, preset, k]): [string, string, number] => [file, preset, k]),
    ['lantern-shape (generated)', 'lantern-shape', 10]
  ]

  it.each(cases)('%s: KiCad loads it and places every pad where the generator says', (name: string, preset: string, kicadMajor: number) => {
    const spec = PRESETS[preset](kicadMajor)
    const { file, done } = scratchBoard(generatePreset(preset, kicadMajor))
    try {
      const oracle = parseIpc2581Pads(exportIpc2581(kicad!.path, file))
      let checked = 0
      for (const fp of spec.footprints) {
        for (const pad of fp.pads) {
          if (!pad.net) continue
          const key = `${fp.ref}\t${pad.num}`
          const o = oracle.get(key)
          expect(o, `KiCad has no pad ${fp.ref}.${pad.num} (${name})`).toBeDefined()
          expect(o!.net, `${fp.ref}.${pad.num} net`).toBe(pad.net)
          const w = padWorld(fp, pad)
          // IPC-2581 y is the negation of the .kicad_pcb y.
          expect(o!.x, `${fp.ref}.${pad.num} x`).toBeCloseTo(w.x, 3)
          expect(-o!.y, `${fp.ref}.${pad.num} y`).toBeCloseTo(w.y, 3)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(0)
    } finally {
      done()
    }
  }, 60_000)

  it('routed-rotated is fully connected in KiCad (zero unconnected items)', () => {
    const drc = runDrc(kicad!.path, join(FIXTURE_DIR, 'routed-rotated-kicad10.kicad_pcb'))
    expect(drc.unconnected, 'kicad-cli pcb drc unconnected items').toBe(0)
  }, 60_000)

  it('routed-rotated KiCad pad centres match the committed golden (rewrite with CIRCSIM_CORPUS_UPDATE_ORACLE=1)', () => {
    const boardFile = join(FIXTURE_DIR, 'routed-rotated-kicad10.kicad_pcb')
    const oracle = parseIpc2581Pads(exportIpc2581(kicad!.path, boardFile))
    const golden = [...oracle]
      .map(([key, p]) => {
        const [ref, pad] = key.split('\t')
        return { ref, pad, net: p.net, x: Math.round(p.x * 1e4) / 1e4, y: Math.round(-p.y * 1e4) / 1e4 }
      })
      .sort((a, b) => (a.ref + '\t' + a.pad).localeCompare(b.ref + '\t' + b.pad, undefined, { numeric: true }))
    const goldenFile = join(FIXTURE_DIR, 'routed-rotated-kicad10.kicad-pads.json')
    if (updateGolden || !existsSync(goldenFile)) {
      writeFileSync(goldenFile, JSON.stringify({ source: kicad!.version, unit: 'mm', pads: golden }, null, 2) + '\n')
    }
    const committed = JSON.parse(readFileSync(goldenFile, 'utf8')) as { pads: typeof golden }
    expect(committed.pads).toEqual(golden)
  }, 60_000)
})
