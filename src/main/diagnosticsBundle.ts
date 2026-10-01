/**
 * src/main/diagnosticsBundle.ts
 *
 * Main-process half of the diagnostics bundle (issue #26). Keeps what only main
 * can see (the SimHost child's stdout/stderr and its exit codes, which packaged
 * apps never show on a console), validates the files the renderer sends, adds
 * its own, and zips the lot. No Electron imports: index.ts wires the save dialog
 * and the filesystem, so this stays testable in plain Node.
 */

import { basename } from 'path'
import type { CrashedPayload } from './simhostSupervisor'
import { buildZip, type ZipOptions } from '../core/report/zip'
import type { DiagnosticsFile } from '../core/report/diagnostics'

const MAX_OUTPUT_CHUNKS = 500
const MAX_CRASHES = 50
const MAX_FILES = 64
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** A chunk of SimHost output, tagged with the stream and when it arrived. */
export interface OutputChunk {
  at: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface CrashRecord extends CrashedPayload {
  at: number
}

/** Rolling record of SimHost output and exits for this app session. */
export class MainDiagnostics {
  private output: OutputChunk[] = []
  private crashes: CrashRecord[] = []

  recordOutput(stream: 'stdout' | 'stderr', text: string, at: number = Date.now()): void {
    this.output.push({ at, stream, text })
    if (this.output.length > MAX_OUTPUT_CHUNKS) this.output.splice(0, this.output.length - MAX_OUTPUT_CHUNKS)
  }

  recordCrash(payload: CrashedPayload, at: number = Date.now()): void {
    this.crashes.push({ ...payload, at })
    if (this.crashes.length > MAX_CRASHES) this.crashes.splice(0, this.crashes.length - MAX_CRASHES)
  }

  /** The files main contributes to a bundle (besides `environment.json`). */
  files(): DiagnosticsFile[] {
    const log = this.output
      .map(c => `${new Date(c.at).toISOString()} [${c.stream}] ${c.text.replace(/\r?\n$/, '')}`)
      .join('\n')
    return [
      { name: 'simhost-output.log', text: log + (log ? '\n' : '') },
      {
        name: 'crashes.json',
        text:
          JSON.stringify(
            this.crashes.map(c => ({ ...c, at: new Date(c.at).toISOString() })),
            null,
            2,
          ) + '\n',
      },
    ]
  }
}

/**
 * Validate what the renderer sent over IPC. Anything that is not an array of
 * `{ name: string, text: string }` with a plain relative name is rejected, so a
 * compromised renderer cannot make main write odd archive paths.
 */
export function validateRendererFiles(value: unknown): DiagnosticsFile[] {
  if (!Array.isArray(value)) throw new Error('diagnostics: files must be an array')
  if (value.length > MAX_FILES) throw new Error('diagnostics: too many files')
  const seen = new Set<string>()
  const out: DiagnosticsFile[] = []
  for (const item of value) {
    const f = item as { name?: unknown; text?: unknown }
    if (typeof f?.name !== 'string' || typeof f.text !== 'string') {
      throw new Error('diagnostics: each file needs a string name and text')
    }
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(f.name) || f.name.split('/').includes('..')) {
      throw new Error(`diagnostics: bad file name ${JSON.stringify(f.name)}`)
    }
    if (seen.has(f.name)) throw new Error(`diagnostics: duplicate file ${f.name}`)
    if (f.text.length > MAX_FILE_BYTES) throw new Error(`diagnostics: ${f.name} is too large`)
    seen.add(f.name)
    out.push({ name: f.name, text: f.text })
  }
  return out
}

/** A safe default file name: no path, always ends in .zip. */
export function sanitizeBundleName(name: unknown): string {
  const base = typeof name === 'string' ? basename(name.replace(/\\/g, '/')) : ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '')
  if (!cleaned) return 'circsim-diagnostics.zip'
  return /\.zip$/i.test(cleaned) ? cleaned : `${cleaned}.zip`
}

/**
 * Zip the renderer's files plus main's. Main's files win a name collision, so
 * the renderer cannot forge `environment.json` or the crash history.
 */
export function assembleBundle(
  rendererFiles: DiagnosticsFile[],
  mainFiles: DiagnosticsFile[],
  zipOpts: ZipOptions = {},
): Uint8Array {
  const mainNames = new Set(mainFiles.map(f => f.name))
  const all = [...rendererFiles.filter(f => !mainNames.has(f.name)), ...mainFiles]
  return buildZip(
    all.map(f => ({ name: f.name, data: f.text })),
    zipOpts,
  )
}
