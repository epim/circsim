#!/usr/bin/env node
/**
 * license-hygiene.mjs — repo licensing-compliance gate (Spec §14, §15, Task 27).
 *
 * Three hard rules, enforced by repo layout (not memory):
 *
 *  1. Every file under resources/models/ MUST contain a `Provenance:` header.
 *     This is the "only in-house-written (MIT) or verified-BSD" guarantee from
 *     Spec §14 — a model file with no provenance line is a redistribution risk.
 *
 *  2. `table.cm` MUST be absent from EVERY platform's ngspice code-model dir
 *     (resources/ngspice/<platform>/lib/ngspice/). table.cm is GPL-encumbered
 *     and is deleted by both fetch-ngspice.mjs and build-ngspice.sh; this check
 *     is the belt-and-suspenders that fails the build if it ever reappears.
 *
 *  3. Every package reachable from package.json `dependencies` (walked through
 *     package-lock.json, nested node_modules resolved as npm does) MUST declare
 *     a license, and it MUST NOT be copyleft (GPL, LGPL, AGPL, MPL, CC-BY-SA,
 *     and similar). devDependencies are not shipped and are not checked.
 *
 * Exit code 0 = clean, 1 = at least one violation (with a printed reason list).
 * The same logic is unit-tested in
 * src/core/__tests__/license-hygiene.test.ts so a violation fails CI even
 * without invoking this script directly.
 *
 * Usage: node scripts/license-hygiene.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

export const PLATFORM_DIRS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64']

/**
 * Run the full hygiene scan against a project root. Pure (no process.exit) so
 * tests can call it directly. Returns { ok, violations: string[] }.
 *
 * Notes on robustness:
 *  - Model files are scanned only if resources/models exists. A missing models
 *    dir IS a violation (the bundle must ship models).
 *  - ngspice platform dirs are gitignored and only present after a fetch/build.
 *    A MISSING platform dir is NOT a violation (you only fetch your own
 *    platform locally) — but if a dir exists, table.cm must not be in it.
 */
export function runLicenseHygiene(projectRoot = PROJECT_ROOT) {
  const violations = []

  // ── Rule 1: every resources/models/* file carries a Provenance: header ──────
  const modelsDir = path.join(projectRoot, 'resources', 'models')
  if (!fs.existsSync(modelsDir)) {
    violations.push(`resources/models/ is missing (no bundled model library)`)
  } else {
    const files = fs
      .readdirSync(modelsDir)
      .filter((f) => !f.startsWith('.'))
      .filter((f) => fs.statSync(path.join(modelsDir, f)).isFile())
    if (files.length === 0) {
      violations.push(`resources/models/ contains no model files`)
    }
    for (const f of files) {
      const text = fs.readFileSync(path.join(modelsDir, f), 'utf8')
      if (!/Provenance:/.test(text)) {
        violations.push(`resources/models/${f}: missing 'Provenance:' header (Spec §14)`)
      }
    }
  }

  // ── Rule 2: table.cm absent from every present platform ngspice dir ─────────
  for (const plat of PLATFORM_DIRS) {
    const cmDir = path.join(projectRoot, 'resources', 'ngspice', plat, 'lib', 'ngspice')
    if (!fs.existsSync(cmDir)) continue // platform not fetched locally — fine
    const tableCm = path.join(cmDir, 'table.cm')
    if (fs.existsSync(tableCm)) {
      violations.push(
        `resources/ngspice/${plat}/lib/ngspice/table.cm present — GPL-encumbered, must be deleted (Spec §14)`
      )
    }
  }

  // ── Rule 3: shipped npm tree is permissively licensed ───────────────────────
  violations.push(...checkShippedNpmTree(projectRoot))

  return { ok: violations.length === 0, violations }
}

// ── Rule 3 helpers: walk package-lock.json from the production roots ─────────

/**
 * SPDX identifier prefixes treated as copyleft for the shipped tree. Matched
 * case-insensitively against the start of each identifier in a license
 * expression, so `GPL-2.0-only`, `LGPL-3.0-or-later` and `AGPL-3.0` all hit.
 * Weak-copyleft (LGPL, MPL, EPL, CDDL) is included: nothing in the shipped tree
 * uses it today and adding it should be a conscious, documented decision.
 */
const COPYLEFT_PREFIXES = ['GPL', 'LGPL', 'AGPL', 'MPL', 'CC-BY-SA', 'EUPL', 'CDDL', 'EPL', 'SSPL', 'OSL']

function isCopyleftId(id) {
  const up = id.toUpperCase()
  return COPYLEFT_PREFIXES.some((p) => up === p || up.startsWith(p + '-') || up.startsWith(p + '+'))
}

