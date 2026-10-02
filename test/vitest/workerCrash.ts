/**
 * test/vitest/workerCrash.ts
 *
 * Shared pieces of the worker-crash diagnostics (issue #155): what a vitest
 * fork worker leaves behind while it runs a test file, and how the runner turns
 * that plus the child's exit status into a report.
 *
 * Why this exists. A fork worker that dies mid-file (libngspice aborting the
 * process, the OS killing it for memory) surfaces in vitest only as
 * "Error: Worker exited unexpectedly": no file, no exit code, no signal, no
 * ngspice message. The pieces:
 *
 *   workerCrashSetup.ts        runs in each worker: keeps a breadcrumb file
 *                              (file, running test, memory) current.
 *   src/simhost/outputTrace.ts appends ngspice's stderr lines to a per-pid log.
 *   workerCrashGlobalSetup.ts  runs in the vitest main process: watches every
 *                              test worker's exit, and when one exits without
 *                              having been asked to, prints this report and
 *                              appends it to the CI job summary.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Directory the main process creates and exports to the workers. */
export const WORKER_TRACE_DIR_ENV = 'CIRCSIM_WORKER_TRACE_DIR'

/** What a worker keeps current while it runs one test file. */
export interface Breadcrumb {
  pid: number
  /** 'running' while a file is in progress; 'finished' once its last hook ran. */
  state: 'running' | 'finished'
  /** Test file the worker is running ("unknown" until vitest names it). */
  file: string
  /** Full name of the test that started last ("(collecting)" before the first). */
  test: string
  /** Wall-clock ms (Date.now) of the last update. */
  updatedAt: number
  /** Resident set size of the worker, MiB, at the last update. */
  rssMiB: number
  /** Highest rssMiB seen by this worker so far. */
  peakRssMiB: number
  /** os.freemem() at the last update, MiB. */
  freeMemMiB: number
  /** os.totalmem(), MiB. */
  totalMemMiB: number
}

export function breadcrumbFile(dir: string, pid: number): string {
  return join(dir, `worker-${pid}.json`)
}

/**
 * The worker's breadcrumb: null when it never wrote one (it died before its
 * setup file ran), 'unreadable' when the file exists but does not parse (the
 * worker died in the middle of rewriting it).
 */
export function readBreadcrumb(dir: string, pid: number): Breadcrumb | 'unreadable' | null {
  const file = breadcrumbFile(dir, pid)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Breadcrumb
  } catch {
    return 'unreadable'
  }
}

/** Number of workers whose breadcrumb says they are mid-file. */
export function liveWorkerCount(dir: string): number {
  try {
    return readdirSync(dir)
      .filter((n) => /^worker-\d+\.json$/.test(n))
      .filter((n) => {
        try {
          return (JSON.parse(readFileSync(join(dir, n), 'utf8')) as Breadcrumb).state === 'running'
        } catch {
          return true // mid-rewrite: it was running
        }
      }).length
  } catch {
    return 0
  }
}

/** Last `max` non-empty lines of `file` ([] when it does not exist). */
export function readTail(file: string, max: number): string[] {
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
    return lines.slice(-max)
  } catch {
    return []
  }
}

/** Windows NTSTATUS exit codes a native crash produces. */
const NTSTATUS: Record<number, string> = {
  0xc0000005: 'STATUS_ACCESS_VIOLATION (segfault)',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN (fail-fast / abort)',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc0000135: 'STATUS_DLL_NOT_FOUND',
  0x80000003: 'STATUS_BREAKPOINT'
}

/** One phrase for a child's exit: its signal if it had one, else its code. */
export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `killed by signal ${signal}`
  if (code === null) return 'exited with no code and no signal'
  const unsigned = code < 0 ? code >>> 0 : code
  if (unsigned > 255) {
    const name = NTSTATUS[unsigned]
    return `exit code ${unsigned} (0x${unsigned.toString(16).toUpperCase()}${name ? `, ${name}` : ''})`
  }
  return `exit code ${code}`
}

export interface CrashFacts {
  pid: number
  code: number | null
  signal: string | null
  breadcrumb: Breadcrumb | 'unreadable' | null
  /** Tail of the worker's ngspice stderr trace. */
  ngspiceTail: string[]
  /** Workers mid-file when this one died, itself included. */
  liveWorkers: number
  /** Logical CPUs and system memory seen by the main process at the exit. */
  cpus: number
  freeMemMiB: number
  totalMemMiB: number
  platform: string
  nowMs: number
}

/** The report text: plain, no markup beyond a markdown-safe layout. */
export function formatCrashReport(f: CrashFacts): string {
  const b = f.breadcrumb
  const out: string[] = []
  if (b === null) {
    out.push(`WORKER CRASH: pid ${f.pid} ${describeExit(f.code, f.signal)} before its test file started`)
    out.push('  file: (unknown: the worker died before its setup file wrote a breadcrumb)')
  } else if (b === 'unreadable') {
    out.push(`WORKER CRASH: pid ${f.pid} ${describeExit(f.code, f.signal)} while running a test file`)
    out.push('  file: (unknown: the worker died while rewriting its breadcrumb)')
  } else {
    const where = b.state === 'running' ? 'while running a test file' : 'after finishing its test file'
    out.push(`WORKER CRASH: pid ${f.pid} ${describeExit(f.code, f.signal)} ${where}`)
    out.push(`  file: ${b.file}`)
    out.push(`  ${b.state === 'running' ? 'last test started' : 'last test run'}: ${b.test}`)
    const ageS = Math.max(0, (f.nowMs - b.updatedAt) / 1000)
    out.push(
      `  worker memory at last update (${ageS.toFixed(1)} s before the exit was seen): ` +
        `rss ${b.rssMiB} MiB, peak rss ${b.peakRssMiB} MiB, system free ${b.freeMemMiB} of ${b.totalMemMiB} MiB`
    )
  }
  out.push(
    `  at the exit: ${f.liveWorkers} worker(s) mid-file, ${f.cpus} CPU(s), ` +
      `system free ${f.freeMemMiB} of ${f.totalMemMiB} MiB, platform ${f.platform}`
  )
  if (f.ngspiceTail.length === 0) {
    out.push('  ngspice stderr: (none recorded; the worker died without ngspice reporting an error)')
  } else {
    out.push(`  ngspice stderr, last ${f.ngspiceTail.length} line(s):`)
    for (const l of f.ngspiceTail) out.push(`    ${l}`)
  }
  return out.join('\n')
}

/** The same report as a markdown block for the GitHub job summary. */
export function formatSummaryMarkdown(f: CrashFacts): string {
  return ['### vitest worker crash', '', '```', formatCrashReport(f), '```', ''].join('\n')
}
