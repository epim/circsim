/**
 * src/cli/main.ts
 *
 * The headless circsim CLI (issue #28): `audit`, `deck` and `op`, running the
 * same core pipeline the GUI runs (parseBoard, extract, resolveAll, the
 * src/core/solve two-pass plan, runCritic) on the in-process ngspice engine.
 * No Electron, no network, and no design file is ever written.
 *
 * runCli takes injected I/O so tests drive it without spawning a process.
 * Exit codes: 0 ok, 1 audit found error-severity findings, 2 usage or input
 * error, 3 the simulation failed or could not run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { runCritic } from '../core/critic/run'
import type { CriticReport } from '../core/critic/types'
import { buildDeck, runSolvePlan, SolveFailedError, type SolveResult } from '../core/solve'
import { ngspiceResourcesAvailable, resolveNgspicePaths } from '../simhost/ngspiceFfi'
import { createInProcessSolveEngine } from '../simhost/solveEngine'
import { HELP_TEXT, parseArgs, type CliOptions } from './args'
import { buildCriticOpFromSolve } from './criticOp'
import { withCopperFindings } from './copperFindings'
import { findPackageRoot, loadModelLibrary, resolveModelsDir } from './modelLibrary'
import {
  auditJson,
  auditText,
  deckJson,
  opJson,
  opText,
  solveSummary,
  type SolveSummary,
} from './report'
import { InputError, openSession, type Session } from './session'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
}

export const EXIT_OK = 0
export const EXIT_FINDINGS = 1
export const EXIT_USAGE = 2
export const EXIT_SIM = 3

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'help') {
    io.stdout(HELP_TEXT)
    return EXIT_OK
  }
  if (parsed.kind === 'version') {
    io.stdout(`${readVersion()}\n`)
    return EXIT_OK
  }
  if (parsed.kind === 'error') {
    io.stderr(`circsim: ${parsed.message}\n`)
    return EXIT_USAGE
  }
  const opts = parsed.options

  try {
    const library = loadModelLibrary(resolveModelsDir(opts.modelsDir, io.env, __dirname))
    const session = openSession(opts, library, io.cwd)
    switch (opts.command) {
      case 'audit':
        return await audit(opts, session, io)
      case 'op':
        return await op(opts, session, io)
      case 'deck':
        return await deck(opts, session, io)
    }
  } catch (err) {
    io.stderr(`circsim: ${err instanceof Error ? err.message : String(err)}\n`)
    return err instanceof InputError ? EXIT_USAGE : EXIT_SIM
  }
}

// ─── commands ─────────────────────────────────────────────────────────────────

async function audit(opts: CliOptions, session: Session, io: CliIo): Promise<number> {
  let solved: SolveResult | null = null
  let solve: SolveSummary
  if (opts.noOp) {
    solve = solveSummary(session, null, 'skipped by --no-op')
  } else if (session.cannotSolve !== null || session.inputs === null) {
    solve = solveSummary(session, null, session.cannotSolve ?? 'no solve inputs')
  } else {
    const r = await solveSession(opts, session, io)
    solved = r.solved
    solve = solveSummary(session, r.solved, r.error, r.ngspiceErrors)
  }

  const critic: CriticReport = withCopperFindings(runCritic(
    session.board,
    session.circuit,
    solved ? buildCriticOpFromSolve(session.circuit, session.resolutions, solved) : undefined,
  ), session.board, solved?.copper)

  // A gate must not pass clean when the simulation it asked for did not run.
  let code = EXIT_OK
  if (solved?.op.method === 'failed') code = EXIT_SIM
  else if (critic.summary.error > 0) code = EXIT_FINDINGS
  else if (!solve.ran && !opts.noOp) code = EXIT_SIM

  if (opts.json) io.stdout(JSON.stringify(auditJson(session, solve, critic, code), null, 2) + '\n')
  else {
    io.stdout(auditText(session, solve, critic))
    if (!solve.ran && !opts.noOp) {
      io.stderr(`circsim: simulation-dependent checks did not run: ${solve.reason}\n`)
    }
  }
  return code
}

async function op(opts: CliOptions, session: Session, io: CliIo): Promise<number> {
  if (session.cannotSolve !== null || session.inputs === null) {
    io.stderr(`circsim: ${session.cannotSolve ?? 'nothing to solve'}\n`)
    return EXIT_USAGE
  }
  const r = await solveSession(opts, session, io)
  const solve = solveSummary(session, r.solved, r.error, r.ngspiceErrors)
  if (!r.solved) {
    io.stderr(`circsim: ${r.error}\n`)
    if (opts.json) io.stdout(JSON.stringify(opJson(session, solve, null), null, 2) + '\n')
    return EXIT_SIM
  }
  io.stdout(opts.json ? JSON.stringify(opJson(session, solve, r.solved), null, 2) + '\n' : opText(session, solve, r.solved))
  return solve.ran ? EXIT_OK : EXIT_SIM
}

async function deck(opts: CliOptions, session: Session, io: CliIo): Promise<number> {
  if (session.cannotSolve !== null || session.inputs === null) {
    io.stderr(`circsim: ${session.cannotSolve ?? 'nothing to build'}\n`)
    return EXIT_USAGE
  }
  const outDir = resolve(io.cwd, opts.outDir ?? '.')
  const base = session.boardName.replace(/\.kicad_pcb$/i, '')
  const files: string[] = []
  const write = (suffix: string, lines: string[]): void => {
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, `${base}.${suffix}.cir`)
    writeFileSync(path, lines.join('\n') + '\n', 'utf8')
    files.push(path)
  }

  // Pass 1 is the family-default baseline and needs no simulator.
  const pass1 = buildDeck({ ...session.inputs, measuredRails: undefined })
  write('pass1', pass1)

  let solve: SolveSummary
  let code = EXIT_OK
  if (opts.pass1Only) {
    solve = solveSummary(session, null, 'skipped by --pass1-only')
  } else {
    // Pass 2 exists only if a rail measured off pass 1's op changed the deck.
    const r = await solveSession(opts, session, io)
    solve = solveSummary(session, r.solved, r.error, r.ngspiceErrors)
    if (r.solved?.pass2Deck) write('pass2', r.solved.pass2Deck)
    if (!r.solved) {
      io.stderr(`circsim: ${r.error}; wrote the pass-1 deck only\n`)
      code = EXIT_SIM
    }
  }

  if (opts.json) io.stdout(JSON.stringify(deckJson(session, solve, files), null, 2) + '\n')
  else {
    for (const f of files) io.stdout(`wrote ${f}\n`)
    if (solve.ran && solve.pass2 === 'not-needed') io.stdout('pass 2 not needed: no measured rail changed the deck\n')
  }
  return code
}

// ─── solve ────────────────────────────────────────────────────────────────────

interface SolveOutcome {
  solved: SolveResult | null
  error?: string
  ngspiceErrors: string[]
}

/**
 * True when `target` lies under `base`. path.relative returns an absolute path
 * (not a "..") when the two sit on different Windows drives, so that case is
 * outside as well.
 */
