/**
 * SHA256SUMS generator test (issue #40, plan task R6).
 *
 * Exercises scripts/sha256sums.mjs `buildSha256Sums(dir)`:
 *  - output is `sha256sum -c` compatible ("<hex>  <name>" lines, sorted);
 *  - only release installer extensions are listed;
 *  - nested artifact directories are flattened to basenames;
 *  - an empty directory and duplicate basenames are hard errors, so a release
 *    can never ship a silently empty or ambiguous checksum file.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

import { buildSha256Sums, RELEASE_EXTENSIONS } from '../../../scripts/sha256sums.mjs'

const tmpDirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circsim-sums-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('buildSha256Sums', () => {
  it('lists installers as sorted "<hex>  <name>" lines', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'circsim-1.0.0-x64-setup.exe'), 'win')
    writeFileSync(join(dir, 'circsim-1.0.0-arm64.dmg'), 'mac')
    writeFileSync(join(dir, 'circsim-1.0.0-amd64.deb'), 'deb')
    const { text, entries } = buildSha256Sums(dir)
    expect(text).toBe(
      [
        `${sha('deb')}  circsim-1.0.0-amd64.deb`,
        `${sha('mac')}  circsim-1.0.0-arm64.dmg`,
        `${sha('win')}  circsim-1.0.0-x64-setup.exe`,
        ''
      ].join('\n')
    )
    expect(entries).toHaveLength(3)
  })

  it('ignores non-release files and flattens nested artifact folders', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'circsim-macos-14'))
    writeFileSync(join(dir, 'circsim-macos-14', 'circsim-1.0.0-arm64.dmg'), 'mac')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'SHA256SUMS'), 'stale')
    writeFileSync(join(dir, 'latest.yml'), 'x')
    const { text } = buildSha256Sums(dir)
    expect(text).toBe(`${sha('mac')}  circsim-1.0.0-arm64.dmg\n`)
  })

  it('covers every installer type the release job attaches', () => {
    expect([...RELEASE_EXTENSIONS].sort()).toEqual(['.AppImage', '.deb', '.dmg', '.exe'])
  })

  it('throws when no installer is found', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(() => buildSha256Sums(dir)).toThrow(/no release files/i)
  })

  it('throws on duplicate basenames with different paths', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'a'))
    mkdirSync(join(dir, 'b'))
    writeFileSync(join(dir, 'a', 'circsim.dmg'), '1')
    writeFileSync(join(dir, 'b', 'circsim.dmg'), '2')
    expect(() => buildSha256Sums(dir)).toThrow(/duplicate/i)
  })
})
