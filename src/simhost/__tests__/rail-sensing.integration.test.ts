/**
 * src/simhost/__tests__/rail-sensing.integration.test.ts
 *
 * Op-informed rail-sensing proof against REAL bundled ngspice-46 (koffi 3.1.1).
 *
 * Exercises the CORE pipeline (`generateDeck` + `deriveMeasuredRailVHigh` from
 * src/core/spicegen/generate.ts) end-to-end for a CD40106 whose VDD sits on a
 * SWITCHED/DERIVED rail (`/VGATED`) — a resistor divider from a 12 V bench
 * supply that biases `/VGATED` to a deterministic ~5 V at the operating point.
 * The chip has NO direct bench supply on its VDD net, so tier-1 cannot own it;
 * the family default is 12 V. This is the exact gap tier-3 (op-measured rail)
 * closes.
 *
 * Runs the real libngspice via koffi against the bundled resources for this
 * platform; skipped automatically when resources/ngspice/<platform> is missing.
 *
 * Three cases (the plan's Task 8):
 *   1. Two-pass derives the measured swing — pass-1 deck uses the 12 V family
 *      default; a REAL op measures ~5 V on `/VGATED`; deriveMeasuredRailVHigh
 *      returns that rail; regenerating with it swaps the B-source to the 5 V
 *      swing (2.5/3.0/2.0 thresholds, 5.0 rail) and drops the 12 V default.
 *   2. Gated-off — the divider top driven to ~0 → `/VGATED` ≈ 0 V at the op →
 *      the rail is withheld (kept out of `rails`) and named in `gatedOff`; the
 *      pass-1 (12 V default) deck is what a caller keeps.
 *   3. Manual override pins the voltage — a tier-2 railOverride of 3.3 V beats
 *      even a conflicting tier-3 measuredRailVHigh of 5 V; the deck uses the
 *      3.3 V swing (1.65/1.98/1.32 thresholds, 3.3 rail) though the op measures 5.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { deriveMeasuredRailVHigh, generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS = join(process.cwd(), 'resources', 'models')
const LOGIC4000 = haveNgspice ? readFileSync(join(MODELS, 'logic4000.json'), 'utf8') : ''

// ─── real-ngspice op harness (copied from library-ic.integration.test.ts) ──────

async function runOp(deck: string[]): Promise<{ errs: string[]; v: Record<string, number> }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const v = await host.runOp()
    const errs = (events.filter((e) => e.type === 'log' && e.level === 'error') as Extract<
      SimEvent,
      { type: 'log' }
    >[]).map((e) => e.text)
    return { errs, v }
  } finally {
    await host.dispose()
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

    // Pass 1: no measuredRailVHigh → the CD40106 uses the 12 V family default.
    const pass1 = generateDeck({
      circuit, resolutions, instruments, groundNetId,
      title: 'rail-sensing-pass1', modelTexts,
    })
    const pass1Text = pass1.join('\n')
    // Pass-1 carries the 12 V family-default swing (mid 6.0 / V_T+ 7.2 / rail 12).
    expect(pass1Text).toContain('(v(out) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')

    // Run the REAL op and read the divider-biased /VGATED node voltage.
    const r = await runOp(pass1)
    // eslint-disable-next-line no-console
    console.log(`\n[rail-sensing pass1] v(/VGATED)=${r.v['vgated']?.toFixed(4)}V (expect ~5) errs=[${r.errs.join('|')}]\n`)
    expect(r.errs).toEqual([])
    expect(r.v['vgated']).toBeCloseTo(5, 1)

    // Tier-3 sensing derives the measured rail on the VDD net.
    const { rails, gatedOff } = deriveMeasuredRailVHigh({
      opValues: r.v, circuit, resolutions, instruments, groundNetId, modelTexts,
    })
    expect(rails.get(vgatedNetId)).toBeCloseTo(5, 1)
    expect(gatedOff).toEqual([])

    // Pass 2: regenerate with the measured rail → the B-source now carries the
    // 5 V-derived swing (mid 2.5 / V_T+ 3.0 / V_T- 2.0 / rail 5.0), NOT 12 V.
    const pass2 = generateDeck({
      circuit, resolutions, instruments, groundNetId,
      title: 'rail-sensing-pass2', modelTexts, measuredRailVHigh: rails,
    })
    const pass2Text = pass2.join('\n')
    expect(pass2Text).toContain('(v(out) > 2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000')
    expect(pass2Text).not.toContain('12.0000')
    // Provenance names the tier (the raw vHigh is the un-rounded ~4.99996 V op).
    expect(pass2Text).toContain('(op-measured rail; family default 12)')

    // The regenerated deck also solves in real ngspice.
    const r2 = await runOp(pass2)
    expect(r2.errs).toEqual([])
  }, 90_000)

  it('gated-off rail (~0 V) keeps the family default and reports gatedOff', async () => {
    // Drive the divider top to ~0 (0 V bench supply) → /VGATED collapses to ~0.
    const { circuit, resolutions, instruments, groundNetId, vgatedNetId } = buildFixture(0)

    // Pass-1 deck a caller would keep: still the 12 V family default swing.
    const pass1 = generateDeck({
      circuit, resolutions, instruments, groundNetId,
      title: 'rail-sensing-gatedoff', modelTexts,
    })
    expect(pass1.join('\n')).toContain('(v(out) > 6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')

    const r = await runOp(pass1)
    // eslint-disable-next-line no-console
    console.log(`\n[rail-sensing gated-off] v(/VGATED)=${r.v['vgated']?.toFixed(4)}V (expect ~0) errs=[${r.errs.join('|')}]\n`)
    expect(r.errs).toEqual([])
    expect(r.v['vgated']).toBeLessThan(2)

    const { rails, gatedOff } = deriveMeasuredRailVHigh({
      opValues: r.v, circuit, resolutions, instruments, groundNetId, modelTexts,
    })
    // Below the floor → withheld from rails, surfaced as gated-off naming the chip.
    expect(rails.has(vgatedNetId)).toBe(false)
    expect(gatedOff).toEqual([{ ref: 'U1', netId: vgatedNetId, kicadName: '/VGATED' }])
  }, 90_000)

  it('a manual override pins the voltage regardless of the measured op', async () => {
    // Full 12 V supply → the op still measures ~5 V on /VGATED, but a tier-2
    // override of 3.3 V (with a CONFLICTING tier-3 measured 5 V) must win.
    const { circuit, resolutions, instruments, groundNetId, vgatedNetId } = buildFixture(12)

    const deck = generateDeck({
      circuit, resolutions, instruments, groundNetId,
      title: 'rail-sensing-override', modelTexts,
      railOverrides: new Map([[vgatedNetId, 3.3]]),
      measuredRailVHigh: new Map([[vgatedNetId, 5]]),
    })
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
