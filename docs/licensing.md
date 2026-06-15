# circsim licensing & provenance

This document expands the licensing-compliance summary from the design spec
(§14) into the operational rules circsim's repo layout and CI enforce. The
guiding principle: **compliance is enforced by repo layout and CI checks, not by
memory.** A licensing violation should fail a build, not ship in an installer.

circsim is fully offline. It bundles a SPICE engine (ngspice) and an in-house
SPICE model library; it never bundles vendor SPICE models or KiCad 3D `.wrl`
assets.

## Summary table (Spec §14, expanded)

| Asset | License / status | Policy in circsim | Enforced by |
|---|---|---|---|
| **circsim app + all first-party code** | MIT | Shipped. `LICENSE`/`package.json` `license: MIT`. | repo |
| **ngspice shared library** (`ngspice.dll`, `libngspice.{dylib,so}`) | ngspice license (BSD-style "New BSD" + original SPICE/Berkeley terms) | Bundled per platform via `extraResources` (outside asar). `COPYING` shipped beside the binaries and shown in the About dialog. | `electron-builder.yml`, About |
| **ngspice XSPICE code models** (`*.cm`) — `analog`, `digital`, `spice2poly`, `xtradev`, `xtraevt`, `tlines` | Same as ngspice | Bundled per platform. | `electron-builder.yml` |
| **`table.cm`** | GPL-encumbered | **Never bundled.** Deleted by `fetch-ngspice.mjs` / `build-ngspice.sh`; absence re-verified by the license-hygiene gate against every platform dir. | `scripts/license-hygiene.mjs` + test |
| **Bundled SPICE models** (`resources/models/*.lib`, `logic74hc.json`, `index.json`) | MIT (in-house) | Only in-house-written from datasheet parameters, or verified-BSD. Every file carries a `Provenance:` header. | license-hygiene gate + `library-content.test.ts` |
| **Vendor models** (TI / ADI / onsemi), Micro-Cap / Intusoft libraries | Proprietary / non-redistributable | **Never in repo or bundle.** User-import path only (Tier 4). No vendor copyright/“All Rights Reserved”/“encrypted” markers may appear in any `.lib`. | `library-content.test.ts` forbidden-marker scan |
| **KiCad `packages3D` `.wrl` models** | CC-BY-SA (share-alike) | **Never bundled and never cached.** Loaded only from the user's own KiCad install at runtime; caching a `.wrl` into app-data would itself be redistribution and trigger share-alike. (VRML loading is deferred to post-v1; placeholders are used in v1.) | design (no `.wrl` read/write path in v1) |
| **kicanvas / Velxio** | MIT-but-alpha / AGPLv3 | **No vendored code from either.** Pattern reference only. | repo review |
| **Electron, React, Three.js, zustand, troika-three-text, koffi** | MIT | Bundled (npm deps). | `package-lock.json` |
| **7zip-min (build-time only)** | LGPL/BSD (7-Zip via 7za) | devDependency; used only to unpack the ngspice download. Not shipped in installers. | `package.json` devDependencies |

## How "no `table.cm`" is enforced (defense in depth)

1. `scripts/fetch-ngspice.mjs` (Windows) and `scripts/build-ngspice.sh`
   (macOS/Linux) delete `table.cm` immediately after extraction/build and record
   `tablecmExcluded: true` in each platform's `manifest.json`.
2. `src/simhost/ngspiceFfi.ts` only loads five code models
   (`spice2poly`, `analog`, `digital`, `xtradev`, `xtraevt`) — `table.cm` is
   never referenced and the runtime `spinit` is regenerated with absolute
   `codemodel` paths (the stock ngspice `spinit`, which *does* reference
   `table.cm`, is never used).
3. `scripts/license-hygiene.mjs` (run in CI and unit-tested) fails the build if
   `table.cm` is found in any `resources/ngspice/<platform>/lib/ngspice/` dir.

## How model provenance is enforced

- Every file in `resources/models/` must contain a `Provenance:` header.
- `src/core/models/__tests__/library-content.test.ts` asserts the header on
  every file, that no forbidden vendor-copyright marker text appears, and that
  every `index.json` entry resolves to a real `.model`/`.subckt`/template.
- `scripts/license-hygiene.mjs` re-checks the `Provenance:` rule as a standalone
  CI gate (independent of the unit suite) and is itself unit-tested in
  `src/core/__tests__/license-hygiene.test.ts`.

## Packaging facts that matter for compliance

- Native libraries (`ngspice.*`, `*.cm`) and the koffi `*.node` addon **cannot
  load from inside an asar archive**. `electron-builder.yml` ships them as
  `extraResources` (ngspice/models/sample/docs) and `asarUnpack`s koffi, so they
  live at real paths under the packaged app's `resources/` directory.
- Each platform installer bundles **only its own** ngspice directory
  (`win32-x64` / `darwin-x64` / `darwin-arm64` / `linux-x64`). electron-builder
  concatenates the common top-level `extraResources` with each platform block's
  ngspice entry, so no cross-platform native binaries leak into an installer.
- The packaged path resolver (`resolveNgspicePaths`) looks under
  `process.resourcesPath/ngspice/<platform>/`, which is exactly where
  `extraResources` places each platform's library. The `.cm` files load via an
  explicit `codemodel <abs>.cm` bootstrap using those packaged absolute paths.

## Code signing / notarization — deferred (the one allowed v1 deferral, Spec §15)

v1 ships **unsigned** installers from CI:

- **Windows (NSIS `.exe`):** unsigned. Windows SmartScreen will warn on first
  run. To sign for distribution: provide an Authenticode certificate and set
  `CSC_LINK` / `CSC_KEY_PASSWORD` (or `WIN_CSC_*`) in the release environment;
  electron-builder signs automatically when those are present.
- **macOS (`.dmg`):** unsigned, `identity: null`. Gatekeeper will block by
  default (users must right-click → Open, or remove the quarantine attribute).
  To sign + notarize for distribution: an Apple Developer ID Application
  certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`), `notarize` config, and
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` credentials.
- **Linux (AppImage / `.deb`):** signing is not generally required for direct
  download; an optional GPG-signed `.deb` and `zsync` AppImage updates can be
  added for a repository-based distribution channel.

This is the only deferred item for v1 and is a release-blocker only for
distribution beyond direct download. It does not affect functional correctness
of the packaged app.