/**
 * True when an SPDX license expression forces copyleft terms on the consumer.
 * `A OR B` is copyleft only if every alternative is (the consumer may pick the
 * permissive one); `A AND B` is copyleft if either side is. `X WITH exception`
 * is judged by X alone. Unparseable input is treated as not copyleft here;
 * the caller separately rejects a missing license field.
 */
export function isCopyleftExpression(expr) {
  const tokens = String(expr)
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean)
  let pos = 0
  function parseOr() {
    let result = parseAnd()
    while (tokens[pos] && tokens[pos].toUpperCase() === 'OR') {
      pos++
      const rhs = parseAnd()
      result = result && rhs
    }
    return result
  }
  function parseAnd() {
    let result = parseAtom()
    while (tokens[pos] && tokens[pos].toUpperCase() === 'AND') {
      pos++
      const rhs = parseAtom()
      result = result || rhs
    }
    return result
  }
  function parseAtom() {
    const t = tokens[pos++]
    if (t === undefined) return false
    if (t === '(') {
      const inner = parseOr()
      if (tokens[pos] === ')') pos++
      return inner
    }
    if (tokens[pos] && tokens[pos].toUpperCase() === 'WITH') pos += 2
    return isCopyleftId(t)
  }
  return parseOr()
}

/** Normalise the lockfile `license` field (string, {type}, or array of either). */
function licenseText(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw.map(licenseText).filter(Boolean).join(' OR ')
  }
  if (typeof raw === 'object' && typeof raw.type === 'string') return raw.type.trim()
  return ''
}

/** Find the lockfile key npm would resolve `name` to when required from `from`. */
function resolveLockKey(packages, from, name) {
  let base = from
  for (;;) {
    const key = (base ? base + '/' : '') + 'node_modules/' + name
    if (packages[key]) return key
    if (!base) return null
    const i = base.lastIndexOf('/node_modules/')
    base = i < 0 ? '' : base.slice(0, i)
  }
}

/**
 * Walk a parsed package-lock.json (lockfileVersion 2/3) from the root package's
 * `dependencies` and `optionalDependencies` (and non-optional peers), resolving
 * nested node_modules the way npm does. devDependencies are excluded: they are
 * not shipped. Returns [{ name, version, license, key }] in discovery order.
 */
export function collectProductionPackages(lock) {
  const packages = (lock && lock.packages) || {}
  const root = packages['']
  if (!root) return []
  const seen = new Set()
  const out = []
  const queue = ['']
  while (queue.length) {
    const from = queue.shift()
    const entry = packages[from] || {}
    const optionalPeers = entry.peerDependenciesMeta || {}
    const names = new Set([
      ...Object.keys(entry.dependencies || {}),
      ...Object.keys(entry.optionalDependencies || {}),
      ...Object.keys(entry.peerDependencies || {}).filter((n) => !(optionalPeers[n] && optionalPeers[n].optional))
    ])
    for (const name of names) {
      const key = resolveLockKey(packages, from, name)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const p = packages[key]
      if (p.link) continue
      out.push({ name, version: p.version || '?', license: licenseText(p.license), key })
      queue.push(key)
    }
  }
  return out
}

function checkShippedNpmTree(projectRoot) {
  const lockPath = path.join(projectRoot, 'package-lock.json')
  // Synthetic/partial project trees (unit tests) have no lockfile: nothing to
  // walk. CI and the real repo always do.
  if (!fs.existsSync(lockPath)) return []
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch (e) {
    return [`package-lock.json: unreadable (${e instanceof Error ? e.message : String(e)})`]
  }
  const violations = []
  for (const pkg of collectProductionPackages(lock)) {
    const id = `${pkg.name}@${pkg.version}`
    if (!pkg.license) {
      violations.push(`npm ${id}: shipped dependency has no license field in package-lock.json`)
    } else if (/^(UNLICENSED|SEE LICENSE)/i.test(pkg.license)) {
      violations.push(`npm ${id}: shipped dependency has no usable license (${pkg.license})`)
    } else if (isCopyleftExpression(pkg.license)) {
      violations.push(`npm ${id}: copyleft license ${pkg.license} in the shipped tree`)
    }
  }
  return violations
}

// ── CLI entry ──────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { ok, violations } = runLicenseHygiene()
  if (ok) {
    // eslint-disable-next-line no-console
    console.log('license-hygiene: OK — all model files carry Provenance:, no table.cm present, shipped npm tree is permissive.')
    process.exit(0)
  }
  // eslint-disable-next-line no-console
  console.error('license-hygiene: FAILED')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  - ${v}`)
  }
  process.exit(1)
}
