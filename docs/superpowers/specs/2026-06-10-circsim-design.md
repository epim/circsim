# circsim — Design Specification

**Date:** 2026-06-10
**Status:** Approved for implementation planning
**Audience:** Implementation agents (assume no prior context beyond this document and the implementation plan)

---

## 1. Summary

circsim is a cross-platform (Windows / macOS / Linux) desktop application for electronics hobbyists who designed a circuit with LLM assistance, routed the board with Quilter (quilter.ai), and want to *see it work* in a simulator before paying for fabrication.

The user opens the routed board file, sees the physical PCB rendered in 3D, attaches virtual bench instruments (power supply, function generator, logic toggles, probes) directly to nets and pads on the 3D board, and runs an interactive SPICE simulation. Voltages color the copper; an oscilloscope panel shows live waveforms; turning a knob updates the running simulation without a restart.

**Why this app exists (verified by competitive research, June 2026):** every existing hobbyist simulator (KiCad/ngspice, LTspice, Falstad, EveryCircuit, Wokwi, Flux.ai, Proteus, Multisim) simulates from a *schematic*. No tool accepts a finished, routed *board file* as its simulation input. Quilter's output is exactly that — a routed board file — so Quilter users have nowhere to go. circsim fills that gap.

---

## 2. Verified input reality (do not redesign around assumptions)

Research against Quilter's public documentation (docs.quilter.ai, June 2026) established:

1. Quilter accepts native **KiCad** projects (schematic + board) and Altium; Allegro/Xpedition via IPC-2581 export.
2. Quilter returns the routed layout **in the same native format it received** — for KiCad users, a `.kicad_pcb` file. **Quilter does NOT emit a BOM, netlist, or Gerbers.** BOM generation is the downstream CAD tool's job.
3. No KiCad version is publicly pinned; the S-expression format is stable since KiCad 6 with additive changes in 7/8/9.

**Consequences for circsim:**

- Primary input: a single `.kicad_pcb` file (KiCad 6+ S-expression format). This is mandatory.
- Optional input #1: the project's `.kicad_sch` schematic. It is the *only* source of KiCad simulation fields (`Sim.Device`, `Sim.Type`, `Sim.Params`, `Sim.Pins`, `Sim.Library`, `Sim.Name`), pin names/types, and no-connect markers.
- Optional input #2: a BOM CSV (e.g., exported from KiCad, or produced by the user/LLM). Used to enrich part identification (MPN column → model lookup).
- A `.kicad_pcb` alone contains **full net connectivity**: a global `(net N "NAME")` table plus a `(net N "NAME")` token on every connected pad. The circuit netlist (ref + pad + net) is reconstructable from the board file alone. Tracks, vias, and zones also carry net references.
- Altium and IPC-2581 are **out of scope for v1** (KiCad path only).

---

## 3. Goals and non-goals

### Goals (v1)

- G1: Open `.kicad_pcb` (+ optional `.kicad_sch`, + optional BOM CSV) and render the board convincingly in 3D at 60 fps on an integrated GPU.
- G2: Extract the circuit netlist from the board file and map every component to a SPICE model via a tiered resolution pipeline, with an explicit, polished workflow for parts that have no model.
- G3: Interactive "virtual bench": attach power supplies, function generators, logic inputs, ground reference, voltage/current probes to nets/pads by clicking the 3D board.
- G4: Live simulation: continuous transient analysis streaming to an oscilloscope panel; parameter changes (`alter`) take effect without restarting; DC operating-point "power-on check" annotates every net's voltage on the board.
- G5: Honest reporting: unresolved models, excluded parts, convergence failures, and fidelity limits are always visible — this audience cannot debug a silently-wrong simulation.
- G6: Ships as signed-or-unsigned installers for Windows (x64), macOS (x64 + arm64), Linux (x64) from a single CI pipeline.

### Non-goals (v1)

- No schematic or PCB *editing*, routing, or DRC.
- No signal-integrity / EM / crosstalk analysis. No trace parasitics (flagged as v2).
- No MCU firmware execution (MCUs are stubbed as interactive pin panels; avr8js co-simulation is v2).
- No Altium / IPC-2581 / Gerber import.
- No cloud services; the app is fully offline. (The "LLM model assist" feature is copy/paste, not API calls.)
- No GPU-accelerated SPICE solving — see §6 decision record.

---

## 4. Target user and primary scenario

Hobbyist, possibly with zero formal electronics training, who iterated a design through an LLM chat and Quilter. They think in terms of "plug in 5 V, press the button, does the LED blink?" — not in terms of `.tran` directives.

**Primary scenario (the demo that must work end-to-end):**

1. User drags `myboard.kicad_pcb` (and ideally `myboard.kicad_sch`) onto the window.
2. Board appears in 3D. A side panel lists components; parts without SPICE models are highlighted amber with a "Fix" affordance.
3. App auto-suggests the ground net (name heuristics: `GND`, `AGND`, `VSS`, `0V`) and the supply net (`+5V`, `VCC`, `3V3`, …). User confirms or clicks the actual nets on the board.
4. User clicks "Power on" → DC operating point runs → every net gets a floating voltage label; copper tints by voltage. Rail at 4.98 V = reassurance.
5. User drops a function generator on an input net, a probe on an output net → oscilloscope panel shows the live waveform; user drags the frequency knob and watches the response change in real time.
6. Misbehavior (rail at 0.3 V, op-amp output stuck) is *visible on the physical board*, which is the emotional payoff: "I watched my actual board work."

---

## 5. Technology stack (decision record)

