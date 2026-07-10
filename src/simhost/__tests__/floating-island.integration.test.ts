/**
 * src/simhost/__tests__/floating-island.integration.test.ts — M8
 *
 * Floating-island bleed resistors against the REAL bundled libngspice.
 *
 * A deck whose element cards form a conductive island with no path of any kind
 * to node 0 has a structurally singular MNA matrix: a FRESH `tran … uic` (the
 * app's exact flow — loadCircuit re-sources the deck, uic skips the operating
 * point) hits a zero pivot on the first step and aborts "Timestep too small"
 * with 0 data rows, blaming an arbitrary device. generateDeck now detects such
 * islands via union-find over the emitted element cards and bleeds every island
 * net to ground through 1 GΩ (`r_float_<i>`), which makes the same transient
 * run to completion.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing (same
 * guard as library-ic.integration.test.ts). The real-board section additionally
 * skips when the lantern board file is absent on this machine.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBoard } from '../../core/kicad/board'
import { parseSchematicSimData } from '../../core/kicad/schematic'
import { resolveAll } from '../../core/models/resolve'
import type { LibraryEntry } from '../../core/models/types'
import type { Resolution } from '../../core/models/types'
import { extract, suggestGround, suggestSupplies } from '../../core/netlist/extract'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

// Real routed board from the diagnosis (headers-only lantern variant). The test
// skips when the file is not present on this machine.
const LANTERN_BOARD = 'C:\\Users\\bear\\lantern\\hardware\\Routed\\revb-handtuned-complete\\led_lantern-revb-headers-only-handtuned.kicad_pcb'
const LANTERN_SCH = 'C:\\Users\\bear\\lantern\\hardware\\led_lantern.kicad_sch'
const MODELS = join(process.cwd(), 'resources', 'models')

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Load a deck into a FRESH SimHost circuit and run `tran <tstep> <tstop> uic`
 * — the exact app flow that aborts on a singular deck. Returns the number of
 * time rows and any error-level log lines.
 */
async function runFreshTranUic(
  deck: string[],
  tstep: string,
  tstop: string
): Promise<{ rows: number; errs: string[] }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (host as any).engine
    await engine.command(`tran ${tstep} ${tstop} uic`, true)
    const plot = engine.currentPlot()
    let rows = 0
    for (const name of engine.allVectors(plot)) {
      if (name.toLowerCase() === 'time') {
        const d = engine.vectorData(name)
        rows = d ? d.length : 0
      }
    }
    const errs = (events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
      SimEvent,
      { type: 'log' }
    >[]).map((e) => e.text)
    return { rows, errs }
  } finally {
    await host.dispose()
  }
}

/**
 * Fixture: a grounded divider under a 5 V supply, plus a dangling R pair whose
 * two nets have no path of any kind to node 0 (the lantern r_r38 shape).
 */
function makeIslandFixture(): { circuit: Circuit; resolutions: Resolution[]; instruments: Instrument[] } {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: 2, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    { id: 3, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    { id: 4, kicadName: '/LED3_K', spiceNode: '_led3_k', padRefs: [] },
    { id: 5, kicadName: '/GAUGE_C3', spiceNode: '_gauge_c3', padRefs: [] },
  ]
  const parts: Part[] = [
    { ref: 'R1', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
    { ref: 'R2', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 2], ['2', 3]]), properties: {} },
    { ref: 'R38', value: '2.2k', libId: 'R', layer: 'F', padNet: new Map([['1', 4], ['2', 5]]), properties: {} },
  ]
  const circuit: Circuit = { nets, parts, warnings: [] }
  const resolutions: Resolution[] = [
    { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 vin out 10000' } },
    { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 out 0 10000' } },
    { ref: 'R38', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r38 _led3_k _gauge_c3 2200' } },
  ]
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: 3 },
    { kind: 'dc-supply', id: '1', netId: 1, volts: 5, seriesOhms: 0.1 },
  ]
  return { circuit, resolutions, instruments }
}

