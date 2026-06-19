# circsim Board Critic — Design Spec

**Status:** approved direction (2026-06-19, "make it so"). Part of the post-P&R "validation bench" pivot.

**Goal:** A **read-only adversarial audit** of a board the user *brought to circsim* (parsed from their `.kicad_pcb` — never one circsim generated). It surfaces real-world physics and manufacturability risks the behavioral simulator is otherwise blind to — IR-drop/rail-sag, thermal hotspots, missing/distant decoupling, clearance lint, floating nets, and (stretch) high-speed loop area — as plain-language findings pinned to locations in the 3D view.

**Why this and not P&R:** the UX council rejected in-circsim place-and-route because it made circsim both *author* and *grader* of a board (manufacturing false pre-fab confidence). The critic keeps those roles separate: it only *grades* boards it did not create, deepening circsim's validator moat. It reuses the genuinely valuable engineering from the (superseded) P&R spec — the thermal/IR/loop/clearance math — as **analysis, not generation**.

**Non-goals (v1):** full EM/SI field solving; real 3D thermal FEM; differential-pair/length-match analysis; auto-fixing the board (read-only — findings + suggestions only, no edits); manufacturability beyond clearance (no full DFM/DRC parity).

---

## 1. Product framing & honesty

Findings are **risks to check, not verdicts**. Every finding states the underlying numbers and its key assumption (e.g. "assuming 1 oz copper", "current from operating-point sim"). This preserves circsim's core trust asset: it never over-claims. Severity is advisory:

- `error` — very likely a real problem (e.g. a power trace below its current rating).
- `warn` — worth checking (e.g. rail sags >2%).
- `info` — FYI / educational (e.g. "U3 dissipates 0.4 W — warmest part").

The critic is strictly **read-only**: it highlights and explains; it never modifies the board.

## 2. Inputs

Everything is derived from what circsim already parses/simulates — no new parsing.

- `BoardModel` (`core/kicad/types.ts`): `tracks` (start/end/widthMm/layer/netId), `vias`, `footprints` (at, pads w/ offsets+size+netId, `courtyardBounds`, `properties`), `netById`, `outline`, `boardThicknessMm`.
- `Circuit` (`core/netlist/extract.ts`): `nets` (id, kicadName, spiceNode, padRefs), `parts` (ref, value, libId, padNet, properties), existing `warnings`.
- **Optional** `OpResult` — an operating-point solution (node voltages + branch currents) from the existing ngspice path. When present it powers IR-drop and thermal with *real* currents; when absent those checks fall back to estimates and say so (`assumption: 'estimated, no sim'`).
- Net classification (reuse `suggestGround`/`suggestSupplies` + a small classifier): which nets are power/ground vs signal, plus copper layer count/weight (default 2-layer, 1 oz).

## 3. Data model — `src/core/critic/types.ts`

```ts
type Severity = 'error' | 'warn' | 'info'
type CheckId = 'floating' | 'ir-drop' | 'ampacity' | 'decoupling' | 'thermal' | 'clearance' | 'loop-area'

interface Finding {
  id: string                 // stable, e.g. "ir-drop:/5V"
  check: CheckId
  severity: Severity
  title: string              // short, plain language: "5V rail sags to 4.62 V at U3"
  detail: string             // the numbers + the why
  assumption?: string        // e.g. "1 oz copper; current from op-point sim"
  refs?: string[]            // component refs involved (U3, C7…)
  netId?: number
  location?: { x: number; y: number }   // mm, board coords — for the 3D pin/marker
  suggestion?: string        // "widen this trace to ≥0.4 mm" — advice only, never auto-applied
  metrics?: Record<string, number>
}

interface CriticReport {
  findings: Finding[]
  ranBy: CheckId[]           // which checks executed (some need a sim)
  skipped: { check: CheckId; reason: string }[]
  summary: { error: number; warn: number; info: number }
}

interface CriticOptions {
  copperOz?: number          // default 1
  minClearanceMm?: number    // default 0.2
  irDropWarnPct?: number     // default 2
  irDropErrPct?: number      // default 5
  decouplingNearMm?: number  // default 5
  decouplingFarMm?: number   // default 15
  ambientC?: number          // default 25
}
```

## 4. Shared geometry — `src/core/critic/geom.ts`

Pure helpers (unit-tested):
- `padWorldPos(footprint, pad): {x,y}` — footprint `at` + pad offset rotated by `footprint.at.rotDeg` (**must match the convention in `renderer/.../viewport/componentGeometry.ts`** — verify at implementation time).
- `segLengthMm(seg)`, `arcLengthMm(arc)`.
- `trackResistanceOhms(lengthMm, widthMm, copperOz, layerThicknessFactor)` — ρ_Cu = 1.68e-8 Ω·m; thickness = `copperOz × 34.8 µm`; R = ρ·L/(w·t).
- `segPointDistance`, `segSegDistance` (for clearance), `pointInOutline`.

