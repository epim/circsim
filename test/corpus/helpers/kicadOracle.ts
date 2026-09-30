/**
 * test/corpus/helpers/kicadOracle.ts - kicad-cli as an independent connectivity oracle.
 *
 * circsim's own netlist extraction (src/core/netlist/extract.ts) reads pad-to-net
 * assignments straight from the .kicad_pcb text. Checking it against itself proves
 * nothing, so this module asks KiCad: `kicad-cli pcb export ipc2581` writes, for
 * every net, the list of (component, pin) pads on it, with untruncated net names
 * and the pad world positions as KiCad computed them. (IPC-D-356, the other export,
 * truncates net names to 14 characters, so it is not usable as a name-level oracle.)
 *
 * Node only. Used by the corpus suite.
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Known install locations, tried after CIRCSIM_KICAD_CLI and PATH. */
const KNOWN_LOCATIONS = [
  'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe',
  'C:\\Program Files\\KiCad\\9.0\\bin\\kicad-cli.exe',
  'C:\\Program Files\\KiCad\\8.0\\bin\\kicad-cli.exe',
  '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
  '/usr/bin/kicad-cli',
  '/usr/local/bin/kicad-cli'
]

export interface KicadCli {
  path: string
  version: string
}

/**
 * Locate kicad-cli. Returns null when it is not installed.
 * Order: $CIRCSIM_KICAD_CLI, PATH, known install locations.
 */
export function findKicadCli(): KicadCli | null {
  // CIRCSIM_KICAD_CLI=none forces the no-kicad-cli path (what CI without KiCad runs).
  if (process.env.CIRCSIM_KICAD_CLI === 'none') return null
  const candidates: string[] = []
  if (process.env.CIRCSIM_KICAD_CLI) candidates.push(process.env.CIRCSIM_KICAD_CLI)
  candidates.push('kicad-cli', ...KNOWN_LOCATIONS)
  for (const cand of candidates) {
    if (cand !== 'kicad-cli' && !fs.existsSync(cand)) continue
    try {
      const out = execFileSync(cand, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
      return { path: cand, version: out }
    } catch {
      // not runnable, try the next candidate
    }
  }
  return null
}

/**
 * Export a board to IPC-2581 XML. kicad-cli writes <board>.kicad_prl next to its
 * input, so the board is copied into a scratch directory first: a user's (or the
 * corpus cache's) directory is never written to.
 */
export function exportIpc2581(cliPath: string, boardPath: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circsim-oracle-'))
  try {
    const copy = path.join(dir, 'board.kicad_pcb')
    const out = path.join(dir, 'board.xml')
    fs.copyFileSync(boardPath, copy)
    execFileSync(cliPath, ['pcb', 'export', 'ipc2581', '-o', out, copy], {
      stdio: 'pipe',
      timeout: 180_000,
      maxBuffer: 1 << 26
    })
    return fs.readFileSync(out, 'utf8')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export interface OraclePad {
  net: string
  /** Pad centre, mm, IPC orientation (y is the negation of the .kicad_pcb y). */
  x: number
  y: number
  rotDeg: number
}

/**
 * Parse an IPC-2581 document into per-pad records keyed "ref\tpin".
 *
 * A through-hole pad is listed once per copper layer by KiCad; the layers agree
 * on net and position, so the first sighting wins. Pads KiCad puts in an unnamed
 * set (no net) are not returned.
 */
export function parseIpc2581Pads(xml: string): Map<string, OraclePad> {
  const pads = new Map<string, OraclePad>()
  const setRe = /<Set\b([^>]*)>([\s\S]*?)<\/Set>/g
  let setMatch: RegExpExecArray | null
  while ((setMatch = setRe.exec(xml)) !== null) {
    const netAttr = /\bnet="([^"]*)"/.exec(setMatch[1])
    if (!netAttr) continue
    const net = unescapeXml(netAttr[1])
    const padRe = /<Pad\b[^>]*>([\s\S]*?)<\/Pad>/g
    let padMatch: RegExpExecArray | null
    while ((padMatch = padRe.exec(setMatch[2])) !== null) {
      const body = padMatch[1]
      const pin = /<PinRef\b[^>]*\bcomponentRef="([^"]*)"[^>]*\bpin="([^"]*)"/.exec(body)
      if (!pin) continue
      const loc = /<Location\b[^>]*\bx="([^"]*)"[^>]*\by="([^"]*)"/.exec(body)
      const rot = /<Xform\b[^>]*\brotation="([^"]*)"/.exec(body)
      const key = `${unescapeXml(pin[1])}\t${unescapeXml(pin[2])}`
      if (pads.has(key)) continue
      pads.set(key, {
        net,
        x: loc ? Number(loc[1]) : NaN,
        y: loc ? Number(loc[2]) : NaN,
        rotDeg: rot ? Number(rot[1]) : 0
      })
    }
  }
  return pads
}

