/**
 * test/corpus/padpos.corpus.test.ts
 *
 * Pad centres against KiCad on every corpus board (issues #3, #22, #48).
 *
 * `padWorldPos` (src/core/critic/geom.ts) is what the Board Critic uses to place
 * every pad. KiCad computes the same positions and exports them in IPC-2581
 * (kicad-cli pcb export ipc2581), including for rotated and back-side footprints,
 * so this is an independent oracle for the transform rather than a check of the
 * renderer against itself.
 *
 * Issue #3 (padWorldPos rotated with the wrong handedness) is fixed, so this is
 * an ordinary test: the geometry oracle for the fix on real boards.
 *
 * Needs kicad-cli (skipped with a visible warning otherwise). The pad positions
 * are not committed because they derive from third-party boards.
 */

import { describe, expect, it } from 'vitest'

import { corpusFile } from '../../scripts/fetch-corpus.mjs'
import { parseBoard } from '../../src/core/kicad/board'
import { padWorldPos } from '../../src/core/critic/geom'
import { corpusBoards, readCorpusBoard } from './helpers/corpus'
import { ambiguousRefPredicate, findKicadCli, oraclePadsCached } from './helpers/kicadOracle'

const kicad = findKicadCli()
if (!kicad) console.warn('[corpus] kicad-cli not found: the pad-centre oracle suite is SKIPPED (set CIRCSIM_KICAD_CLI)')

const TOL_MM = 0.01
const boards = corpusBoards().filter((b) => !b.knownFailing)

describe.skipIf(!kicad)('corpus pad centres equal KiCad', () => {
  // One test over the whole corpus: a board whose rotations happen to be
  // symmetric (0 or 180 degrees) agrees under both conventions, so the defect is
  // only visible in aggregate.
  it(
    'padWorldPos matches KiCad for every uniquely named pad on every corpus board',
    () => {
      const off: string[] = []
      let compared = 0
      for (const entry of boards) {
        const board = parseBoard(readCorpusBoard(entry))
        const oracle = oraclePadsCached(kicad!, corpusFile(entry), entry.sha256)
        const ambiguous = ambiguousRefPredicate(board.footprints.map((f) => f.ref))
        for (const fp of board.footprints) {
          if (ambiguous(fp.ref)) continue
          const counts = new Map<string, number>()
          for (const p of fp.pads) counts.set(p.number, (counts.get(p.number) ?? 0) + 1)
          for (const pad of fp.pads) {
            if (counts.get(pad.number) !== 1) continue // repeated numbers: IPC keeps one of several, cannot pair them
            const o = oracle.get(`${fp.ref}\t${pad.number}`)
            if (!o) continue
            compared++
            const w = padWorldPos(fp, pad)
            // KiCad exports the DRILL centre for through-hole pads, which differs from
            // the pad centre when the drill has an (offset ...) (0.4 mm on the TO-92
            // transistors of complex_hierarchy). Allow up to half the pad size there:
            // the handedness defect moves pads by a pitch, far more than that.
            const tol = pad.type === 'smd' ? TOL_MM : Math.max(TOL_MM, Math.max(pad.size.w, pad.size.h) / 2)
            if (Math.hypot(w.x - o.x, w.y - -o.y) > tol) off.push(`${entry.id}:${fp.ref}.${pad.number}`)
          }
        }
      }
      expect(compared, 'pads compared').toBeGreaterThan(1000)
      expect(off.slice(0, 10), `${off.length} of ${compared} pads differ from KiCad by more than the tolerance`).toEqual([])
    },
    600_000
  )
})
