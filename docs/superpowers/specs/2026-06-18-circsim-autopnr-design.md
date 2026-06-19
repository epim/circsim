# circsim Auto Place-and-Route — Design Spec

> **⛔ SUPERSEDED / ABANDONED (2026-06-19).** A unanimous UI/UX council (product positioning, target-user advocate, interaction design, trust/expectations) judged that in-circsim auto-P&R **undermines** circsim: the target user always arrives with an already-routed board, it forfeits the validator moat to compete with Quilter, and it creates a structural "author + grader" conflict that manufactures false pre-fab confidence — the exact failure circsim exists to prevent. The decision: **do not build P&R.** Pivot to making the core simulator astonishing (a live, breadboard-like, directly-manipulable bench). The physics/cost models sketched below (thermal proxy, RF/loop-area, IR-drop, congestion, GPU compute) are retained as *candidate ideas for a read-only board-audit/critic layer*, not for generation. This document is kept only as a record of the considered-and-rejected design.

**Status:** SUPERSEDED — see banner above. (Originally: approved direction 2026-06-18; full place + route together; custom physics-aware 2-layer router.)

**Goal:** Given a circuit's connectivity (netlist + parts + footprint geometry) and a board outline, autonomously produce a *placed and routed* KiCad 9 `.kicad_pcb` for 2-layer hobbyist boards — taking power/thermal, RF/criticality, and routability into account — that round-trips through circsim's parser and can be simulated immediately.

**Non-goals (v1):** >2 copper layers; arbitrary curved outlines for the routing grid (rectangular/rectilinear only); full 3D thermal FEM or EM field solving; differential-pair length matching; BGA escape routing; importing a full KiCad footprint library (v1 reuses footprint geometry already present in an input board).

---

## 1. Why this fits circsim

circsim today *simulates* a board someone else placed and routed. Auto-P&R closes the loop into a single tool:

```
netlist/BOM ─▶ auto-place ─▶ auto-route ─▶ DRC ─▶ simulate (ngspice) ─▶ iterate
```

It reuses everything already built: the KiCad parser (`core/kicad`), netlist extraction (`core/netlist`), the SPICE deck generator + ngspice SimHost (`core/spicegen`, `src/simhost`), and the Three.js viewport (`renderer/.../viewport`). The two genuinely new capabilities are: **(a)** a board *writer* (we can only parse today), and **(b)** the P&R engine itself.

## 2. Algorithmic approach (and what "GPU permutations" really means)

Pure brute-force permutation does not converge — placement is `N!` × continuous positions × rotations; routing is NP-hard. The sound realization of "generate many board variants on the GPU and let the best win" is **GPU-accelerated parallel metaheuristic search**:

- A **population** of candidate placements evolves via **parallel simulated annealing** (per-candidate Metropolis acceptance) plus periodic **evolutionary recombination** (graft good sub-regions of strong candidates).
- The **cost function is evaluated for the whole population in parallel on the GPU** (WebGPU compute). Cost evaluation, overlap checks, and the thermal solve are embarrassingly parallel.
- The router is a deterministic grid **maze/A\* router with rip-up-and-retry**, criticality-ordered, run after placement converges.

Every GPU kernel has a **CPU reference implementation** that is the source of truth for tests; the GPU path is validated to match the CPU path within tolerance, and is used only to go *wider and faster*. With no GPU, the engine still runs (smaller population, fewer iterations).

## 3. Process & threading model (important)

WebGPU lives in Chromium (the **renderer**), not in a Node `utilityProcess`. The ngspice SimHost runs in a `utilityProcess` because it needs native FFI; P&R has **no native dependency** and **does** need the GPU, so it lives on the opposite side:

- The P&R engine runs in a **dedicated Web Worker in the renderer**, using **WebGPU compute** for the parallel work and the worker thread for orchestration/CPU fallback. This keeps the UI responsive and makes live 3D preview natural (the viewport is right there).
- `navigator.gpu` is available in dedicated workers in Electron 30 / Chromium 124. If absent, the worker uses the CPU path.

This is a deliberate departure from the SimHost pattern and is documented here so implementers don't try to force P&R into a `utilityProcess`.