/**
 * sha256 of the connectivity PARTITION of a pad-to-net map: pads sorted by key,
 * each net replaced by its order of first appearance. Net names never enter the
 * digest, because KiCad's exporters legitimately rename nets (for example an
 * inner copper layer named GND makes IPC-2581 write the net as GND_2), while two
 * pads being on the same net or not is the fact circsim must get right.
 */
export function partitionDigest(padToNet: Map<string, string>): string {
  const keys = [...padToNet.keys()].sort()
  const label = new Map<string, number>()
  const lines: string[] = []
  for (const k of keys) {
    const net = padToNet.get(k)!
    if (!label.has(net)) label.set(net, label.size)
    lines.push(`${k}\t${label.get(net)}`)
  }
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

/**
 * Refs that cannot be compared one-to-one: refs duplicated in the board (KiCad
 * renames the extras in IPC-2581, e.g. "POLY" -> "POLY_1") and the renamed forms.
 */
export function ambiguousRefPredicate(refsInBoard: string[]): (ref: string) => boolean {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of refsInBoard) {
    if (seen.has(r)) dup.add(r)
    seen.add(r)
  }
  return (ref: string) => {
    if (dup.has(ref)) return true
    const m = /^(.*)_\d+$/.exec(ref)
    return !!m && dup.has(m[1])
  }
}

/**
 * IPC-2581 pad map for a corpus board, cached on disk next to the board so the
 * several suites that need KiCad's answer pay for one kicad-cli run. The cache
 * key includes the board's sha256 and the kicad-cli version.
 */
export function oraclePadsCached(cli: KicadCli, boardPath: string, boardSha: string): Map<string, OraclePad> {
  const tag = crypto.createHash('sha256').update(`${boardSha}|${cli.version}`).digest('hex').slice(0, 16)
  const cacheDir = path.join(path.dirname(boardPath), 'oracle-cache')
  const cacheFile = path.join(cacheDir, `${path.basename(boardPath)}.${tag}.json`)
  if (fs.existsSync(cacheFile)) {
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as [string, OraclePad][]
    return new Map(rows)
  }
  const pads = parseIpc2581Pads(exportIpc2581(cli.path, boardPath))
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(cacheFile, JSON.stringify([...pads]))
  return pads
}

export interface DrcSummary {
  violations: number
  unconnected: number
}

/**
 * Run `kicad-cli pcb drc` on a scratch copy and return the violation and
 * unconnected-item counts. Only the unconnected count is a connectivity oracle;
 * the synthetic boards carry an uncut pour as their zone fill, so clearance
 * violations against the pour are expected noise there.
 */
export function runDrc(cliPath: string, boardPath: string): DrcSummary {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circsim-drc-'))
  try {
    const copy = path.join(dir, 'board.kicad_pcb')
    const out = path.join(dir, 'drc.json')
    fs.copyFileSync(boardPath, copy)
    try {
      execFileSync(cliPath, ['pcb', 'drc', '--format', 'json', '--severity-all', '-o', out, copy], {
        stdio: 'pipe',
        timeout: 180_000
      })
    } catch {
      // A non-zero exit still leaves the report; read it below.
    }
    const report = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      violations?: unknown[]
      unconnected_items?: unknown[]
    }
    return { violations: report.violations?.length ?? 0, unconnected: report.unconnected_items?.length ?? 0 }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
