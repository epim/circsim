# circsim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build circsim — a cross-platform Electron desktop app that loads a Quilter-routed KiCad board file, renders it in 3D, and runs an interactive ngspice simulation with virtual bench instruments.

**Architecture:** Three processes — Electron Main (lifecycle, SimHost supervision), Renderer (React UI + imperative Three.js viewport + all pure-TS domain logic), SimHost (utilityProcess loading libngspice via koffi FFI, crash-isolated). Pure domain pipeline: `.kicad_pcb` → S-expr parse → `BoardModel` → netlist → tiered model resolution → SPICE deck → SimHost streaming back samples.

**Tech Stack:** Electron + electron-vite + electron-builder, TypeScript, React 18, zustand, Three.js (WebGL2), troika-three-text, koffi, ngspice ≥ 46 (libngspice + XSPICE `.cm`), Vitest, Playwright.

**Canonical reference:** `docs/superpowers/specs/2026-06-10-circsim-design.md` (cited below as "Spec §N"). Every task agent MUST read the cited spec sections before writing code. Where the plan and spec conflict, the spec wins; report the conflict.

**Working conventions for every task (do not repeat per task):**
1. TDD: write the listed failing tests first, run them (expect FAIL), implement minimally, run again (expect PASS), then commit.
2. Commit per task minimum, more if natural: `feat(scope): summary` / `test(scope): summary`.
3. Run `npm run typecheck && npm test` before declaring a task done.
4. `src/core/**` must not import from `electron`, `react`, or `three` (enforced by an ESLint rule added in Task 1).
5. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

**Task dependency graph (tasks in the same phase with no arrow between them are parallel-safe):**

```
Phase 0: T1
Phase 1: T1 → T2 → {T3, T5} ; T3 → T4 ; T2 → {T6 needs T3, T7}
Phase 2: T1 → T8 → T9 → T10 ; T1 → T11 (T11 needs T9 for payload types)
Phase 3: T6 → T12 → T13 ; T12 → T14a, T14b → T15
Phase 4: T3 → T16 → T17 → {T18, T19} → T20
Phase 5: {T13, T11, T20} → T21 → T22 → T23 → T24 → T25
Phase 6: T24 → T26 → T27 ; T24 → T28
```

---

## Phase 0 — Scaffold

