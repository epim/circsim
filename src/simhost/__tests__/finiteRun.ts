import type { SimEvent } from '../protocol'

/** Completion is reported after the entire finite run's sample tail is sent. */
export function finiteRunCompleted(events: readonly SimEvent[], tstop: number): boolean {
  return events.some(event => event.type === 'status' && !event.running && event.simTimeSeconds >= tstop)
}

export async function waitForFiniteRun(events: readonly SimEvent[], tstop: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!finiteRunCompleted(events, tstop)) {
    if (Date.now() >= deadline) throw new Error(`No final sample-channel status for tstop=${tstop}; received ${events.length} events`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
