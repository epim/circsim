/**
 * Stale known-bug marker gate (scripts/check-known-bug-markers.mjs).
 *
 * Marker strings in the fixtures below are assembled from parts so this file
 * does not itself contain a marker the scanner would pick up.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { findMarkers, findStale, scanMarkers } from '../../../scripts/check-known-bug-markers.mjs'

const KB = ['KNOWN', 'BUG'].join('_')
const ITF = ['it', 'fails'].join('.')
const KF = ['known', 'Failing'].join('')
const prose = (word: string, n: number): string => `${['known', word].join(' ')} #${n}`

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('findMarkers', () => {
  it('finds the flag form with its line number', () => {
    const text = `import x\n\nconst ${KB}_12_OPEN = true\n`
    expect(findMarkers(text)).toEqual([expect.objectContaining({ issue: 12, line: 3, kind: 'KNOWN_BUG_<n>_OPEN' })])
  })

  it('finds prose forms regardless of case', () => {
    const text = `// ${prose('bug', 3)}\n// ${prose('failing', 8).toUpperCase()}\n`
    expect(findMarkers(text).map((m) => [m.issue, m.line])).toEqual([
      [3, 1],
      [8, 2]
    ])
  })

  it('finds knownFailing in TypeScript and JSON forms', () => {
    const text = `const a = { ${KF}: '#41' }\n{ "${KF}": "#86" }\n`
    expect(findMarkers(text).map((m) => [m.issue, m.line])).toEqual([
      [41, 1],
      [86, 2]
    ])
  })

  it('ignores the documentation placeholder and a knownFailing object', () => {
    const text = `"${KF}": "#N" marks a row\n${KF}?: string\n${KF}: { issue: 'x' }\n`
    expect(findMarkers(text)).toEqual([])
  })

  it('finds an issue number in an it.fails title, including a multi-line call', () => {
    const text = `${ITF}('encodes the defect from #5', () => {})\n${ITF}(\n  "second #6 and #7",\n  () => {}\n)\n`
    expect(findMarkers(text).map((m) => [m.issue, m.kind])).toEqual([
      [5, 'it.fails title'],
      [6, 'it.fails title'],
      [7, 'it.fails title']
    ])
  })

  it('does not flag an it.fails without an issue number or an ordinary test', () => {
    expect(findMarkers(`${ITF}('no number here', () => {})\nit('mentions #9 but is a plain test', () => {})\n`)).toEqual([])
  })

  it('reports a line once per issue when two patterns match it', () => {
    const text = `${ITF}('${prose('bug', 11)}', () => {})\n`
    expect(findMarkers(text)).toHaveLength(1)
  })
})

describe('scanMarkers', () => {
  it('scans only the named dirs, skips node_modules, and reports relative paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'circsim-markers-'))
    tmpDirs.push(root)
    mkdirSync(join(root, 'src', 'a'), { recursive: true })
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true })
    mkdirSync(join(root, 'other'), { recursive: true })
    writeFileSync(join(root, 'src', 'a', 'x.test.ts'), `const ${KB}_4_OPEN = true\n`)
    writeFileSync(join(root, 'src', 'node_modules', 'y.ts'), `const ${KB}_5_OPEN = true\n`)
    writeFileSync(join(root, 'other', 'z.ts'), `const ${KB}_6_OPEN = true\n`)
    expect(scanMarkers(root, ['src', 'missing'])).toEqual([expect.objectContaining({ file: 'src/a/x.test.ts', issue: 4, line: 1 })])
  })

  it('runs on the real repo and only reports positive issue numbers', () => {
    const markers = scanMarkers()
    for (const m of markers) {
      expect(m.issue).toBeGreaterThan(0)
      expect(m.file).toMatch(/^(src|test|resources)\//)
    }
  })
})

describe('findStale', () => {
  const markers = [
    { file: 'a.ts', line: 1, kind: 'k', text: 't', issue: 1 },
    { file: 'b.ts', line: 2, kind: 'k', text: 't', issue: 2 },
    { file: 'c.ts', line: 3, kind: 'k', text: 't', issue: 3 },
    { file: 'd.ts', line: 4, kind: 'k', text: 't', issue: 2 }
  ]

  it('names every marker whose issue is closed and lists unknown issues separately', async () => {
    const state: Record<number, 'OPEN' | 'CLOSED' | null> = { 1: 'OPEN', 2: 'CLOSED', 3: null }
    const r = await findStale(markers, async (n) => state[n])
    expect(r.stale.map((m) => m.file)).toEqual(['b.ts', 'd.ts'])
    expect(r.unknown).toEqual([3])
  })

  it('is clean when every issue is open', async () => {
    const r = await findStale(markers, async () => 'OPEN')
    expect(r.stale).toEqual([])
    expect(r.unknown).toEqual([])
  })

  it('looks each issue up once', async () => {
    const calls: number[] = []
    await findStale(markers, async (n) => {
      calls.push(n)
      return 'OPEN'
    })
    expect(calls.sort()).toEqual([1, 2, 3])
  })
})
