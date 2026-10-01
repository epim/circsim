/**
 * src/simhost/__tests__/logic-output-drive.integration.test.ts
 *
 * Issue #12: a logic output used to be an ideal voltage source on the pad net,
 * so a bare LED on a CD40106 pin read 1.5 A and a 74HC00 into 10 ohm delivered
 * 500 mA. The family JSON now carries an output stage (series resistance plus a
 * drive-current limit) that generateDeck emits between the gate and the pad.
 *
 * Every deck here goes through the REAL generateDeck with the shipped family
 * JSON, then runs on the bundled ngspice.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Resolution } from '../../core/models/types'
import type { Circuit, CircuitNet, Part } from '../../core/netlist/extract'
import { generateDeck } from '../../core/spicegen/generate'
import type { Instrument } from '../../core/spicegen/instruments'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { normalizeVectorKey, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
const MODELS = join(process.cwd(), 'resources', 'models')

const read = (name: string): string => readFileSync(join(MODELS, name), 'utf8')

interface Gate {
  file: 'logic74hc.json' | 'logic4000.json'
  template: string
  /** Output signal whose pad is loaded. */
  out: string
  /** Static input levels by signal name. */
  inputs: Record<string, 0 | 1>
  pinMap: Record<string, string>
}

const HC00: Gate = {
  file: 'logic74hc.json',
  template: '74HC00',
  out: '1Y',
  inputs: { '1A': 0, '1B': 1 },
  pinMap: {
    '1': '1A', '2': '1B', '3': '1Y', '7': 'GND', '14': 'VCC'
  }
}

const CD40106: Gate = {
  file: 'logic4000.json',
  template: 'CD40106',
  out: '1Y',
  inputs: { '1A': 0 },
  pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' }
}

/** Build the deck, then splice `load` element lines (on net "out") before .end. */
function buildDeck(g: Gate, vcc: number, load: string[]): string[] {
  const nets: CircuitNet[] = []
  const add = (name: string, spiceNode: string): number => {
    const id = nets.length + 1
    nets.push({ id, kicadName: name, spiceNode, padRefs: [] })
    return id
  }
  const gnd = add('GND', '0')
  const vccNet = add('VCC', 'vdd')
  const padNet = new Map<string, number>()
  const instruments: Instrument[] = [
    { kind: 'ground-ref', netId: gnd },
    { kind: 'dc-supply', id: 'vcc', netId: vccNet, volts: vcc, seriesOhms: 0.1 }
  ]
  let k = 0
  for (const [pad, sig] of Object.entries(g.pinMap)) {
    if (sig === 'GND') padNet.set(pad, gnd)
    else if (sig === 'VCC') padNet.set(pad, vccNet)
    else if (sig === g.out) padNet.set(pad, add(sig, 'out'))
    else {
      const id = add(sig, sig.toLowerCase())
      padNet.set(pad, id)
      instruments.push({
        kind: 'logic-input',
        id: `in${++k}`,
        netId: id,
        level: g.inputs[sig] ?? 0,
        vHigh: vcc
      })
    }
  }
  const parts: Part[] = [
    { ref: 'U1', value: g.template, libId: `Logic:${g.template}`, layer: 'F', padNet, properties: {} }
  ]
  const resolutions: Resolution[] = [
    {
      ref: 'U1',
      status: 'ok',
      tier: 3,
      warnings: [],
      model: { kind: 'xspice-digital', templateId: g.template, pinMap: g.pinMap }
    }
  ]
  const circuit: Circuit = { nets, parts, warnings: [] }
  const deck = generateDeck({
    circuit,
    resolutions,
    instruments,
    groundNetId: gnd,
    title: 'logic output drive',
    modelTexts: { [g.file]: read(g.file) }
  })
  const end = deck.lastIndexOf('.end')
  return [...deck.slice(0, end), ...load, '.end']
}

async function op(deck: string[]): Promise<{ errs: string[]; op: Record<string, number> }> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    const result = await host.runOp()
    const errs = events
      .filter((e) => e.type === 'log' && e.level === 'error')
      .map((e) => (e as Extract<SimEvent, { type: 'log' }>).text)
    return { errs, op: result }
  } finally {
    await host.dispose()
  }
}

/** Final sample of every vector after a short transient (digital nodes need events). */
async function tranEnd(deck: string[], stop: string): Promise<Record<string, number>> {
  const events: SimEvent[] = []
  const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines: deck })
    await host.whenIdle()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = (host as any).engine
    await engine.command(`tran 10n ${stop} uic`, true)
    const out: Record<string, number> = {}
    for (const name of engine.allVectors(engine.currentPlot())) {
      const d = engine.vectorData(name)
      if (d && d.length) out[normalizeVectorKey(name)] = d[d.length - 1]
    }
    return out
  } finally {
    await host.dispose()
  }
}

const LED = ['vsense_d1 out nled 0', 'd1 nled 0 LED_RED', ...read('led.lib').split(/\r?\n/)]

describe.skipIf(!haveNgspice)('logic output stage (issue #12)', () => {
  it('a bare red LED on a CD40106 pin at 5 V draws a datasheet-bounded current', async () => {
    const r = await op(buildDeck(CD40106, 5, LED))
    expect(r.errs).toEqual([])
    const iMa = Math.abs(r.op['i(vsense_d1)']) * 1e3
    // Was 1528.8 mA. CD4000B at 5 V sources on the order of 1 to 3 mA.
    expect(iMa).toBeGreaterThan(0.1)
    expect(iMa).toBeLessThan(5)
    // The pin collapses toward the LED forward voltage instead of holding 5 V.
    expect(r.op['out']).toBeLessThan(3)
    expect(r.op['out']).toBeGreaterThan(1.3)
  })

  it('a 74HC00 output into 10 ohm sags and stays inside the rated output current', async () => {
    const r = await op(buildDeck(HC00, 5, ['rload out 0 10']))
    expect(r.errs).toEqual([])
    const v = r.op['out']
    expect(v).toBeLessThan(4.5)
    // Was 500 mA at a full 5 V. 74HC absolute maximum output current is 25 mA.
    const iMa = (v / 10) * 1e3
    expect(iMa).toBeLessThanOrEqual(26)
    expect(iMa).toBeGreaterThan(5)
  })

  it('an unloaded output still reaches the rail', async () => {
    const hc = await op(buildDeck(HC00, 5, ['rload out 0 10meg']))
    expect(hc.op['out']).toBeGreaterThan(4.99)
    const cd = await op(buildDeck(CD40106, 5, ['rload out 0 10meg']))
    expect(cd.op['out']).toBeGreaterThan(4.99)
  })

  it('a low output sinks load current through the same output stage', async () => {
    const low: Gate = { ...HC00, inputs: { '1A': 1, '1B': 1 } }
    const end = await tranEnd(buildDeck(low, 5, ['rload out vdd 470']), '2u')
    // Ideal source: 0 V. Real HC output: tens of ohms, a few hundred mV at 10 mA of load.
    expect(end['out']).toBeGreaterThan(0.1)
    expect(end['out']).toBeLessThan(1)
  })
})
