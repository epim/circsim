# koffi #271 — source patch (reference only)

circsim runs **stock koffi 3.1.1** from the npm registry on every platform. This
directory keeps `koffi-3.1.1-271.patch` only as the **source-of-record** for the
fix to [Koromix/koffi#271](https://github.com/Koromix/koffi/issues/271): a fatal
abort / segfault at process exit when a foreign thread — e.g. libngspice's
background simulation thread — is still invoking a registered koffi callback
during teardown (see `src/simhost/ngspiceFfi.ts`).

## Why we ship stock, not a patched binary

We briefly vendored a **pre-built patched** koffi 3.1.1 (Windows x64) and swapped
it in via a `postinstall` script. It passed the entire Node/vitest suite and a
standalone #271 repro — but it **crashes on `require('koffi')` inside the Electron
runtime**, which is where circsim actually runs. Root cause: the patched prebuilt
was a native-MSVC / `delayimp` build, whereas stock koffi ships clang cross-builds
that Electron loads cleanly. A Node-only validation missed it; the E2E gate caught
it. So the patched binary is **not** vendored.

The tradeoff of running stock 3.1.1: we lose the *native* #271 guard, but circsim's
`SimHost.dispose` already performs the safe teardown — halt + join the ngspice
background thread, then `koffi.unregister` + `lib.unload` — before the environment
tears down, which avoids the race on every normal exit path. The native patch was
only belt-and-suspenders for exits that skip `dispose`.

## Upstreaming

The fix is being submitted upstream. When a koffi release carries it (built the
same way as the official binaries, so Electron-compatible), bump the `koffi`
dependency to that release and delete this directory. `koffi-3.1.1-271.patch`
touches `src/koffi/src/{call.cc,ffi.cc,ffi.hh}` — the three #271 teardown guards.
