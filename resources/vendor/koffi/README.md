# Vendored koffi #271 patch — TEMPORARY

This directory vendors a **patched build of koffi 3.1.1** that fixes
[Koromix/koffi#271](https://github.com/Koromix/koffi/issues/271): a fatal
`napi_throw` / SIGABRT (exit 134) at process exit when a foreign thread is still
invoking a registered callback. circsim triggers this because libngspice's
background simulation thread keeps calling registered callbacks during teardown
(see `src/simhost/ngspiceFfi.ts`).

The stock npm `koffi@3.1.1` does **not** contain the #271 fix. This build carries
three native guards (all keyed off an `exiting` flag set by a `process.on('exit')`
listener): the async broker drops the in-flight relay into a dying environment,
callbacks bail out during teardown, and library unmap (`FreeLibrary`/`dlclose`)
is skipped so a still-running foreign thread does not crash. 3.x's teardown
handling is strictly better than the 2.16.2 patch — clean 0/10 exits even under a
pathological no-sleep callback loop.

## Why this is vendored, and not just a dependency bump

The fix is **native-only** — a patched `koffi.node`, same version (3.1.1), no
JavaScript or API change. The prebuilt here is **win32_x64 only**. Pointing the
`koffi` dependency at the tarball would force macOS/Linux to build koffi from
source and break those CI legs, so instead a postinstall script
(`scripts/apply-koffi-271-patch.mjs`) swaps the patched binary into
`node_modules` **only on Windows x64**. Every other platform keeps the stock
registry koffi 3.1.1 (unpatched, relying on the `dispose()` thread-join +
`koffi.unregister` workaround in `ngspiceFfi.ts`).

koffi 3.x ships its native binary in a per-platform optional dependency
(`@koromix/koffi-<platform>`), not `koffi/build/...` as 2.x did. On win32_x64 the
swap target is therefore
`node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node`.

## Files

| file | what |
|------|------|
| `koffi-3.1.1-271-win32x64.tgz` | full patched koffi 3.1.1 npm package (win32_x64 prebuilt; `optionalDependencies` + install script stripped so it bundles the binary directly), for reference / manual `npm install` |
| `koffi-3.1.1-271-win32x64.node` | the patched native binary the postinstall swaps in — sha256 `594350D4F597D99093BF92EE6C83B5BB037958352B70D328060B1730BADFAD0D` |
| `koffi-3.1.1-271.patch` | the exact source change (three files: `call.cc`, `ffi.cc`, `ffi.hh`), for transparency / rebuilding |

## ⚠️ Remove this when the fix is upstreamed

This vendoring is a stopgap **only until a koffi release ships the #271 fix**
(the maintainer is submitting an upstream PR). When that release lands:

1. Bump the `koffi` dependency in `package.json` to that release.
2. Delete the `postinstall` hook from `package.json`.
3. Delete `scripts/apply-koffi-271-patch.mjs`.
4. Delete this `resources/vendor/koffi/` directory.

Watch the upstream issue for the release that carries the fix.
