# ngspice Bundled Binaries

This directory contains pre-built ngspice shared library binaries and XSPICE code models
for each supported platform. These files are **not committed to git** (see `.gitignore`).
They are downloaded or built by the CI/build scripts.

## Platform layout

```
resources/ngspice/
  win32-x64/
    ngspice.dll              — ngspice shared library (Windows x64)
    libomp140.x86_64.dll     — OpenMP runtime required by ngspice.dll
    lib/ngspice/
      analog.cm              — XSPICE analog code models
      digital.cm             — XSPICE digital code models (required for d_inv etc.)
      spice2poly.cm
      xtradev.cm
      xtraevt.cm
      tlines.cm
      (table.cm is EXCLUDED — see below)
    spinit.stock             — stock spinit script (for reference; SimHost generates a patched version)
    manifest.json            — version + SHA-256 checksums of all bundled files
  darwin-x64/               — macOS Intel (built from source in CI)
  darwin-arm64/             — macOS Apple Silicon (built from source in CI)
  linux-x64/                — Linux x64 (built from source in CI)
  README.md                 — this file
  COPYING                   — ngspice BSD-3-Clause license text
```

## Provenance and license

**ngspice** is distributed under the **BSD-3-Clause** license.  
Copyright (C) 1985–2024 The ngspice team.  
Homepage: https://ngspice.sourceforge.io/  
Source:   https://github.com/ngspice/ngspice  

Full license text: see `COPYING` in this directory.

### Windows binaries

Downloaded from the official SourceForge release:
`https://master.dl.sourceforge.net/project/ngspice/ng-spice-rework/<VERSION>/ngspice-<VERSION>_dll_64.7z?viasf=1`

The `_dll_64` archive (not the plain `_64` archive) contains the shared library (`ngspice.dll`).

The companion `libomp140.x86_64.dll` is the Microsoft OpenMP runtime (`libomp`), part of
the Visual C++ Redistributable. It is included in the ngspice release archive and is
redistributable under the terms of the Visual C++ Redistributable EULA.

### macOS / Linux binaries

Built from source in CI using:
```
./configure --with-ngshared --enable-xspice --enable-cider --with-x=no --disable-debug && make -j
```

## table.cm exclusion

`table.cm` is **excluded** from the bundle. It contains GPL-licensed third-party lookup-table
code that is incompatible with our BSD/MIT redistribution intent. All other `.cm` files are
BSD-licensed or public domain. This exclusion is enforced by both `fetch-ngspice.mjs` and
`build-ngspice.sh`.

## Acquiring the binaries

Run the appropriate script from the project root:

```sh
# Windows: download prebuilt DLL
node scripts/fetch-ngspice.mjs

# macOS / Linux: build from source
bash scripts/build-ngspice.sh
```

CI runs these scripts automatically and caches the results keyed on the ngspice version.
