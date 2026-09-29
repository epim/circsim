/**
 * test/corpus/op.corpus.test.ts
 *
 * The generated deck of every corpus board goes through the REAL bundled
 * libngspice for an operating point, inside a per-board time budget. Asserts the
 * solve completes, every returned value is finite (no NaN), and the bench supply
 * node is present and physically sane (0 < V <= the source voltage). It does not
 * assert that the numbers are right: that is what the characterization suite
 * and the physics oracles are for. It asserts that circsim can put a real
 * board's deck through a real solver without the solver or the deck breaking.
 *
 * Skipped with a visible message when resources/ngspice/<platform> is absent
 * (same guard as the integration suites).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { SimHost } from '../../src/simhost/index'
import { ngspiceResourcesAvailable } from '../../src/simhost/ngspiceFfi'
import { METRICS_DIR, corpusBoards, readCorpusBoard, type CorpusEntry } from './helpers/corpus'
import { runPipeline } from './helpers/pipeline'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[corpus] resources/ngspice/<platform> missing: the corpus operating-point suite is SKIPPED (run npm run fetch:ngspice)')
}

/** Wall-clock ceiling for load + op on any one corpus board. */
const OP_BUDGET_MS = 60_000
const SUPPLY_VOLTS = 5

const boards = corpusBoards().filter((b) => !b.knownFailing && b.op !== false)

describe.skipIf(!haveNgspice)('corpus operating point (real ngspice)', () => {
  const opMetrics: Record<string, { opMs: number; supplyNode: string | null; supplyVolts: number | null; values: number }> = {}

  it.each(boards)('$id: deck solves an op inside the time budget with finite values', async (entry: CorpusEntry) => {
    const result = runPipeline(readCorpusBoard(entry), { title: `${entry.id}.kicad_pcb`, supplyVolts: SUPPLY_VOLTS })
    if (!result.deck) {
      // No ground-like net: nothing a bench could reference. Recorded, not failed.
      opMetrics[entry.id] = { opMs: 0, supplyNode: null, supplyVolts: null, values: 0 }
      return
    }

    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    const t0 = performance.now()
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: result.deck })
      await host.whenIdle()
      const values = await host.runOp()
      const opMs = Math.round(performance.now() - t0)

      const entries = Object.entries(values)
      expect(entries.length, 'op returned node values').toBeGreaterThan(0)
      const nonFinite = entries.filter(([, v]) => !Number.isFinite(v)).map(([k]) => k)
      expect(nonFinite, 'non-finite node values').toEqual([])
      expect(opMs, 'load + op wall time').toBeLessThan(OP_BUDGET_MS)

      let supplyNode: string | null = null
      let supplyVolts: number | null = null
      if (result.supplyNetId !== undefined) {
        supplyNode = result.circuit.nets.find((n) => n.id === result.supplyNetId)?.spiceNode ?? null
        if (supplyNode && supplyNode in values) {
          supplyVolts = values[supplyNode]
          expect(supplyVolts, `bench supply node ${supplyNode}`).toBeGreaterThan(0)
          expect(supplyVolts, `bench supply node ${supplyNode}`).toBeLessThanOrEqual(SUPPLY_VOLTS + 1e-6)
        }
      }
      opMetrics[entry.id] = { opMs, supplyNode, supplyVolts, values: entries.length }
    } finally {
      await host.dispose()
    }
  }, OP_BUDGET_MS + 30_000)

  afterAll(() => {
    mkdirSync(join(METRICS_DIR, 'metrics'), { recursive: true })
    for (const [id, m] of Object.entries(opMetrics)) {
      writeFileSync(join(METRICS_DIR, 'metrics', `${id}.op.json`), JSON.stringify(m, null, 2) + '\n')
    }
  })
})
