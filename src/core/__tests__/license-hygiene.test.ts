/**
 * License-hygiene CI gate test (Task 27, Spec §14, §15).
 *
 * Exercises scripts/license-hygiene.mjs `runLicenseHygiene(projectRoot)`:
 *  - the REAL repo is clean (every resources/models/* has Provenance:,
 *    no table.cm in any present platform ngspice dir);
 *  - a synthetic project with a model file missing Provenance: is flagged;
 *  - a synthetic project with a stray table.cm is flagged;
 *  - a synthetic clean project passes.
 *
 * The pure function form (no process.exit) is what makes this testable —
 * the .mjs CLI wraps it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

// The hygiene module is plain ESM .mjs; import its exported pure function.
import { runLicenseHygiene, PLATFORM_DIRS } from '../../../scripts/license-hygiene.mjs'

const PROJECT_ROOT = join(process.cwd())

const tmpDirs: string[] = []
function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circsim-hygiene-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('license-hygiene gate (Spec §14)', () => {
  it('the real circsim repo passes the hygiene scan', () => {
    const { ok, violations } = runLicenseHygiene(PROJECT_ROOT)
    expect(violations).toEqual([])
    expect(ok).toBe(true)
  })

  it('PLATFORM_DIRS covers all four ship targets', () => {
    expect(new Set(PLATFORM_DIRS)).toEqual(
      new Set(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'])
    )
  })

  it('flags a model file missing a Provenance: header', () => {
    const root = makeTmpProject()
    const models = join(root, 'resources', 'models')
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'good.lib'), '* Provenance: in-house, MIT\n.model X d\n')
    writeFileSync(join(models, 'bad.lib'), '* no provenance here\n.model Y d\n')

    const { ok, violations } = runLicenseHygiene(root)
    expect(ok).toBe(false)
    expect(violations.some((v: string) => v.includes('bad.lib'))).toBe(true)
    expect(violations.some((v: string) => v.includes('good.lib'))).toBe(false)
  })

  it('flags a stray table.cm in any platform ngspice dir', () => {
    const root = makeTmpProject()
    // valid model so rule 1 is clean
    const models = join(root, 'resources', 'models')
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'm.lib'), '* Provenance: MIT\n')
    // stray table.cm
    const cm = join(root, 'resources', 'ngspice', 'win32-x64', 'lib', 'ngspice')
    mkdirSync(cm, { recursive: true })
    writeFileSync(join(cm, 'table.cm'), 'binary-ish')
    writeFileSync(join(cm, 'digital.cm'), 'binary-ish')

    const { ok, violations } = runLicenseHygiene(root)
    expect(ok).toBe(false)
    expect(violations.some((v: string) => v.includes('table.cm'))).toBe(true)
  })

  it('passes a synthetic clean project (models present, no table.cm)', () => {
    const root = makeTmpProject()
    const models = join(root, 'resources', 'models')
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'a.lib'), '* Provenance: written in-house, MIT\n')
    writeFileSync(join(models, 'b.json'), '{ "$comment": "Provenance: MIT" }\n')
    const cm = join(root, 'resources', 'ngspice', 'linux-x64', 'lib', 'ngspice')
    mkdirSync(cm, { recursive: true })
    writeFileSync(join(cm, 'digital.cm'), 'x')
    writeFileSync(join(cm, 'analog.cm'), 'x')

    const { ok, violations } = runLicenseHygiene(root)
    expect(violations).toEqual([])
    expect(ok).toBe(true)
  })

  it('flags a project with no resources/models dir at all', () => {
    const root = makeTmpProject()
    const { ok, violations } = runLicenseHygiene(root)
    expect(ok).toBe(false)
    expect(violations.some((v: string) => v.includes('resources/models/ is missing'))).toBe(true)
  })
})