## 4. Data model — `src/core/pnr/types.ts`

All P&R types are pure (no electron/three/react imports), mirroring `core/kicad/types.ts`.

```ts
type Layer = 'F' | 'B'

interface PnrPad {
  number: string
  netId?: number          // resolved net (from Circuit); undefined = no-connect
  dx: number; dy: number  // pad center offset from footprint origin (mm), at rot 0
  w: number; h: number     // pad size (mm)
  shape: 'circle'|'rect'|'oval'|'roundrect'|'custom'
  drill?: number           // through-hole if present
}

interface PnrComponent {
  ref: string
  libId: string
  pads: PnrPad[]
  courtyard: { w: number; h: number }   // bounding courtyard at rot 0
  power?: number                         // watts (BOM or op-point); default 0
  posLocked?: boolean                    // fixed position (e.g. connectors)
  layerLocked?: boolean
  group?: string                         // optional grouping hint (e.g. 'analog')
}

type NetClass = 'power' | 'ground' | 'signal' | 'analog' | 'clock' | 'highspeed'

interface PnrNet {
  id: number
  name: string
  pads: { ref: string; padNumber: string }[]
  netClass: NetClass
  criticality: number    // 0..1 — routing/placement priority
  widthMm: number        // routed trace width (by class/current)
  clearanceMm: number
}

interface BoardSpec {
  outline: { w: number; h: number }   // rectangular, mm (auto-sized or given)
  originOffset: { x: number; y: number }
  layers: 2
  gridMm: number                       // routing grid (default 0.2)
  edgeClearanceMm: number              // default 0.5
}

interface Placement {
  positions: Map<string /*ref*/, { x: number; y: number; rotDeg: 0|90|180|270; layer: Layer }>
}

interface RouteResult {
  tracks: TrackSegment[]   // reuse core/kicad/types TrackSegment
  vias: Via[]
  unrouted: number[]       // netIds that could not be fully routed
}

interface CostWeights {
  wirelength: number; thermal: number; rf: number; compactness: number; congestion: number
}

interface PnrProblem {
  components: PnrComponent[]
  nets: PnrNet[]
  board: BoardSpec
  weights: CostWeights
  seed: number             // deterministic PRNG seed
}

interface PnrMetrics {
  hpwlMm: number; overlapArea: number; maxTempC: number
  routedNets: number; totalNets: number; viaCount: number; drcErrors: number
}

interface PnrResult { placement: Placement; route: RouteResult; metrics: PnrMetrics; cost: Record<string, number> }
```

### Building a `PnrProblem`

- **Connectivity & parts:** from the existing `Circuit` (`core/netlist/extract.ts`).
- **Footprint geometry (pad offsets, courtyard):** v1 derives it from an input `BoardModel`'s footprints — we already parse `pad.at` offsets and `courtyardBounds`. (Future: a footprint-library importer keyed on `libId`.)
- **Net classing & criticality** (`core/pnr/classify.ts`): rule-based from net name + connected parts — `ground` (matches ground heuristic), `power` (supply heuristic), `clock`/`highspeed` (names like CLK/XTAL/USB/DP/DM/HS or connection to a crystal), `analog` (parts in an analog group / sensitive op-amp inputs), else `signal`. `widthMm` defaults wider for power/ground; `criticality` highest for clock/highspeed/analog.
- **Power per component** (`power`): from a BOM power field if present; else optionally from an **operating-point simulation** of a reference board (we already have ngspice op-point); else 0. The thermal term degrades gracefully to "spread parts out" when powers are unknown.

## 5. Cost model — `src/core/pnr/cost/`

Pure, deterministic, unit-tested. `totalCost = Σ wᵢ · termᵢ`. Overlap and edge violations carry an effectively-hard weight.

