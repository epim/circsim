#!/usr/bin/env node
/**
 * apply-koffi-271-patch.mjs — postinstall: apply the koffi issue #271 fix.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ TEMPORARY. Remove this script, the package.json `postinstall` hook,    │
 * │ and resources/vendor/koffi/ once a koffi release ships the #271 fix    │
 * │ upstream (the maintainer is submitting a PR), then just use the stock  │
 * │ registry koffi. Tracking: https://github.com/Koromix/koffi/issues/271  │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Issue #271: on process exit, koffi's cross-thread callback broker fires one
 * last relay into an environment that can no longer run JS → node-addon-api
 * calls napi_throw → fatal SIGABRT (exit 134). circsim hits this because
 * libngspice's background thread keeps invoking registered callbacks during
 * teardown (see src/simhost/ngspiceFfi.ts). Verified on Windows x64 / Node 24:
 * stock 3.1.1 aborts 134; the patched binary exits cleanly (0/10 even on a
 * pathological no-sleep callback loop — 3.x's teardown handling is fully
 * robust, unlike the 2.16.2 patch which had a small residual race).
 *
 * The fix is NATIVE ONLY — a patched koffi.node, same version (3.1.1), no JS
 * or API change. The vendored prebuilt is win32_x64 ONLY, so this script is a
 * no-op on every other OS/arch (they keep the stock registry koffi 3.1.1,
 * unpatched, relying on the dispose() thread-join + unregister workaround in
 * ngspiceFfi.ts). That is why the fix is applied as a Windows-only binary swap
 * rather than by pointing the `koffi` dependency at the tarball: a `file:` dep
 * would force mac/linux to build koffi from source and break those CI legs.
 *
 * koffi 3.x delivers its native binary through a per-platform optional
 * dependency (`@koromix/koffi-<platform>`), NOT `koffi/build/...` like 2.x.
 * On win32_x64 the loader (koffi/src/koffi/src/static.js) does
 * `require('@koromix/koffi-win32-x64')`, whose index.js requires
 * `./win32_x64/koffi.node` — that is the file we swap.
 *
 * Idempotent: if koffi is already the patched binary, it does nothing. If the
 * installed koffi is not the version this binary was built for, it warns and
 * skips rather than corrupting an incompatible build.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

const EXPECTED_KOFFI_VERSION = '3.1.1'
// sha256 of the patched win32_x64 koffi.node (HANDOFF-verified).
const PATCHED_SHA256 = '594350D4F597D99093BF92EE6C83B5BB037958352B70D328060B1730BADFAD0D'

const VENDOR_BINARY = path.join(
  PROJECT_ROOT,
  'resources',
  'vendor',
  'koffi',
  'koffi-3.1.1-271-win32x64.node'
)

const TAG = '[koffi-271]'

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
}

function main() {
  // Windows x64 only — the vendored prebuilt is per-OS/arch.
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(`${TAG} not win32/x64 (${process.platform}/${process.arch}); using stock koffi.`)
    return
  }

  const koffiPkg = path.join(PROJECT_ROOT, 'node_modules', 'koffi', 'package.json')
  if (!fs.existsSync(koffiPkg)) {
    console.log(`${TAG} koffi not installed yet; skipping.`)
    return
  }

  const installedVersion = JSON.parse(fs.readFileSync(koffiPkg, 'utf8')).version
  if (installedVersion !== EXPECTED_KOFFI_VERSION) {
    console.warn(
      `${TAG} installed koffi is ${installedVersion}, patch binary is for ${EXPECTED_KOFFI_VERSION}. ` +
        `Skipping — verify the #271 fix is upstream and remove this script if so.`
    )
    return
  }

  if (!fs.existsSync(VENDOR_BINARY)) {
    console.warn(`${TAG} vendored patched binary missing at ${VENDOR_BINARY}; skipping.`)
    return
  }

  // Integrity: the vendored artifact must be exactly the known-good patch.
  const vendorSha = sha256(VENDOR_BINARY)
  if (vendorSha !== PATCHED_SHA256) {
    console.error(
      `${TAG} vendored binary sha256 ${vendorSha} != expected ${PATCHED_SHA256}. ` +
        `Refusing to install a mismatched binary.`
    )
    process.exit(1)
  }

  // koffi 3.x loads win32_x64 from the @koromix/koffi-win32-x64 optional dep,
  // whose index.js requires ./win32_x64/koffi.node.
  const target = path.join(
    PROJECT_ROOT,
    'node_modules',
    '@koromix',
    'koffi-win32-x64',
    'win32_x64',
    'koffi.node'
  )
  if (!fs.existsSync(target)) {
    console.warn(`${TAG} target koffi.node not found at ${target}; skipping.`)
    return
  }

  if (sha256(target) === PATCHED_SHA256) {
    console.log(`${TAG} koffi ${EXPECTED_KOFFI_VERSION} already patched (#271); nothing to do.`)
    return
  }

  fs.copyFileSync(VENDOR_BINARY, target)
  console.log(
    `${TAG} applied #271 fix to koffi ${EXPECTED_KOFFI_VERSION} (win32_x64). ` +
      `TEMPORARY until the fix ships upstream — see scripts/apply-koffi-271-patch.mjs.`
  )
}

main()
