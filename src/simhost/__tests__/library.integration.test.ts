/**
 * src/simhost/__tests__/library.integration.test.ts
 *
 * Bundled model library integration test (Task 14a / Spec §8.5, §13).
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing.
 * Wired into `npm run test:integration`.
 *
 * For EACH .model card referenced by resources/models/index.json, builds a
 * minimal one-source bias deck that INSTANTIATES the device and inlines the card,
 * loads it, and runs an op. The card is considered "loads without error" when:
 *   - no `log` event with level 'error' was emitted (ngspice prints
 *     "Error: ..." / "circuit not parsed" on a bad/unknown model), and
 *   - the op produced finite node voltages.
 *
 * The integration also sanity-checks the device physics (diode conducts with a
 * forward drop in range; BJT/MOSFET switch) so a syntactically-valid but
 * electrically-dead card is caught.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS_DIR = join(process.cwd(), 'resources', 'models')

interface IndexEntry {
  id: string
  model: { type: string; file?: string; name: string }
}

/** Pull every `.model NAME TYPE(...)` (full card, continuation lines folded). */
function readCards(file: string): Map<string, { type: string; card: string }> {
  const text = readFileSync(join(MODELS_DIR, file), 'utf8')
  const joined = text.replace(/\r?\n\+/g, ' ')
  const out = new Map<string, { type: string; card: string }>()
  const re = /^\s*(\.model\s+(\S+)\s+(\w+)\s*\([^)]*\))/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(joined))) {
    out.set(m[2].toUpperCase(), { type: m[3].toUpperCase(), card: m[1].replace(/\s+/g, ' ').trim() })
  }
  return out
}

/** A one-source bias deck that instantiates the device and inlines its card. */
function biasDeck(name: string, type: string, card: string): string[] {
  switch (type) {
    case 'D':
      return [`* ${name}`, 'v1 a 0 dc 5', 'r1 a k 1k', `d1 k 0 ${name}`, card, '.op', '.end']
    case 'NPN':
      return [
        `* ${name}`,
        'vc c 0 dc 5',
        'vb b 0 dc 0.7',
        'rc c col 1k',
        `q1 col b 0 ${name}`,
        card,
        '.op',
        '.end'
      ]
    case 'PNP':
      return [
        `* ${name}`,
        'vc c 0 dc -5',
        'vb b 0 dc -0.7',
        'rc c col 1k',
        `q1 col b 0 ${name}`,
        card,
        '.op',
        '.end'
      ]
    case 'VDMOS':
      return [
        `* ${name}`,
        'vd d 0 dc 5',
        'vg g 0 dc 5',
        'rd d drn 100',
        `m1 drn g 0 0 ${name}`,
        card,
        '.op',
        '.end'
      ]
    default:
      return [`* ${name}`, card, '.op', '.end']
  }
}

/** Crude physics sanity check per device class. */
function physicsOk(type: string, v: Record<string, number>): boolean {
  if (type === 'D') {
    // anode=k, cathode=0; conducting → 0 < Vf < 5, current flowing.
    const vf = v['k']
    return Number.isFinite(vf) && vf > 0.05 && vf < 5
  }
  if (type === 'NPN') return Number.isFinite(v['col']) && v['col'] < 5 // pulled below rail = on
  if (type === 'PNP') return Number.isFinite(v['col']) && v['col'] > -5
  if (type === 'VDMOS') return Number.isFinite(v['drn']) && v['drn'] < 5 // some conduction
  return Object.values(v).some((x) => Number.isFinite(x))
}

const index: IndexEntry[] = haveNgspice
  ? (JSON.parse(readFileSync(join(MODELS_DIR, 'index.json'), 'utf8')).entries as IndexEntry[])
  : []

// Build the (id, file, name) list of model-card entries to exercise.
const cardEntries = index.filter((e) => e.model.type === 'model-card' && e.model.file)

describe.skipIf(!haveNgspice)('bundled model library loads in real ngspice', () => {
  it('exercises every model-card index entry', async () => {
    expect(cardEntries.length).toBeGreaterThanOrEqual(16)

    const cardCache = new Map<string, Map<string, { type: string; card: string }>>()
    const loaded: string[] = []
    const failures: string[] = []

    for (const entry of cardEntries) {
      const file = entry.model.file as string
      if (!cardCache.has(file)) cardCache.set(file, readCards(file))
      const found = cardCache.get(file)!.get(entry.model.name.toUpperCase())
      if (!found) {
        failures.push(`${entry.id}: model ${entry.model.name} not found in ${file}`)
        continue
      }

      const events: SimEvent[] = []
      const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
      try {
        await host.start()
        host.handleCommand({
          type: 'loadCircuit',
          deckLines: biasDeck(entry.model.name, found.type, found.card)
        })
        await host.whenIdle()
        const values = await host.runOp()

        const errs = (events.filter(
          (e) => e.type === 'log' && e.level === 'error'
        ) as Extract<SimEvent, { type: 'log' }>[]).map((e) => e.text)

        if (errs.length > 0) {
          failures.push(`${entry.id} (${entry.model.name}): error log [${errs.join(' | ')}]`)
        } else if (!physicsOk(found.type, values)) {
          failures.push(
            `${entry.id} (${entry.model.name}): physics check failed, values=${JSON.stringify(values)}`
          )
        } else {
          const detail =
            found.type === 'D'
              ? `Vf=${values['k'].toFixed(3)}V`
              : found.type === 'NPN' || found.type === 'PNP'
                ? `Vcol=${values['col'].toFixed(3)}V`
                : found.type === 'VDMOS'
                  ? `Vdrn=${values['drn'].toFixed(3)}V`
                  : 'ok'
          loaded.push(`${entry.id} (${entry.model.name}/${found.type}) ${detail}`)
        }
      } finally {
        host.dispose()
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n=== bundled model library: ${loaded.length} loaded OK ===\n` +
        loaded.join('\n') +
        (failures.length ? `\n--- FAILURES ---\n${failures.join('\n')}` : '') +
        '\n'
    )

    expect(failures, failures.join('\n')).toEqual([])
    expect(loaded.length).toBe(cardEntries.length)
  }, 120_000)
})