### Task 1: Project scaffold, tooling, CI skeleton

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `.eslintrc.cjs`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`
- Create: `src/simhost/index.ts` (placeholder that logs "simhost alive" — replaced in Task 9)
- Create: `.github/workflows/ci.yml`
- Test: `src/core/__tests__/smoke.test.ts`

- [ ] Scaffold with `npm create @quick-start/electron` (electron-vite, React + TS template), then add `zustand`, `three`, `@types/three`, `troika-three-text`, `koffi`, `vitest`, `@vitest/coverage-v8`, `eslint`.
- [ ] Add a `simhost` build entry to `electron.vite.config.ts` (extra Node entry alongside `main`/`preload`) producing `out/simhost/index.js`.
- [ ] ESLint rule: `no-restricted-imports` of `electron|react|three` for files under `src/core/**`.
- [ ] Smoke test asserting Vitest runs: `expect(1 + 1).toBe(2)`.
- [ ] CI: `.github/workflows/ci.yml` matrix `[windows-latest, macos-15-intel, macos-14, ubuntu-latest]` (NOT `macos-13` — that runner image was retired Dec 2025), steps: checkout → setup-node 20 → `npm ci` → `npm run typecheck` → `npm test`. (ngspice steps land in Task 8.)
- [ ] Acceptance: `npm run dev` opens a window titled "circsim"; `npm test` passes; CI green on all four runners.

---

## Phase 1 — Core domain (pure TS)

### Task 2: `core/sexpr` — S-expression parser

**Files:**
- Create: `src/core/sexpr/parse.ts`
- Test: `src/core/sexpr/__tests__/parse.test.ts`

Spec §8.1. API:

```ts
export type SExpr = string | number | SExpr[];
export function parseSexpr(text: string): SExpr;          // throws SexprError {line, col, message}
export function findAll(node: SExpr, head: string): SExpr[];   // immediate children whose [0] === head
export function find(node: SExpr, head: string): SExpr | undefined;
export function atom(node: SExpr, index: number): string | number | undefined;
```

- [ ] Failing tests (write all, verbatim behaviors):
  - parses `(net 1 "VIN")` → `["net", 1, "VIN"]`
  - quoted strings with escapes: `(a "he said \"hi\"")` → `["a", 'he said "hi"']`
  - numbers stay numbers (`1.6`, `-0.9125`), version-like tokens that aren't valid numbers stay strings
  - nested depth ≥ 6; bare symbols (`smd`, `F.Cu`) parse as strings
  - **junk tolerance:** unknown heads survive round-trip into the tree (parser never validates vocabulary)
  - error case: unbalanced paren → `SexprError` with line/col
  - `findAll`/`find`/`atom` helper behaviors
- [ ] Implement (~200 lines, recursive descent). No regex tokenization for strings (escape handling).
- [ ] Acceptance: all listed tests pass; parses a 1 MB synthetic file in < 500 ms (add a perf test with `expect(ms).toBeLessThan(500)`).

### Task 3: `core/kicad` — board parser + first fixture

**Files:**
- Create: `src/core/kicad/board.ts`, `src/core/kicad/types.ts`
- Create: `fixtures/fixture-rc.kicad_pcb`
- Test: `src/core/kicad/__tests__/board.test.ts`

Spec §2, §8.2 (the `BoardModel`/`Footprint`/`Pad` interfaces there are normative — copy them into `types.ts` exactly).

- [ ] Author the fixture file with this exact content (KiCad-7-style; a voltage divider: R1 VIN→OUT, R2 OUT→GND):

```
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (37 "F.SilkS" user "F.Silkscreen")
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "VIN")
  (net 2 "OUT")
  (net 3 "GND")
  (footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")
    (at 10 10)
    (fp_text reference "R1" (at 0 -1.65) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1.65) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.9125 0) (size 1.025 1.4)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 1 "VIN"))
    (pad "2" smd roundrect (at 0.9125 0) (size 1.025 1.4)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 2 "OUT"))
  )
  (footprint "Resistor_SMD:R_0805_2012Metric" (layer "F.Cu")
    (at 20 10)
    (fp_text reference "R2" (at 0 -1.65) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value "10k" (at 0 1.65) (layer "F.Fab")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd roundrect (at -0.9125 0) (size 1.025 1.4)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 2 "OUT"))
    (pad "2" smd roundrect (at 0.9125 0) (size 1.025 1.4)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 3 "GND"))
  )
  (segment (start 10.9125 10) (end 19.0875 10) (width 0.25) (layer "F.Cu") (net 2))
  (gr_text "fixture-rc" (at 15 17) (layer "F.SilkS")
    (effects (font (size 1 1) (thickness 0.15))))
  (gr_line (start 0 0) (end 30 0) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 0) (end 30 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 30 20) (end 0 20) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 20) (end 0 0) (layer "Edge.Cuts") (width 0.1))
)
```

- [ ] Failing tests: `parseBoard(text)` returns 3 named nets + net 0 ignored; 2 footprints with correct `ref`, `value`, `libId`, `at` — **including `at.rotDeg === 0` when the rotation token is absent** (common NaN bug); R1 pad "1" → netId 1, pad "2" → netId 2; 1 track segment (`kind:'segment'`, netId 2, widthMm 0.25 — `TrackSegment` is the discriminated union from Spec §8.2); board thickness 1.6; `edgeCuts` has 4 `EdgePrimitive`s of `kind:'line'` (type defined in Spec §8.2; stitching is Task 4); `silkscreen` has ≥ 1 entry (the `gr_text` on F.SilkS) and value text on `F.Fab` is NOT in `silkscreen`.
- [ ] Implement `parseBoard` on top of `core/sexpr`. **Both** `fp_text reference|value` (KiCad 6/7) **and** `(property "Reference" …)` (KiCad 8+) forms must populate ref/value — add a small KiCad-8-style footprint variant test inline (string literal in the test, not a second fixture). Accept both `F.SilkS` and `F.Silkscreen` layer spellings. Pad `layers` lists are NOT validated against the file's `(layers …)` table (files legitimately reference undeclared layers).
- [ ] Unknown tokens anywhere must be skipped silently (test: inject `(zzz_future_field 42)` at three levels, parse still succeeds).
- [ ] Acceptance: tests pass; fixture committed.

### Task 4: Edge.Cuts outline stitching

**Files:**
- Create: `src/core/kicad/outline.ts`
- Test: `src/core/kicad/__tests__/outline.test.ts`
- Create: `fixtures/fixture-arcs.kicad_pcb` (rounded-corner rectangle outline using 4 `gr_line` + 4 `gr_arc`, plus one interior circular cutout `gr_circle`; author by hand, ~30 lines, same header style as Task 3's fixture)

Spec §8.2 "Edge.Cuts stitching". `EdgePrimitive`, `Vec2` (`{x,y}`), and `OutlineGeometry` are defined in Spec §8.2 — copy them, don't improvise. KiCad 6+ arcs are the three-point form (`start`/`mid`/`end` are points ON the arc; `mid` is not the center). API:

```ts
export function stitchOutline(primitives: EdgePrimitive[], toleranceMm?: number /* 0.01 */): OutlineGeometry;
```

- [ ] Failing tests: 4-segment rectangle (any segment order, some reversed) → 1 closed outer loop, 0 holes; arcs tessellated (≥ 8 points per 90°); circle → hole when contained in outer loop; **gap > tolerance → bounding-box fallback + warning string containing "outline"**; two disjoint outer loops → larger = outer, warning emitted.
- [ ] Implement: endpoint-matching chain builder with tolerance; arc tessellation from KiCad's (start/mid/end) arc form; containment test via point-in-polygon; area sign normalization (outer CCW, holes CW).
- [ ] Acceptance: all tests pass including the arcs fixture parsed end-to-end through `parseBoard` + `stitchOutline`.

### Task 5: `core/kicad` — minimal schematic parser + full 555 fixture pair

**Files:**
- Create: `src/core/kicad/schematic.ts`
- Create: `fixtures/fixture-555.kicad_sch` AND `fixtures/fixture-555.kicad_pcb` — a **complete minimal 555 astable** (this pair is reused by Task 14b, Task 24's acceptance, and Task 26's sample): components U1 (NE555, `Sim.Pins=1=GND 2=TRIG 3=OUT 4=RESET 5=CTRL 6=THRES 7=DISCH 8=VCC`, plus `Sim.Library`/`Sim.Name` fields), R1 10k (VCC→DISCH), R2 47k (DISCH→THRES), C1 10u (THRES→GND, THRES tied to TRIG), C2 100n (CTRL→GND), R3 330 (OUT→LED_A), D1 LED (LED_A→GND), nets VCC/GND/DISCH/THRES/OUT/LED_A; RESET tied to VCC. The `.kicad_pcb` mirrors the same nets/pads using the Task 3 fixture's footprint style (SOIC-8 for U1: 8 pads numbered 1–8). U1's pins carry numbers+names; include one no-connect example on a spare net. Author both by hand following Task 3 conventions.
- Test: `src/core/kicad/__tests__/schematic.test.ts`

Spec §2, §8.2. API: `parseSchematicSimData(text): SchematicSimData` where `SchematicSimData = Map<string /*ref*/, SymbolSimInfo>`; `SymbolSimInfo = { value?: string; sim: Partial<Record<'Device'|'Type'|'Params'|'Pins'|'Library'|'Name', string>>; pins: { number: string; name: string; type: string }[]; noConnects: string[] }`.

- [ ] Failing tests: extracts the six `Sim.*` properties keyed by ref; pin numbers/names from `(symbol (pin …))` blocks resolved through `lib_symbols`; no-connect pad listed; symbols without Sim fields still appear with empty `sim`.
- [ ] Implement; tolerate hierarchical-sheet files by flat-scanning all `(symbol …)` instances (v1 explicitly ignores hierarchy path semantics — document in code comment).
- [ ] Acceptance: tests pass.

### Task 6: `core/netlist` — connectivity extraction

**Files:**
- Create: `src/core/netlist/extract.ts`, `src/core/netlist/spiceNames.ts`
- Test: `src/core/netlist/__tests__/extract.test.ts`

Spec §8.3 (interfaces normative). 

- [ ] Failing tests: fixture-rc → 3 `CircuitNet`s; `OUT` net has padRefs `[{R1,2},{R2,1}]`; spiceNode sanitization follows the Spec §8.3 deterministic algorithm exactly — assert `VIN`→`vin`, `+5V`→`_5v`, `Net-(R1-Pad1)`→`net_r1_pad1_`, collision → `_2` suffix; designated ground netId → spiceNode `"0"`; `Part` objects built per Spec §8.3 (`padNet` map correct for both fixtures); warnings: pad with no net → `floating-pad`, net with single pad → `single-pad-net`; `suggestGround(nets)` returns the `GND` net for names `GND|AGND|DGND|VSS|0V` (case-insensitive) and `suggestSupplies(nets)` matches `VCC|VDD|3V3|5V|+5V|+3.3V|12V` patterns.
- [ ] Implement (the golden decks in Task 13 depend on this sanitization being exactly as specified — do not deviate).
- [ ] Acceptance: tests pass.

### Task 7: value parser + BOM CSV importer

**Files:**
- Create: `src/core/values/parseValue.ts`, `src/core/bom/parseBom.ts`
- Test: `src/core/values/__tests__/parseValue.test.ts`, `src/core/bom/__tests__/parseBom.test.ts`

Spec §8.4, §8.5 Tier 2.

- [ ] Failing tests for `parseValue(text, kind: 'R'|'C'|'L'): number|undefined` (returns base units). Convention (Spec §8.5 Tier 2 — this is the *value-field* domain, not SPICE text): uppercase `M` and `Meg`/`MEG` = mega; lowercase `m` = milli. Decks never see suffixes (spicegen emits plain numbers), so SPICE's own M-means-milli rule never applies. Cases:
  `"10k"→1e4`, `"4k7"→4.7e3`, `"4.7u"→4.7e-6`, `"100n"→1e-7`, `"2.2Meg"→2.2e6`, `"1M"(R)→1e6`, `"1m"(R)→1e-3`, `"0R22"→0.22`, `"DNP"→undefined`, `"10uF"→1e-5`, `"470"(R)→470`.
- [ ] Failing tests for `parseBom(csvText): BomParseResult` (`{ rows: Map<ref, {value?, mpn?, footprint?}>, columnGuess: Record<string,string>, errors: string[] }`): comma + semicolon + tab autodetect; header aliases (`Designator`→ref, `Manufacturer Part Number`/`MPN`/`Part Number`→mpn); grouped-ref rows (`"R1, R2, R3"` in one row) expand to one entry per ref; quoted fields with embedded commas.
- [ ] Implement both (no external CSV dependency; ~120 lines is enough given the tolerance requirements above).
- [ ] Acceptance: tests pass.

---

## Phase 2 — SimHost (ngspice)

### Task 8: ngspice binary acquisition + resources layout

**Files:**
- Create: `scripts/fetch-ngspice.mjs` (Windows download path), `scripts/build-ngspice.sh` (mac/linux source build)
- Create: `resources/ngspice/README.md` (provenance + license note), `resources/ngspice/COPYING` (copied from ngspice)
- Modify: `.github/workflows/ci.yml`, `package.json` (config key `circsim.ngspiceVersion`)

Spec §7.2, §7.3, §15.

- [ ] `fetch-ngspice.mjs`: downloads the pinned official Windows 64-bit release archive from SourceForge, extracts `ngspice.dll` + `lib/ngspice/*.cm` into `resources/ngspice/win32-x64/`, **deletes `table.cm`**, verifies `digital.cm` exists, writes a `manifest.json` with version + sha256s.
  - **VERIFIED archive + paths (probed 2026-06-14 — the research was WRONG about this, do not rediscover):**
    - **Use the `_dll_64` package, NOT `ngspice-46_64.7z`.** The plain `ngspice-46_64.7z` ships only `ngspice.exe`/`ngspice_con.exe` — it has **no `ngspice.dll`**. The shared library lives in a separate archive: **`ngspice-46_dll_64.7z`** (≈4.2 MB).
    - Working direct URL (the `…/files/…/download` and `downloads.sourceforge.net` hosts return an HTML interstitial, not the binary — use `master.dl`): `https://master.dl.sourceforge.net/project/ngspice/ng-spice-rework/46/ngspice-46_dll_64.7z?viasf=1`. Validate the response is `application/x-7z-compressed` and > 2 MB before extracting; fail loudly on HTML.
    - **Internal layout (top folder `Spice64_dll/`):** `Spice64_dll/dll-vs/ngspice.dll` (the library) and its **required companion `Spice64_dll/dll-vs/libomp140.x86_64.dll`** (ngspice.dll will not load without the OpenMP runtime beside it); code models `Spice64_dll/lib/ngspice/*.cm` (analog, digital, spice2poly, table, tlines, xtradev, xtraevt); init script `Spice64_dll/share/ngspice/scripts/spinit`. Copy `ngspice.dll` + `libomp140.x86_64.dll` into `resources/ngspice/win32-x64/`, the `.cm` files into `resources/ngspice/win32-x64/lib/ngspice/` (then delete `table.cm`). Locate entries by glob after extraction; don't hardcode the top-folder name across versions.
  - **Extraction:** this machine has NO system 7-Zip and Windows `tar`/libarchive does not handle `.7z`. Add `7zip-min` (npm, bundles 7za for win/mac/linux) as a devDependency and extract with it (`import { unpack } from '7zip-min'`).
- [ ] `build-ngspice.sh`: on mac/linux builds the pinned version: `./configure --with-ngshared --enable-xspice --enable-cider --with-x=no --disable-debug && make -j` then copy the shared library + `.cm` files into `resources/ngspice/<darwin-x64|darwin-arm64|linux-x64>/`, same `table.cm` deletion + manifest. **The shared-library flag is `--with-ngshared`** — there is no `--with-ngspice-lib`; a wrong flag silently builds an executable instead. The script must end with a verification that the artifact is a shared library: `file libngspice.so | grep -q "shared object"` (Linux) / `test -f libngspice.dylib` + `file … | grep -q "dynamically linked shared library"` (macOS) — fail loudly otherwise.
- [ ] CI: add an ngspice step per OS with `actions/cache` keyed on the pinned version (macOS runners first: `brew install autoconf automake libtool`); artifacts must exist before tests of Phase 2 run.
- [ ] Acceptance: script run on each CI OS leaves `resources/ngspice/<platform>/{libngspice.*, lib/ngspice/digital.cm, manifest.json}` and **no `table.cm`**; a unit test asserts `manifest.json` parses and `table.cm` is absent.

### Task 9: SimHost FFI bindings + command queue + op analysis

**Files:**
- Create: `src/simhost/index.ts`, `src/simhost/engine.ts` (the `SpiceEngine` interface), `src/simhost/ngspiceFfi.ts`, `src/simhost/protocol.ts` (the `SimCommand`/`SimEvent` types from Spec §6.1, copied verbatim)
- Test: `src/simhost/__tests__/op.integration.test.ts` (runs in Node via Vitest, tagged `integration`)

Spec §6.1 (protocol normative), §7.1, §7.4. The C surface to bind with koffi (from ngspice's `sharedspice.h` — verify against the header shipped with the pinned version and adjust if it differs):

```c
// callbacks
typedef int (SendChar)(char* output, int libId, void* user);
typedef int (SendStat)(char* status, int libId, void* user);
typedef int (ControlledExit)(int exitStatus, bool immediate, bool quitOnExit, int libId, void* user);
typedef int (SendData)(pvecvaluesall data, int vecCount, int libId, void* user);
typedef int (SendInitData)(pvecinfoall data, int libId, void* user);
typedef int (BGThreadRunning)(bool notRunning, int libId, void* user); // NOTE: true means NOT running
// structs
typedef struct vecvalues { char* name; double creal; double cimag; bool is_scale; bool is_complex; } vecvalues, *pvecvalues;
typedef struct vecvaluesall { int veccount; int vecindex; pvecvalues* vecsa; } vecvaluesall, *pvecvaluesall;
// functions
int  ngSpice_Init(SendChar*, SendStat*, ControlledExit*, SendData*, SendInitData*, BGThreadRunning*, void* user);
int  ngSpice_Circ(char** circarray /* null-terminated */);
int  ngSpice_Command(char* command);
pvector_info ngGet_Vec_Info(char* vecname);
char* ngSpice_CurPlot(void);
char** ngSpice_AllVecs(char* plotname);
bool ngSpice_running(void);
```

- [ ] Implement `ngspiceFfi.ts` with koffi: load the platform library from `resources/ngspice/<platform>/` (path resolution helper honoring packaged vs dev layout), register the six callbacks, expose a typed wrapper.
- [ ] **`.cm` path bootstrap (packaging-critical, Spec §7.2):** before `ngSpice_Init`, generate a `spinit` file in an app-data/temp dir whose `codemodel` lines use ABSOLUTE paths to the five bundled `.cm` files, and set `process.env.SPICE_SCRIPTS` to that directory. Relative spinit paths resolve against the Electron executable in packaged builds and will silently fail — never rely on the stock spinit.
- [ ] **Hard rules encoded here:** (a) command strings lowercased for device tokens before `alter`; (b) callbacks ONLY enqueue onto an internal event queue — never call `ngSpice_Command` from a callback frame (drain the command queue from a `setImmediate` loop); (c) `destroy all` issued before every `loadCircuit`; (d) **potentially-blocking commands (`op`, `loadCircuit`, non-bg runs) are invoked via koffi's async call form** — a sync FFI call blocks the event loop, which freezes both callback delivery and the watchdog timer (`bg_*` commands return immediately and may stay sync); (e) 10 s watchdog: if a submitted command produces no SendChar/SendStat/queue progress in 10 s, `process.exit(86)` (Main respawns, Task 11).
- [ ] `loadCircuit` via `ngSpice_Circ`; `runOp` = async command `op`, then read all vectors of the current plot via `ngSpice_CurPlot`/`ngSpice_AllVecs`/`ngGet_Vec_Info` into `opResult`. **Key normalization (Spec §6.1):** `opResult.values` keys are bare lowercase node names (`"out"`, never `"v(out)"`/`"OUT"`); strip any `v(...)` wrapper ngspice returns; device/source currents keyed `i(<device>)`. Encode this in `protocol.ts` doc comments and assert it in the test.
- [ ] Startup self-check: run this exact smoke deck once at init (XSPICE `a` elements are event-driven — `.tran`, never `.op`); pass = final `v(out)` ≥ 4.5; on failure emit `log{level:'error'}` naming the `.cm` files (Spec §7.2):

```
* cm smoke: 0V in -> adc -> d_inv -> dac -> expect ~5V out
v1 in 0 dc 0
abr_in [in] [din] adcm
.model adcm adc_bridge(in_low=1.0 in_high=2.0)
ainv din dout invm
.model invm d_inv(rise_delay=1n fall_delay=1n)
abr_out [dout] [out] dacm
.model dacm dac_bridge(out_low=0 out_high=5)
.tran 1n 20n
.end
```

- [ ] Integration test (skipped automatically when `resources/ngspice/<platform>` is missing): deck `["* rc divider","v1 vin 0 dc 5","r1 vin out 10k","r2 out 0 10k",".end"]` → `runOp` → `opResult.values["out"]` ≈ 2.5 within 1 %; `values["vin"]` ≈ 5 (keys per the normalization rule above).
- [ ] Acceptance: `npm run test:integration` passes locally and in CI on all OS runners.

### Task 10: SimHost transient streaming, pacing, alter

**Files:**
- Modify: `src/simhost/engine.ts`, `src/simhost/index.ts`
- Create: `src/simhost/sampleBatcher.ts`
- Test: `src/simhost/__tests__/transient.integration.test.ts`

Spec §6.1, §7.4, §7.5.

- [ ] `runTransient`: issue `bg_tran <tstep> <tstop>` (decks carry no `.tran` card; a bare `bg_run` has no analysis to run); `SendInitData` → emit `vectors`; `SendData` → `sampleBatcher` (flush every 16 ms or 4096 points, transferable Float64Arrays).
- [ ] **Bounded bench windows (Spec §7.5 — mandatory, sharedspice retains all timepoints in RAM):** `tstop` = bench window `W` (default 30 s sim-time). On window end OR SimHost RSS > 1.5 GB (check `process.memoryUsage().rss` in the pacing loop): halt → `destroy all` → reload deck → restart tran from t=0 → emit `benchRestarted{reason}`. Scope history lives in renderer ring buffers, so nothing is lost visually. Never issue an unbounded/huge tstop.
- [ ] **Halt ownership state machine (Spec §7.4.3):** single `haltOwner: 'none'|'user'|'alter'|'pacing'` field; only the halting owner resumes; `user` outranks others (alters during user-pause apply but don't resume). Renderer `halt`/`resume` commands set/clear the `user` owner. Unit-test the state transitions with a stubbed engine.
- [ ] `alter`: queue → `bg_halt` → all pending alters → `bg_resume` (batch window 30 ms so a knob drag coalesces), respecting haltOwner. Function-gen SIN/PULSE params use the vector form with exact spacing: `alter @vfgen_2[sin] [ <vo> <va> <freq> ]` (all params re-sent together).
- [ ] Pacing (Spec §7.5): 50 ms loop comparing sim-time vs wall-time × factor, halting/resuming as needed (owner `pacing`); `setPace` with `'max'` disables; report achieved factor in `status` every 250 ms.
- [ ] Convergence pattern-match on SendChar text ("timestep too small", "no convergence", "singular matrix") → `convergenceFailure` (Spec §7.4.6) and gmin/src-step retry ladder for `op` (Spec §8.8).
- [ ] Integration tests: (1) RC charge: deck `v1 in 0 dc 5` / `r1 in out 1k` / `c1 out 0 1u`, tran 1u 10m → captured samples match `5*(1-e^(-t/RC))` within 2 % at t = 1 ms, 2 ms, 5 ms; (2) mid-run `alter v1` to 10 → final samples ≈ 10 V steady-state; (3) sample batches arrive as Float64Array with matching `simTime` length.
- [ ] Acceptance: integration tests pass on all OS runners.

### Task 11: Main process — SimHost supervision + MessagePort relay

**Files:**
- Modify: `src/main/index.ts`
- Create: `src/main/simhostSupervisor.ts`, `src/preload/index.ts` (typed bridge: `window.circsim = { openFileDialog(), readFile(path), getSimPort(), onSimhostCrashed(cb), platformPaths() }`)
- Test: `src/main/__tests__/supervisor.test.ts` (unit-level with a stub child script)

Spec §6, §6.1 (`crashed` event), §12.

- [ ] `utilityProcess.fork(out/simhost/index.js)`; create a `MessageChannelMain`; send one port to SimHost via `child.postMessage` and the other to the renderer via `webContents.postMessage` — a **one-time handshake per spawn**; Main is NOT in the message path afterward (Spec §6).
- [ ] On SimHost exit (any code): notify the renderer via the **contextBridge** path (`onSimhostCrashed(cb)` with `{ willRespawn }`) — the MessagePort died with the process and cannot carry this event (Spec §6.1). Respawn with backoff (250 ms, 1 s, 5 s; give up after 5 consecutive crashes < 30 s apart → surface fatal error state) and re-run the port handshake.
- [ ] `contextIsolation: true`, `nodeIntegration: false`, CSP allowing `worker-src blob:` (troika — Spec §5 table).
- [ ] Acceptance: unit test proves respawn/backoff with a child that exits immediately; `npm run dev` shows "simhost ready" log in devtools console.

---

## Phase 3 — Model resolution & deck generation

### Task 12: `core/models` — resolution pipeline (tiers 1, 2, 6)

**Files:**
- Create: `src/core/models/resolve.ts`, `src/core/models/types.ts` (Spec §8.5 `ResolvedModel`/`Resolution`/`PinMap`/`LibraryEntry` verbatim)
- Test: `src/core/models/__tests__/resolve.test.ts`

Spec §8.5 (tier table normative).

- [ ] `resolveAll(circuit, schematicSimData?, bom?, library?, userOverrides?) → Resolution[]`.
- [ ] Failing tests: R with value `10k` → tier 2 primitive `r_<ref> <n1> <n2> 10000`; C polarity warning when footprint matches `CP_|Elec` and value parsed; part with `Sim.Device=R, Sim.Params="R=10k"` → tier 1 wins over tier 2; unknown IC → `status:'unresolved'`; user override to `{kind:'stub',mode:'open'}` → tier 6 `stubbed`; DNP value → stub open with warning.
- [ ] Tier 1 translation: `Sim.Device`/`Sim.Type`/`Sim.Params`/`Sim.Pins` → primitive card or subckt ref per KiCad semantics (R/C/L/V/I devices + `SUBCKT` type with `Sim.Library`/`Sim.Name`). Out-of-scope Sim devices (e.g. `KIBIS`) → unresolved with warning naming the device type.
- [ ] Acceptance: tests pass.

### Task 13: `core/spicegen` — deck generator + instruments

**Files:**
- Create: `src/core/spicegen/generate.ts`, `src/core/spicegen/instruments.ts` (Spec §9 `Instrument` type verbatim)
- Test: `src/core/spicegen/__tests__/generate.test.ts` (golden decks under `src/core/spicegen/__tests__/golden/`)

Spec §8.8, §9.

- [ ] Failing golden test #1 (fixture-rc + ground=GND + dc-supply 5 V on VIN). Node names are deterministic per the Spec §8.3 sanitization algorithm (`VIN`→`vin`, `OUT`→`out`, ground→`0`), so this golden is exact. Note the series-R splice puts the synthetic node on the **source side** (Spec §8.8) so net `vin` keeps its name for the overlay:

```
* circsim deck — fixture-rc
* R1: tier 2 (primitive) | R2: tier 2 (primitive)
vpsu_1 vpsu_1_int 0 DC 5
rpsu_1 vpsu_1_int vin 0.1
r_r1 vin out 10000
r_r2 out 0 10000
.save all
.end
```

- [ ] Tests: function-gen sine → `SIN(<offset> <amp> <freq>)` source; pulse with duty → `PULSE(…)` with computed widths; logic-input level 1, vHigh 5 → `DC 5`; numeric emission rule — values always plain decimal/exponent, never letter suffixes (test a 4.7 µF cap emits `4.7e-06`); current probe on R1 (top-level primitive) → adds `.save @r_r1[i]`, no extra element; current probe on a subckt part → inserts `vamm_<id>` 0 V ammeter at the designated pad (golden test #2 — this is a reload-path deck change, Spec §8.8); voltage probes add nothing; stub-open part contributes no cards but a comment line; stub-short ties pads via 1 µΩ resistors; xspice-digital template expands with `adc_bridge`/`dac_bridge` cards; every deck ends `.end`; all element names lowercase; **no blanket `.options savecurrents`** (memory — Spec §8.8).
- [ ] `alterPlan(instrumentChange) → {kind:'alter', commands: string[]} | {kind:'reload'}` rule (Spec §9): `dc-supply.volts`, `logic-input.level` → alter; `function-gen` freq/amp/offset → alter via the SIN/PULSE vector form `alter @vfgen_2[sin] [ <vo> <va> <freq> ]` (exact spacing, all params re-sent); `function-gen.wave` type change → reload; current-probe add/remove on subckt part → reload. Test every branch of this mapping.
- [ ] Acceptance: golden + unit tests pass.

### Task 14a: Bundled model library — discretes

**Files:**
- Create: `resources/models/index.json`, `resources/models/diodes.lib`, `resources/models/bjt.lib`, `resources/models/mosfet.lib`, `resources/models/led.lib`
- Test: `src/core/models/__tests__/library-content.test.ts`, `src/simhost/__tests__/library.integration.test.ts`

Spec §8.5 (content rules + licensing — **read the "never bundle" list before writing any model**).

- [ ] Write `.model` cards from datasheet parameters (each file header: `* Provenance: written for circsim from <datasheet> parameters, MIT`): 1N4148, 1N4001, 1N5819 (Schottky), BZX55C5V1 (Zener via bv/ibv), LEDs (red/green/blue/white — adjusted Vf via n & eg), 2N2222, 2N3904, 2N3906, BC547, BC557, 2N7002, AO3400-class NMOS, generic P-MOSFET.
- [ ] `index.json` entries per Spec §8.5 `LibraryEntry`, with `pinMaps` for the common footprints (`SOT-23` BJT EBC vs Asian CBE variants noted: provide both maps keyed by full footprint regex; diode `D_SMA|D_0805`: pad 1 = cathode per KiCad convention).
- [ ] Unit test: every file in `resources/models/` contains `Provenance:`; every index entry's `file`+`name` resolves; every entry has `pinMaps` or `defaultPinMap`.
- [ ] Integration test: for each `.model` card, a one-source test deck loads in SimHost without error (loop over index).
- [ ] Acceptance: tests pass; **no vendor-copied text** in any `.lib`.

### Task 14b: Bundled model library — ICs and digital

**Files:**
- Create: `resources/models/opamp.lib`, `resources/models/regulators.lib`, `resources/models/timer555.lib`, `resources/models/logic74hc.json` (XSPICE templates)
- Modify: `resources/models/index.json`
- Test: extend both test files from Task 14a

Spec §8.5.

- [ ] Behavioral op-amp macromodel (single subckt, parameterized: Aol, GBW, slew, Vsat from rails) instantiated for LM358, LM324, TL072, LM393 (comparator variant: open-collector output stage).
- [ ] Behavioral LDO/linear-regulator macromodel (Vout param, dropout, current limit) for 78xx family + AMS1117-3.3/5 (write from datasheet params — research confirmed no redistributable vendor model exists).
- [ ] NE555: write an in-house behavioral subckt from the datasheet block diagram (two comparators + RS latch via XSPICE `d_srlatch` or a B-source latch + discharge switch + 5k/5k/5k divider). There is NO `special_models` directory in the ngspice distribution; its example netlists (`examples/p-to-n-examples/555-timer-*.cir`) may be consulted for structure but their text must not be copied (provenance unstated — Spec §8.5).
- [ ] `logic74hc.json`: XSPICE digital templates (Spec §8.5 `xspice-digital`) for 74HC00/04/08/14/32/74/86/164/595 — gate-level using `d_nand`/`d_inv`/etc. with datasheet-typical delays, schmitt (HC14) via `d_inv` + hysteresis on the `adc_bridge` thresholds; per-package pinMaps (DIP-14/SOIC-14 etc. from datasheet pinouts).
- [ ] Integration tests: LM358 voltage-follower deck → op → out ≈ in; 555 astable fixture deck → transient → oscillation period within 20 % of RC formula; 74HC00 NAND truth table via **one `.tran` run stepping the four input states with PWL sources** (e.g. hold each state 1 µs, sample mid-state; inputs 00/01/10/11 → out high/high/high/low). XSPICE digital elements are event-driven and do NOT propagate in `.op` — never test digital logic with operating-point analysis.
- [ ] Acceptance: tests pass.

### Task 15: Library matching (tier 3) + user `.lib` import (tier 4)

**Files:**
- Modify: `src/core/models/resolve.ts`
- Create: `src/core/models/libraryMatch.ts`, `src/core/models/userLibrary.ts`
- Test: `src/core/models/__tests__/libraryMatch.test.ts`

Spec §8.5, §8.7 (validation flow — engine call is injected, keep core pure: `validateModel(deckLines) → Promise<ok|error>` passed in as a callback).

- [ ] Matching precedence tests: exact normalized MPN (`LM358DR` matches entry mpn `LM358` by prefix-after-normalization rules: strip package suffixes `[DPN]R?$|DT?$`… keep the rule list in code constants) → value regex (`NE555`) → refdesPrefix+footprint fallback; ambiguous matches (2 entries) → unresolved with warning listing candidates.
- [ ] Pin map selection: footprint regex match → entry pinMap; no match → `defaultPinMap` + warning `pinmap-unverified`.
- [ ] `userLibrary.ts`: scan a user dir (path injected) for `.lib/.sub`, extract `.subckt` names by regex, persist user-confirmed `{mpn → subckt, pinMap}` bindings as JSON; round-trip test.
- [ ] Acceptance: tests pass.

---

## Phase 4 — 3D viewport

### Task 16: Viewport shell + board substrate

**Files:**
- Create: `src/renderer/src/viewport/Viewport.tsx` (canvas mount + resize only), `src/renderer/src/viewport/scene.ts` (imperative scene manager, the ONLY file owning THREE objects), `src/renderer/src/viewport/boardGeometry.ts`
- Test: `src/renderer/src/viewport/__tests__/boardGeometry.test.ts` (geometry counts/extents only — no GL context)

Spec §10.1 (substrate row), §10.3.

- [ ] `buildSubstrate(outline: OutlineGeometry, thicknessMm): THREE.BufferGeometry`: one `THREE.Shape` per `outer` loop (holes assigned to their containing loop) → one `ExtrudeGeometry` each → merged (Spec §8.2 note — `outer` is `Vec2[][]`, multi-loop boards are legal); unit test asserts bounding box = 30×20×1.6 for fixture-rc, hole vertex presence for fixture-arcs, and a two-outer-loop synthetic input produces merged geometry.
- [ ] `scene.ts`: scene, ambient+directional lights, `OrbitControls`, ortho-top toggle, flip-to-back action, render loop with on-demand invalidation (render only when dirty — battery matters).
- [ ] KiCad-Y-axis note: KiCad Y grows downward; viewport flips to Z-up right-handed — conversion lives in ONE exported function `kicadToWorld(x,y)` used by all geometry builders (test it).
- [ ] Acceptance: `npm run dev` shows the fixture-rc board substrate in 3D, orbitable at 60 fps; geometry tests pass.

### Task 17: Copper geometry (tracks/pads/zones/vias)

**Files:**
- Create: `src/renderer/src/viewport/copperGeometry.ts`
- Modify: `src/renderer/src/viewport/scene.ts`
- Test: `src/renderer/src/viewport/__tests__/copperGeometry.test.ts`

Spec §10.1 (copper rows — **merge per (net, layer)**; that grouping is what enables picking/tinting later).

- [ ] `buildCopper(board: BoardModel) → Map<netId, { F?: BufferGeometry; B?: BufferGeometry }>`: `TrackSegment` is the Spec §8.2 discriminated union — `kind:'segment'` as quad strips with round caps (12-segment fans); `kind:'arc'` tessellated from the three-point start/mid/end form (compute center from the three points, ≥ 8 points per 90°) then rendered like segments; pads as shape geometries (circle/rect/oval/roundrect; `custom` → bounding rect + warning), zone polygons earcut-triangulated (`THREE.ShapeUtils`), all merged per net/layer via `BufferGeometryUtils.mergeGeometries`.
- [ ] Vias: one `InstancedMesh` of cylinders; instance→netId lookup array kept alongside.
- [ ] Materials: copper PBR per Spec §10.1 table; one material instance per net (clone of shared base) so tinting is per-net.
- [ ] Unit tests: fixture-rc → copper map has nets 1,2,3; net 2 F geometry vertex count > net 1 (track + 2 pads); via instancing count matches fixture-arcs via count (add one via to that fixture).
- [ ] Acceptance: fixture board shows tracks/pads; orbit stays 60 fps with a synthetic 5,000-segment board (add `scripts/gen-stress-fixture.mjs` emitting a stress `.kicad_pcb`, run manually).

### Task 18: Component placeholders + silkscreen

**Files:**
- Create: `src/renderer/src/viewport/componentGeometry.ts`, `src/renderer/src/viewport/silkscreen.ts`
- Modify: `src/renderer/src/viewport/scene.ts`

Spec §10.1 (components + silkscreen rows). VRML loading is **explicitly deferred** to post-v1 polish; placeholders only here.

- [ ] Boxes from `courtyardBounds` (fallback: pads bounding box + 0.4 mm margin), heights by class: passives 0.6 mm, SOT 1.1 mm, SOIC/DIP 2.5 mm, TO-220 4 mm (classify from footprint name regex table); color by part class; ref label on top via troika `Text`.
- [ ] B-side components mirrored under the board.
- [ ] Silkscreen `gr_text`/`fp_text` via troika, white, +0.02 mm above mask; respect rotation and mirroring on B side.
- [ ] Acceptance: fixture-rc shows two labeled boxes, "R1"/"R2" silkscreen text; visual check screenshot attached to PR.

### Task 19: Picking + hover/selection

**Files:**
- Create: `src/renderer/src/viewport/picking.ts`
- Modify: `src/renderer/src/viewport/scene.ts`
- Test: `src/renderer/src/viewport/__tests__/picking.test.ts` (raycast math against known geometry, headless)

Spec §10.2.

- [ ] Raycaster over copper meshes (net hit via mesh→netId map), via instances (instanceId→netId), component boxes (→ref). Emits typed events: `{type:'hoverNet', netId}|{type:'clickNet', netId, worldPos}|{type:'clickComponent', ref}|{type:'clearHover'}` through a callback the store subscribes to (scene.ts stays React-free).
- [ ] Hover: emissive boost on all meshes of the net (both layers + vias).
- [ ] Acceptance: headless raycast test passes (camera looking at fixture pad center hits net 1); manual: hovering the OUT track highlights R1 pad 2 and R2 pad 1 simultaneously.

### Task 20: Overlay modes + probe markers

**Files:**
- Create: `src/renderer/src/viewport/overlay.ts`, `src/renderer/src/viewport/markers.ts`
- Modify: `src/renderer/src/viewport/scene.ts`

Spec §10.2 (modes), §11 probes.

- [ ] `setOverlay(mode: 'realistic'|'voltage'|'highlight')`; voltage mode: `applyNetVoltages(Map<netId, volts>, min, max)` → per-net material color lerp blue→red; legend data exposed to UI; ≤ 16 ms for 500 nets (test with perf assertion on color-write loop, no GL needed).
- [ ] Markers: probe flags + instrument badges as screen-space sprites anchored to world positions (probe color = trace color); net voltage labels for op results (`markers.showOpAnnotations(Map<netId, volts>)` — auto-declutter: hide labels < 24 px apart at current zoom).
- [ ] Acceptance: demo script in dev tools tints fixture nets and shows labels; perf test passes.

---

## Phase 5 — UI integration

### Task 21: Store, file-open flow, parts panel, Model Doctor

**Files:**
- Create: `src/renderer/src/store/appStore.ts` (zustand: `project`, `circuit`, `resolutions`, `instruments`, `simState`, `probes`, actions), `src/renderer/src/panels/PartsPanel.tsx`, `src/renderer/src/panels/ModelDoctor.tsx`, `src/renderer/src/ipc/simClient.ts` (wraps the MessagePort with the Spec §6.1 protocol, promise API + event emitter)
- Test: `src/renderer/src/store/__tests__/appStore.test.ts`

Spec §8.6, §11, §12.

- [ ] Open flow: drag-drop or dialog → read `.kicad_pcb` (+ sibling `.kicad_sch` auto-detected by basename, + optional BOM via second drop) → parse → extract → resolve → store. Errors per Spec §12 (viewer-only mode when sim can't proceed).
- [ ] PartsPanel: searchable list (ref, value, status badge ok/amber/red); click ↔ viewport selection sync (both directions).
- [ ] ModelDoctor drawer per Spec §8.6: per-part actions [Stub open][Stub short][Interactive pins][Import .lib…][Ask your LLM] + pin-map editor (table: pad number ↔ model terminal, dropdowns); every change re-runs `resolveAll` and flags `deckDirty`.
- [ ] Store test: loading fixture-rc text yields 2 parts resolved tier 2, 0 unresolved; stubbing R2 flips counts and sets `deckDirty`.
- [ ] Acceptance: tests pass; manual flow works on fixture-rc.

### Task 22: Instrument rack + attachment + ground confirm

**Files:**
- Create: `src/renderer/src/panels/InstrumentRack.tsx`, `src/renderer/src/panels/InstrumentProps.tsx`, `src/renderer/src/panels/GroundSetup.tsx`
- Modify: `src/renderer/src/store/appStore.ts`, viewport drop-target handling in `Viewport.tsx`

Spec §9, §4 (steps 3–5).

- [ ] GroundSetup: on project load, suggest ground/supply nets (Task 6 heuristics); confirm via click-on-board or list pick; ground is required before Run enables (Spec §12).
- [ ] Rack: drag instrument chips onto board (drop → nearest picked net) or onto net names; instruments appear in viewport as badges (Task 20 markers) and in a list with remove.
- [ ] Props panel: numeric fields + drag-knobs for volts/freq/amplitude/duty; logic-input renders as a toggle; MCU interactive-pins panel per Spec §9 (per-pad Hi-Z/0/1/watch rows, pin names from schematic when present).
- [ ] Changes route through `alterPlan` (Task 13): alter-safe → `simClient.alter` live; reload-required → `deckDirty` + auto re-run if it was running.
- [ ] Acceptance: manual: attach supply to VIN on fixture-rc, ground GND, knob-drag volts with sim running (Task 24 wires run) — store-level unit tests for attach/detach/alter-vs-reload routing pass now.

### Task 23: Oscilloscope panel

**Files:**
- Create: `src/renderer/src/panels/Scope.tsx`, `src/renderer/src/scope/ringBuffer.ts`, `src/renderer/src/scope/render2d.ts`
- Test: `src/renderer/src/scope/__tests__/ringBuffer.test.ts`, `__tests__/render2d.test.ts` (decimation math)

Spec §11.

- [ ] `RingBuffer`: per-probe Float64Array ring (default 1 M points) fed from `samples` events; O(1) append; windowed read.
- [ ] `render2d.ts`: min/max decimation per pixel column → 2D canvas polyline per trace; follow mode (window tracks latest simTime) + pause/scrub; autoscale per trace; cursors (two, ΔV/Δt readout); measurements: Vpp, mean, frequency (zero-crossing estimate) — pure functions, unit-tested with synthetic sine input (freq estimate within 1 %).
- [ ] Scope.tsx: trace list bound to probes (colors match), time/div + follow controls.
- [ ] Acceptance: unit tests pass; manual: synthetic feeder script draws 3 traces at 60 fps.

### Task 24: End-to-end wiring — Power On, Run, fidelity banner

**Files:**
- Create: `src/renderer/src/panels/Toolbar.tsx`, `src/renderer/src/panels/WarningsBar.tsx`, `src/renderer/src/panels/SimLog.tsx`
- Modify: `src/renderer/src/store/appStore.ts` (sim orchestration slice)

Spec §4 (the primary scenario IS this task's acceptance), §6.1, §12.

- [ ] Power On: generate deck → `loadCircuit` → `runOp` → op annotations on board (Task 20) + copper voltage tint; convergence failure → plain-language card with retry-ladder note + expandable raw log (Spec §12).
- [ ] Run/Pause: deck (re)load when dirty → `runTransient` (tstep from fastest instrument: `min(1/(200·fmax), 10 µs)`; tstop = the bench window, default 30 s sim-time — never unbounded, Spec §7.5) → samples → ring buffers → scope + live voltage overlay (latest sample per probed net; un-probed nets keep op tint); `benchRestarted` events show a brief toast ("bench restarted" + sequential-logic caveat when digital parts present) while scope history persists in the ring buffers; pace selector (0.1×/1×/max) → `setPace`; Pause button → `halt`/`resume` commands (user-owner semantics, Task 10).
- [ ] Fidelity banner: persistent when any `Resolution.status !== 'ok'`, listing refs + modes (Spec §8.6 wording); SimLog panel streams `log` events; `crashed` → toast + auto state replay (re-send deck + re-apply instrument state, resume if was running).
- [ ] Acceptance (= Spec §4 scenario on fixture-rc + fixture-555): power-on annotates 2.5 V on OUT (rc); run + probe shows 555 oscillation on scope; supply knob drag changes amplitude live; kill SimHost process manually → app recovers within 5 s, sim resumes.

### Task 25: LLM-assist + user .lib import UX

**Files:**
- Create: `src/renderer/src/panels/LlmAssist.tsx`, `src/renderer/src/panels/LibImport.tsx`
- Modify: `src/renderer/src/panels/ModelDoctor.tsx`
- Test: `src/core/models/__tests__/llmPrompt.test.ts`

Spec §8.7.

- [ ] `buildLlmPrompt(part, padList) → string` (pure, tested: includes MPN, package, pad numbers, required `.subckt` header with exact node count, ngspice-dialect constraints, "cite datasheet values" instruction).
- [ ] Paste box → validation via SimHost test-deck (Spec §8.7) → on success persist to user library (Task 15) with provenance `llm-generated` + pin-map editor pre-opened (forced review — never auto-trust LLM pin order).
- [ ] LibImport: file picker → Task 15 `userLibrary` scan → subckt pick list → pin map → bind to part.
- [ ] Acceptance: paste a valid hand-written subckt → part goes green; paste garbage → ngspice error text shown, nothing persisted.

---

## Phase 6 — Sample project, E2E, packaging

### Task 26: Bundled sample project + Playwright E2E

**Files:**
- Create: `resources/sample/blinker-555.kicad_pcb`, `resources/sample/blinker-555.kicad_sch` (start from Task 5's `fixture-555` pair — copy and polish: nicer board outline, sensible silkscreen; netlist must simulate out-of-the-box with bundled models)
- Create: `e2e/smoke.spec.ts`, `playwright.config.ts`
- Modify: first-run UI (`App.tsx`): "Open sample project" empty-state button

Spec §11 (first-run), §13 (E2E path).

- [ ] Guard test (CI, plain Vitest): `parseBoard` + `parseSchematicSimData` + `extract` + `resolveAll` over the sample files → 0 parse errors, 0 unresolved parts. A malformed sample must fail CI, not first launch.

- [ ] E2E (Playwright `_electron.launch`): launch → open sample → expect parts list 8 rows, 0 unresolved → Power On → expect ≥ 1 op annotation visible → Run → wait 2 s → expect scope canvas non-blank (pixel sample) → alter supply to 9 V → expect annotation text change.
- [ ] CI: E2E on ubuntu runner under xvfb; artifact screenshots on failure.
- [ ] Acceptance: E2E green in CI; a new user reaches a live waveform in ≤ 3 clicks from first launch.

### Task 27: Packaging + licensing surfacing

**Files:**
- Create: `electron-builder.yml`, `src/renderer/src/panels/About.tsx`, `docs/licensing.md`
- Modify: `.github/workflows/ci.yml` (tag-triggered release job)

Spec §14, §15.

- [ ] electron-builder: NSIS (win x64), dmg (mac x64 + arm64), AppImage + deb (linux x64); `extraResources` maps `resources/ngspice/<platform>` + `resources/models` + `resources/sample`; per-platform builds only bundle their own ngspice.
- [ ] About dialog: app license (MIT), ngspice COPYING text, model-library provenance statement; `docs/licensing.md` = Spec §14 table expanded.
- [ ] CI check (script + test): every `resources/models/*` file has `Provenance:` header; `table.cm` absent from every platform dir.
- [ ] Release job on tag: build matrix → artifacts attached to GitHub release (unsigned; signing documented as TODO-for-distribution in `docs/licensing.md` — this is the one allowed deferred item, per Spec §15).
- [ ] Acceptance: installers from CI run on each OS; sample project simulates in the packaged app (manual check per OS).

### Task 28: Error-handling sweep + fidelity docs

**Files:**
- Create: `docs/what-circsim-can-tell-you.md`, `src/renderer/src/panels/EmptyStates.tsx`
- Modify: panels per the sweep checklist

Spec §12 (every bullet is a checklist row), §16 risk 7.

- [ ] Walk Spec §12 line by line; implement/verify each: parse error card with line/col + viewer-only mode; no-ground guided state; no-source guided state; convergence card wording; banner non-dismissable; crash toast. Add a store-level test per state.
- [ ] `what-circsim-can-tell-you.md`: plain-language fidelity doc (what behavioral models are, why MCUs are stubbed, what "no parasitics" means, when to trust/not trust results); linked from the fidelity banner and About.
- [ ] Acceptance: each §12 state reachable and screenshotted in PR; doc linked from banner.

---

## Post-v1 backlog (do not build now — Spec §17)

VRML component models from user's KiCad install; AC/Bode panel (protocol already supports `runAc`); MCU co-sim (avr8js); thermal overlay; trace parasitics; WebGPU path; current-flow animation.

---

## Plan self-review notes

- **Spec coverage check:** §2–§12, §14–§15 all map to tasks (§5 → T1; §6 → T11/T21; §7 → T8–T10; §8 → T2–T7, T12–T15; §9 → T13/T22; §10 → T16–T20; §11 → T21–T24; §12 → T24/T28; §13 → distributed test steps + T26; §14 → T14a/T27; §15 → T1/T8/T27). §16/§17 are risk/deferral registers, no tasks needed.
- **Known intentional deviations:** VRML loading deferred from Spec §10.1's "progressive enhancement" to post-v1 backlog (T18 note) — placeholder boxes satisfy v1 G1.
- **Type-consistency anchors:** `SimCommand`/`SimEvent` (T9 copies Spec §6.1), `Vec2`/`EdgePrimitive`/`TrackSegment`/`BoardModel` (T3/T4 copy Spec §8.2), `Circuit`/`Part` (T6 copies Spec §8.3), `Resolution`/`LibraryEntry` (T12 copies Spec §8.5), `Instrument` (T13 copies Spec §9). Agents must copy from spec, not improvise.
- **Adversarial review applied (2026-06-10, 3 reviewers):** bounded bench windows replace the indefinite transient (RAM growth in sharedspice); `--with-ngshared` build flag; `macos-15-intel` runner; runtime-generated spinit with absolute `.cm` paths + `SPICE_SCRIPTS` env; `crashed` moved off the MessagePort to the contextBridge; series-R splice on the source side; async FFI for blocking commands; haltOwner state machine; digital tests via `.tran` only; in-house 555; deterministic node-name algorithm anchoring the golden decks; full 555 fixture pair so end-to-end acceptance can actually oscillate.
