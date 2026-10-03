import { describe, expect, it } from 'vitest'
import { finiteRunCompleted } from './finiteRun'
import type { SimEvent } from '../protocol'

describe('finite sample-channel completion (issue #164)', () => {
  it('does not treat startup or an internal halt before tstop as a completed run', () => {
    const events: SimEvent[] = [{ type: 'status', running: false, simTimeSeconds: 0, realtimeFactor: 0 }]
    expect(finiteRunCompleted(events, 0.01)).toBe(false)
    events.push({ type: 'status', running: false, simTimeSeconds: 0.0005, realtimeFactor: 1 })
    expect(finiteRunCompleted(events, 0.01)).toBe(false)
    events.push({ type: 'status', running: true, simTimeSeconds: 0.01, realtimeFactor: 1 })
    expect(finiteRunCompleted(events, 0.01)).toBe(false)
    events.push({ type: 'status', running: false, simTimeSeconds: 0.01, realtimeFactor: 1 })
    expect(finiteRunCompleted(events, 0.01)).toBe(true)
  })
})
