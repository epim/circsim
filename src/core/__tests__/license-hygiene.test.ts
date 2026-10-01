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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, afterEach } from 'vitest'

// The hygiene module is plain ESM .mjs; import its exported pure function.
import {
  runLicenseHygiene,
  PLATFORM_DIRS,
  collectProductionPackages,
  isCopyleftExpression
} from '../../../scripts/license-hygiene.mjs'

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

// ---------------------------------------------------------------------------
// Rule 3: the shipped npm tree (package-lock.json walked from root deps).
// ---------------------------------------------------------------------------

type LockPkg = Record<string, unknown>

/** Synthetic project with a valid models dir and the given lockfile packages. */
function makeLockProject(packages: Record<string, LockPkg>): string {
  const root = makeTmpProject()
  const models = join(root, 'resources', 'models')
  mkdirSync(models, { recursive: true })
  writeFileSync(join(models, 'm.lib'), '* Provenance: MIT\n')
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  return root
}

describe('license-hygiene gate: shipped npm tree (issue #79)', () => {
  it('the real lockfile production tree has no electron-updater and passes the gate', () => {
    const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package-lock.json'), 'utf8'))
    const prod = collectProductionPackages(lock)
    const names = prod.map((p: { name: string }) => p.name)
    expect(names).toContain('koffi')
    expect(names).not.toContain('electron-updater')
    expect(names).not.toContain('js-yaml')
    expect(runLicenseHygiene(PROJECT_ROOT).violations).toEqual([])
  })

  it('flags a copyleft license reachable from root dependencies', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '1' } },
      'node_modules/b': { version: '1.0.0', license: 'LGPL-3.0-or-later' }
    })
    const { ok, violations } = runLicenseHygiene(root)
    expect(ok).toBe(false)
    expect(violations.some((v: string) => v.includes('b@1.0.0') && v.includes('LGPL'))).toBe(true)
  })

  it('flags a production package with no license field', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1' } },
      'node_modules/a': { version: '1.0.0' }
    })
    const { ok, violations } = runLicenseHygiene(root)
    expect(ok).toBe(false)
    expect(violations.some((v: string) => v.includes('a@1.0.0') && v.includes('no license'))).toBe(
      true
    )
  })

  it('ignores copyleft packages reachable only from devDependencies', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1' }, devDependencies: { tool: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/tool': { version: '1.0.0', license: 'GPL-3.0', dev: true }
    })
    expect(runLicenseHygiene(root).violations).toEqual([])
  })

  it('resolves nested node_modules the way npm does', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '2' } },
      'node_modules/b': { version: '1.0.0', license: 'MIT' },
      'node_modules/a/node_modules/b': { version: '2.0.0', license: 'AGPL-3.0' }
    })
    const { violations } = runLicenseHygiene(root)
    expect(violations.some((v: string) => v.includes('b@2.0.0'))).toBe(true)
    expect(violations.some((v: string) => v.includes('b@1.0.0'))).toBe(false)
  })

  it('follows optionalDependencies and treats them as shipped', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', optionalDependencies: { o: '1' } },
      'node_modules/o': { version: '1.0.0', license: 'MPL-2.0', optional: true }
    })
    expect(runLicenseHygiene(root).ok).toBe(false)
  })

  it('passes a permissive tree including ISC, BlueOak and dual-licensed OR expressions', () => {
    const root = makeLockProject({
      '': { dependencies: { a: '1', c: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'ISC', dependencies: { b: '1' } },
      'node_modules/b': { version: '1.0.0', license: 'BlueOak-1.0.0' },
      'node_modules/c': { version: '1.0.0', license: '(MIT OR GPL-3.0-only)' }
    })
    expect(runLicenseHygiene(root).violations).toEqual([])
  })

  it('isCopyleftExpression handles SPDX operators', () => {
    expect(isCopyleftExpression('MIT')).toBe(false)
    expect(isCopyleftExpression('GPL-2.0-only')).toBe(true)
    expect(isCopyleftExpression('GPL-2.0-only WITH Classpath-exception-2.0')).toBe(true)
    expect(isCopyleftExpression('CC-BY-SA-4.0')).toBe(true)
    expect(isCopyleftExpression('(MIT OR GPL-3.0)')).toBe(false)
    expect(isCopyleftExpression('(MIT AND GPL-3.0)')).toBe(true)
    expect(isCopyleftExpression('(GPL-2.0 OR LGPL-2.1)')).toBe(true)
    expect(isCopyleftExpression('CC-BY-4.0')).toBe(false)
  })

  it('skips the npm-tree rule when there is no package-lock.json', () => {
    const root = makeTmpProject()
    const models = join(root, 'resources', 'models')
    mkdirSync(models, { recursive: true })
    writeFileSync(join(models, 'm.lib'), '* Provenance: MIT\n')
    expect(runLicenseHygiene(root).violations).toEqual([])
  })
})
