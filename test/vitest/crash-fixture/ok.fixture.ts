/**
 * Control for crash.fixture.ts: a file that finishes normally must produce no
 * crash report (src/simhost/__tests__/workerCrash.test.ts).
 */

import { describe, expect, it } from 'vitest'

describe('ok fixture', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2)
  })
})
