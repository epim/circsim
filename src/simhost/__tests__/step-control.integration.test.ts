import { describe, expect, it } from 'vitest'
import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'

describe.skipIf(!ngspiceResourcesAvailable())('bandwidth-derived native step control', () => {
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
