/**
 * test/corpus/private.corpus.test.ts
 *
 * Private-board regression suite, keyed on CIRCSIM_PRIVATE_BOARDS_DIR (issue #23).
 *
 * The maintainer's own designs (the routed 130-part led_lantern rev B and
 * friends) cannot be committed, and they cannot be fetched. Point this variable
 * at a directory of .kicad_pcb files (each optionally next to a .kicad_sch of the
 * same name for tier-1 Sim.* fields) and every board goes through the same
 * pipeline as the public corpus: parse, extract, resolve, deck without NaN, and
 * pad-to-net equality against kicad-cli when kicad-cli is installed.
 *
 *   CIRCSIM_PRIVATE_BOARDS_DIR=C:\path\to\boards npm run test:corpus
 *
 * Unset: the suite is SKIPPED and says so in the log. Set to a missing or empty
 * directory: a test FAILS, so a misconfigured run never looks green. The
 * real-lantern deck invariants (M8, M10, M11) live in
 * src/simhost/__tests__/floating-island.integration.test.ts behind the same
 * variable.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { circsimPadNets, diffConnectivity, NO_DIFF, oraclePadNets } from './helpers/connectivity'
import { exportIpc2581, findKicadCli, parseIpc2581Pads } from './helpers/kicadOracle'
import { findBadDeckLine, readIfExists, runPipeline } from './helpers/pipeline'

const dir = process.env.CIRCSIM_PRIVATE_BOARDS_DIR
const kicad = findKicadCli()

if (dir === undefined) {
  console.warn(
    '[private-boards] CIRCSIM_PRIVATE_BOARDS_DIR is not set: private-board regression tests are SKIPPED on this machine.'
  )
}

describe.skipIf(dir === undefined)('private boards (CIRCSIM_PRIVATE_BOARDS_DIR)', () => {
  const boards =
    dir !== undefined && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.kicad_pcb')).sort() : []

  it('the directory exists and holds at least one .kicad_pcb', () => {
    expect(existsSync(dir!), `CIRCSIM_PRIVATE_BOARDS_DIR="${dir}" does not exist`).toBe(true)
    expect(boards.length, `no .kicad_pcb files in ${dir}`).toBeGreaterThan(0)
  })

  it.each(boards)('%s: pipeline, deck and KiCad connectivity', (name: string) => {
    const file = join(dir!, name)
    const schematicText = readIfExists(join(dir!, name.replace(/\.kicad_pcb$/, '.kicad_sch')))
    const result = runPipeline(readFileSync(file, 'utf8'), { title: name, schematicText })
    expect(result.board.footprints.length).toBeGreaterThan(0)
    if (result.deck) expect(findBadDeckLine(result.deck)).toBeUndefined()

    if (kicad) {
      // exportIpc2581 works on a scratch copy: the private directory is never written to.
      const oracle = oraclePadNets(result.board, parseIpc2581Pads(exportIpc2581(kicad.path, file)))
      expect(diffConnectivity(circsimPadNets(result.board), oracle), `pad-to-net mismatch vs ${kicad.version}`).toEqual(NO_DIFF)
    }
  })
})
