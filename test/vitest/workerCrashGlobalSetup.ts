/**
 * test/vitest/workerCrashGlobalSetup.ts
 *
 * Vitest globalSetup, runs once in the MAIN process. It makes a fork worker's
 * death name its cause (issue #155; see workerCrash.ts for the whole picture).
 *
 * Vitest's own message for a dead worker carries nothing but "Worker exited
 * unexpectedly", because tinypool swallows the exit code and signal. The main
 * process is the one place that still sees them, as the 'exit' event of the
 * child process. This file watches that event for every test worker the
 * process spawns (a wrapper on ChildProcess.prototype.emit, so it does not
 * depend on how the pool imports fork). A worker that exits without having been
 * asked to (tinypool asks with kill(), which sets `killed`) is reported: the
 * report goes to stderr and is appended to GITHUB_STEP_SUMMARY.
 *
 * This only observes. It retries nothing and never changes a test's outcome.
 */

import { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { ngspiceTraceFile } from '../../src/simhost/outputTrace'
import {
  WORKER_TRACE_DIR_ENV,
  formatCrashReport,
  formatSummaryMarkdown,
  liveWorkerCount,
  readBreadcrumb,
  readTail,
  type CrashFacts
} from './workerCrash'

const MIB = 1024 * 1024
/** Lines of the worker's ngspice stderr trace shown in the report. */
const NGSPICE_TAIL_LINES = 20

/** True for the child processes tinypool forks to run test files. */
function isTestWorker(child: ChildProcess): boolean {
  return child.spawnargs.some((a) => /tinypool[\\/]/.test(a))
}

export default function setup(): () => void {
  const dir = mkdtempSync(join(os.tmpdir(), 'circsim-worker-trace-'))
  // Workers are forked after globalSetup returns, so they inherit this.
  process.env[WORKER_TRACE_DIR_ENV] = dir

  const crashes: string[] = []
  const originalEmit = ChildProcess.prototype.emit

  ChildProcess.prototype.emit = function patchedEmit(
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === 'exit' && this.pid !== undefined && !this.killed && isTestWorker(this)) {
      try {
        onWorkerExit(this.pid, (args[0] as number | null) ?? null, (args[1] as string | null) ?? null)
      } catch {
        /* a reporting bug must never change how vitest sees the exit */
      }
    }
    return Reflect.apply(originalEmit, this, [event, ...args]) as boolean
  } as typeof ChildProcess.prototype.emit

  function onWorkerExit(pid: number, code: number | null, signal: string | null): void {
    const breadcrumb = readBreadcrumb(dir, pid)
    // A worker that finished its file and then left on its own with status 0
    // (the IPC channel closing at the end of the run) is not a crash.
    if (code === 0 && signal === null && breadcrumb !== null && breadcrumb !== 'unreadable' && breadcrumb.state === 'finished') {
      return
    }
    const facts: CrashFacts = {
      pid,
      code,
      signal,
      breadcrumb,
      ngspiceTail: readTail(ngspiceTraceFile(dir, pid), NGSPICE_TAIL_LINES),
      liveWorkers: liveWorkerCount(dir),
      cpus: os.cpus().length,
      freeMemMiB: Math.round(os.freemem() / MIB),
      totalMemMiB: Math.round(os.totalmem() / MIB),
      platform: `${process.platform}-${process.arch}`,
      nowMs: Date.now()
    }
    const report = formatCrashReport(facts)
    const file = breadcrumb !== null && breadcrumb !== 'unreadable' ? breadcrumb.file : 'unknown file'
    crashes.push(`pid ${pid}: ${file}`)
    process.stderr.write(`\n${report}\n\n`)
    const summary = process.env.GITHUB_STEP_SUMMARY
    if (summary) {
      try {
        appendFileSync(summary, `${formatSummaryMarkdown(facts)}\n`)
      } catch {
        /* the console copy above is the primary one */
      }
    }
    try {
      writeFileSync(join(dir, `crash-${pid}.txt`), `${report}\n`)
    } catch {
      /* best effort */
    }
  }

  return function teardown(): void {
    ChildProcess.prototype.emit = originalEmit
    if (crashes.length > 0) {
      process.stderr.write(
        `\n${crashes.length} vitest worker(s) died unexpectedly (details above and in ${dir}):\n` +
          `${crashes.map((c) => `  ${c}`).join('\n')}\n`
      )
      return // keep the trace directory for the post-mortem
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp dir, the OS will reap it */
    }
  }
}
