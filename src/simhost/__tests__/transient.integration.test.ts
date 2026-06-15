/**
 * src/simhost/__tests__/transient.integration.test.ts
 *
 * SimHost transient-streaming integration test (Task 10 / Spec §6.1, §7.4, §7.5).
 *
 * Runs the REAL libngspice via koffi against the bundled resources for this
 * platform. Skipped automatically when resources/ngspice/<platform> is missing.
 * Wired into `npm run test:integration`.
 *
 * Asserts (all against captured samples streamed over the SimEvent channel):
 *  (1) RC charge: v1 in 0 dc 5 / r1 in out 1k / c1 out 0 1u, tran 1u 10m →
 *      captured "out" samples match 5*(1-e^(-t/RC)) within 2 % at t=1,2,5 ms.
 *  (2) mid-run `alter v1` to 10 → final steady-state samples ≈ 10 V.
 *  (3) sample batches arrive as Float64Array with matching simTime length.
 *
 * The RC charge curve is only visible when the transient starts from zero initial
 * conditions; the deck carries `ic=0` on the cap + `.ic v(out)=0` and
 * runTransient drives `bg_tran … uic` (verified against ngspice 46 — without uic
 * the run starts already DC-settled at the rail).
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()

/** Collects samples streamed from a SimHost into flat per-vector arrays. */
class SampleCollector {
  readonly events: SimEvent[] = []
  vectorNames: string[] = []
  time: number[] = []
  cols: Record<string, number[]> = {}
  batchCount = 0
  /** Every flushed batch, retained so we can assert on payload shape. */
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

  /** Nearest captured sample of `vec` to sim-time `t`. */
  valueAt(vec: string, t: number): number {
    const col = this.cols[vec]
    let bestIdx = 0
    let bestErr = Infinity
    for (let i = 0; i < this.time.length; i++) {
      const e = Math.abs(this.time[i] - t)
      if (e < bestErr) {
        bestErr = e
        bestIdx = i
      }
    }
    return col[bestIdx]
  }

  finalValue(vec: string): number {
    const col = this.cols[vec]
    return col[col.length - 1]
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
      // give the final SendData/flush a beat
      await new Promise((r) => setTimeout(r, 30))
      ;(host as any).pacingTick?.()
      return
    }
  }
}

describe.skipIf(!haveNgspice)('SimHost transient streaming (real libngspice)', () => {
  it('(1) RC charge curve matches 5*(1-e^(-t/RC)) within 2% at 1,2,5 ms', async () => {
    const col = new SampleCollector()
    const host = new SimHost({
      emit: col.emit,
      // Run unthrottled so the 10 ms transient completes promptly in the test.
      // pace is set after the run starts.
    })
    try {
      await host.start()
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: [
          '* rc charge',
          'v1 in 0 dc 5',
          'r1 in out 1k',
          'c1 out 0 1u ic=0',
          '.ic v(out)=0',
          '.end'
        ]
      })
      await host.whenIdle()
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-6, tstopSeconds: 10e-3 })
      await host.whenIdle()
      host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
      await host.whenIdle()

      await waitUntilStopped(host, 15_000)

      // Vectors event must have arrived (SendInitData → 'vectors').
      expect(col.vectorNames).toContain('out')
      expect(col.time.length).toBeGreaterThan(100)

      const RC = 1e3 * 1e-6 // 1 ms
      for (const t of [1e-3, 2e-3, 5e-3]) {
        const captured = col.valueAt('out', t)
        const analytic = 5 * (1 - Math.exp(-t / RC))
        const relErr = Math.abs(captured - analytic) / analytic
        // eslint-disable-next-line no-console
        console.log(
          `[RC] t=${(t * 1e3).toFixed(0)}ms captured=${captured.toFixed(5)}V ` +
            `analytic=${analytic.toFixed(5)}V relErr=${(relErr * 100).toFixed(3)}%`
        )
        expect(relErr).toBeLessThan(0.02)
      }
    } finally {
      host.dispose()
    }
  }, 30_000)

  it('(3) sample batches are Float64Array with matching simTime length', async () => {
    const col = new SampleCollector()
    const host = new SimHost({ emit: col.emit })
    try {
      await host.start()
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: ['* rc', 'v1 in 0 dc 5', 'r1 in out 1k', 'c1 out 0 1u ic=0', '.ic v(out)=0', '.end']
      })
      await host.whenIdle()
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-6, tstopSeconds: 10e-3 })
      await host.whenIdle()
      host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
      await host.whenIdle()
      await waitUntilStopped(host, 15_000)

      expect(col.batches.length).toBeGreaterThan(0)
      for (const b of col.batches) {
        expect(b.simTime).toBeInstanceOf(Float64Array)
        expect(b.columns.length).toBe(b.vectorNames.length)
        for (const c of b.columns) {
          expect(c).toBeInstanceOf(Float64Array)
          expect(c.length).toBe(b.simTime.length)
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[batches] ${col.batches.length} batches, ${col.time.length} total points`)
    } finally {
      host.dispose()
    }
  }, 30_000)

  it('(2) mid-run alter v1 to 10 → final steady-state ≈ 10 V', async () => {
    const col = new SampleCollector()
    const host = new SimHost({ emit: col.emit })
    try {
      await host.start()
      // Fast RC (RC = 100 us) so steady state is reached within a window; long
      // tstop (30 s) so the bg thread stays alive while we alter mid-run. Pace 1x
      // keeps the run alive long enough to halt/alter/resume.
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: [
          '* rc alter',
          'v1 in 0 dc 5',
          'r1 in out 100',
          'c1 out 0 1u ic=0',
          '.ic v(out)=0',
          '.end'
        ]
      })
      await host.whenIdle()
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 30 })
      await host.whenIdle()

      // Let it run a bit (sim settles to 5 V), then alter the supply to 10 V.
      await new Promise((r) => setTimeout(r, 600))
      host.handleCommand({ type: 'alter', device: 'v1', value: 10 })
      // Force the alter coalesce window closed promptly.
      ;(host as any).flushAlters()
      await host.whenIdle()

      // Let the circuit settle to the new rail, then stop.
      await new Promise((r) => setTimeout(r, 800))
      host.handleCommand({ type: 'stop' })
      await host.whenIdle()
      await new Promise((r) => setTimeout(r, 100))

      const finalOut = col.finalValue('out')
      // eslint-disable-next-line no-console
      console.log(`[alter] final out = ${finalOut.toFixed(4)} V (expected ≈ 10)`)
      expect(finalOut).toBeGreaterThan(9.5)
      expect(finalOut).toBeLessThan(10.5)
    } finally {
      host.dispose()
    }
  }, 30_000)
})
