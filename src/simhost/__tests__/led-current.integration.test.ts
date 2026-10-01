/**
 * src/simhost/__tests__/led-current.integration.test.ts
 *
 * Live-Bench SPIKE: prove an LED's BRANCH CURRENT actually streams as a transient
 * vector from the REAL ngspice SimHost, with the correct sign and a sane magnitude.
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing.
 *
 * Mirrors the harness in transient.integration.test.ts EXACTLY: a real SimHost is
 * spun up, a hand-written deck is loaded via loadCircuit deckLines, a transient is
 * run via runTransient, pace is set to 'max', and the streamed `vectors`/`samples`
 * SimEvents are collected by a SampleCollector.
 *
 * Circuit: current-limited LED.
 *   v1 vcc 0 dc 5
 *   r1 vcc a 330
 *   d1 a 0 dled            (diode model tuned to Vf ≈ 1.8–2 V at ~10 mA)
 * Steady-state forward current ≈ (5 − Vf)/330 ≈ 9–10 mA.
 *
 * We capture the LED current TWO ways and document what the real SimHost streams:
 *   (a) `.save all @d1[i]` — diode device-internal current vector. RESULT: the
 *       "@d1[i]" name IS announced in the `vectors` event, but the vector carries
 *       no readable data (ngspice 46 holds none for a diode's own current), so its
 *       column is all NaN. The other vectors of the run stream normally. NOT a
 *       viable Live-Bench path for a device current.
 *   (b) a 0 V series ammeter `vmeas a ak 0` + `d1 ak 0 dled` + `.save i(vmeas)`.
 *       RESULT: streams cleanly as "vmeas#branch", ~8.65 mA, every timepoint.
 *       THIS is the path Live-Bench should use for a device branch current.
 *
 * HISTORY (issue #25): while samples arrived through ngspice's per-timepoint
 * SendData callback, a saved "@d1[i]" made ngspice skip SendData for the WHOLE
 * run (zero callbacks, zero samples; the identical circuit without it streamed
 * 1000+ rows). Samples are now read from the plot vectors instead, so the run
 * survives and only that one column is lost.
 *
 * NORMALIZATION NOTE (load-bearing): the transient streaming path (initData and
 * the plot reads) passes ngspice's RAW vector names straight through, it does NOT
 * call normalizeVectorKey() (only the op path does). So the streamed
 * `vectors`/`samples` events carry the RAW name ("vmeas#branch", "@d1[i]"), NOT
 * the canonical "i(vmeas)". The renderer/store must normalize on its side. This
 * test asserts on both raw and normalized forms.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { normalizeVectorKey, type SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

/** Collects samples streamed from a SimHost into flat per-vector arrays. */
class SampleCollector {
  readonly events: SimEvent[] = []
  vectorNames: string[] = []
  time: number[] = []
  cols: Record<string, number[]> = {}
  batchCount = 0
  batches: Extract<SimEvent, { type: 'samples' }>[] = []

  emit = (ev: SimEvent): void => {
    this.events.push(ev)
    if (ev.type === 'vectors') {
      this.vectorNames = ev.names
      for (const n of ev.names) this.cols[n] ??= []
    } else if (ev.type === 'samples') {
      this.batchCount++
      this.batches.push(ev)
      for (let i = 0; i < ev.simTime.length; i++) this.time.push(ev.simTime[i])
      for (let c = 0; c < ev.vectorNames.length; c++) {
        const name = ev.vectorNames[c]
        const arr = (this.cols[name] ??= [])
        const col = ev.columns[c]
        for (let i = 0; i < col.length; i++) arr.push(col[i])
      }
    }
  }

  finalValue(vec: string): number {
    const col = this.cols[vec]
    return col ? col[col.length - 1] : NaN
  }
}

/** Poll until the engine's bg thread is no longer running, or timeout. */
async function waitUntilStopped(host: SimHost, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = (host as any).engine
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    if (engine.isRunning && !engine.isRunning()) {
      await new Promise((r) => setTimeout(r, 30))
      ;(host as any).pacingTick?.()
      return
    }
  }
}

/** Run a deck through a real SimHost transient and return the collected samples. */
async function runTransient(deckLines: string[]): Promise<SampleCollector> {
  const col = new SampleCollector()
  const host = new SimHost({ emit: col.emit })
  try {
    await host.start()
    host.handleCommand({ type: 'loadCircuit', deckLines })
    await host.whenIdle()
    // Short window: DC steady, so current is ~constant. 1 ms / 1 us step is plenty.
    host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-6, tstopSeconds: 1e-3 })
    await host.whenIdle()
    host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
    await host.whenIdle()
    await waitUntilStopped(host, 15_000)
  } finally {
    await host.dispose()
  }
  return col
}

