/**
 * Not a test of its own: src/simhost/__tests__/workerCrash.test.ts runs this
 * file in a nested vitest and checks that the report names the crash. It kills
 * its own worker process in the middle of the second test, after writing the
 * line libngspice would have written to stderr.
 */

import { describe, expect, it } from 'vitest'

import { traceNgspiceOutput } from '../../../src/simhost/outputTrace'

describe('crash fixture', () => {
  it('finishes normally before the crash', () => {
    expect(1 + 1).toBe(2)
  })

  it('dies with the worker mid-test', () => {
    traceNgspiceOutput('stdout Doing analysis at TEMP = 27.000000 and TNOM = 27.000000')
    traceNgspiceOutput('stderr Error: fixture ngspice fatal (deliberate)')
    process.kill(process.pid, 'SIGKILL')
  })
})