| Decision | Choice | Rationale |
|---|---|---|
| App shell | **Electron** (current LTS) | Cross-platform from one codebase; renderer is Chromium so WebGL2 is uniform via ANGLE on all 3 OSes; richest documentation corpus for implementation agents; bundle size is irrelevant to this audience. Tauri rejected: splits the codebase into Rust + TS and makes ngspice FFI harder for simple agents. |
| Language | **TypeScript everywhere** (main, renderer, sim host, core) | One language for all agents; pure-TS core modules are unit-testable without Electron. |
| UI framework | **React 18** for panels/chrome; **imperative Three.js** (no react-three-fiber) for the 3D viewport, encapsulated in one module behind a narrow interface | React is the most agent-familiar UI layer. R3F rejected: the viewport is a small number of large merged meshes managed by data-driven rebuild logic, which is simpler and faster imperative. |
| 3D rendering | **Three.js, WebGL2 baseline** | Works on every GPU/driver Chromium supports; WebGPU optional later. Geometry generated procedurally from the board model (see §10). |
| State | **zustand** | Minimal, agent-familiar, no boilerplate. |
| Build | **electron-vite** + **electron-builder** | Standard, documented, supports preload/main/renderer + extra Node entries; builder produces NSIS/dmg/AppImage+deb. |
| Tests | **Vitest** for core/unit; **Playwright** for one end-to-end smoke test | Core modules are pure TS → fast deterministic tests. |
| Simulation engine | **ngspice 46+ as `libngspice` shared library** (BSD-3-Clause), loaded via **koffi** FFI **inside an isolated child process** | See §7. KLU/Sparse CPU solving is milliseconds at hobbyist scale. |
| FFI | **koffi** (MIT) | Maintained, prebuilt for win/mac/linux x64+arm64, supports C callbacks and struct marshaling declaratively. |
| Child process | **Electron `utilityProcess.fork`** | Purpose-built for this: crash isolation + MessagePort IPC. |
| Text on board | **troika-three-text** (MIT) | SDF text, sharp at all zooms. CSP must allow `worker-src blob:` or use its `workerUrl` option. |
| App license | **MIT** | All chosen dependencies are MIT/BSD. Keeps future options open. |

### 5.1 GPU usage decision record

**The SPICE solve stays on the CPU.** Research verdict (TinySPICE, GLU3.0, SFLU, Xyce 7.10): GPU sparse-LU only wins on huge matrices or thousands-of-parallel-runs Monte Carlo. A hobbyist board is 100–2000 nodes; ngspice transient steps complete in microseconds–milliseconds on one CPU core; CPU↔GPU transfer alone would exceed the compute. There is no off-the-shelf GPU SPICE library. Building one would burn the entire project budget on a non-problem.

**The GPU is used for:** (a) the 3D board render; (b) net-voltage color overlay on copper (per-net mesh tinting); (c) oscilloscope waveform rendering (v1: 2D canvas is acceptable; v1.5: GPU line rendering if profiling demands it); (d) v2 stretch: thermal heatmap overlay via a small compute/fragment-shader diffusion pass driven by per-component power from the operating point.

---

## 6. Process architecture

```
┌────────────────────────────────────────────────────────────┐
│ Electron Main process                                       │
│  - window lifecycle, file dialogs, recent files             │
│  - spawns/respawns SimHost via utilityProcess.fork          │
│  - relays MessagePort between Renderer and SimHost          │
└──────────────┬─────────────────────────────┬───────────────┘
               │ contextBridge IPC           │ one-time port handshake
┌──────────────▼──────────────┐  ┌───────────▼───────────────┐
│ Renderer (Chromium)         │  │ SimHost (utilityProcess)   │
│  - React UI panels          │  │  - loads libngspice via    │
│  - Three.js 3D viewport     │  │    koffi FFI               │
│  - zustand store            │  │  - command queue (serial)  │
│  - parsing + netlist + model│  │  - sample batcher          │
│    resolution (pure TS core)│  │  - watchdog/respawn-safe   │
└─────────────────────────────┘  └────────────────────────────┘
```

- **Renderer** owns all domain logic that is pure computation (file parsing, netlist extraction, model resolution, SPICE deck generation) — these are plain TS modules imported into the renderer, kept Electron-free so Vitest covers them in Node.
- **SimHost** exists for *crash isolation*: libngspice is not process-isolated; a pathological netlist can crash it. SimHost crashing must never take down the app.
- **Port handshake, not relay:** Main creates a `MessageChannelMain` once per SimHost spawn, sends one port to SimHost via `child.postMessage` and the other to the renderer via `webContents.postMessage`. After the handshake, **Main is not in the message path** — `samples` traffic (transferable buffers) flows renderer↔SimHost directly. Main must never proxy individual messages.
- **Security defaults:** `contextIsolation: true`, `nodeIntegration: false`; the preload script exposes a minimal typed API (`openFile`, `simPort`, …).

### 6.1 SimHost ⇄ Renderer protocol (the most important interface in the app)

All messages are JSON-serializable except sample payloads, which use transferable `Float64Array` buffers.

```ts
// renderer → simhost
type SimCommand =
  | { type: 'loadCircuit'; deckLines: string[] }       // full SPICE deck, one card per line
  | { type: 'runTransient'; tstepSeconds: number; tstopSeconds: number }
  | { type: 'runOp' }                                   // DC operating point
  | { type: 'runAc'; fStart: number; fStop: number; pointsPerDecade: number }
  | { type: 'alter'; device: string; param?: string; value: number | string }
      // device MUST be lowercased by sender; see §8.4 gotchas
  | { type: 'halt' } | { type: 'resume' } | { type: 'stop' }
  | { type: 'setPace'; realtimeFactor: number | 'max' }

// simhost → renderer
type SimEvent =
  | { type: 'ready'; ngspiceVersion: string }
  | { type: 'vectors'; names: string[] }                // vector list after run starts
  | { type: 'samples'; vectorNames: string[]; columns: Float64Array[]; simTime: Float64Array }
      // batched: flushed every 16 ms or 4096 points, whichever first
  | { type: 'opResult'; values: Record<string, number> }
      // KEY FORMAT (normative): node voltages keyed by the bare lowercase SPICE node name
      // ("out", never "v(out)" or "OUT"); source/device currents keyed "i(<device>)".
      // SimHost normalizes whatever vector names ngspice returns into this format.
  | { type: 'acResult'; freq: Float64Array; vectors: Record<string, { mag: Float64Array; phaseDeg: Float64Array }> }
  | { type: 'status'; running: boolean; simTimeSeconds: number; realtimeFactor: number }
  | { type: 'benchRestarted'; reason: 'window-elapsed' | 'memory' }   // see §7.5 bench windows
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }   // ngspice stdout/stderr lines
  | { type: 'convergenceFailure'; detail: string }
```

