#!/usr/bin/env node
/**
 * license-hygiene.mjs — repo licensing-compliance gate (Spec §14, §15, Task 27).
 *
 * Two hard rules, enforced by repo layout (not memory):
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

  return { ok: violations.length === 0, violations }
}

// ── CLI entry ──────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { ok, violations } = runLicenseHygiene()
  if (ok) {
    // eslint-disable-next-line no-console
    console.log('license-hygiene: OK — all model files carry Provenance:, no table.cm present.')
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
