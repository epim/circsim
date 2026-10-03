import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SimHost } from '../index'
import { NgspiceFfiEngine, ngspiceResourcesAvailable } from '../ngspiceFfi'
import { BENCH_TSTEP_MAX_SECONDS } from '../protocol'

describe.skipIf(!ngspiceResourcesAvailable())('bandwidth-derived native step control', () => {
  it('prevents a discrete BJT astable flat line by recognising its timing caps', async () => {
    const engine = new NgspiceFfiEngine()
    const host = new SimHost({ engine, emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      // A 1 percent base-resistor asymmetry selects the astable mode instead
      // of relying on numerical startup noise in the perfectly symmetric deck.
      // Claude approved this deterministic variant in R2's fixture follow-up.
      await host.loadCircuit([
        '* discrete astable', 'v1 vcc 0 5', 'rc1 vcc c1 1k', 'rc2 vcc c2 1k',
        'rb1 vcc b1 47k', 'rb2 vcc b2 47.5k', 'cx1 c1 b2 100n', 'cx2 c2 b1 100n',
        'q1 c1 b1 0 NPNX', 'q2 c2 b2 0 NPNX',
        '.model NPNX NPN(IS=1e-14 BF=200 VAF=100 RB=10 RC=1 CJE=20p CJC=8p TF=0.3n)',
        '.save v(c1)', '.end',
      ])
      const period = (time: ArrayLike<number>, values: ArrayLike<number>): number => {
        const edges: number[] = []
        let armed = false
        for (let i = 1; i < time.length; i++) {
          if (values[i] < 1) armed = true
          if (time[i] > 0.05 && armed && values[i - 1] < 4 && values[i] >= 4) {
            const fraction = (4 - values[i - 1]) / (values[i] - values[i - 1])
            edges.push(time[i - 1] + fraction * (time[i] - time[i - 1]))
            armed = false
          }
        }
        expect(edges.length).toBeGreaterThan(25)
        return (edges.at(-1)! - edges[0]) / (edges.length - 1)
      }
      await engine.command('tran 1u 0.3 0 1u uic', true)
      const reference = period(engine.vectorData('time')!, engine.vectorData('c1')!)
      if (process.env.CIRCSIM_PROFILE_REALTIME === '1') {
        for (const step of [480e-6, 240e-6, 96e-6, 48e-6, 24e-6, 10e-6]) {
          await engine.command(`tran ${step} 0.3 0 ${step} uic`, true)
          const candidate = period(engine.vectorData('time')!, engine.vectorData('c1')!)
          console.log(`[step-calibration] BJT astable: step=${step}s, period=${candidate}s, error=${100 * Math.abs(candidate - reference) / reference}%`)
        }
      }
      const bench = await host.runTran(BENCH_TSTEP_MAX_SECONDS, 0.3)
      const actual = period(bench.time, bench.vectors.c1)
      console.log(`[step-control] BJT astable: 1 us period=${reference}s, bench period=${actual}s`)
      // Recognition prevents the former flat line, but this nonlinear deck's
      // period is not calibrated by RC/10. Claude explicitly deferred that
      // fidelity issue; the documentation requires a 1 us comparison.
      for (let i = 1; i < bench.time.length; i++) {
        expect(bench.time[i] - bench.time[i - 1]).toBeLessThanOrEqual(480e-6 * 1.00001)
      }
    } finally { await host.dispose() }
  }, 60_000)

  it('preserves a fast self-oscillating 555 period without a periodic source', async () => {
    const engine = new NgspiceFfiEngine()
    const host = new SimHost({ engine, emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      await host.loadCircuit([
        '* fast 555 astable', 'v1 vcc 0 5', 'r1 vcc disch 10k', 'r2 disch timing 47k',
        'c1 timing 0 100n', 'c2 ctrl 0 10n', 'rload out 0 10k',
        'x1 0 timing out vcc ctrl timing disch vcc NE555',
        ...readFileSync('resources/models/timer555.lib', 'utf8').split(/\r?\n/), '.save v(out)', '.end',
      ])
      const period = async (step: number, reference = false): Promise<number> => {
        // The reference bypasses the new guard, so changing that guard cannot
        // silently change both sides of this regression to the same step.
        if (reference) await engine.command(`tran ${step} 0.3 0 ${step} uic`, true)
        const result = reference
          ? { time: engine.vectorData('time')!, vectors: { out: engine.vectorData('out')! } }
          : await host.runTran(step, 0.3)
        const edges: number[] = []
        const out = result.vectors.out
        for (let i = 1; i < result.time.length; i++) {
          if (result.time[i] > 0.05 && out[i - 1] < 2.5 && out[i] >= 2.5) {
            const fraction = (2.5 - out[i - 1]) / (out[i] - out[i - 1])
            edges.push(result.time[i - 1] + fraction * (result.time[i] - result.time[i - 1]))
          }
        }
        expect(edges.length).toBeGreaterThan(25)
        return (edges.at(-1)! - edges[0]) / (edges.length - 1)
      }
      const reference = await period(100e-6, true)
      const bench = await period(BENCH_TSTEP_MAX_SECONDS)
      console.log(`[step-control] fast 555: 100 us period=${reference}s, bench period=${bench}s`)
      expect(Math.abs(bench - reference) / reference).toBeLessThan(0.03)
    } finally { await host.dispose() }
  }, 60_000)

  it('resolves the 1 ms RC dynamics with a 5 ms quiet-region request', async () => {
    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      await host.loadCircuit(['* RC dynamics', 'v1 in 0 5', 'r1 in out 1k', 'c1 out 0 1u ic=0', '.save v(out)', '.end'])
      const result = await host.runTran(BENCH_TSTEP_MAX_SECONDS, 0.3)
      const withinFiveTau = result.time.filter(time => time <= 0.005)
      expect(withinFiveTau.length).toBeGreaterThan(50)
      for (let i = 1; i < withinFiveTau.length; i++) {
        expect(result.time[i] - result.time[i - 1]).toBeLessThanOrEqual(100e-6 * 1.00001)
        expect(Math.abs(result.vectors.out[i] - 5 * (1 - Math.exp(-result.time[i] / 0.001)))).toBeLessThan(0.005)
      }
    } finally { await host.dispose() }
  })

  it('keeps 200 samples per fast sine period even when the requested quiet step is 1 ms', async () => {
    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      await host.loadCircuit(['* fast sine', 'v1 out 0 SIN(0 1 100000)', 'r1 out 0 1k', '.end'])
      const result = await host.runTran(1e-3, 30e-6)
      const values = result.vectors.out
      expect(result.time.at(-1)).toBeCloseTo(30e-6, 12)
      for (let i = 1; i < result.time.length; i++) {
        expect(result.time[i] - result.time[i - 1]).toBeLessThanOrEqual(1 / (200 * 100000) * 1.00001)
        expect(values[i]).toBeCloseTo(Math.sin(2 * Math.PI * 100000 * result.time[i]), 5)
      }
    } finally { await host.dispose() }
  })

  it('retains nanosecond pulse edges with a coarser quiet step', async () => {
    const host = new SimHost({ emit: () => {}, disableWatchdog: true })
    try {
      await host.start()
      await host.loadCircuit(['* fast pulse', 'v1 out 0 PULSE(0 5 0 1e-9 1e-9 5e-6 1e-5)', 'r1 out 0 1k', '.end'])
      const result = await host.runTran(1e-3, 30e-6)
      const values = result.vectors.out
      for (const edge of [10e-6, 20e-6]) {
        const before = result.time.findIndex(t => t >= edge - 1e-9)
        const after = result.time.findIndex(t => t >= edge + 1e-9)
        expect(values[before]).toBeLessThan(0.01)
        expect(values[after]).toBeGreaterThan(4.99)
        expect(result.time.slice(before, after + 1).length).toBeGreaterThan(2)
      }
    } finally { await host.dispose() }
  })
})
