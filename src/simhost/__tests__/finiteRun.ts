import type { SimEvent } from '../protocol'

/** Completion is reported after the entire finite run's sample tail is sent. */
export function finiteRunCompleted(events: readonly SimEvent[], tstop: number): boolean {
  return events.some(event => event.type === 'status' && !event.running && event.simTimeSeconds >= tstop)
}

export async function waitForFiniteRun(events: readonly SimEvent[], tstop: number, maxTurns = 750): Promise<void> {
  let turns = 0
  while (!finiteRunCompleted(events, tstop)) {
    if (turns++ >= maxTurns) throw new Error(`No final sample-channel status for tstop=${tstop}; received ${events.length} events`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
