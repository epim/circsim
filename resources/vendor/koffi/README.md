# Vendored koffi #271 patch — TEMPORARY

This directory vendors a **patched build of koffi 2.16.2** that fixes
[Koromix/koffi#271](https://github.com/Koromix/koffi/issues/271): a fatal
`napi_throw` / SIGABRT (exit 134) at process exit when a foreign thread is still
invoking a registered callback. circsim triggers this because libngspice's
background simulation thread keeps calling registered callbacks during teardown
(see `src/simhost/ngspiceFfi.ts`).

## Why this is vendored, and not just a dependency bump

The fix is **native-only** — a patched `koffi.node`, same version (2.16.2), no
JavaScript or API change. The prebuilt here is **win32_x64 only**. Pointing the
`koffi` dependency at the tarball would force macOS/Linux to build koffi from
source and break those CI legs, so instead a postinstall script
(`scripts/apply-koffi-271-patch.mjs`) swaps the patched binary into
`node_modules/koffi` **only on Windows x64**. Every other platform keeps the
stock registry koffi.

## Files

| file | what |
|------|------|
| `koffi-2.16.2-271-win32x64.tgz` | full patched koffi 2.16.2 npm package (win32_x64 prebuilt), for reference / manual `npm install` |
| `koffi-2.16.2-271-win32x64.node` | the patched native binary the postinstall swaps in — sha256 `44BC8D016166D26D436F4C82884B89F5BE34A384AAB26FDF1E026E217B0A5D52` |
| `koffi-2.16.2-271.patch` | the exact source change, for transparency / rebuilding |

## ⚠️ Remove this when the fix is upstreamed

This vendoring is a stopgap **only until a koffi release later than 2.16.2 ships
the #271 fix**. When that happens:

1. Bump the `koffi` dependency in `package.json` to that release.
2. Delete the `postinstall` hook from `package.json`.
3. Delete `scripts/apply-koffi-271-patch.mjs`.
4. Delete this `resources/vendor/koffi/` directory.

Watch the upstream issue for the release that carries the fix.
