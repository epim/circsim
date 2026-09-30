/**
 * Pad-position oracle (not a test file; imported by tests).
 *
 * Two independent references for "where does KiCad put this pad":
 *
 *  1. Routed copper (`checkPadsAgainstCopper`): on a board that KiCad wrote and
 *     a router connected, every routed pad's center must coincide with a
 *     same-net track endpoint or via. Self-checking, needs no external tool,
 *     so it works on any routed board (the corpus suite calls it per board).
 *
 *  2. kicad-cli Gerber export (`plotPadCentersWithKicadCli` and
 *     `checkPadsAgainstFlashes`): `kicad-cli pcb export gerbers` writes one D03
 *     flash per pad with X2 attributes naming the reference, pad number and
 *     net. Those flash coordinates are KiCad's own computed pad centers.
 *
 * The caller passes the function under test as `padPos`, so the same oracle
 * exercises the critic helper and any renderer helper built on it.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BoardModel, Footprint, Pad, Vec2 } from '../../kicad/types'

export type PadPosFn = (fp: Footprint, pad: Pad) => Vec2

/** A pad center as reported by KiCad (board mm, KiCad Y-down frame). */
export interface PadFlash {
  ref: string
  pad: string
  net: string
  x: number
  y: number
}

// ─── oracle 1: routed copper ──────────────────────────────────────────────────

export interface CopperMismatch {
  ref: string
  pad: string
  at: Vec2
  nearestMm: number
}

/**
 * Every pad with a net that has at least one track endpoint or via on that net
 * must have one of them within `tolMm` of the computed pad center. Returns the
 * pads that fail, plus how many were checked (so a caller can assert the check
 * was not vacuous).
 *
 * On a hand-built fixture every pad is routed to its center, so the expected
 * mismatch list is empty. On a real board some pads are legitimately reported
 * (zone-only connections, tracks that end off-center inside a large pad), so a
 * corpus caller should assert a mismatch RATE against a wrong-formula baseline
 * rather than an empty list.
 */
export function checkPadsAgainstCopper(
  board: BoardModel,
  padPos: PadPosFn,
  tolMm = 0.01,
): { checked: number; mismatches: CopperMismatch[] } {
  const endpoints = new Map<number, Vec2[]>()
  const add = (netId: number | undefined, p: Vec2): void => {
    if (netId === undefined || netId === 0) return
    const list = endpoints.get(netId) ?? []
    list.push(p)
    endpoints.set(netId, list)
  }
  for (const t of board.tracks) {
    add(t.netId, t.start)
    add(t.netId, t.end)
  }
  for (const v of board.vias) add(v.netId, v.at)

  let checked = 0
  const mismatches: CopperMismatch[] = []
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      if (pad.netId === undefined || pad.netId === 0) continue
      const pts = endpoints.get(pad.netId)
      if (!pts || pts.length === 0) continue
      const c = padPos(fp, pad)
      let nearest = Infinity
      for (const p of pts) nearest = Math.min(nearest, Math.hypot(p.x - c.x, p.y - c.y))
      checked++
      if (nearest > tolMm) mismatches.push({ ref: fp.ref, pad: pad.number, at: c, nearestMm: nearest })
    }
  }
  return { checked, mismatches }
}

// ─── oracle 2: kicad-cli gerber flashes ───────────────────────────────────────

/** Parse pad flashes out of one KiCad-written Gerber copper file (format 4.6, mm). */
export function parseGerberPadFlashes(text: string): PadFlash[] {
  const out: PadFlash[] = []
  let ref = ''
  let pad = ''
  let net = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const p = /^%TO\.P,([^,]*),([^*]*)\*%$/.exec(line)
    if (p) {
      ref = p[1]
      pad = p[2]
      net = ''
      continue
    }
    if (line === '%TD*%') {
      // attributes end here; later flashes (vias) are not pads
      ref = ''
      pad = ''
      net = ''
      continue
    }
    const n = /^%TO\.N,([^*]*)\*%$/.exec(line)
    if (n) {
      net = n[1]
      continue
    }
    const f = /^X(-?\d+)Y(-?\d+)D03\*$/.exec(line)
    if (f && ref) {
      // FSLAX46Y46: 6 decimals; Gerber Y is up, KiCad file Y is down.
      out.push({ ref, pad, net, x: Number(f[1]) / 1e6, y: -Number(f[2]) / 1e6 })
    }
  }
  return out
}

/** Locate kicad-cli: $KICAD_CLI, then the standard Windows install, then PATH. */
export function findKicadCli(): string | undefined {
  const env = process.env.KICAD_CLI
  if (env && existsSync(env)) return env
  const win = 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe'
  if (existsSync(win)) return win
  try {
    execFileSync('kicad-cli', ['--version'], { stdio: 'ignore' })
    return 'kicad-cli'
  } catch {
    return undefined
  }
}

/** Run kicad-cli on a board file and return every copper pad flash it plots. */
export function plotPadCentersWithKicadCli(cli: string, boardPath: string): PadFlash[] {
  const dir = mkdtempSync(join(tmpdir(), 'circsim-gerb-'))
  try {
    // Work on a copy: kicad-cli drops a .kicad_prl next to the board it opens.
    const work = join(dir, basename(boardPath))
    copyFileSync(boardPath, work)
    const out = join(dir, 'out')
    execFileSync(cli, ['pcb', 'export', 'gerbers', '--layers', 'F.Cu,B.Cu', '--no-protel-ext', '-o', out + '/', work], {
      stdio: 'ignore',
    })
    const flashes: PadFlash[] = []
    for (const name of readdirSync(out)) {
      if (!name.endsWith('.gbr')) continue
      flashes.push(...parseGerberPadFlashes(readFileSync(join(out, name), 'utf8')))
    }
    return flashes
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface FlashMismatch {
  ref: string
  pad: string
  expected: Vec2
  actual: Vec2
  errMm: number
}

/**
 * Compare computed pad centers with KiCad's flashes. A pad on both copper
 * layers (through-hole) has several flashes at the same point; any one match is
 * enough. Pads KiCad did not flash (no copper on plotted layers) are skipped.
 */
export function checkPadsAgainstFlashes(
  board: BoardModel,
  padPos: PadPosFn,
  flashes: PadFlash[],
  tolMm = 0.001,
): { checked: number; mismatches: FlashMismatch[] } {
  let checked = 0
  const mismatches: FlashMismatch[] = []
  for (const fp of board.footprints) {
    for (const pad of fp.pads) {
      const cands = flashes.filter((f) => f.ref === fp.ref && f.pad === pad.number)
      if (cands.length === 0) continue
      checked++
      const c = padPos(fp, pad)
      let best = cands[0]
      let bestErr = Infinity
      for (const f of cands) {
        const e = Math.hypot(f.x - c.x, f.y - c.y)
        if (e < bestErr) {
          bestErr = e
          best = f
        }
      }
      if (bestErr > tolMm) {
        mismatches.push({ ref: fp.ref, pad: pad.number, expected: { x: best.x, y: best.y }, actual: c, errMm: bestErr })
      }
    }
  }
  return { checked, mismatches }
}
