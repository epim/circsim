/**
 * src/simhost/__tests__/sample-channel.integration.test.ts
 *
 * The live sample channel against the REAL libngspice (issue #25): samples are
 * read from the plot vectors (no per-timepoint callback), so what reaches the
 * renderer must match what ngspice computed, and must survive the halt/resume
 * cycles the bench goes through all the time.
 *
 *  (1) a finite bg run's polled `samples` equal a foreground `tran` of the same
 *      deck, point for point, and the `latest` snapshot carries the final value
 *      of every unwatched vector;
 *  (2) alters (each batch of them a bg_halt / bg_resume, during which ngspice
 *      repeats SendInitData for the same plot) and a user pause never replay
 *      or reorder the stream: sim time only moves forward;
 *  (3) samples reach the renderer on the 16 ms tick, not the 50 ms pacing tick
 *      (issue #78).
 *
 * Skipped with a visible message when resources/ngspice/<platform> is missing.
 */

import { describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import type { SimEvent } from '../protocol'

const haveNgspice = ngspiceResourcesAvailable()
if (!haveNgspice) {
  console.warn('[sample-channel] resources/ngspice/<platform> missing: the sample channel checks are SKIPPED (run npm run fetch:ngspice)')
}

type Samples = Extract<SimEvent, { type: 'samples' }>

const RC_DECK = ['* rc charge', 'v1 in 0 dc 5', 'r1 in out 1k', 'c1 out 0 1u ic=0', '.ic v(out)=0', '.end']

/** Resolve once `done(events)` holds, or reject after `timeoutMs`. */
async function until(events: SimEvent[], done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`condition not reached within ${timeoutMs} ms (${events.length} events)`)
}

describe.skipIf(!haveNgspice)('live sample channel (real libngspice)', () => {
  it('(1) polled samples equal a foreground tran of the same deck; latest carries the other vectors', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: RC_DECK })
      host.handleCommand({ type: 'watch', vectors: ['out'] })
      host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 5e-3 })
      await host.whenIdle()
      await until(
        events,
        () => events.some((e) => e.type === 'status' && !e.running && e.simTimeSeconds >= 5e-3),
        15_000
      )

      const batches = events.filter((e): e is Samples => e.type === 'samples')
      const time = batches.flatMap((b) => Array.from(b.simTime))
      const out = batches.flatMap((b) => Array.from(b.columns[b.vectorNames.indexOf('out')]))

      // Every batch carries only the watched vector as a column.
      for (const b of batches) expect(b.vectorNames).toEqual(['out'])

      const ref = await host.runTran(1e-5, 5e-3)
      expect(time.length).toBe(ref.time.length)
      expect(time.length).toBeGreaterThan(400)
      for (let i = 0; i < time.length; i++) {
        expect(time[i]).toBe(ref.time[i])
        expect(out[i]).toBe(ref.vectors['out'][i])
      }

      // The last snapshot has the unwatched vectors at their final values: the
      // supply node is at 5 V, and the source branch current is what the RC draws.
      const latest = [...batches].reverse().find((b) => b.latest)!.latest!
      expect(latest.vectorNames).toContain('in')
      expect(latest.values[latest.vectorNames.indexOf('in')]).toBeCloseTo(5, 9)
      const iv1 = latest.vectorNames.indexOf('v1#branch')
      expect(iv1).toBeGreaterThanOrEqual(0)
      expect(latest.values[iv1]).toBeCloseTo(ref.vectors['i(v1)'][ref.time.length - 1], 12)
    } finally {
      await host.dispose()
    }
  }, 60_000)

  it('(2) alters and a user pause never replay or reorder the stream', async () => {
    const events: SimEvent[] = []
    const host = new SimHost({ emit: (e) => events.push(e), disableWatchdog: true })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: RC_DECK })
      host.handleCommand({ type: 'watch', vectors: ['out'] })
      host.handleCommand({ type: 'setPace', realtimeFactor: 'max' })
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 1000 })
      await host.whenIdle()

      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 150))
        host.handleCommand({ type: 'alter', device: 'v1', value: 4 + k })
      }
      host.handleCommand({ type: 'halt' })
      await new Promise((r) => setTimeout(r, 300))
      host.handleCommand({ type: 'resume' })
      await new Promise((r) => setTimeout(r, 300))
      host.handleCommand({ type: 'stop' })
      await host.whenIdle()

      // One "Doing analysis" each for the startup smoke deck and the run's
      // start, then one per resume. Six alters 150 ms apart come faster than a
      // halt / resume cycle (about 300 ms), so they are applied in two to four
      // batches, plus the user's resume.
      const starts = events.filter((e) => e.type === 'log' && /Doing analysis/.test(e.text)).length
      expect(starts, 'the run went through halt/resume cycles').toBeGreaterThanOrEqual(4)

      const batches = events.filter((e): e is Samples => e.type === 'samples')
      const time = batches.flatMap((b) => Array.from(b.simTime))
      expect(time.length).toBeGreaterThan(1000)
      let backwards = 0
      for (let i = 1; i < time.length; i++) if (time[i] <= time[i - 1]) backwards++
      expect(backwards, 'sim time must be strictly increasing across every resume').toBe(0)

      // The last alter (9 V) is visible in the stream: out heads for it.
      const out = batches.flatMap((b) => Array.from(b.columns[0]))
      expect(out[out.length - 1]).toBeGreaterThan(8.9)
    } finally {
      await host.dispose()
    }
  }, 60_000)

  it('(3) samples reach the renderer on the 16 ms tick, not the 50 ms pacing tick (#78)', async () => {
    const stamps: number[] = []
    const host = new SimHost({
      emit: (e) => {
        if (e.type === 'samples') stamps.push(Date.now())
      },
      disableWatchdog: true
    })
    try {
      await host.start()
      host.handleCommand({ type: 'loadCircuit', deckLines: RC_DECK })
      // Real-time pace: ~1600 new points per 16 ms, so every tick is one batch.
      host.handleCommand({ type: 'setPace', realtimeFactor: 1 })
      host.handleCommand({ type: 'runTransient', tstepSeconds: 1e-5, tstopSeconds: 1000 })
      await host.whenIdle()
      await new Promise((r) => setTimeout(r, 2500))
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b)
      const median = gaps[gaps.length >> 1]
      console.log(`[sample-channel] batches=${stamps.length} median gap=${median} ms `)
      expect(stamps.length).toBeGreaterThan(60)
      // 16 ms by design; the old pacing-tick flush sat at 50 ms (median 50.0).
      expect(median).toBeLessThan(30)
    } finally {
      await host.dispose()
    }
  }, 30_000)
})
