/**
 * test/vitest/workerCrashSetup.ts
 *
 * Vitest setup file, runs in every fork worker before its test file. Keeps a
 * breadcrumb (see workerCrash.ts) naming the file and the test being run, with
 * the worker's memory, so that if this process dies the main process can say
 * what it was doing. When the file finishes the breadcrumb is marked finished
 * rather than removed, so a death after that is told apart from one mid-file.
 *
 * Inert unless the main process exported CIRCSIM_WORKER_TRACE_DIR (it does, via
 * workerCrashGlobalSetup.ts), so running a single file under another runner
 * costs nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, expect } from 'vitest'

import { NGSPICE_TRACE_DIR_ENV } from '../../src/simhost/outputTrace'
import { WORKER_TRACE_DIR_ENV, breadcrumbFile, type Breadcrumb } from './workerCrash'

const MIB = 1024 * 1024
/** How often the worker refreshes its memory reading while a test runs. */
const SAMPLE_INTERVAL_MS = 1000

/** "outer describe > inner describe > test" for a task. */
function fullName(task: { name: string; suite?: { name: string; suite?: unknown } }): string {
  const parts: string[] = [task.name]
  let s = task.suite as { name: string; suite?: unknown } | undefined
  while (s) {
    if (s.name) parts.unshift(s.name)
    s = s.suite as { name: string; suite?: unknown } | undefined
  }
  return parts.join(' > ')
}

/** Repo-relative, forward-slash form of a test file path when it is under the cwd. */
function displayPath(p: string): string {
  const rel = path.relative(process.cwd(), p)
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : rel.split(path.sep).join('/')
}

const dir = process.env[WORKER_TRACE_DIR_ENV]

if (dir) {
  // The ngspice stderr trace lives next to the breadcrumbs.
  process.env[NGSPICE_TRACE_DIR_ENV] = dir
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* the writes below are best effort too */
  }

  const file = breadcrumbFile(dir, process.pid)
  let testPath = displayPath(expect.getState().testPath ?? 'unknown')
  let test = '(collecting)'
  let peak = 0
  let state: Breadcrumb['state'] = 'running'

  const write = (): void => {
    const rss = Math.round(process.memoryUsage().rss / MIB)
    peak = Math.max(peak, rss)
    const crumb: Breadcrumb = {
      pid: process.pid,
      state,
      file: testPath,
      test,
      updatedAt: Date.now(),
      rssMiB: rss,
      peakRssMiB: peak,
      freeMemMiB: Math.round(os.freemem() / MIB),
      totalMemMiB: Math.round(os.totalmem() / MIB)
    }
    try {
      writeFileSync(file, JSON.stringify(crumb))
    } catch {
      /* best effort */
    }
  }

  write()
  const timer = setInterval(write, SAMPLE_INTERVAL_MS)
  timer.unref()

  beforeAll((suite) => {
    testPath = suite.file?.filepath ? displayPath(suite.file.filepath) : testPath
    write()
  })
  beforeEach((ctx) => {
    testPath = ctx.task.file?.filepath ? displayPath(ctx.task.file.filepath) : testPath
    test = fullName(ctx.task)
    write()
  })
  afterAll(() => {
    clearInterval(timer)
    // Kept, not deleted: a worker that dies after its file finished (at its
    // own teardown, say) is then reported as that, not as a startup death.
    state = 'finished'
    write()
  })
}
