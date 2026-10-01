/**
 * core/report/diagnostics.ts
 *
 * The diagnostics bundle (issue #26): everything a maintainer needs to see what
 * circsim believed about a board when a reading looked wrong, as a flat list of
 * files the main process zips and saves. Pure TypeScript: the renderer gathers
 * the inputs from the store, main adds the environment and the SimHost output,
 * and this module only lays them out.
 *
 * The board file itself is NOT included, only its name and sha256, so a user
 * can attach the bundle without handing over a design. The decks do carry part
 * references, values and net names (they are the point of the bundle).
 */

import type { Resolution } from '../models/types'
import type { Instrument } from '../spicegen/instruments'

export interface DiagnosticsFile {
  /** Forward-slash relative path inside the bundle. */
  name: string
  text: string
}

export interface DiagnosticsCrash {
  willRespawn: boolean
  exitCode: number | null
  reason: string
  /** Epoch milliseconds. */
  at: number
}

export interface DiagnosticsOp {
  values: Record<string, number>
  /** Which retry-ladder rung converged; absent means direct. */
  method?: string
}

export interface DiagnosticsInput {
  /** ISO 8601 timestamp of when the bundle was assembled. */
  generatedAt: string
  board: {
    fileName: string | null
    schematicFileName: string | null
    /** Lowercase hex sha256 of the .kicad_pcb text; null when no board is open. */
    sha256: string | null
    /** The `(version N)` stamp from the board file header. */
    kicadFileVersion: number | null
  }
  versions: {
    app: string
    ngspice: string | null
  }
  /** The latest SimHost crash the renderer heard about, if any. */
  crash: DiagnosticsCrash | null
  decks: {
    /** Pass 1 of the last operating-point solve (family-default baseline). */
    pass1: string[] | null
    /** Pass 2 of the last solve, when a measured rail changed the circuit. */
    pass2: string[] | null
    pass2Status: 'not-needed' | 'solved' | 'failed' | null
    /** The deck the last transient run or crash replay loaded. */
    run: string[] | null
  }
  /**
   * How the latest operating-point solve ended, and when. `pass1-failed` means
   * the deck in decks.pass1 is the one that did not solve (convergence failure
   * or timeout); there is no op for it. Null when no solve has been attempted.
   */
  solve: { status: 'solved' | 'pass1-failed'; at: number } | null
  /** The operating point of the latest successful solve; null when the latest solve failed. */
  op: DiagnosticsOp | null
  resolutions: Resolution[]
  instruments: Instrument[]
  /** The ngspice log ring, oldest first. */
  log: { level: string; text: string }[]
}

/** Read the `(version N)` stamp off the head of a .kicad_pcb. */
export function kicadFileVersion(boardText: string | null): number | null {
  if (!boardText) return null
  const m = /\(version\s+(\d+)\)/.exec(boardText.slice(0, 4096))
  return m ? Number(m[1]) : null
}

/** Lowercase hex sha256 of a UTF-8 string (Web Crypto: renderer and Node). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** Default save name, e.g. `circsim-diagnostics-blinker-555-20260930-165700.zip`. */
export function bundleFileName(boardFileName: string | null, now: Date): string {
  const stem = (boardFileName ?? 'no-board')
    .replace(/\.kicad_pcb$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `circsim-diagnostics-${stem || 'board'}-${stamp}.zip`
}

const README = `circsim diagnostics bundle

Attach this file to a bug report when a simulated voltage, LED state or
warning looks wrong.

Contents
  manifest.json      App and ngspice versions, board file name and sha256,
                     KiCad file version, latest SimHost crash, deck summary.
  decks/pass1.cir    The SPICE deck of the first operating-point solve. When
                     manifest.json says solve.status is pass1-failed, this is
                     the deck that failed to solve and op.json is null.
  decks/pass2.cir    The second solve, when a measured rail changed the deck.
  decks/run.cir      The deck the last transient run or crash replay loaded.
  ngspice.log        The Sim Log ring (up to 2000 lines), oldest first.
  op.json            The operating point shown on screen and how it converged.
  resolutions.json   Each part: which model tier resolved it, and to what.
  instruments.json   The bench: supplies, generators, probes and leads.
  environment.json   Electron, Chromium, Node, OS (added by the main process).
  simhost-output.log Recent stdout and stderr of the SimHost process.
  crashes.json       SimHost exits this session, with exit codes.

Privacy
  The board file is not included, only its name and sha256. The decks and
  resolutions do contain part references, values and net names.
`

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function deckText(deck: string[]): string {
  return deck.join('\n') + '\n'
}

function modelSummary(r: Resolution): Record<string, unknown> {
  const m = r.model
  if (!m) return {}
  switch (m.kind) {
    case 'primitive':
      return { kind: m.kind, card: m.card }
    case 'subckt':
      return { kind: m.kind, libFile: m.libFile, subcktName: m.subcktName, pinMap: m.pinMap }
    case 'xspice-digital':
      return { kind: m.kind, templateId: m.templateId, pinMap: m.pinMap }
    case 'stub':
      return { kind: m.kind, mode: m.mode }
  }
}

/** Lay the bundle out as files. Order is the order they appear in the zip. */
export function buildDiagnosticsFiles(input: DiagnosticsInput): DiagnosticsFile[] {
  const files: DiagnosticsFile[] = [{ name: 'README.txt', text: README }]

  const deckInfo = (deck: string[] | null): { lines: number } | null =>
    deck ? { lines: deck.length } : null
  files.push({
    name: 'manifest.json',
    text: json({
      generatedAt: input.generatedAt,
      app: input.versions.app,
      ngspice: input.versions.ngspice,
      board: input.board,
      crash: input.crash
        ? { ...input.crash, at: new Date(input.crash.at).toISOString() }
        : null,
      decks: {
        pass1: deckInfo(input.decks.pass1),
        pass2: deckInfo(input.decks.pass2),
        pass2Status: input.decks.pass2Status,
        run: deckInfo(input.decks.run),
      },
      solve: input.solve
        ? { status: input.solve.status, at: new Date(input.solve.at).toISOString() }
        : null,
      opMethod: input.op ? (input.op.method ?? 'direct') : null,
      logLines: input.log.length,
    }),
  })

  if (input.decks.pass1) files.push({ name: 'decks/pass1.cir', text: deckText(input.decks.pass1) })
  if (input.decks.pass2) files.push({ name: 'decks/pass2.cir', text: deckText(input.decks.pass2) })
  if (input.decks.run) files.push({ name: 'decks/run.cir', text: deckText(input.decks.run) })

  files.push({
    name: 'ngspice.log',
    text: input.log.map(l => `[${l.level}] ${l.text}`).join('\n') + (input.log.length ? '\n' : ''),
  })
  files.push({ name: 'op.json', text: json(input.op ?? null) })
  files.push({
    name: 'resolutions.json',
    text: json(
      input.resolutions.map(r => ({
        ref: r.ref,
        status: r.status,
        tier: r.tier,
        model: modelSummary(r),
        warnings: r.warnings,
        ...(r.note ? { note: r.note } : {}),
      })),
    ),
  })
  files.push({ name: 'instruments.json', text: json(input.instruments) })
  return files
}