export function isInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Start the in-process engine, run the two-pass plan, and always release ngspice. */
async function solveSession(opts: CliOptions, session: Session, io: CliIo): Promise<SolveOutcome> {
  const ngspiceErrors: string[] = []
  const baseDir = opts.ngspiceDir ?? (io.env.CIRCSIM_NGSPICE_DIR || undefined)
  // resolveNgspicePaths falls back to the repo layout when an override is
  // missing; an explicit directory that does not hold ngspice is an error, not
  // a silent switch to a different ngspice.
  const found = ngspiceResourcesAvailable(baseDir)
  const insideOverride = baseDir === undefined || isInside(baseDir, resolveNgspicePaths(baseDir).libPath)
  if (!found || !insideOverride) {
    const where = baseDir ? `under ${baseDir}` : 'in the default resources/ngspice location'
    return {
      solved: null,
      error: `ngspice library not found ${where}; run "npm run fetch:ngspice" or set CIRCSIM_NGSPICE_DIR`,
      ngspiceErrors,
    }
  }

  let engine: Awaited<ReturnType<typeof createInProcessSolveEngine>> | null = null
  try {
    engine = await createInProcessSolveEngine({
      resourcesBaseDir: baseDir,
      onEvent: (ev) => {
        if (ev.type === 'log') {
          if (ev.level === 'error') ngspiceErrors.push(ev.text)
          if (opts.verbose) io.stderr(`ngspice: ${ev.text}\n`)
        }
      },
    })
    const solved = await runSolvePlan(session.inputs!, engine)
    return { solved, ngspiceErrors }
  } catch (err) {
    const message = err instanceof SolveFailedError || err instanceof Error ? err.message : String(err)
    return { solved: null, error: message, ngspiceErrors }
  } finally {
    await engine?.dispose().catch(() => undefined)
  }
}

function readVersion(): string {
  const root = findPackageRoot(__dirname)
  if (!root) return 'unknown'
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