**Crash notification travels on a different channel.** When SimHost dies, its MessagePort dies with it — so the crash event cannot be a `SimEvent`. Main detects process exit and notifies the renderer through the contextBridge preload API (`onSimhostCrashed(cb)` with payload `{ willRespawn: boolean }`), then respawns and re-runs the port handshake. The renderer must treat a crash as routine: re-send `loadCircuit` + re-apply instrument state after the new port arrives. Instrument state lives in the zustand store, never only inside ngspice.

---

## 7. ngspice integration (SimHost internals)

### 7.1 Engine choice and embedding

- ngspice ≥ 46, **shared library** (`ngspice.dll` / `libngspice.dylib` / `libngspice.so`), BSD-3-Clause. Redistribution is permitted; the app bundle must include ngspice's `COPYING` file.
- The library API (from `sharedspice.h`): `ngSpice_Init(SendChar, SendStat, ControlledExit, SendData, SendInitData, BGThreadRunning, userData)`, `ngSpice_Circ(char**)` (load deck from memory — no temp files), `ngSpice_Command(char*)`, `ngGet_Vec_Info(char*)`, `ngSpice_CurPlot()`, `ngSpice_AllVecs(char*)`.
- Simulation runs on ngspice's background thread — start transients with `bg_tran <tstep> <tstop>` (the decks carry no `.tran` card, so a bare `bg_run` would have no analysis to run); `SendData` fires per accepted timepoint with all saved vector values.

### 7.2 XSPICE code models — packaging requirement

XSPICE digital primitives (`d_and`, `d_ff`, `d_lut`, `d_state`, `adc_bridge`, `dac_bridge`, …) live in `.cm` plugin files (`digital.cm`, `analog.cm`, `spice2poly.cm`, `xtradev.cm`, `xtraevt.cm`). **Shipping the bare DLL without the `.cm` files silently breaks every digital model.** The bundle must ship the full `lib/ngspice/` tree alongside the library.

**Path resolution is a packaging trap.** ngspice locates `.cm` files via the `spinit` init script, whose relative `codemodel` paths resolve against the *calling process executable* — in a packaged app that's the Electron binary, not our resources directory, so the stock spinit will fail to find the `.cm` files in production while working in dev. Approach (Phase 2 verified): SimHost generates a `spinit` in a temp/app-data dir with absolute `codemodel` paths and sets `SPICE_SCRIPTS` before `ngSpice_Init` **AND** — because ngspice's native `getenv` does not reliably observe a Node-mutated `process.env` on Windows — **also issues explicit `ngSpice_Command("codemodel <absolute>/<file>.cm")` for each bundled `.cm` right after `ngSpice_Init`.** The explicit `codemodel` commands are the environment-independent belt-and-suspenders that actually guarantee loading; the spinit/env path remains for packaging correctness. Verify with the smoke deck below.

**Verified ngspice-46 specifics (Phase 2):** the inverter primitive is `d_inverter` (not `d_inv`); transient runs that must charge from initial conditions need the `uic` flag (`bg_tran <tstep> <tstop> uic`); libngspice is a process-global singleton (one `ngSpice_Init` per process — the reason SimHost is its own utilityProcess, and why integration tests use a forked/isolated pool).

Startup smoke deck (run at init; on failure emit a loud structured error naming `.cm` files):

```
* cm smoke: 0V in -> adc -> d_inverter -> dac -> expect ~5V out
v1 in 0 dc 0
abr_in [in] [din] adcm
.model adcm adc_bridge(in_low=1.0 in_high=2.0)
ainv din dout invm
.model invm d_inverter(rise_delay=1n fall_delay=1n)
abr_out [dout] [out] dacm
.model dacm dac_bridge(out_low=0 out_high=5)
.tran 1n 20n
.end
```

Pass criterion: transient runs and `v(out)` ends ≥ 4.5 V. (XSPICE `a` elements are event-driven: use `.tran`, never `.op`, to exercise them — DC operating point does not propagate digital events.)

**Exclude `table.cm`** from the bundle: it contains GPL-licensed third-party code; everything else is BSD/public domain.

### 7.3 Binary acquisition (per platform, done in CI — see §15)

- **Windows x64:** official prebuilt **shared-library** archive from SourceForge — `ngspice-<ver>_dll_64.7z` (the plain `ngspice-<ver>_64.7z` has the executables but no DLL). Contains `ngspice.dll` + its `libomp140.x86_64.dll` companion + `.cm` files. See plan Task 8 for verified URL/paths.
- **macOS x64/arm64, Linux x64:** build from source in CI: `./configure --with-ngshared --enable-xspice --enable-cider --with-x=no --disable-debug && make -j`. **The shared-library flag is `--with-ngshared`** (`--with-ngspice-lib` does not exist; a wrong flag silently produces an executable instead of `libngspice.{dylib,so}`). The build script must verify the output is actually a shared library (`file` says "shared object"/"dynamically linked shared library"). Do not use Homebrew: its formula does not build the shared library at all, regardless of version.
- Pin the ngspice version in one config file; binaries land in `resources/ngspice/<platform>/`.

### 7.4 Known gotchas (each one is a verified bug-report-grade fact; encode them in code, not tribal memory)

