/**
 * Release signing pipeline guard (issue #40, plan task R6).
 *
 * Static checks on electron-builder.yml and the release job in
 * .github/workflows/ci.yml. They cannot prove a certificate works (none exist
 * yet) but they pin the properties that keep the pipeline honest:
 *  - the mac block no longer hard-disables signing with `identity: null`;
 *  - the unsigned path still exists and disables identity auto-discovery;
 *  - every secret the signed path reads is gated on being present;
 *  - notarization uses the notarytool object form;
 *  - SHA256SUMS is produced and attached by a job that follows the matrix.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()
const builderYml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

/** Text of one top-level job in ci.yml, from its `  name:` line to the next job. */
function jobText(job: string): string {
  const start = ci.indexOf(`\n  ${job}:\n`)
  expect(start, `job ${job} present`).toBeGreaterThan(-1)
  const rest = ci.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('electron-builder.yml signing config', () => {
  it('does not hard-disable mac signing', () => {
    const code = builderYml
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/^\s*identity:\s*null/m)
  })
})

describe('release job signing', () => {
  const release = jobText('release')

  it('reads every signing secret it can use', () => {
    for (const name of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD'
    ]) {
      expect(release, name).toContain(`secrets.${name}`)
    }
  })

  it('keeps an unsigned path that skips identity auto-discovery', () => {
    expect(release).toContain('Package installers (unsigned)')
    expect(release).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/)
  })

  it('signs only when the detect step says every secret is present', () => {
    expect(release).toContain('id: signing')
    expect(release).toMatch(/Package installers \(signed\)\n\s+if: steps\.signing\.outputs\.sign == 'true'/)
    expect(release).toMatch(/Package installers \(unsigned\)\n\s+if: steps\.signing\.outputs\.sign != 'true'/)
  })

  it('notarizes with the notarytool object form, never bare notarize: true', () => {
    expect(release).toContain('-c.mac.notarize.teamId=')
    expect(builderYml).not.toMatch(/^\s*notarize:\s*true/m)
  })

  it('verifies signed output', () => {
    expect(release).toContain('codesign --verify')
    expect(release).toContain('stapler validate')
    expect(release).toContain('Get-AuthenticodeSignature')
  })
})

describe('checksums job', () => {
  const checksums = jobText('checksums')

  it('runs after the release matrix, tag-only', () => {
    expect(checksums).toMatch(/needs:\s*\[release\]/)
    expect(checksums).toContain("startsWith(github.ref, 'refs/tags/v')")
  })

  it('builds SHA256SUMS with the repo script and attaches it to the release', () => {
    expect(checksums).toContain('node scripts/sha256sums.mjs')
    expect(checksums).toContain('sha256sum -c')
    expect(checksums).toMatch(/files:\s*SHA256SUMS/)
    expect(checksums).toMatch(/fail_on_unmatched_files:\s*true/)
  })
})