- **`hpwl.ts`** — `Σ_net criticalityWeight(net) · halfPerimeter(bbox(net pad positions))`. The standard wirelength proxy; also the routability driver.
- **`overlap.ts`** — `Σ pairwise courtyard intersection area` + edge-clearance violations. Hard constraint → must reach 0.
- **`thermal.ts`** — steady-state heat-spread proxy. Rasterize component `power` onto a coarse grid; iteratively relax a 2D Poisson/diffusion field (∇²T ∝ −q); return `maxTempC` and `Σ T at hot components`. Penalizes hotspots and hot-part clustering; rewards spreading high-power parts and edge proximity. CPU reference + WGSL Jacobi/red-black kernel.
- **`rf.ts`** — rule sum: decoupling-cap→IC-power-pin distance, crystal→IC distance, critical-net length, analog/digital region separation, loop-area proxy for high-speed nets.
- **`congestion.ts`** — coarse grid; accumulate each net's bbox into bins; cost = Σ overfull bins. Predicts routability *before* routing so placement avoids un-routable layouts.

## 6. Placement engine — `src/core/pnr/place/`

- **`seed.ts`** — connectivity-aware warm start (lightweight force-directed / net-cluster seeding) to beat random initialization.
- **`anneal.ts`** — parallel simulated annealing over a population. Moves: translate (annealed step size), rotate 90°, swap two components, flip layer, shift a `group`. Geometric cooling; Metropolis acceptance on Δcost. Respects `posLocked`/`layerLocked`. Seeded xorshift PRNG (reproducible).
- **`evolve.ts`** — every K epochs, recombine: take the best candidates and graft strong spatial regions; cull the worst. Keeps population diverse and escapes local minima.
- **`place.ts`** — orchestrates seed → anneal/evolve loop → returns best `Placement`. Streams the current best each N iterations for live preview.
- CPU single-candidate path is the reference; population cost eval offloads to GPU when available.

## 7. GPU layer — `src/core/pnr/gpu/`

- **`context.ts`** — `GpuContext`: request adapter/device, compile WGSL, manage buffers, dispatch, read back. `GpuContext.available()` gates use; everything has a CPU fallback.
- **`costKernel.wgsl` + `costKernel.ts`** — given a buffer of P candidate placements (positions/rotations) and static net/pad/courtyard data, compute HPWL + overlap + congestion per candidate in parallel (one workgroup per candidate).
- **`thermalKernel.wgsl` + `thermalKernel.ts`** — Jacobi/red-black relaxation of the thermal grid; K iterations; reduce to max/avg.
- **`validate.test.ts`** — asserts GPU outputs equal CPU outputs within epsilon on fixtures. **This is the gate that lets us trust the GPU path.**

## 8. Routing engine — `src/core/pnr/route/`

Custom, physics-aware, 2 layers.

- **`grid.ts`** — uniform `gridMm` occupancy grid over the board, per layer. Cells blocked by pads (of other nets), courtyards where required, edge clearance, and existing tracks + their clearance. Trace width and clearance (from `PnrNet`) inflate occupancy.
- **`maze.ts`** — A\*/Lee expansion between cells, with via transitions between layers (via cost penalty), directional bias (prefer H on F.Cu, V on B.Cu).
- **`order.ts`** — net ordering: criticality desc, then pin-count/bbox. Hard nets first.
- **`multipin.ts`** — multi-pin nets routed as a growing tree: MST-order the pads, route each new pad to the nearest already-routed cell of the same net.
- **`ripup.ts`** — on failure, rip up blocking nets and retry in a perturbed order; bounded retries; report genuinely `unrouted` nets honestly.
- **`router.ts`** — orchestrates; emits `RouteResult`. Collinear grid runs are simplified into `TrackSegment`s.
- **Physics in routing:** power/ground → wider widths (more cells, lower IR drop/heat); clock/highspeed/analog → length caps + extra clearance; via penalty discourages layer thrash on critical nets.

## 9. DRC — `src/core/pnr/drc.ts`

Post-route check: clearance violations (track-track, track-pad, track-edge), width compliance, and unconnected/unrouted nets. Returns a structured report; `drcErrors` feeds `PnrMetrics`. Reuses board geometry types.

## 10. Board writer — `src/core/kicad/write.ts`

`writeBoard(board: BoardModel): string` → KiCad 9 `.kicad_pcb` text (`version 20260206`): header, `general`/`layers`, footprints (`at`, pads with **name-only** `(net "NAME")`), `segment`/`arc`, `via`, `zone`, `gr_line` edge cuts, `gr_text`. **Round-trip invariant:** `parseBoard(writeBoard(b))` reproduces `b`'s nets/footprints/tracks/vias within tolerance (tested). Net ids are internal (synthesized on parse); the writer emits **names**.