/** Find the streamed column whose NORMALIZED name equals `i(<dev>)`. */
function findCurrentColumn(col: SampleCollector, dev: string): { raw: string; value: number } | null {
  const target = `i(${dev.toLowerCase()})`
  for (const raw of col.vectorNames) {
    if (normalizeVectorKey(raw) === target) {
      return { raw, value: col.finalValue(raw) }
    }
  }
  return null
}

describe.skipIf(!haveNgspice)('Live-Bench spike — LED branch current streams (real libngspice)', () => {
  it('(a) `.save all @d1[i]` is announced, but its column is NaN; the rest of the run still streams', async () => {
    // Diode model: is/n chosen so Vf ≈ 1.8–2 V at ~10 mA (so i ≈ (5-Vf)/330).
    // A device-internal "@d1[i]" vector appears in the `vectors` event but holds
    // no readable data on ngspice 46, so SimHost reports NaN for that column
    // (see the HISTORY note above for the old SendData behavior).
    const deck = [
      '* current-limited LED — diode internal current via .save all @d1[i]',
      'v1 vcc 0 dc 5',
      'r1 vcc a 330',
      'd1 a 0 dled',
      '.model dled d (is=1e-20 n=2 rs=1)',
      '.save all @d1[i]',
      '.tran 1u 1m',
      '.end'
    ]
    const col = await runTransient(deck)

    // eslint-disable-next-line no-console
    console.log(
      `\n[LED @d1[i]] streamed vectorNames = ${JSON.stringify(col.vectorNames)}\n` +
        `  normalized = ${JSON.stringify(col.vectorNames.map(normalizeVectorKey))}\n` +
        `  batches=${col.batchCount} points=${col.time.length}`
    )

    // The device current vector name IS announced in the `vectors` event...
    expect(col.vectorNames).toContain('@d1[i]')
    expect(col.vectorNames.map(normalizeVectorKey)).toContain('i(d1)')
    // ...the run streams anyway (node voltages arrive)...
    expect(col.time.length).toBeGreaterThan(10)
    expect(Number.isFinite(col.finalValue('a'))).toBe(true)
    // ...but the device current itself is not readable: all NaN. Still not a usable
    // transient current source; the 0 V ammeter in (b) is.
    expect(col.cols['@d1[i]'].every((v) => Number.isNaN(v))).toBe(true)
  }, 30_000)

  it('(b) series 0V ammeter i(vmeas) streams the LED current, ~9-10 mA, positive', async () => {
    const deck = [
      '* current-limited LED — series 0V ammeter vmeas measures the LED current',
      'v1 vcc 0 dc 5',
      'r1 vcc a 330',
      'vmeas a ak dc 0',
      'd1 ak 0 dled',
      '.model dled d (is=1e-20 n=2 rs=1)',
      '.save i(vmeas)',
      '.tran 1u 1m',
      '.end'
    ]
    const col = await runTransient(deck)

    // eslint-disable-next-line no-console
    console.log(
      `\n[LED vmeas] streamed vectorNames = ${JSON.stringify(col.vectorNames)}\n` +
        `  normalized = ${JSON.stringify(col.vectorNames.map(normalizeVectorKey))}\n` +
        `  batches=${col.batchCount} points=${col.time.length}`
    )

    expect(col.time.length).toBeGreaterThan(10)

    const found = findCurrentColumn(col, 'vmeas')
    // eslint-disable-next-line no-console
    console.log(
      `[LED vmeas] current vector ${found ? `PRESENT raw="${found.raw}" → i(vmeas)` : 'ABSENT'} ` +
        `value=${found ? (found.value * 1e3).toFixed(3) + ' mA' : 'n/a'}`
    )

    expect(found, 'ammeter current vector i(vmeas) not present in streamed vectorNames').not.toBeNull()
    const i = found!.value
    // Observed against ngspice 46: forward conduction streams i(vmeas) = +8.65 mA
    // (current flows vcc → r1 → a → vmeas(+→−) → d1 → 0, reported POSITIVE through
    // the ammeter). Assert the magnitude sits in the LED operating band AND the
    // sign is positive for forward conduction.
    const mag = Math.abs(i)
    expect(mag).toBeGreaterThan(1e-3)
    expect(mag).toBeLessThan(20e-3)
    expect(Number.isFinite(i)).toBe(true)
    expect(i).toBeGreaterThan(0) // forward conduction → positive branch current
  }, 30_000)
})