1. **`alter` device names must be lowercase** through the shared-library API. Uppercase silently no-ops. SimHost lowercases every device token defensively.
2. **Never call `ngSpice_Command` from inside a `SendData` callback** — deadlock/no-op. SimHost queues all commands; the queue is drained only from the main JS thread, never from FFI callback frames.
3. The interactive-change sequence is `bg_halt` → `alter …` → `bg_resume`. Batch multiple pending alters inside one halt/resume window. **Halt/resume ownership state machine:** three actors issue halts (user pause, alter batching, pacing). SimHost keeps a single `haltOwner: 'none'|'user'|'alter'|'pacing'` state; only the owner that halted may resume, and `user` outranks the others (an alter batch or pacing tick during user-pause applies the alters but does not resume). Without this guard, the 50 ms pacing timer races the alter batcher into double-halt / missed-resume states.
4. **Blocking FFI calls must use koffi's async call form.** A synchronous `ngSpice_Command("op")` blocks SimHost's event loop, which (a) stops koffi from delivering background-thread callbacks and (b) makes the watchdog timer unable to fire during the exact hangs it exists to catch. Any command that can run long (`op`, non-bg `tran`, `loadCircuit`) is invoked async; `bg_*` commands return immediately and may stay sync.
5. Memory accumulates across re-runs; issue `destroy all` before each new `loadCircuit`.
6. Convergence failures arrive as text via `SendChar` and via `ControlledExit`. SimHost pattern-matches known failure strings ("timestep too small", "no convergence") into structured `convergenceFailure` events.
7. **Watchdog:** if a command gets no response/progress within 10 s, SimHost exits and is respawned by Main. Because libngspice state is unrecoverable after some failures, respawn (not in-process retry) is the only reliable reset. (Viable only because of gotcha 4 — the event loop must be free to run the timer.)

### 7.5 Real-time pacing and bounded bench windows

ngspice simulates as fast as possible — small circuits run far faster than wall-clock. For the "live bench" feel, SimHost paces: a 50 ms interval timer compares sim-time progress vs wall-time and issues `bg_halt`/`bg_resume` (respecting the haltOwner state machine, §7.4.3) to hold `realtimeFactor` ≈ 1.0 (or runs unthrottled when the user selects `max`). The actual achieved factor is reported in `status` events and shown in the UI (slow complex circuits will run < 1× and that must be visible, not mysterious).

**Memory constraint (verified): an indefinite transient is not possible.** In shared-library/interactive mode, ngspice retains *every timepoint of every saved vector in RAM* for the life of the plot — the write-to-disk rawfile path exists only in batch mode. A `tran` left running for an open-ended bench session grows until OOM. Therefore the "continuous" bench is implemented as **bounded bench windows**:

- Each Run executes a transient with a finite `tstop` = the bench window `W` (default 30 s of sim-time; configurable).
- When sim-time reaches `W` (or SimHost RSS exceeds a 1.5 GB guard), SimHost halts, issues `destroy all`, reloads the deck, restarts the transient from t = 0, and emits `benchRestarted` (§6.1) so the UI shows a brief "bench restarted" notice. Scope history survives — the renderer's ring buffers own all history; ngspice never needs to retain it.
- State across a restart is re-established by the circuit settling again from initial conditions (acceptable for hobbyist observation; sequential-logic state loss is a documented limitation surfaced in the restart notice when digital parts are present).
- To slow growth within a window, the deck saves all node voltages (needed for the live board overlay) but *not* blanket device currents — `.options savecurrents` is replaced by targeted `.save @dev[i]` lines for active current probes only (§8.8 amended).

### 7.6 Fallback adapter

SimHost is written against an internal `interface SpiceEngine { load(deck): …; command(cmd): …; on(event): … }`. The koffi/libngspice adapter is the primary implementation. If FFI proves unstable on some platform, a secondary adapter spawning `ngspice -p` (pipe mode) can be substituted *behind the same interface* — design for it, don't build it in v1.

---

## 8. Domain pipeline (pure TS modules in `src/core/`)

```
.kicad_pcb ──► sexpr parser ──► BoardModel ──► netlist extractor ──► Circuit
.kicad_sch ──► sexpr parser ──► SchematicSimData ─┐                    │
BOM CSV    ──► bom parser ───► BomData ───────────┴──► model resolver ─┴─► ResolvedCircuit
ResolvedCircuit + Instruments + groundNet ──► spice deck generator ──► deckLines[]
```

