/**
 * src/simhost/__tests__/rail-sensing.integration.test.ts
 *
 * Op-informed rail-sensing proof against REAL bundled ngspice-46.
 *
 * Runs the production two-pass plan (`runSolvePlan` from src/core/solve) through
 * the in-process SolveEngine (src/simhost/solveEngine.ts) for a CD40106 whose
 * VDD sits on a SWITCHED/DERIVED rail (`/VGATED`): a resistor divider from a
 * 12 V bench supply that biases `/VGATED` to a deterministic ~5 V at the
 * operating point. The chip has NO direct bench supply on its VDD net, so tier-1
 * cannot own it; the family default is 12 V. This is the exact gap tier-3
 * (op-measured rail) closes. Before issue #53 this file re-implemented the loop
 * by hand because the orchestration was reachable only through the renderer
 * store; it now runs the same code the store runs.
 *
 * Runs the real libngspice via koffi against the bundled resources for this
 * platform; skipped automatically when resources/ngspice/<platform> is missing.
 *
 * Three cases (the plan's Task 8):
 *   1. Two-pass derives the measured swing: the pass-1 deck uses the 12 V family
 *      default; a REAL op measures ~5 V on `/VGATED`; the plan senses that rail,
 *      regenerates the deck with the 5 V swing (2.5/3.0/2.0 thresholds, 5.0
 *      rail), drops the 12 V default, and re-solves once in real ngspice.
 *   2. Gated-off: the divider top driven to ~0 leaves `/VGATED` at ~0 V, so the
 *      rail is withheld (kept out of `measuredRails`), named in `gatedOff`, and
 *      the pass-1 (12 V default) deck is the one the result reports.
 *   3. Manual override pins the voltage: a tier-2 railOverride of 3.3 V beats
 *      even a conflicting tier-3 measured rail of 5 V; the deck uses the 3.3 V
 *      swing (1.65/1.98/1.32 thresholds, 3.3 rail) though the op measures 5.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import type { Instrument } from '../../core/spicegen/instruments'
import {
  buildDeck,
  buildSolveInputs,
  runSolvePlan,
  type SolveInputs,
  type SolveResult,
} from '../../core/solve'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'
import { createInProcessSolveEngine } from '../solveEngine'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS = join(process.cwd(), 'resources', 'models')
const LOGIC4000 = haveNgspice ? readFileSync(join(MODELS, 'logic4000.json'), 'utf8') : ''

// ─── real-ngspice harness ─────────────────────────────────────────────────────

/** Collects ngspice error lines from the in-process engine's event stream. */
function errorSink(): { errs: string[]; onEvent: (e: SimEvent) => void } {
  const errs: string[] = []
  return {
    errs,
    onEvent: (e) => {
      if (e.type === 'log' && e.level === 'error') errs.push(e.text)
    },
  }
}

/** Run the production solve plan through the in-process engine. */
async function solve(inputs: SolveInputs): Promise<{ errs: string[]; result: SolveResult }> {
  const sink = errorSink()
  const engine = await createInProcessSolveEngine({ onEvent: sink.onEvent })
  try {
    return { errs: sink.errs, result: await runSolvePlan(inputs, engine) }
  } finally {
    await engine.dispose()
  }
}

/** Load one deck and run one op through the in-process engine. */
async function runOp(deck: string[]): Promise<{ errs: string[]; v: Record<string, number> }> {
  const sink = errorSink()
  const engine = await createInProcessSolveEngine({ onEvent: sink.onEvent })
  try {
    await engine.loadCircuit(deck)
    const { values } = await engine.runOp()
    return { errs: sink.errs, v: values }
  } finally {
    await engine.dispose()
  }
}

// ─── fixture: CD40106 with VDD on a divider-derived /VGATED rail ────────────────

/**
 * A CD40106 (hex inverting Schmitt) whose VDD pad (14) lands on `/VGATED`
 * (net 2). `/VGATED` is the mid-point of a resistor divider from a `supplyV`
 * bench supply on `VIN` (net 1): R1 = 7 kΩ (VIN→/VGATED) over R2 = 5 kΩ
 * (/VGATED→GND). At `supplyV = 12` that biases `/VGATED` to 12·5k/12k = 5.0 V —
 * a NON-12 V rail with no direct supply, so pass-1 falls back to the 12 V family
 * default and only a measured op reveals the real 5 V swing. Input 1A (net 3) is
 * pulled to ground through R3 (100 kΩ) so the op is a clean static point; output
 * 1Y is net 4. VSS (pad 7) is grounded.
 *
 * The digital expansion's Schmitt B-source does NOT load `/VGATED` (it is a
 * behavioral source on the 1Y node that only READS v(1A)/v(1Y)), so the divider
 * alone sets the rail voltage — deterministic and independent of the derived
 * swing used for the thresholds.
 */
