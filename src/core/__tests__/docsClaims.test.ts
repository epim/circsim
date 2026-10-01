/**
 * Positioning and KiCad-support claims in the docs, checked against what the repo proves
 * (issues #63, #64, #65).
 *
 * The support statement is derived from scripts/corpus-manifest.json, the same file
 * `npm run test:corpus` fetches and runs: every KiCad major listed in the docs has
 * KiCad-written boards behind it, and a board the suite requires to fail is named
 * instead of hidden. The positioning checks keep the narrowing phrases the council
 * flagged from coming back.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

interface ManifestBoard {
  id: string
  kicadMajor: number
  formatVersion: number
  source: string
  knownFailing?: { issue: string; stage: string }
}
const manifest = JSON.parse(read('scripts/corpus-manifest.json')) as { boards: ManifestBoard[] }

function docFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '.vitepress' || name === 'node_modules') continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...docFiles(rel))
    else if (name.endsWith('.md')) out.push(rel)
  }
  return out
}
const PUBLIC_DOCS = ['README.md', ...docFiles('website/docs')]

describe('KiCad support statement (backed by the corpus manifest)', () => {
  const majors = [...new Set(manifest.boards.map((b) => b.kicadMajor))].sort((a, b) => a - b)
  const lo = majors[0]
  const hi = majors[majors.length - 1]

  it('the corpus covers every KiCad major from the oldest to the newest it claims', () => {
    for (let m = lo; m <= hi; m++) expect(majors, `KiCad ${m}`).toContain(m)
    expect([lo, hi]).toEqual([6, 10])
  })

  it('README and the docs state the same range the corpus covers', () => {
    const claim = `KiCad ${lo} to ${hi}`
    expect(read('README.md')).toContain(claim)
    expect(read('website/docs/reference/file-formats.md')).toContain(claim)
    expect(read('website/docs/start/install.md')).toContain(claim)
    expect(read('website/docs/guides/open-board.md')).toContain(claim)
  })

  it('no page keeps the old range or an open-ended "or newer"', () => {
    for (const f of PUBLIC_DOCS) {
      const text = read(f)
      expect(text, f).not.toMatch(/KiCad 6\s*(?:–|-)\s*9\b/)
      // "KiCad 6 to 9" is fine when it describes the numeric-net-table generations; not as a support range.
      expect(text, f).not.toMatch(/\(KiCad 6 to 9\)/)
      expect(text, f).not.toMatch(/KiCad 6 (?:or|and) newer/)
    }
  })

  it('the version table in file-formats.md matches the manifest row for row', () => {
    const doc = read('website/docs/reference/file-formats.md')
    for (const major of majors) {
      const boards = manifest.boards.filter((b) => b.kicadMajor === major)
      const formats = [...new Set(boards.map((b) => b.formatVersion))].sort((a, b) => a - b).join(', ')
      const opens = boards.filter((b) => !b.knownFailing).length
      const row = `| KiCad ${major} | ${formats} | ${boards.length} | ${opens} |`
      expect(doc, `row for KiCad ${major}`).toContain(row)
    }
  })

  it('a board the corpus requires to fail is named in the support statement', () => {
    const doc = read('website/docs/reference/file-formats.md')
    const failing = manifest.boards.filter((b) => b.knownFailing)
    expect(failing.length).toBeGreaterThan(0)
    for (const b of failing) {
      const file = b.source.split('/').pop()!.replace(/\.kicad_pcb$/, '')
      expect(doc, b.id).toContain(file)
    }
  })

  it('the name-only net format is attributed to KiCad 10 (format 20260206), not KiCad 9', () => {
    for (const f of PUBLIC_DOCS) {
      const text = read(f)
      expect(text, f).not.toMatch(/KiCad 9 (?:\/|\(and)[^.]*2026/)
      expect(text, f).not.toMatch(/KiCad 9[^.]*dropped the numeric/)
    }
    expect(read('website/docs/reference/file-formats.md')).toMatch(/KiCad 10[^.]*20260206/)
    expect(read('website/docs/concepts/board-to-circuit.md')).toMatch(/KiCad 10[^.]*name/)
    const header = read('fixtures/fixture-rc-v10.kicad_pcb').slice(0, 200)
    expect(header).toContain('(version 20260206)')
    expect(header).toContain('(generator_version "10.0")')
    expect(existsSync(join(ROOT, 'fixtures/fixture-rc-v9.kicad_pcb'))).toBe(false)
  })
})

describe('positioning (issues #64, #65)', () => {
  const heroOf = (text: string, endMarker: RegExp): string => text.split(endMarker)[0]

  it('Quilter is a named way in, not the premise: the hero and README lead do not mention it', () => {
    expect(heroOf(read('website/docs/index.md'), /^## /m)).not.toMatch(/quilter/i)
    expect(heroOf(read('README.md'), /^## /m)).not.toMatch(/quilter/i)
    expect(read('website/docs/reference/file-formats.md')).toMatch(/quilter/i)
  })

  it('the hero leads with any routed KiCad board', () => {
    expect(heroOf(read('website/docs/index.md'), /^## /m)).toMatch(/any routed KiCad board/)
    expect(heroOf(read('README.md'), /^## /m)).toMatch(/any routed KiCad board/)
  })

  it('the narrowing claims the council flagged are gone', () => {
    const banned = [
      /often no clean schematic/i,
      /every other hobbyist simulator wants a schematic/i,
      /wants you to \*?draw a schematic first/i,
      /none of them accept a routed board/i,
      /starts from your board, not a schematic/i
    ]
    for (const f of PUBLIC_DOCS) {
      const text = read(f)
      for (const re of banned) expect(text, `${f} ${re}`).not.toMatch(re)
    }
  })

  it('the schematic is documented as an optional input that circsim picks up next to the board', () => {
    const doc = read('website/docs/guides/attach-schematic.md')
    expect(doc).toMatch(/same folder/)
    expect(doc).toMatch(/same (?:base )?name/)
    // src/renderer/src/ipc/fileOpen.ts siblingSchematicPath, covered by store/__tests__/fileOpen.test.ts
    const fileOpen = read('src/renderer/src/ipc/fileOpen.ts')
    expect(fileOpen).toContain('${name}.kicad_sch')
  })

  it('the docs say the simulation treats nets as ideal nodes while the Critic reads the copper', () => {
    const doc = read('website/docs/concepts/validation-bench.md')
    expect(doc).toMatch(/ideal node/)
    expect(doc).toMatch(/Critic/)
  })
})