Module dependency rule: `core/*` imports nothing from Electron, React, or Three.js. Everything below is unit-tested against hand-authored fixture files (do not redistribute KiCad's demo boards; their licenses are mixed — author small fixtures from scratch).

### 8.1 `core/sexpr` — S-expression parser

KiCad files are UTF-8 Lisp-style S-expressions. Implement a ~200-line tokenizer + recursive-descent parser producing `type SExpr = string | number | SExpr[]`. Requirements: handles quoted strings with escapes; preserves token order; **tolerant of unknown tokens** (KiCad 7/8/9 add fields — never throw on unrecognized atoms); streaming not required (files are ≤ tens of MB).

### 8.2 `core/kicad` — typed board/schematic models

From `.kicad_pcb`, extract into:

```ts
type Vec2 = { x: number; y: number };

// Raw Edge.Cuts primitives (input to outline stitching). KiCad 6+ arcs are the
// three-point form: start/mid/end are points ON the arc (mid ≠ center).
type EdgePrimitive =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2 }
  | { kind: 'circle'; center: Vec2; radiusPoint: Vec2 }
  | { kind: 'rect'; start: Vec2; end: Vec2 };

// Copper tracks: discriminated union; arcs use the same three-point form.
type TrackSegment =
  | { kind: 'segment'; start: Vec2; end: Vec2; widthMm: number; layer: string; netId: number }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2; widthMm: number; layer: string; netId: number };

interface BoardModel {
  netById: Map<number, { id: number; name: string }>;
  footprints: Footprint[];
  tracks: TrackSegment[];
  vias: Via[];                 // at, size, drill, layers, netId
  zones: Zone[];               // filled polygons with holes, netId, layer
  edgeCuts: EdgePrimitive[];   // raw, in file order
  outline: OutlineGeometry;    // stitched from edgeCuts (see below)
  silkscreen: BoardText[];     // gr_text + fp_text on F.SilkS/F.Silkscreen + B equivalents
  boardThicknessMm: number;    // from (general (thickness …)), default 1.6
}
interface OutlineGeometry { outer: Vec2[][]; holes: Vec2[][]; warnings: string[] }
// Multiple outer loops are legal (panelized/odd boards): the substrate builder
// creates one THREE.Shape per outer loop (holes assigned by containment) and
// merges the extrusions. Parsers must default absent rotation to rotDeg: 0.
interface Footprint {
  ref: string; value: string; libId: string;          // "Resistor_SMD:R_0402"
  layer: 'F' | 'B'; at: { x: number; y: number; rotDeg: number };
  pads: Pad[];
  model3d?: { path: string; offset: Xyz; scale: Xyz; rotate: Xyz }; // path may contain ${KICAD*_3DMODEL_DIR}
  properties: Record<string, string>;                  // MPN, datasheet, etc. if present
  courtyardBounds?: { w: number; h: number };          // from F.CrtYd, for placeholder boxes
}
interface Pad {
  number: string;                                      // pad "names" can be alphanumeric
  type: 'smd' | 'thru_hole' | 'np_thru_hole';
  shape: 'circle' | 'rect' | 'oval' | 'roundrect' | 'custom';
  at: { x: number; y: number; rotDeg: number }; size: { w: number; h: number };
  drill?: number; layers: string[];
  netId?: number;                                      // absent ⇒ unconnected pad
  pinFunction?: string; pinType?: string;              // present only if board was synced
}
```

From `.kicad_sch` (minimal parse — no rendering): per symbol instance keyed by reference: `value`, the six `Sim.*` property fields, pin list (number, name, electrical type), no-connect flags. Type: `SchematicSimData = Map<ref, SymbolSimInfo>`.

**Edge.Cuts stitching** is a named, separately-tested utility: collect `gr_line`/`gr_arc`/`gr_circle`/`gr_rect` on Edge.Cuts, tessellate arcs, chain segments into closed loops with endpoint tolerance (0.01 mm), classify outer boundary vs cutout holes by area/containment. Broken outlines (gaps > tolerance) produce a structured warning and fall back to the bounding box. This is a known geometry-pitfall area — allocate real test coverage (boards with arcs, multiple cutouts, slots).

### 8.3 `core/netlist` — connectivity extraction

```ts
interface Circuit {
  nets: CircuitNet[];                 // every net with ≥1 pad
  parts: Part[];
  warnings: NetlistWarning[];         // floating pads, single-pad nets, nets with no driver
}
interface CircuitNet { id: number; kicadName: string; spiceNode: string; padRefs: { ref: string; pad: string }[] }
interface Part {
  ref: string; value: string; libId: string; layer: 'F' | 'B';
  padNet: Map<string /* pad number */, number /* netId */>;
  properties: Record<string, string>;          // board fields merged with BOM (BOM wins)
}
```

SPICE node naming (deterministic algorithm — golden tests depend on it): lowercase the KiCad net name; replace every character outside `[a-z0-9_]` with `_`; collapse runs of `_`; on collision append `_2`, `_3`, …. Examples: `VIN` → `vin`; `+5V` → `_5v`; `Net-(R1-Pad1)` → `net_r1_pad1_`. Keep a bidirectional map. The user-designated ground net maps to node `0`. Heuristic ground/power suggestions (`GND|AGND|DGND|VSS|0V` / `VCC|VDD|\+?\d+V\d*|3V3|5V`) are suggestions only — the UI confirms with the user.

### 8.4 `core/bom` — BOM CSV import

Tolerant CSV reader: auto-detect delimiter, header row; map columns by header heuristics (`Reference|Designator`, `Value`, `Footprint`, `MPN|Manufacturer Part Number|Part Number`); expose a column-remap structure the UI can adjust. Output `Map<ref, { value?, mpn?, … }>` merged into `Part.properties` (BOM wins over board fields when both present).

### 8.5 `core/models` — SPICE model resolution (the make-or-break subsystem)

Every `Part` is resolved through a tier cascade; first hit wins; every resolution records its provenance:

| Tier | Source | Covers |
|---|---|---|
| 1 | **Schematic `Sim.*` fields** (if `.kicad_sch` loaded) | Anything the user already configured in KiCad — highest fidelity, includes explicit `Sim.Pins` mapping |
| 2 | **Built-in primitive inference** | R/C/L from refdes prefix + parsed value (`10k`, `4.7u`, `100n`, `4k7`); value-field suffix convention: `M`/`Meg`/`MEG` = mega, lowercase `m` = milli (this is the *value-field* domain, not SPICE text — decks emit plain numbers, §8.8); polarity-aware for electrolytics |
| 3 | **Bundled model library** (see format below) | Common diodes/LEDs/BJTs/MOSFETs, op-amps, comparators, 555, linear regulators, 74HC logic — matched by MPN (normalized), then value, then footprint hints |
| 4 | **User-imported `.lib`/`.sub` files** | Vendor models the *user* downloads (TI etc. — never bundled; see §14) |
| 5 | **LLM-assist paste** (§8.7) | Anything else with a datasheet |
| 6 | **Stub** | `open` (default — pins disconnected), `short` (all pins tied — jumpers/ferrites), or `interactive-pins` (MCUs — see §9.3) |

```ts
type ResolvedModel =
  | { kind: 'primitive'; card: string }                                  // e.g. "r{ref} n1 n2 10k"
  | { kind: 'subckt'; libFile: string; subcktName: string; pinMap: PinMap }
  | { kind: 'xspice-digital'; templateId: string; pinMap: PinMap }       // expands to adc_bridge+gates+dac_bridge
  | { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' };
interface Resolution { ref: string; status: 'ok' | 'stubbed' | 'unresolved' | 'documented-open'; model?: ResolvedModel;
                       tier: 1|2|3|4|5|6; warnings: string[];
                       note?: string /* why intentionally not modeled — documented-open only */ }
type PinMap = Record<string /* pad number */, string /* subckt node position or name */>;
```

**Bundled library format** — a JSON index plus `.lib` text files in `resources/models/`:

```ts
interface LibraryEntry {
  id: string;
  match: { mpn?: string[]; valueRegex?: string; refdesPrefix?: string[]; footprintRegex?: string };
  model: { type: 'subckt' | 'model-card' | 'xspice-digital' | 'documented-open'; file?: string; name: string };
  note?: string;        // REQUIRED for documented-open: why the part is intentionally not modeled
  pinMaps: Record<string /* footprint pattern, e.g. "SOT-23" */, PinMap>;  // REQUIRED — see pin-mapping note ({} for documented-open)
  defaultPinMap?: PinMap;
  provenance: string;   // who wrote it, from which datasheet — every entry must have this
}
```

**Pin mapping is a first-class correctness problem.** A board file gives only pad *numbers*. SOT-23 transistor pinouts vary by part; *standard KiCad library* diode/LED footprints put the cathode on pad 1 (a library default, not a rule — third-party footprints differ, which is why every default map must be user-verifiable in the pin-map editor); an op-amp subckt's node order is arbitrary. Therefore: every library entry carries explicit per-footprint pin maps; Tier-1 resolutions use KiCad's `Sim.Pins`; and the Model Doctor (§8.6) includes a pin-map viewer/editor showing pad numbers on the 3D footprint next to model terminal names. Wrong pin maps produce confidently-wrong simulations — the worst failure mode for this audience.

**Bundled model content rules (licensing — verified, non-negotiable):**
- Write our own models: behavioral op-amp/comparator/regulator macromodels from datasheet parameters; LED/diode `.model` cards; a behavioral NE555 (two comparators + RS latch + discharge switch, from the datasheet block diagram); 74HC parts as XSPICE `d_lut`/`d_state` behavioral templates (adc_bridge → logic → dac_bridge with datasheet-typical delays). All MIT-licensed with provenance headers.
- ngspice's distributed example netlists (e.g. `examples/p-to-n-examples/555-timer-*.cir` — there is no `special_models` directory in the distribution) may be *consulted* for structure, but per-file provenance is unstated; do not copy their text into the bundle.
- **Never bundle:** TI/ADI/onsemi vendor models ("use only with our devices" licenses), Micro-Cap-derived 74xx libraries (ngspice's own page flags them non-redistributable), Intusoft-derived `74HC.LIB` ("All Rights Reserved" header).
- Initial library scope (v1 target ≈ 60 entries): 1N4148/1N400x/Zeners/generic LEDs per color, 2N2222/2N3904/2N3906/BC547/BC557, 2N7002/AO3400/IRLZ44N-class MOSFETs, LM358/LM324/TL072/LM393, NE555, 78xx/AMS1117-class behavioral LDOs, 74HC00/04/08/14/32/74/86/164/595, common Schottkys.

### 8.6 Model Doctor (UX for unresolved parts)

A docked drawer listing every part with `status ≠ ok`, never a blocking modal. Per part: amber highlight on the 3D board; actions: **[Stub open] [Stub short] [Interactive pins] [Import .lib…] [Ask your LLM]** plus the pin-map editor. A persistent, non-dismissable banner during simulation: *"Results approximate: U2 (ESP32) stubbed, D5 (WS2812B) excluded."* Re-resolution and deck regeneration happen immediately on any change.

### 8.7 LLM-assist model import

The audience designs with LLMs; lean into it without network calls: the **[Ask your LLM]** button copies a generated prompt to the clipboard — part number, package, pad list, required `.subckt` interface, ngspice dialect constraints, and an instruction to cite datasheet values. The user pastes the prompt into their own LLM, pastes the resulting `.subckt` back into a validation box. circsim validates by sending a tiny test deck (subckt + dummy sources) to SimHost; on clean load it's saved into the user library (Tier 4) with provenance `llm-generated`. Malformed models are rejected with ngspice's error text shown.

### 8.8 `core/spicegen` — deck generation

Deterministic, pure function: `(circuit, resolutions, instruments, groundNetId, analysisDefaults) → deckLines[]`.

Rules:
- Element names derive from refs (`r_r1`, `q_q3`, `x_u2`) — lowercase always (alter gotcha).
- **All numeric values are emitted as plain decimal or exponent notation (`10000`, `4.7e-06`) — never letter suffixes.** This sidesteps SPICE's `M`-means-milli trap entirely; suffix interpretation happens once, in `parseValue` (§8.4 conventions: in *value fields*, `M`/`Meg` = mega, lowercase `m` = milli).
- Instruments are SPICE elements with stable names (`vpsu_1`, `vfgen_2`, `vlogic_3`) so `alter` can target them.
- **Series-resistance splice rule (overlay correctness):** the synthetic node goes on the *source side*, so the KiCad net keeps its own spiceNode and the board overlay/probes read the true pin voltage. E.g. supply on net `vin`: `vpsu_1 vpsu_1_int 0 DC 5` + `rpsu_1 vpsu_1_int vin 0.1`. Voltage overlay and op annotations must always read the named-net node, never a synthetic `_int` node.
- Voltage probes need no elements (node voltages are saved).
- **Current probes attach to a specific part, and their liveness depends on the model tier:** parts resolved as top-level primitives (R/C/L/diode/BJT…) read the device's own vector `@<dev>[i]` — live, no deck change. Parts resolved as subckts expose **no** instance current vector (`@x_u2[i]` does not exist); probing them inserts a 0 V ammeter `vamm_<id>` in series at the probed pad, which is a deck-regen + reload operation, not a live alter. The UI must reflect this (probe applies on next reload).
- Saving: `.save all` for node voltages (board overlay needs every net) plus targeted `.save @<dev>[i]` per active current probe. Do **not** emit blanket `.options savecurrents` — it multiplies vector count and accelerates the §7.5 memory growth.
- Sane `gmin`/`reltol` defaults, `.options noacct`.
- Every deck ends with provenance comments (tier per part) so a saved deck is self-describing.
- Digital templates expand to `adc_bridge`/`dac_bridge` instances per the XSPICE pattern.
- Convergence aids: if op fails, retry ladder — `.options gminsteps` bump, then source-stepping (`.options srcsteps`), then report structured failure (§7.4.6). Encode the ladder in SimHost, not the user's lap.

---

## 9. Virtual bench (instruments)

```ts
type Instrument =
  | { kind: 'ground-ref'; netId: number }                                   // exactly one required
  | { kind: 'dc-supply'; id: string; netId: number; volts: number; seriesOhms: number /* default 0.1 */ }
  | { kind: 'function-gen'; id: string; netId: number; wave: 'sine'|'square'|'triangle'|'pulse';
      freqHz: number; amplitudeV: number; offsetV: number; dutyPct?: number; outputOhms: number /* default 50 */ }
  | { kind: 'logic-input'; id: string; netId: number; level: 0 | 1; vHigh: number /* default = chosen rail */ }
  | { kind: 'voltage-probe'; id: string; netId: number; color: string }
  | { kind: 'current-probe'; id: string; ref: string; pad?: string; color: string }
      // device current; pad designates the ammeter splice point for subckt parts (§8.8)
```

- Mapping to SPICE: dc-supply → `v… node 0 DC <v>` + series R per the §8.8 splice rule; function-gen → `SIN`/`PULSE` source forms; logic-input → DC source toggled via `alter`.
- Knob changes route through the alter queue (`bg_halt`→alters→`bg_resume`). **Alter-safe:** dc-supply volts, logic-input level, and function-gen freq/amplitude/offset — SIN/PULSE parameters are altered with the vector form, all params re-sent together, exact spacing required: `alter @vfgen_2[sin] [ <vo> <va> <freq> ]`. **Reload-required:** waveform *type* changes (sine↔pulse↔triangle — the element card changes) and current probes on subckt parts (§8.8). The store knows which edits are which.
- Attachment UX: drag instrument from a rack onto the 3D board (drop targets = pads/vias/tracks → resolves to a net) or onto a net in the net list. Probes: click = voltage probe; Shift+click on a component = current probe (Proteus-style live probing; no restart).
- **MCU interactive-pins stub:** a panel per stubbed MCU listing its pads (named via schematic pin names when available). Each pin can be: Hi-Z (default), driven 0/1 (toggle → logic-input source), or watched (voltage readout). This covers "press the button, did the GPIO net go high" validation without firmware simulation.

---

## 10. 3D viewport

### 10.1 Geometry pipeline (procedural, from `BoardModel` — no external CAD tooling)

| Element | Technique |
|---|---|
| FR4 substrate | Stitched Edge.Cuts loops → one `THREE.Shape` per outer loop (holes assigned by containment) → `ExtrudeGeometry` per shape, merged; depth = board thickness |
| Copper tracks | Per net per layer: segments/arcs → polyline extrusion (vendored `geometry-extrude` for miter joins, or rect-per-segment + round caps as the simpler fallback) → **merged into one `BufferGeometry` per (net, layer)** |
| Pads | Shape geometry per pad merged into the same per-net buffers; `InstancedMesh` for plated drills |
| Zones | Filled polygons (with holes) → `ExtrudeGeometry`, thin, per (net, layer) |
| Vias | `InstancedMesh` cylinders, colored per net |
| Soldermask | Substrate clone, +0.01 mm offset, semi-transparent; pad openings approximated (skip exact mask subtraction in v1) |
| Silkscreen | troika-three-text per text item, positioned just above mask |
| Components | **Default: parametric placeholder boxes** sized from courtyard/pad bounds, label = ref, color by part class. **Progressive enhancement:** if a KiCad install is detected (path probe per OS + settings override), resolve `${KICAD*_3DMODEL_DIR}` and load `.wrl` via Three.js `VRMLLoader`, cached by path, falling back per-model on parse failure. **Never bundle kicad-packages3D** (CC-BY-SA share-alike if redistributed). |

Grouping copper **by net** serves three needs at once: picking (raycast hit → net), highlight (hover), and the voltage overlay (tint material per net). Net count is typically < 500 → < ~1000 draw calls worst case; merge across nets into layer-level buffers with per-vertex color attributes only if profiling demands it.

### 10.2 Interaction

- OrbitControls (rotate/pan/zoom), flip-to-back shortcut, top-down ortho toggle.
- Raycast picking: pads, tracks, vias, component boxes. Hover = net highlight + tooltip (net name, latest V). Click = voltage probe. Click component = select (BOM panel sync, current-probe affordance).
- Overlay modes: **Realistic** | **Voltage** (copper tinted blue→red over a min/max legend, driven by latest samples or op result) | **Highlight-only**.
- Floating 3D labels (probes, net annotations) via screen-space sprites.

### 10.3 Performance targets

Parse + first render of a 5 MB board ≤ 2 s on a mid-range laptop; 60 fps orbit on Intel integrated graphics for 5,000 track segments; overlay tint update ≤ 16 ms (material color writes only, no geometry rebuild).

---

## 11. UI layout

```
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: Open • Power On (op) • Run/Pause • pace • overlay   │
├───────────┬──────────────────────────────────┬───────────────┤
│ Left dock │                                  │ Right dock    │
│  Parts/BOM│        3D viewport               │  Instrument   │
│  (search, │                                  │  rack +       │
│  status   │                                  │  properties   │
│  badges)  │                                  │  (knobs)      │
│  Model    │                                  │  Probes list  │
│  Doctor   ├──────────────────────────────────┴───────────────┤
│  drawer   │ Bottom dock: Oscilloscope (multi-trace, autoscale,│
│           │ cursors) • Sim log • Warnings banner              │
└───────────┴──────────────────────────────────────────────────┘
```

- Scope: multi-trace, color-matched to probes, time-window follow mode + pause/scrub, per-trace autoscale, measurement readouts (Vpp, mean, freq estimate). v1 renders to 2D canvas with min/max decimation per pixel column from ring buffers (per-probe `Float64Array` ring, default 1 M points).
- First-run experience: sample project bundled (a small 555 LED blinker board authored in-house) so a user with no files sees the full loop in 60 seconds.

---

## 12. Error handling and honesty requirements

- Parse errors: structured, with line/column and "open anyway (viewer-only mode)" when netlist extraction succeeds but simulation can't proceed.
- Simulation without ground designated, or with zero resolved sources → guided empty-state, not a dead Run button.
- Convergence failure → plain-language card ("The simulator couldn't find a stable solution. Common causes: …") with the retry-ladder already attempted, plus the raw ngspice log expandable.
- The fidelity banner (§8.6) is always shown when any part is stubbed/excluded. The app must never present a partial simulation as a complete one.
- SimHost crash → auto-respawn + state replay (§6.1), toast notification, never a frozen UI.

---

## 13. Testing strategy

- **Unit (Vitest):** sexpr parser (quoting, escapes, junk tolerance); board parsing against hand-authored fixtures; Edge.Cuts stitching (arcs, cutouts, broken loops); value parser (`4k7`, `100n`, `2.2Meg`); netlist extraction; model resolution tiers + pin maps; deck generation (golden-file decks); BOM column mapping.
- **Fixtures:** authored from scratch in-repo (small KiCad projects we own): `fixture-rc.kicad_pcb` (RC divider), `fixture-555.kicad_pcb` + `.kicad_sch` (a *complete* minimal 555 astable — NE555, two resistors, two capacitors, LED + series resistor — so end-to-end acceptance tests can actually oscillate), `fixture-mixed` (74HC + MCU stub), `fixture-arcs` (curved outline + cutout). No third-party board files in the repo.
- **SimHost integration (Node, real libngspice):** load RC deck → op → assert node voltage ±1%; transient RC charge curve vs analytic e^(−t/RC) within tolerance; alter mid-run changes steady state; kill/respawn replay; digital smoke test (`d_inverter` via bridges) proving `.cm` loading.
- **E2E (Playwright, one path):** open fixture-555 → power on → op annotations appear → run → scope draws ≥ N samples → alter supply voltage → annotation changes.
- **CI gates:** unit + simhost-integration on all three OS runners; E2E on Linux runner (xvfb).

---

## 14. Licensing compliance summary (enforced by repo layout, not memory)

| Asset | Policy |
|---|---|
| ngspice library + `.cm` (minus `table.cm`) | Bundle; include `COPYING` in About + installer |
| Bundled SPICE models | Only in-house-written (MIT, provenance header) or verified-BSD; CI check: every file in `resources/models/` must contain a `Provenance:` header |
| Vendor models (TI/ADI/onsemi), Micro-Cap/Intusoft libs | **Never in repo or bundle**; user-import path only |
| KiCad packages3D `.wrl` | **Never bundled**; loaded from user's KiCad install at runtime. No caching of `.wrl` files into app-data either — a model cache is redistribution and triggers CC-BY-SA share-alike |
| kicanvas / Velxio | MIT-but-alpha / AGPLv3 — **do not vendor code from either**; pattern reference only |
| App + own code | MIT |

---

## 15. Build, packaging, CI

- GitHub Actions matrix: `windows-latest`, `macos-15-intel` (x64 — the `macos-13` image was retired in Dec 2025), `macos-14` (arm64), `ubuntu-latest`. macOS runners need `brew install autoconf automake libtool` before the ngspice source build.
- Pipeline: fetch/build ngspice (cached per version) → typecheck → unit tests → simhost integration tests → package (electron-builder: NSIS `.exe`, `.dmg`, AppImage + `.deb`) → upload artifacts on tags.
- Code signing/notarization: out of scope for v1 builds (documented as a release-blocker note for distribution beyond direct download).
- ngspice version + download/build steps live in `scripts/fetch-ngspice.{ts,sh}` with the version pinned in `package.json` config.

---

## 16. Risks and mitigations (top 8)

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Model coverage** — hobbyist boards are full of ESP32/WS2812B-class parts with no SPICE model. This is the #1 product risk. | Tiered resolution; polished Model Doctor; interactive-pins MCU stubs; LLM-assist import; honest fidelity banner. The app's value holds even when only the analog subset simulates. |
| 2 | Wrong pin maps → confidently wrong results | Per-footprint pin maps mandatory in library entries; visual pin-map editor; Tier-1 `Sim.Pins` preferred when schematic present |
| 3 | ngspice convergence failures on realistic boards | Retry ladder (gmin/source stepping); structured plain-language errors; watchdog respawn |
| 4 | FFI instability on some platform | Process isolation (SimHost), state replay on respawn; pipe-mode adapter as designed fallback |
| 5 | Edge.Cuts stitching breaks on real boards | Dedicated utility + heavy test coverage; bounding-box fallback with warning |
| 6 | `.cm` files missing next to library → digital silently broken | Startup `d_inverter` smoke test; packaging test in CI |
| 7 | Users over-trust results (no parasitics, behavioral models) | Persistent fidelity messaging; "what this simulation can/can't tell you" doc page linked from banner |
| 8 | KiCad format drift (v10+) | Tolerant parser (ignore-unknown); fixtures regenerated per KiCad release; format quirks isolated in `core/kicad` |

---

## 17. Future (v2+, explicitly deferred)

MCU firmware co-simulation (avr8js/rp2040js MIT, Velxio-style GPIO↔SPICE bridge — reimplemented, not copied, AGPL); trace parasitic extraction (DC IR-drop from copper geometry); thermal overlay (GPU diffusion from op-point power); AC/Bode instrument panel (engine support already specced in §6.1); WebGPU renderer path; Altium/IPC-2581 import; current-flow animated dots on traces.
