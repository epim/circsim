/**
 * Issue #155: a vitest fork worker that dies mid-file must name its cause.
 *
 * Before the diagnostics, a dead worker surfaced only as "Error: Worker exited
 * unexpectedly" with no file, exit code, signal or ngspice message. This runs
 * a nested vitest (the project config, test/vitest/crash-fixture) whose single
 * test kills its own worker after writing an ngspice stderr line, and checks
 * that the nested run's output and its GitHub job summary carry the file, the
 * test, the exit status and that line.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  describeExit,
  formatCrashReport,
  readTail,
  type CrashFacts
} from '../../../test/vitest/workerCrash'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('describeExit', () => {
  it('names a signal', () => {
    expect(describeExit(null, 'SIGSEGV')).toBe('killed by signal SIGSEGV')
  })

  it('names a plain exit code', () => {
    expect(describeExit(1, null)).toBe('exit code 1')
  })

  it('decodes a Windows access violation, signed or unsigned', () => {
    expect(describeExit(0xc0000005, null)).toContain('0xC0000005')
    expect(describeExit(0xc0000005, null)).toContain('STATUS_ACCESS_VIOLATION')
    expect(describeExit(0xc0000005 - 2 ** 32, null)).toContain('0xC0000005')
  })

  it('says so when there is neither a code nor a signal', () => {
    expect(describeExit(null, null)).toContain('no code and no signal')
  })
})

describe('formatCrashReport', () => {
  const facts: CrashFacts = {
    pid: 4242,
    code: null,
    signal: 'SIGABRT',
    breadcrumb: {
      pid: 4242,
      state: 'running',
      file: 'src/simhost/__tests__/example.integration.test.ts',
      test: 'suite > the running test',
      updatedAt: 10_000,
      rssMiB: 300,
      peakRssMiB: 350,
      freeMemMiB: 900,
      totalMemMiB: 7000
    },
    ngspiceTail: ['stderr Error: something fatal'],
    liveWorkers: 3,
    cpus: 4,
    freeMemMiB: 800,
    totalMemMiB: 7000,
    platform: 'linux-x64',
    nowMs: 12_500
  }

  it('carries the exit, the file, the test, the memory and the ngspice lines', () => {
    const text = formatCrashReport(facts)
    expect(text).toContain('pid 4242 killed by signal SIGABRT')
    expect(text).toContain('src/simhost/__tests__/example.integration.test.ts')
    expect(text).toContain('suite > the running test')
    expect(text).toContain('peak rss 350 MiB')
    expect(text).toContain('3 worker(s) mid-file, 4 CPU(s)')
    expect(text).toContain('stderr Error: something fatal')
  })

  it('says so when the worker died after finishing its file', () => {
    const b = { ...(facts.breadcrumb as object), state: 'finished' } as CrashFacts['breadcrumb']
    expect(formatCrashReport({ ...facts, breadcrumb: b })).toContain('after finishing its test file')
  })

  it('still reports a worker with no breadcrumb or an unreadable one', () => {
    expect(formatCrashReport({ ...facts, breadcrumb: null })).toContain('before its test file started')
    expect(formatCrashReport({ ...facts, breadcrumb: 'unreadable' })).toContain('while rewriting its breadcrumb')
  })

  it('says when ngspice recorded nothing', () => {
    expect(formatCrashReport({ ...facts, ngspiceTail: [] })).toContain('ngspice stderr: (none recorded')
  })
})

describe('readTail', () => {
  it('returns the last lines and tolerates a missing file', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'circsim-tail-'))
    try {
      const f = join(dir, 'log.txt')
      writeFileSync(f, 'a\nb\n\nc\nd\n')
      expect(readTail(f, 2)).toEqual(['c', 'd'])
      expect(readTail(join(dir, 'missing.txt'), 2)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Run the nested fixture config on one fixture file; the summary file stands in for GITHUB_STEP_SUMMARY. */
function runFixture(fixture: string): { output: string; status: number | null; summary: string } {
  const dir = mkdtempSync(join(os.tmpdir(), 'circsim-crash-run-'))
  const summaryFile = join(dir, 'step-summary.md')
  writeFileSync(summaryFile, '')
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryFile,
      CIRCSIM_CRASH_FIXTURE: fixture
    }
    // The outer run's own trace wiring must not leak into the nested one.
    delete env.CIRCSIM_WORKER_TRACE_DIR
    delete env.CIRCSIM_NGSPICE_TRACE_DIR
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'test/vitest/crash-fixture/vitest.config.mjs'],
      { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    return {
      output: `${run.stdout}\n${run.stderr}`,
      status: run.status,
      summary: readFileSync(summaryFile, 'utf8')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('a crashed fork worker is named in the vitest run (issue #155)', () => {
  it('prints the file, test, exit status and last ngspice stderr line, and writes the job summary', () => {
    const run = runFixture('crash.fixture.ts')
    // The fixture really did kill its worker, and vitest still failed the run.
    expect(run.output).toContain('Worker exited unexpectedly')
    expect(run.status).not.toBe(0)

    for (const text of [run.output, run.summary]) {
      expect(text).toContain('WORKER CRASH')
      expect(text).toContain('crash.fixture.ts')
      expect(text).toContain('crash fixture > dies with the worker mid-test')
      expect(text).toMatch(/killed by signal SIG\w+|exit code \d+/)
      expect(text).toContain('stderr Error: fixture ngspice fatal (deliberate)')
      // stdout chatter is deliberately not recorded.
      expect(text).not.toContain('Doing analysis at TEMP')
    }
  }, 120_000)

  it('a run whose workers all finish normally reports no crash', () => {
    const run = runFixture('ok.fixture.ts')
    expect(run.status).toBe(0)
    expect(run.output).not.toContain('WORKER CRASH')
    expect(run.summary).toBe('')
  }, 120_000)
})

