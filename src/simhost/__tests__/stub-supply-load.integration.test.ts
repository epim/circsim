/**
 * src/simhost/__tests__/stub-supply-load.integration.test.ts
 *
 * Issue #29: a controller, addressable LED or USB-serial bridge that the stub
 * rules recognize is a supply load in the real deck, not an unmodeled hole. The
 * synthetic lantern-class board (lantern-shape plus the target-board parts) goes
 * through parse, extract, resolve, deck and the real ngspice, with the bench
 * supply on +5V. The ESP32, STM32 and RP2040 loads sit on +3V3 behind the
 * AP2112K LDO, so the 5 V supply must carry them too.
 *
 * Skipped with a visible message when resources/ngspice/<platform> is missing.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../core/kicad/board'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import { extract, suggestGround } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { lanternClassBoardText } from '../../core/models/__tests__/lanternClassBoard'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[stub-supply-load] resources/ngspice/<platform> missing: the stub deck test is SKIPPED (run npm run fetch:ngspice)')
}

const MODELS = join(process.cwd(), 'resources', 'models')

function build() {
  const board = parseBoard(lanternClassBoardText())
  const library = (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')) as { entries: LibraryEntry[] }).entries
  const modelTexts: Record<string, string> = {}
  for (const f of readdirSync(MODELS)) {
    if (f === 'index.json') continue
    if (f.endsWith('.lib') || f.endsWith('.json')) modelTexts[f] = readFileSync(join(MODELS, f), 'utf8')
  }
  const gnd = suggestGround(extract(board).nets)
  if (!gnd) throw new Error('no ground suggested')
  const circuit = extract(board, { groundNetId: gnd.id })
  const resolutions = resolveAll(circuit, undefined, undefined, library)
  const net = (name: string) => {
    const n = circuit.nets.find((x) => x.kicadName === name)
    if (!n) throw new Error(`net ${name} not found`)
    return n
  }
  return { circuit, resolutions, modelTexts, gndId: gnd.id, net }
}

async function runOp(deck: string[]): Promise<{ v: Record<string, number>; errors: string[] }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const v = await host.runOp()
    const errors = events
      .filter((e): e is Extract<SimEvent, { type: 'log' }> => e.type === 'log' && e.level === 'error')
      .map((e) => e.text)
    return { v, errors }
  } finally {
    await host.dispose()
  }
}

describe.skipIf(!haveNgspice)('supply-load stubs in the real deck (issue #29)', () => {
  const b = build()
  const supplyOhms = 0.1
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: b.gndId },
    { kind: 'dc-supply', id: 'bench', netId: b.net('+5V').id, volts: 5, seriesOhms: supplyOhms },
    // The Li-ion pack on the TP4056 BAT pin, as the bench would stand in for it.
    { kind: 'dc-supply', id: 'pack', netId: b.net('/VBAT').id, volts: 3.7, seriesOhms: 0.1 },
  ]
  const deck = generateDeck({
    circuit: b.circuit,
    resolutions: b.resolutions,
    instruments,
    groundNetId: b.gndId,
    title: 'lantern-class.kicad_pcb',
    modelTexts: b.modelTexts,
  })

  it('instantiates every stub with its own subcircuit and inlines stubs.lib', () => {
    for (const ref of ['U20', 'U21', 'U22', 'U23', 'U24', 'D20', 'D21', 'D22']) {
      expect(deck.some((l) => l.toLowerCase().startsWith(`x_${ref.toLowerCase()} `)), `${ref} instance`).toBe(true)
    }
    expect(deck.some((l) => /^\.subckt\s+sup_load\b/i.test(l))).toBe(true)
    expect(deck.some((l) => /^\.subckt\s+MCU_STUB_ESP32\b/i.test(l))).toBe(true)
  })

  it('solves in ngspice with no error, the 3.3 V rail up behind the LDO', async () => {
    const r = await runOp(deck)
    expect(r.errors).toEqual([])
    const v33 = r.v[b.net('+3V3').spiceNode.toLowerCase()]
    expect(v33).toBeGreaterThan(3.2)
    expect(v33).toBeLessThan(3.35)
  }, 60_000)

  it('the 5 V bench supply carries exactly the stub loads: removing the stubs lifts the rail by their current times its series resistance', async () => {
    const STUBS = ['U20', 'U21', 'U22', 'U23', 'U24', 'D20', 'D21', 'D22']
    const withoutStubs = generateDeck({
      circuit: b.circuit,
      resolutions: b.resolutions.map((r) =>
        STUBS.includes(r.ref) ? { ref: r.ref, status: 'unresolved' as const, tier: 6 as const, warnings: [] } : r,
      ),
      instruments,
      groundNetId: b.gndId,
      title: 'lantern-class.kicad_pcb (stubs removed)',
      modelTexts: b.modelTexts,
    })
    const [on, off] = [await runOp(deck), await runOp(withoutStubs)]
    expect(on.errors).toEqual([])
    expect(off.errors).toEqual([])
    const node = b.net('+5V').spiceNode.toLowerCase()
    const drawn = (off.v[node] - on.v[node]) / supplyOhms
    // ESP32 100 mA + STM32F1 36 mA + RP2040 25 mA on 3V3 (through the LDO), plus
    // ATmega 10 mA, CH340 12 mA and three WS2812B at 1 mA on 5 V: 186 mA.
    expect(drawn).toBeGreaterThan(0.186 * 0.97)
    expect(drawn).toBeLessThan(0.186 * 1.03)
  }, 60_000)
})