## 5. Checks — `src/core/critic/checks/*` (each a pure `(ctx) => Finding[]`)

1. **`floating.ts`** — promote/extend `Circuit.warnings`: floating pads, single-pad nets, and active-part power/GND pins with no net. `warn`/`info`. (No sim needed.)
2. **`clearance.ts`** — track↔track, track↔pad, track↔board-edge below `minClearanceMm` (per layer). `error`/`warn`. (No sim needed.)
3. **`ampacity.ts`** — for each track on a power/ground net, compute current capacity via IPC-2221 (`I = k·ΔT^0.44·A^0.725`, external k=0.048, ΔT=10 °C, A in mil²) and compare to the net's current (from `OpResult`, else estimated from supply + load). Flag undersized traces. `error`/`warn`.
4. **`irDrop.ts`** — build the per-net resistive graph (tracks+vias as edges, pads as nodes), inject the op-point currents, solve node voltages, report end-to-end sag from the supply pad to the farthest sink. Headline finding: "5V rail sags to 4.62 V at U3 (−7.6%)". Needs `OpResult` (else `skipped`).
5. **`decoupling.ts`** — for each active IC (multi-pin part on a power net), find its power pin(s); check for a small bypass cap (value ≤ ~1 µF) on the same net within `decouplingNearMm`. Missing/distant → `warn`/`error`, with the measured distance and the offending pin location. (No sim needed.)
6. **`thermal.ts`** — per-component power (`P = Σ|V·I|` across its pads from `OpResult`, else BOM/estimate); rasterize onto a grid and relax the salvaged 2D heat-spread proxy; report the warmest parts and hot clusters as `info`/`warn` with a relative temperature-rise proxy (explicitly *not* absolute °C without a real thermal model). Needs power data (else `skipped`/estimated).
7. **`loopArea.ts`** (stretch) — for clock/high-speed nets, estimate signal↔return loop area (nearest ground track/plane); large loops → `warn`. Heuristic in v1.

## 6. Orchestrator — `src/core/critic/run.ts`

`runCritic(board, circuit, opResult?, opts?): CriticReport` — builds a `CriticContext` (classified nets, geometry cache, copper params), runs each check, collects findings, records `skipped` checks (and why), computes `summary`. Deterministic. No electron/three/react imports.

## 7. Integration (renderer)

- **Critic panel** (`renderer/.../panels/CriticPanel.tsx`): findings grouped by severity, each row shows title + detail + assumption + suggestion; clicking a finding flies the camera to `location` and highlights the involved net/track/part in the 3D viewport (read-only overlay: pin marker + colored highlight). `data-testid` hooks.
- **Trigger:** auto-run the no-sim checks on board load; re-run the sim-dependent checks (IR-drop, ampacity, thermal) automatically after an operating-point solve, feeding the `OpResult` in. A manual "Re-run audit" button too.
- **Viewport overlay** (`viewport/criticOverlay.ts`): markers at finding locations; a toggle to tint copper by the IR-drop voltage field or the thermal field (reusing the same data). Cleared when the panel closes.

## 8. Testing & gates

- **Unit per check** on hand-made fixtures: a deliberately thin power trace → `ampacity`/`ir-drop` finding with correct numbers; an IC with no nearby small cap → `decoupling`; two tracks below clearance → `clearance`; a known floating pad → `floating`; two 1 W parts adjacent → `thermal` hot cluster. Geometry helpers unit-tested (resistance of a known trace; pad world pos under rotation).
- **Determinism:** same inputs → same report.
- **Integration smoke:** `runCritic` on the real KiCad-9 lantern board produces a plausible, non-empty report **without crashing**, and every finding's `location` lies within the board outline.
- **Honesty gate:** every sim-dependent finding either carries real op data or an `assumption` string saying it's estimated; nothing claims absolute °C.

## 9. Phased build

- **C0** types + geom helpers (+ tests).
- **C1** no-sim checks: `floating`, `clearance`, `decoupling` + orchestrator skeleton (works without a simulation).
- **C2** sim-fed checks: wire an operating-point `OpResult` shape from the existing ngspice path; `ampacity` + `ir-drop`.
- **C3** `thermal` proxy (port the heat-spread math from the superseded P&R spec) + (stretch) `loop-area`.
- **C4** renderer: CriticPanel + viewport overlay + auto-trigger wiring + E2E (open lantern board → findings appear → click → camera + highlight).

## 10. Risks

1. **No-sim accuracy** — IR/thermal need currents; without a sim they're estimates. Mitigation: clearly label, auto-run after op-solve, never assert absolute values.
2. **Pad-world-position convention drift** — must match the viewport's transform exactly. Mitigation: shared helper + a rotation unit test cross-checked against `componentGeometry.ts`.
3. **False positives erode trust** — conservative thresholds, plain-language "worth checking" framing, show the math.
4. **Net classification gaps** on odd rail names — reuse the hierarchical-aware `suggestSupplies`/`suggestGround`; allow user to mark a net as power/ground later.