## 11. Orchestration & progress — `src/core/pnr/run.ts` + `src/renderer/src/pnr/worker.ts`

- `runPnr(problem, onProgress, signal): Promise<PnrResult>` — place (stream best every N iters) → route → DRC → assemble result. Cancellable via `AbortSignal`.
- Progress events: `{ phase: 'seed'|'place'|'route'|'drc'|'done', iter, bestCost, costBreakdown, placementPreview, routedNets }`.
- The Web Worker hosts `runPnr`; the renderer posts the problem in and streams progress out for live viewport preview.

## 12. Integration with circsim

- **Store actions** (`appStore.ts`): `buildPnrProblem(opts)`, `startPnr()`, `cancelPnr()`, `acceptPnrResult()`.
- **Accept** converts `PnrResult` → `BoardModel` (placement + tracks + vias + outline), sets it as the current board → the existing extract → spicegen → simulate path works unchanged, and **Save** writes `.kicad_pcb` via the new writer.
- **Power seeding:** optionally run an op-point sim of the current board first to fill `power` for the thermal term.

## 13. UI — `src/renderer/src/panels/AutoPnrPanel.tsx`

Objective weight sliders (Wirelength / Thermal / RF / Compactness), board size (auto or explicit), edge clearance, grid, locked-component multi-select, "use simulated power" toggle, Run/Cancel, live metrics (cost terms, max temp, est. routed %), 3D preview, Accept/Discard. `data-testid` hooks for E2E.

## 14. Testing & quality gates

- **Unit:** each cost term deterministic on fixtures; writer round-trip; router on hand-made fixtures (two pads → one track; a 3-pin net → tree; a forced rip-up case); classifier on real net names (`/GND`, `/VBUS_C`, `XTAL`…).
- **Placement gate:** on a synthetic netlist, converged placement beats a random baseline by ≥ 25% HPWL with **zero** overlaps.
- **GPU gate:** GPU cost == CPU cost within epsilon.
- **Router gate:** ≥ 90% of nets routed with **zero** clearance DRC errors on the v1 test boards (RC, 555 blinker, a ~20-part synthetic).
- **End-to-end:** `runPnr` on the 555 blinker netlist → placed + routed BoardModel → ngspice simulates it → oscillation matches the hand-routed fixture's result.

## 15. Phased build (each phase independently working + gated)

- **P0 — Board writer** (`core/kicad/write.ts`) + round-trip tests. Unblocks output.
- **P1 — Types + classifier + CPU cost model** (`pnr/types.ts`, `classify.ts`, `cost/*`) + tests.
- **P2 — CPU placement** (`place/*`): seed + anneal/evolve. Hits the placement gate (beats random, zero overlap).
- **P3 — Physics terms** wired into placement (thermal proxy, RF rules, congestion) + tuning.
- **P4 — WebGPU** (`gpu/*`): cost + thermal kernels, CPU-validated, then scale population/iterations.
- **P5 — Router + DRC** (`route/*`, `drc.ts`): hits the router gate.
- **P6 — Orchestration + worker** (`run.ts`, `worker.ts`): progress streaming, cancellation, end-to-end gate.
- **P7 — UI + viewport preview + accept/save** (`AutoPnrPanel.tsx`, store actions).

## 16. Risks & mitigations

1. **WebGPU-in-worker variance/perf** → mandatory CPU fallback; GPU validated == CPU; verify on this machine (NVIDIA GPU present).
2. **Router completion on dense boards** → scope 2-layer, moderate density; honest `unrouted` reporting; bounded rip-up.
3. **Footprint-geometry source** → v1 reuses an input board's footprint geometry; library import deferred.
4. **Thermal/RF fidelity** → explicitly first-order proxies; documented; not a substitute for dedicated SI/thermal tools.
5. **Determinism for tests** → seeded PRNG throughout; GPU reductions tolerant-compared.
6. **Scope creep toward "match Quilter"** → fixed v1 boundary (2-layer, tens–~150 parts, rectangular outline); anything beyond is a follow-up spec.
