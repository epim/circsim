/**
 * Issue #155 against the REAL libngspice: the lines ngspice writes to stderr
 * reach the crash-breadcrumb trace (src/simhost/outputTrace.ts), and stdout
 * chatter does not. The trace is what lets a dead vitest worker's report name
 * the ngspice message that preceded the death.
 *
 * Skipped automatically when resources/ngspice/<platform> is missing.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SimHost } from '../index'
import { ngspiceResourcesAvailable } from '../ngspiceFfi'
import { NGSPICE_TRACE_DIR_ENV, ngspiceTraceFile } from '../outputTrace'

const haveNgspice = ngspiceResourcesAvailable()

describe.skipIf(!haveNgspice)('ngspice stderr reaches the crash trace (real libngspice, issue #155)', () => {
  let dir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'circsim-ngspice-trace-'))
    saved = process.env[NGSPICE_TRACE_DIR_ENV]
    process.env[NGSPICE_TRACE_DIR_ENV] = dir
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[NGSPICE_TRACE_DIR_ENV]
    else process.env[NGSPICE_TRACE_DIR_ENV] = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('a model-less diode card leaves its stderr line in the trace, with no stdout lines', async () => {
    const host = new SimHost({ emit: () => {} })
    try {
      await host.start()
      host.handleCommand({
        type: 'loadCircuit',
        deckLines: ['* circsim stderr trace', 'v1 vin 0 dc 5', 'r1 vin a 1k', 'd_d1 a 0', '.op', '.end']
      })
      try {
        await host.runOp()
      } catch {
        // A deck ngspice refused to run is the point: its complaint is what we want.
      }
    } finally {
      await host.dispose()
    }
    const lines = readFileSync(ngspiceTraceFile(dir, process.pid), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.startsWith('stderr') || l.startsWith('controlledExit'))).toBe(true)
    expect(lines.join('\n')).toMatch(/modelname/i)
  }, 60_000)
})
