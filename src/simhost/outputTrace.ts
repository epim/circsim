/**
 * src/simhost/outputTrace.ts
 *
 * Crash breadcrumbs for libngspice's own text output (issue #155).
 *
 * libngspice reports its fatal errors on stderr through the SendChar callback
 * and then, on some paths, aborts the whole process. When that happens inside a
 * vitest fork worker the only evidence the runner prints is "Worker exited
 * unexpectedly". The test harness (test/vitest/workerCrash*.ts) names the cause
 * by reading what this module wrote: every ngspice stderr line, and every
 * ControlledExit request, appended synchronously to `ngspice-<pid>.log` in the
 * directory named by CIRCSIM_NGSPICE_TRACE_DIR.
 *
 * Append is synchronous on purpose: a process that dies on the next
 * instruction has already handed the line to the OS.
 *
 * Without the environment variable (production, the packaged app, every normal
 * developer run) every call is a single lookup that returns. Nothing here ever
 * throws into the FFI callback frame.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory the harness points at; unset means tracing is off. */
export const NGSPICE_TRACE_DIR_ENV = 'CIRCSIM_NGSPICE_TRACE_DIR'

/** The trace file one process writes inside `dir`. */
export function ngspiceTraceFile(dir: string, pid: number): string {
  return join(dir, `ngspice-${pid}.log`)
}

function append(line: string): void {
  const dir = process.env[NGSPICE_TRACE_DIR_ENV]
  if (!dir) return
  try {
    appendFileSync(ngspiceTraceFile(dir, process.pid), `${line}\n`)
  } catch {
    /* tracing must never disturb the engine */
  }
}

/**
 * Record one SendChar line. ngspice prefixes each line with the stream it
 * wrote to ("stdout " / "stderr "); only stderr is kept, because stdout carries
 * the per-step progress chatter and would dominate the file.
 */
export function traceNgspiceOutput(text: string): void {
  if (!text.startsWith('stderr')) return
  append(text.replace(/\r?\n$/, '').replace(/\r?\n/g, ' | '))
}

/** Record that ngspice asked the host to exit (the call that precedes an abort). */
export function traceNgspiceExit(status: number, immediate: boolean, quitOnExit: boolean): void {
  append(`controlledExit status=${status} immediate=${immediate} quitOnExit=${quitOnExit}`)
}