// ─── generated island deck vs real ngspice ────────────────────────────────────

describe.skipIf(!haveNgspice)('M8 — floating-island bleeds in real ngspice', () => {
  it('a deck with a floating island runs a fresh tran-uic AFTER generation (and aborts with the bleeds stripped)', async () => {
    const { circuit, resolutions, instruments } = makeIslandFixture()
    const deck = generateDeck({ circuit, resolutions, instruments, groundNetId: 3, title: 'island-fixture' })

    // The generator emitted per-net bleeds for the island.
    const bleeds = deck.filter((l) => l.startsWith('r_float_'))
    expect(bleeds).toEqual(['r_float_1 _led3_k 0 1e9', 'r_float_2 _gauge_c3 0 1e9'])

    // Control: the SAME deck minus the bleeds is structurally singular — the
    // fresh tran-uic aborts on the first step with zero data rows.
    const unfixed = deck.filter(
      (l) => !l.startsWith('r_float_') && !l.startsWith('* floating-island')
    )
    const broken = await runFreshTranUic(unfixed, '1e-6', '1e-4')
    expect(broken.rows).toBe(0)

    // With the bleeds the identical analysis completes with data.
    const fixed = await runFreshTranUic(deck, '1e-6', '1e-4')
    expect(fixed.errs).toEqual([])
    expect(fixed.rows).toBeGreaterThan(0)
  }, 60_000)
})

// ─── real lantern board (headers-only variant) ────────────────────────────────

const haveLantern = haveNgspice && existsSync(LANTERN_BOARD)

