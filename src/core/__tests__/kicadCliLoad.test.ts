/**
 * Every .kicad_pcb and .kicad_sch shipped as a fixture or bundled sample must
 * load in a real KiCad (via kicad-cli), not merely in circsim's own parser.
 *
 * circsim's parser is deliberately tolerant, so a hand-edited file can pass the
 * whole unit suite while KiCad rejects it (issue #24: segment cards carrying the
 * pad-style `(net N "name")` token, and a `no_connect` nested inside a symbol).
 * This test is the gate that keeps fixtures and samples honest.
 *
 * kicad-cli discovery order: CIRCSIM_KICAD_CLI, PATH, then the standard install
 * locations. When no kicad-cli is found the test is skipped, unless
 * CIRCSIM_REQUIRE_KICAD_CLI=1, in which case a missing kicad-cli is itself a
 * failure so a gate job cannot silently vanish. The oracle is KiCad 10: some
 * fixtures are written in the KiCad 10 board format and an older kicad-cli
 * (for example 9.x) cannot load them.
 *
 * Files are copied to a temp directory first: kicad-cli writes a .kicad_prl
 * next to any board it loads, and fixtures must stay untouched.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCAN_DIRS = [join(ROOT, 'fixtures'), join(ROOT, 'resources', 'sample')]

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.kicad_pcb') || name.endsWith('.kicad_sch')) out.push(p)
  }
}

function findKicadCli(): string | null {
  const exe = process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli'
  const candidates: string[] = []
  if (process.env.CIRCSIM_KICAD_CLI) candidates.push(process.env.CIRCSIM_KICAD_CLI)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, exe))
  }
  if (process.platform === 'win32') {
    const base = process.env.ProgramFiles ?? 'C:\\Program Files'
    const kicadRoot = join(base, 'KiCad')
    if (existsSync(kicadRoot)) {
      for (const v of readdirSync(kicadRoot).sort().reverse()) {
        candidates.push(join(kicadRoot, v, 'bin', exe))
      }
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
  } else {
    candidates.push('/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli')
  }
  return candidates.find((c) => existsSync(c)) ?? null
}

const files: string[] = []
for (const d of SCAN_DIRS) walk(d, files)

const kicadCli = findKicadCli()
const required = process.env.CIRCSIM_REQUIRE_KICAD_CLI === '1'
const scratch = mkdtempSync(join(tmpdir(), 'circsim-kicad-load-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Run kicad-cli on a scratch copy of `file`; returns exit status and combined output. */
function load(cli: string, file: string): { status: number | null; output: string } {
  const isBoard = file.endsWith('.kicad_pcb')
  const copy = join(scratch, `${Math.abs(hash(file))}-${basename(file)}`)
  copyFileSync(file, copy)
  const args = isBoard
    ? ['pcb', 'export', 'ipcd356', '-o', `${copy}.d356`, copy]
    : ['sch', 'export', 'netlist', '-o', `${copy}.net`, copy]
  const r = spawnSync(cli, args, { encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim() }
}

function hash(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return h
}

describe('fixtures and bundled samples load in kicad-cli', () => {
  it('finds at least one board and one schematic to check', () => {
    expect(files.some((f) => f.endsWith('.kicad_pcb'))).toBe(true)
    expect(files.some((f) => f.endsWith('.kicad_sch'))).toBe(true)
  })

  it('has a kicad-cli when the gate is required', () => {
    if (required) expect(kicadCli, 'CIRCSIM_REQUIRE_KICAD_CLI=1 but kicad-cli was not found').not.toBeNull()
  })

  for (const file of files) {
    const rel = relative(ROOT, file).split('\\').join('/')
    it.skipIf(kicadCli === null)(`${rel} loads`, () => {
      const { status, output } = load(kicadCli as string, file)
      expect(output).not.toMatch(/Failed to load/i)
      expect(status, output).toBe(0)
    })
  }
})
