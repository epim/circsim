/**
 * src/simhost/__tests__/floating-supply-pin.integration.test.ts (issue #131)
 *
 * A floating negative supply pin is reported as undriven, against REAL
 * bundled ngspice-46.
 *
 * The op-amp macromodels carry behavioral supply-current sources (bsrc, biq)
 * between VCC and VEE (issue #2). Those are pure current sources, not DC paths,
 * so an LM358 whose V- pin sits on its own unconnected net must not be welded
 * to the driven VCC island through them: the deck bleeds the pin to ground and
 * the solve names it in `undrivenNets`. A V- tied to ground stays driven and
 * reports nothing.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import type { Instrument } from '../../core/spicegen/instruments'
import { buildSolveInputs, runSolvePlan, type SolveResult } from '../../core/solve'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'
import { createInProcessSolveEngine } from '../solveEngine'

const haveNgspice = ngspiceResourcesAvailable()
const OPAMP_LIB = haveNgspice
  ? readFileSync(join(process.cwd(), 'resources', 'models', 'opamp.lib'), 'utf8')
  : ''

/**
 * An LM358 unity-gain follower biased from a 5 V bench supply: V+ (pad 8) on
 * VCC, IN+ (pad 3) on a 10k/10k divider, OUT and IN- (pads 1, 2) on BUF. V-
 * (pad 4) is on GND, or, with `floatVee`, alone on its own KiCad
 * `unconnected-(U1-V-)` net. With `loadBuf`, a 10k resistor loads BUF to GND, so
 * the output has a DC path of its own.
 */
function buildFixture(floatVee: boolean, loadBuf = false): {
  circuit: Circuit
  resolutions: Resolution[]
  instruments: Instrument[]
  groundNetId: number
  veeNetId: number
  bufNetId: number
} {
  const nets: CircuitNet[] = [
    { id: 1, kicadName: 'VCC', spiceNode: 'vcc', padRefs: [] },
    { id: 2, kicadName: 'PLUS', spiceNode: 'plus', padRefs: [] },
    { id: 3, kicadName: 'BUF', spiceNode: 'buf', padRefs: [] },
    { id: 4, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    { id: 5, kicadName: 'unconnected-(U1-V-)', spiceNode: 'unconn_vee', padRefs: [] },
  ]
  const parts: Part[] = [
    {
      ref: 'U1', value: 'LM358', libId: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', layer: 'F',
      padNet: new Map([['1', 3], ['2', 3], ['3', 2], ['4', floatVee ? 5 : 4], ['8', 1]]),
      properties: {},
    },
    { ref: 'R1', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 1], ['2', 2]]), properties: {} },
    { ref: 'R2', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 2], ['2', 4]]), properties: {} },
    ...(loadBuf
      ? [{ ref: 'RL', value: '10k', libId: 'R', layer: 'F', padNet: new Map([['1', 3], ['2', 4]]), properties: {} } as Part]
      : []),
  ]
  const resolutions: Resolution[] = [
    {
      ref: 'U1', status: 'ok', tier: 3, warnings: [],
      model: {
        kind: 'subckt', libFile: 'opamp.lib', subcktName: 'LM358',
        pinMap: { '3': 'inp', '2': 'inn', '1': 'out', '8': 'vcc', '4': 'vee' },
      },
    },
    { ref: 'R1', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r1 vcc plus 10000' } },
    { ref: 'R2', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_r2 plus 0 10000' } },
    ...(loadBuf
      ? [{ ref: 'RL', status: 'ok', tier: 2, warnings: [], model: { kind: 'primitive', card: 'r_rl buf 0 10000' } } as Resolution]
      : []),
  ]
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: 4 },
    { kind: 'dc-supply', id: 'bench', netId: 1, volts: 5, seriesOhms: 0.1 },
  ]
  return { circuit: { nets, parts, warnings: [] }, resolutions, instruments, groundNetId: 4, veeNetId: 5, bufNetId: 3 }
}

async function solve(
  floatVee: boolean,
  loadBuf = false,
): Promise<{ errs: string[]; result: SolveResult; veeNetId: number; bufNetId: number }> {
  const f = buildFixture(floatVee, loadBuf)
  const inputs = buildSolveInputs(null, f.circuit, f.resolutions, f.instruments, f.groundNetId, {
    title: `${floatVee ? 'floating-vee' : 'grounded-vee'}${loadBuf ? '-loaded' : ''}`,
    modelTexts: { 'opamp.lib': OPAMP_LIB },
  })
  const errs: string[] = []
  const onEvent = (e: SimEvent): void => {
    if (e.type === 'log' && e.level === 'error') errs.push(e.text)
  }
  const engine = await createInProcessSolveEngine({ onEvent })
  try {
    return { errs, result: await runSolvePlan(inputs, engine), veeNetId: f.veeNetId, bufNetId: f.bufNetId }
  } finally {
    await engine.dispose()
  }
}

describe.skipIf(!haveNgspice)('floating supply pin is reported undriven (real ngspice)', () => {
  it('an LM358 with V- unconnected lists the V- net as undriven and bleeds it', async () => {
    const { errs, result, veeNetId } = await solve(true)
    expect(errs).toEqual([])
    expect(result.undrivenNets.map(n => n.netId)).toContain(veeNetId)
    expect(result.undrivenNets.find(n => n.netId === veeNetId)?.kicadName).toBe('unconnected-(U1-V-)')
    expect(result.deck.some(l => /^r_float_\d+ unconn_vee 0 1e9$/.test(l))).toBe(true)
    // The bench-driven rail and the divider are never listed.
    expect(result.undrivenNets.map(n => n.kicadName)).not.toContain('VCC')
    expect(result.undrivenNets.map(n => n.kicadName)).not.toContain('PLUS')
  }, 90_000)

  it('the same part with OUT loaded to ground still lists the floating V- net', async () => {
    // The output buffer's vee reference cancels out of its constraint, so a DC
    // path from OUT to ground (the load) must not hide V-. The 1 GOhm bleed does
    // not pin the pin's reading (the supply-current sources set its level), so
    // the note is what tells the user the reading is not meaningful.
    const { errs, result, veeNetId, bufNetId } = await solve(true, true)
    expect(errs).toEqual([])
    expect(result.undrivenNets.map(n => n.netId)).toContain(veeNetId)
    expect(result.undrivenNets.find(n => n.netId === veeNetId)?.kicadName).toBe('unconnected-(U1-V-)')
    expect(result.deck.some(l => /^r_float_\d+ unconn_vee 0 1e9$/.test(l))).toBe(true)
    // The loaded output net has its own path through the buffer: no bleed, not undriven.
    expect(result.deck.some(l => /^r_float_\d+ buf 0 1e9$/.test(l))).toBe(false)
    expect(result.undrivenNets.map(n => n.netId)).not.toContain(bufNetId)
  }, 90_000)

  it('the loaded part with V- on ground reports nothing and needs no bleed', async () => {
    const { errs, result, bufNetId } = await solve(false, true)
    expect(errs).toEqual([])
    expect(result.undrivenNets).toEqual([])
    expect(result.deck.some(l => /^r_float_/.test(l))).toBe(false)
    expect(Math.abs((result.netVoltages.get(bufNetId) ?? NaN) - 2.5)).toBeLessThan(0.15)
  }, 90_000)

  it('the same part with V- on ground reports nothing and needs no bleed', async () => {
    const { errs, result } = await solve(false)
    expect(errs).toEqual([])
    expect(result.undrivenNets).toEqual([])
    expect(result.deck.some(l => /^r_float_/.test(l))).toBe(false)
  }, 90_000)
})