describe.skipIf(!haveLantern)('M8 — real lantern board (headers-only) deck conditioning', () => {
  /** Parsed lantern board + resolutions + model texts, without instruments. */
  interface LanternSetup {
    circuit: Circuit
    resolutions: Resolution[]
    modelTexts: Record<string, string>
    gndId: number
    /** suggestSupplies' top non-ground pick (the M8 tests' historic supply). */
    suggestedSupplyId: number
  }

  function loadLantern(): LanternSetup {
    const board = parseBoard(readFileSync(LANTERN_BOARD, 'utf8'))
    const schData = existsSync(LANTERN_SCH)
      ? parseSchematicSimData(readFileSync(LANTERN_SCH, 'utf8'))
      : undefined

    const library = (JSON.parse(readFileSync(join(MODELS, 'index.json'), 'utf8')) as {
      entries: LibraryEntry[]
    }).entries
    const modelTexts: Record<string, string> = {}
    for (const f of readdirSync(MODELS)) {
      if (f === 'index.json') continue
      if (f.endsWith('.lib') || f.endsWith('.json')) {
        modelTexts[f] = readFileSync(join(MODELS, f), 'utf8')
      }
    }

    const probe = extract(board)
    const gnd = suggestGround(probe.nets)
    if (!gnd) throw new Error('no ground suggested for lantern board')
    const circuit = extract(board, { groundNetId: gnd.id })
    const supply = suggestSupplies(probe.nets).find((s) => s.id !== gnd.id)
    if (!supply) throw new Error('no supply suggested for lantern board')

    const resolutions = resolveAll(circuit, schData, undefined, library)
    return { circuit, resolutions, modelTexts, gndId: gnd.id, suggestedSupplyId: supply.id }
  }

  function makeLanternDeck(setup: LanternSetup, supplyNetId: number): string[] {
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: setup.gndId },
      { kind: 'dc-supply', id: 'auto-supply', netId: supplyNetId, volts: 5, seriesOhms: 0.1 },
    ]
    return generateDeck({
      circuit: setup.circuit,
      resolutions: setup.resolutions,
      instruments,
      groundNetId: setup.gndId,
      title: 'led_lantern-revb-headers-only-handtuned.kicad_pcb',
      modelTexts: setup.modelTexts,
    })
  }

  function buildLanternDeck(): string[] {
    const setup = loadLantern()
    return makeLanternDeck(setup, setup.suggestedSupplyId)
  }

  it('the generated deck bleeds the two stranded R38/R39 islands (per net)', () => {
    const deck = buildLanternDeck()
    const bleedNodes = deck
      .filter((l) => l.startsWith('r_float_'))
      .map((l) => l.split(/\s+/)[1])
    // The diagnosis found exactly two conductive islands, stranded by the
    // off-board LED strings: {_led3_k,_gauge_c3} (r_r38) and {_led4_k,_gauge_c4}
    // (r_r39). Every net of both islands must be bled.
    for (const node of ['_led3_k', '_gauge_c3', '_led4_k', '_gauge_c4']) {
      expect(bleedNodes, `bleed for ${node}`).toContain(node)
    }
    expect(deck).toContain('* floating-island bleed resistors (no DC path to ground)')
  })

  it('M10: the CD4000 parts keep the 12 V family default — their VDD rides /VGATED, not the bench-supplied /PACK+ net', () => {
    // Investigated on the routed board: U7 (CD40106) and U8 (CD4011) both have
    // pad 14 (VDD) on /VGATED — the switched logic rail behind the high-side
    // gate — while the bench dc-supply belongs on the pack rail. The M10 rule
    // is DIRECT net attachment only (no tracing through the pass switch), so
    // neither part derives a supply vHigh and both stay at the documented 12 V
    // family constant.
    //
    // The supply net is pinned BY NAME (/PACK+), never via the suggestSupplies
    // ranking: a future ranking reorder must not silently move the bench supply
    // onto a different rail and turn into a phantom M10 regression here.
    const setup = loadLantern()
    const pack = setup.circuit.nets.find((n) => n.kicadName === '/PACK+')
    expect(pack, 'lantern board must carry a /PACK+ net (deterministic bench-supply target)').toBeDefined()
    const vgated = setup.circuit.nets.find((n) => n.kicadName === '/VGATED')
    expect(vgated, 'lantern board must carry /VGATED (the CD4000 VDD rail)').toBeDefined()

    // Preconditions that make the 12 V assertion meaningful: both CD4000 parts
    // really do have their VDD pad (14) on /VGATED, and the chosen supply net
    // is NOT that rail.
    const u7 = setup.circuit.parts.find((p) => p.ref === 'U7')
    const u8 = setup.circuit.parts.find((p) => p.ref === 'U8')
    expect(u7, 'U7 (CD40106) must exist on the lantern board').toBeDefined()
    expect(u8, 'U8 (CD4011) must exist on the lantern board').toBeDefined()
    expect(u7!.padNet.get('14'), 'U7 VDD pad net').toBe(vgated!.id)
    expect(u8!.padNet.get('14'), 'U8 VDD pad net').toBe(vgated!.id)
    expect(pack!.id, 'supply net must differ from the CD4000 VDD rail').not.toBe(vgated!.id)

    const deck = makeLanternDeck(setup, pack!.id)
    const text = deck.join('\n')
    expect(text).toContain('.model dacm_u7 dac_bridge(out_low=0 out_high=12.0000)')
    expect(text).toContain('.model dacm_u8 dac_bridge(out_low=0 out_high=12.0000)')
    // No part on this board qualifies for supply-derived vHigh.
    expect(text).not.toContain('vhigh:')
  })

  it('the full-board fresh tran-uic (the app flow that used to abort) produces data rows', async () => {
    const deck = buildLanternDeck()
    // Same analysis the diagnosis validated: tran 1e-5 1e-2 uic on a freshly
    // sourced circuit (2,651 rows on the fixed deck; 0 rows / "Timestep too
    // small" abort without the bleeds).
    const { rows } = await runFreshTranUic(deck, '1e-5', '1e-2')
    expect(rows).toBeGreaterThan(0)
  }, 300_000)
})
