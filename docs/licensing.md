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
| **Bundled SPICE models** (`resources/models/*.lib`, `logic74hc.json`, `index.json`) | MIT (in-house) | Only in-house-written from datasheet parameters, or verified-BSD. Every file carries a `Provenance:` header. The discrete BJT, diode, TVS and LED cards are derived from datasheet operating points by `scripts/fit-model-cards.mjs`; no bundled card may reproduce a known third-party library card. | license-hygiene gate + `library-content.test.ts` + `library-fingerprint.test.ts` + `library-derivation.test.ts` |
| **Vendor models** (TI / ADI / onsemi), Micro-Cap / Intusoft libraries | Proprietary / non-redistributable | **Never in repo or bundle.** User-import path only (Tier 4). No vendor copyright/“All Rights Reserved”/“encrypted” markers may appear in any `.lib`. | `library-content.test.ts` forbidden-marker scan |
| **KiCad `packages3D` `.wrl` models** | CC-BY-SA (share-alike) | **Never bundled and never cached.** Loaded only from the user's own KiCad install at runtime; caching a `.wrl` into app-data would itself be redistribution and trigger share-alike. (VRML loading is deferred to post-v1; placeholders are used in v1.) | design (no `.wrl` read/write path in v1) |
| **kicanvas / Velxio** | MIT-but-alpha / AGPLv3 | **No vendored code from either.** Pattern reference only. | repo review |
| **Electron, React, Three.js, zustand, troika-three-text, koffi** and their transitive production dependencies (30 packages in total, all MIT) | MIT | Bundled (npm deps). Electron is a devDependency that electron-builder packs as the runtime. | license-hygiene gate (rule 3) walks `package-lock.json` |
| **electron-updater** | Not shipped | Removed from `dependencies` (issue #79): nothing imported it, and an update channel cannot be wired up until installers are signed (see the deferral below). Re-add it together with the signing work, and add it and its subtree to this table at that time. | license-hygiene gate (rule 3) |
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

## How the shipped npm tree is enforced

`scripts/license-hygiene.mjs` (rule 3) walks `package-lock.json` from the root
`dependencies` (plus `optionalDependencies` and non-optional peers), resolving
nested `node_modules` the way npm does, and fails the build when any reachable
package:

- has no `license` field in the lockfile, or declares `UNLICENSED` /
  `SEE LICENSE IN ...`; or
- carries a copyleft SPDX identifier (GPL, LGPL, AGPL, MPL, CC-BY-SA, and
  similar). In an `A OR B` expression the gate accepts the tree if any
  alternative is permissive; `A AND B` fails if either side is copyleft.

`devDependencies` are not shipped and are not checked. The rule is unit-tested
in `src/core/__tests__/license-hygiene.test.ts`, including a check that the
real lockfile's production tree does not contain `electron-updater`.

## How model provenance is enforced

- Every file in `resources/models/` must contain a `Provenance:` header.
- `src/core/models/__tests__/library-content.test.ts` asserts the header on
  every file, that no forbidden vendor-copyright marker text appears, and that
  every `index.json` entry resolves to a real `.model`/`.subckt`/template.
- The `Provenance:` header only proves the word exists, so the claim behind it is
  enforced separately for the discrete semiconductors (BJT, diode, TVS, LED cards).
  `scripts/fit-model-cards.mjs` derives those cards from datasheet operating points
  (Vf at If, hFE at Ic, fT, Cobo, Cibo, trr, VBR at IT); its non-datasheet
  assumptions are listed in the script and in each `.lib` header.
  `src/core/models/__tests__/library-derivation.test.ts` fails when a `.lib` card
  drifts from the script output, and
  `src/core/models/__tests__/library-fingerprint.test.ts` fails when any bundled
  BJT, diode or LED card matches the parameter tuple of a well-known third-party
  library card (the classic PSpice evaluation-library 2N2222, 2N3904, 2N3906, the
  Motorola 1N4001 card, the LTspice standard.dio 1N4148 and 1N5819 cards), so a
  numerically identical card cannot pass on the strength of its header. The
  datasheet figures in the script are transcribed from the datasheet families and
  are not yet re-verified against vendor PDFs row by row. Add a fingerprint when
  a new third-party card is identified.
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

## Code signing / notarization (certificates supplied at release time)

The release job in `.github/workflows/ci.yml` signs and notarizes installers
when the release environment carries the certificates, and otherwise builds
them unsigned. Which path ran is visible in the job log (the "Package
installers (signed)" or "Package installers (unsigned)" step). Until
certificates are supplied, releases are unsigned.

- **Windows (NSIS `.exe`):** signed when `CSC_LINK` / `CSC_KEY_PASSWORD` (or
  `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`) hold an Authenticode certificate;
  otherwise unsigned and Windows SmartScreen warns on first launch.
- **macOS (`.dmg`):** signed and notarized when an Apple Developer ID
  Application certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) and the notarization
  credentials (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) are
  present. Otherwise the build is unsigned, and macOS 15 and later will not
  open it unless the user deliberately allows it in System Settings > Privacy &
  Security. There is no shortcut around that prompt, and circsim does not
  document one. The steps are in the install guide
  (`website/docs/start/install.md`).
- **Linux (AppImage / `.deb`):** signing is not generally required for direct
  download; an optional GPG-signed `.deb` and `zsync` AppImage updates can be
  added for a repository-based distribution channel.
- **`SHA256SUMS`:** every tagged release attaches this file next to the
  installers. It lists the SHA-256 hash of each installer so a downloader can
  confirm the file is the one that was published, which matters most while the
  installers are unsigned. It is not a substitute for a signature.

Auto-update is deferred: an update channel needs signed builds, so `electron-updater` is not a dependency until that work lands.

Missing certificates are a release-blocker only for distribution beyond direct
download. It does not affect functional correctness
of the packaged app.
