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

// ─── M12: dangling comparator-input net (sense-only subckt terminal) ──────────

describe.skipIf(!haveNgspice)('M12 — dangling comparator-input net in real ngspice', () => {
  /**
   * Fixture: one LM339 (real bundled opamp.lib LM339_QUAD) with unit-3's
   * + input (pad 9) on a net touched by NOTHING else. A comparator input is
   * sense-only (it appears only inside the behavioral-source expression), so
   * the net's MNA row is empty — the same structural singularity as M8's
   * dangling R pair. Pre-M12 the x-card blanket union faked a ground path for
   * it and the bleed was skipped.
   */
  function makeDanglingInputDeck(): string[] {
    const nets: CircuitNet[] = [
      { id: 1, kicadName: 'C1P', spiceNode: 'c1p', padRefs: [] },
      { id: 2, kicadName: 'C1N', spiceNode: 'c1n', padRefs: [] },
      { id: 3, kicadName: 'O1', spiceNode: 'o1', padRefs: [] },
      { id: 4, kicadName: 'C2P', spiceNode: 'c2p', padRefs: [] },
      { id: 5, kicadName: 'C2N', spiceNode: 'c2n', padRefs: [] },
      { id: 6, kicadName: 'O2', spiceNode: 'o2', padRefs: [] },
      { id: 7, kicadName: 'DANGLE', spiceNode: 'dangle', padRefs: [] },
      { id: 8, kicadName: 'C3N', spiceNode: 'c3n', padRefs: [] },
      { id: 9, kicadName: 'O3', spiceNode: 'o3', padRefs: [] },
      { id: 10, kicadName: 'C4P', spiceNode: 'c4p', padRefs: [] },
      { id: 11, kicadName: 'C4N', spiceNode: 'c4n', padRefs: [] },
      { id: 12, kicadName: 'O4', spiceNode: 'o4', padRefs: [] },
      { id: 13, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
      { id: 14, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ]
    const u1: Part = {
      ref: 'U1', value: 'LM339', libId: 'Package_SO:SOP-14_3.9x8.7mm_P1.27mm', layer: 'F',
      padNet: new Map([
        ['1', 6], ['2', 3], ['3', 13], ['4', 2], ['5', 1], ['6', 5], ['7', 4],
        ['8', 8], ['9', 7], ['10', 11], ['11', 10], ['12', 14], ['13', 12], ['14', 9],
      ]),
      properties: {},
    }
    // Bias every OTHER input through a real resistor; pull every output up.
    const biasCards: Array<[string, string]> = [
      ['R1', 'r_r1 c1p 0 100000'], ['R2', 'r_r2 c1n 0 100000'],
      ['R3', 'r_r3 c2p 0 100000'], ['R4', 'r_r4 c2n 0 100000'],
      ['R5', 'r_r5 c3n 0 100000'],
      ['R6', 'r_r6 c4p 0 100000'], ['R7', 'r_r7 c4n 0 100000'],
      ['R8', 'r_r8 vcc o1 10000'], ['R9', 'r_r9 vcc o2 10000'],
      ['R10', 'r_r10 vcc o3 10000'], ['R11', 'r_r11 vcc o4 10000'],
    ]
    const parts: Part[] = [
      u1,
      ...biasCards.map(([ref]): Part => ({
        ref, value: '10k', libId: 'R', layer: 'F', padNet: new Map(), properties: {},
      })),
    ]
    const resolutions: Resolution[] = [
      {
        ref: 'U1', status: 'ok', tier: 3, warnings: [],
        model: {
          kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM339_QUAD',
          pinMap: {
            '1': 'out2', '2': 'out1', '3': 'vcc', '4': 'in1n', '5': 'in1p',
            '6': 'in2n', '7': 'in2p', '8': 'in3n', '9': 'in3p', '10': 'in4n',
            '11': 'in4p', '12': 'vee', '13': 'out4', '14': 'out3',
          },
        },
      },
      ...biasCards.map(([ref, card]): Resolution => ({
        ref, status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card },
      })),
    ]
    const instruments: Instrument[] = [
      { kind: 'ground-ref', netId: 14 },
      { kind: 'dc-supply', id: '1', netId: 13, volts: 5, seriesOhms: 0.1 },
    ]
    return generateDeck({
      circuit: { nets, parts, warnings: [] },
      resolutions,
      instruments,
      groundNetId: 14,
      title: 'm12-dangling-comparator-input',
      modelTexts: { 'opamp.lib': readFileSync(join(MODELS, 'opamp.lib'), 'utf8') },
    })
  }

  it('the dangling input net is bled, the fresh tran-uic completes — and aborts with the bleed stripped (control)', async () => {
    const deck = makeDanglingInputDeck()

    // The generator detected the sense-only island and bled exactly it.
    const bleeds = deck.filter((l) => l.startsWith('r_float_'))
    expect(bleeds).toEqual(['r_float_1 dangle 0 1e9'])

    // Control: the SAME deck minus the bleed is structurally singular — the
    // fresh tran-uic (the app flow) aborts on the first step with zero rows.
    const unfixed = deck.filter(
      (l) => !l.startsWith('r_float_') && !l.startsWith('* floating-island')
    )
    const broken = await runFreshTranUic(unfixed, '1e-6', '1e-4')
    expect(broken.rows).toBe(0)

    // With the bleed the identical analysis completes with data.
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

  it('the generated deck bleeds the remaining stranded nets — the R38/R39 islands now ride x_u5 (M11)', () => {
    const deck = buildLanternDeck()
    const bleedNodes = deck
      .filter((l) => l.startsWith('r_float_'))
      .map((l) => l.split(/\s+/)[1])
    // The original M8 diagnosis found the r_r38 {_led3_k,_gauge_c3} and r_r39
    // {_led4_k,_gauge_c4} pairs stranded — but that was an artifact of the
    // single-unit LM339 map: /GAUGE_C3 and /GAUGE_C4 are U5 comparator OUTPUTS
    // (pads 14/13). With all four units wired (M11) those nets join the
    // grounded component through the x_u5 card and must NOT be bled any more.
    for (const node of ['_led3_k', '_gauge_c3', '_led4_k', '_gauge_c4']) {
      expect(bleedNodes, `no bleed for ${node} (attached via x_u5 since M11)`).not.toContain(node)
    }
    // Island detection itself stays live: the headers-only variant still has
    // genuinely stranded nets (off-board LED1 string, unwired logic outputs).
    for (const node of ['_led1_k', '_led1_drive']) {
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
    // U7 (CD40106, Schmitt) expands to the self-referential hysteresis B-source
    // at the 12 V family constant: mid=6.0, V_T+=7.2, V_T-=4.8, rail=12.0
    // (the node-independent tail is asserted; board nets are not pinned here).
    expect(text).toContain('b_u7_1 ')
    expect(text).toContain('> 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')
    // U8 (CD4011, plain NAND) keeps the adc/dac path at the 12 V constant.
    expect(text).toContain('.model dacm_u8 dac_bridge(out_low=0 out_high=12.0000)')
    // No part on this board qualifies for supply-derived vHigh.
    expect(text).not.toContain('vhigh:')
  })

  it('M11: U5 (LM339) resolves to the LM339_QUAD wrapper with all four units wired (14 nodes on x_u5)', () => {
    const setup = loadLantern()
    const u5 = setup.resolutions.find((r) => r.ref === 'U5')
    expect(u5, 'U5 must have a resolution').toBeDefined()
    expect(u5!.status).toBe('ok')
    expect(u5!.model?.kind).toBe('subckt')
    if (u5!.model?.kind === 'subckt') {
      expect(u5!.model.subcktName).toBe('LM339_QUAD')
    }
    const deck = makeLanternDeck(setup, setup.suggestedSupplyId)
    const xLine = deck.find((l) => l.startsWith('x_u5'))
    expect(xLine, 'deck must carry an x_u5 card').toBeDefined()
    // x_u5 <14 node tokens> LM339_QUAD — all four units wired to board nets
    // (pre-M11 the LM393 single-unit map produced only 5 nodes here). Specific
    // net names are deliberately NOT asserted.
    const tokens = xLine!.trim().split(/\s+/)
    expect(tokens[tokens.length - 1]).toBe('LM339_QUAD')
    expect(tokens.length - 2, `x_u5 node count (card: ${xLine})`).toBe(14)
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