function buildFixture(supplyV: number): {
  circuit: Circuit
  resolutions: Resolution[]
  instruments: Instrument[]
  groundNetId: number
  vgatedNetId: number
} {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VIN', spiceNode: 'vin', padRefs: [] },
    { id: 2, kicadName: '/VGATED', spiceNode: 'vgated', padRefs: [] },
    { id: 3, kicadName: 'IN', spiceNode: 'in', padRefs: [] },
    { id: 4, kicadName: 'OUT', spiceNode: 'out', padRefs: [] },
    { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
  ]
  const parts: Part[] = [
    {
      ref: 'U1', value: 'CD40106', libId: 'Logic:CD40106', layer: 'F',
      // 1A→IN(3), 1Y→OUT(4), GND→GND(5), VCC→/VGATED(2)
      padNet: new Map([['1', 3], ['2', 4], ['7', 5], ['14', 2]]),
      properties: {},
    },
    { ref: 'R1', value: '7k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
    { ref: 'R2', value: '5k', libId: 'R', layer: 'F', padNet: new Map([['1', 2], ['2', 5]]), properties: {} },
    { ref: 'R3', value: '100k', libId: 'R', layer: 'F', padNet: new Map([['1', 3], ['2', 5]]), properties: {} },
  ]
  const circuit: Circuit = { nets, parts, warnings: [] }
  const resolutions: Resolution[] = [
    {
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'xspice-digital', templateId: 'CD40106',
        pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' },
      },
    },
    { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 vin vgated 7000' } },
    { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 vgated 0 5000' } },
    { ref: 'R3', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r3 in 0 100000' } },
  ]
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: 5 },
    { kind: 'dc-supply', id: 'bench', netId: 1, volts: supplyV, seriesOhms: 0.1 },
  ]
  return { circuit, resolutions, instruments, groundNetId: 5, vgatedNetId: 2 }
}

const modelTexts = { 'logic4000.json': LOGIC4000 }

// ─── tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!haveNgspice)('op-informed rail sensing (real ngspice)', () => {
  it('two-pass derives the measured 5 V swing where a single pass used 12 V', async () => {
    const { circuit, resolutions, instruments, groundNetId, vgatedNetId } = buildFixture(12)
    const inputs = buildSolveInputs(null, circuit, resolutions, instruments, groundNetId, {
      title: 'rail-sensing', modelTexts,
    })

    const { errs, result } = await solve(inputs)
    // eslint-disable-next-line no-console
    console.log(`\n[rail-sensing] pass1 v(/VGATED)=${result.measuredRails.get(vgatedNetId)?.toFixed(4)}V (expect ~5) pass2=${result.pass2} errs=[${errs.join('|')}]\n`)
    expect(errs).toEqual([])

    // Pass 1: no measured rail yet, so the CD40106 used the 12 V family default
    // swing (mid 6.0 / V_T+ 7.2 / rail 12).
    expect(result.pass1Deck.join('\n')).toContain('(v(out) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')

    // Tier-3 sensing read the divider-biased rail off the REAL pass-1 op.
    expect(result.measuredRails.get(vgatedNetId)).toBeCloseTo(5, 1)
    expect(result.gatedOff).toEqual([])

    // Pass 2 ran on the 5 V-derived swing (mid 2.5 / V_T+ 3.0 / V_T- 2.0 / rail
    // 5.0), NOT 12 V, and its op is the one the result commits.
    expect(result.pass2).toBe('solved')
    expect(result.deck).toBe(result.pass2Deck)
    const pass2Text = result.deck.join('\n')
    expect(pass2Text).toContain('(v(out) > 2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000')
    expect(pass2Text).not.toContain('12.0000')
    // Provenance names the tier (the raw vHigh is the un-rounded ~4.99996 V op).
    expect(pass2Text).toContain('(op-measured rail; family default 12)')
    // The pass-2 op still measures the divider's ~5 V, now mapped onto the net.
    expect(result.netVoltages.get(vgatedNetId)).toBeCloseTo(5, 1)
  }, 90_000)

  it('gated-off rail (~0 V) keeps the family default and reports gatedOff', async () => {
    // Drive the divider top to ~0 (0 V bench supply) → /VGATED collapses to ~0.
    const { circuit, resolutions, instruments, groundNetId, vgatedNetId } = buildFixture(0)
    const inputs = buildSolveInputs(null, circuit, resolutions, instruments, groundNetId, {
      title: 'rail-sensing-gatedoff', modelTexts,
    })

    const { errs, result } = await solve(inputs)
    // eslint-disable-next-line no-console
    console.log(`\n[rail-sensing gated-off] v(/VGATED)=${result.netVoltages.get(vgatedNetId)?.toFixed(4)}V (expect ~0) errs=[${errs.join('|')}]\n`)
    expect(errs).toEqual([])
    expect(result.netVoltages.get(vgatedNetId)).toBeLessThan(2)

    // Below the floor → withheld from rails, surfaced as gated-off naming the chip,
    // and no second pass: the kept deck is the 12 V family-default one.
    expect(result.measuredRails.has(vgatedNetId)).toBe(false)
    expect(result.gatedOff).toEqual([{ ref: 'U1', netId: vgatedNetId, kicadName: '/VGATED' }])
    expect(result.pass2).toBe('not-needed')
    expect(result.deck.join('\n')).toContain('(v(out) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')
  }, 90_000)

  it('an input that reaches only the chip is reported undriven, not silently 0 V (issue #43)', async () => {
    // Remove R3: IN (1A) now touches only U1's sense-only input. The deck bleeds
    // it to ground so the matrix solves, and the solve must say so.
    const f = buildFixture(12)
    const resolutions = f.resolutions.filter(r => r.ref !== 'R3')
    const circuit: Circuit = { ...f.circuit, parts: f.circuit.parts.filter(p => p.ref !== 'R3') }
    const inputs = buildSolveInputs(null, circuit, resolutions, f.instruments, f.groundNetId, {
      title: 'rail-sensing-undriven', modelTexts,
    })

    const { errs, result } = await solve(inputs)
    expect(errs).toEqual([])
    // The op reads IN as a tidy 0 V and the chip output as a confident level...
    expect(result.op.values.in).toBeCloseTo(0, 3)
    // ...and the solve names IN as undriven. OUT is driven by the gate and the
    // rail nets by the supply, so only IN is listed.
    expect(result.undrivenNets).toEqual([{ netId: 3, kicadName: 'IN', spiceNode: 'in' }])
    expect(result.deck.join('\n')).toContain('r_float_1 in 0 1e9')
  }, 90_000)

  it('a manual override pins the voltage regardless of the measured op', async () => {
    // Full 12 V supply → the op still measures ~5 V on /VGATED, but a tier-2
    // override of 3.3 V (with a CONFLICTING tier-3 measured 5 V) must win.
    const { circuit, resolutions, instruments, groundNetId, vgatedNetId } = buildFixture(12)

    const deck = buildDeck(
      buildSolveInputs(null, circuit, resolutions, instruments, groundNetId, {
        title: 'rail-sensing-override', modelTexts,
        railOverrides: new Map([['/VGATED', 3.3]]),
        measuredRails: new Map([[vgatedNetId, 5]]),
      }),
    )
    const text = deck.join('\n')
    // 3.3 V swing: mid 1.65 / V_T+ 1.98 / V_T- 1.32 / rail 3.3 — tier-2 beats tier-3.
    expect(text).toContain('(v(out) > 1.6500 ? 1.9800 : 1.3200)) ? 0 : 3.3000')
    expect(text).not.toContain(': 5.0000')
    expect(text).not.toContain('12.0000')
    expect(text).toContain('* U1 vhigh: 3.3 (user rail override; family default 12)')

    // Live op: the divider still biases /VGATED to ~5, proving the pinned 3.3 V
    // deck swing is decoupled from what the rail actually measures.
    const r = await runOp(deck)
    // eslint-disable-next-line no-console
    console.log(`\n[rail-sensing override] deck swing=3.3V, measured v(/VGATED)=${r.v['vgated']?.toFixed(4)}V (expect ~5) errs=[${r.errs.join('|')}]\n`)
    expect(r.errs).toEqual([])
    expect(r.v['vgated']).toBeCloseTo(5, 1)
  }, 90_000)
})
