# circsim Bench Leads — Design Spec

**Status:** design (2026-07-17, user-approved in session).

**Supersedes:** the June Live Bench spec's L2 item "3D grabbable on-part knob"
(`2026-06-19-circsim-live-bench-design.md` §4). Pivot rationale: putting the
manipulable controls in 2D front panels and *drawing the leads* to the board
keeps the tactile "I connected it" feeling while sidestepping the two hard
problems of in-scene manipulation — knob drags fighting OrbitControls, and
3D drag interactions that can't be tested headlessly. It is also closer to a
real bench: instruments sit off-board and you run clip leads to the DUT.

**Goal:** instruments live on a **bench shelf** of 2D **front panels** below
the 3D viewport; each wired terminal shows a **sagging lead** drawn from its
panel jack to an alligator-clip marker on the board. The user connects an
instrument by **dragging a lead out of a jack** and dropping it on copper.

---

## 1. Experience

- A horizontal **bench shelf** strip sits below the viewport (above the
  Scope panel region), holding one front panel per instrument, side by side,
  horizontally scrollable on overflow.
- **＋ Add instrument** on the shelf opens a palette (dc-supply,
  function-gen, logic-input, voltage-probe, current-probe, potentiometer).
  A new instrument appears on the shelf **unwired** (open jacks, not in the
  sim) — deck generation only sees it once its required nets are connected,
  which is the existing semantics.
- **Front panel faces** (controls bind to the existing `updateInstrument`
  path — knob turns stay coalesced live `alter`s):
  - **dc-supply**: voltage knob + numeric readout, red **+** jack. (The
    Energize auto-supply appears here automatically — it goes through
    `addInstrument` like everything else.)
  - **function-gen**: wave selector, frequency + amplitude knobs, yellow
    **out** jack.
  - **logic-input**: high/low toggle, purple jack.
  - **potentiometer**: rheostat/divider mode toggle, wiper knob (%), jacks
    **A** (orange) / **W** (green) / **Lo** (blue; divider mode only —
    switching modes changes the jack count 2↔3).
  - **voltage-probe**: color swatch (= trace color), live value readout,
    jack in the trace color.
  - **current-probe**: color swatch, live value readout, jack in the trace
    color; its lead ends in a **clamp** on a *component*, not copper.
  - **ground**: a single panel with one black jack, derived from the
    designated ground; not offered in the palette (GroundSetup remains the
    designation flow — see §7).
- **Leads** are sagging wires drawn from jack to clip. Wired = solid, in
  the jack color above; drag-in-progress = dashed; dangling (net vanished
  after reload) = dashed + clip hidden + jack ringed open.
- The **board-end clip** is the existing probe-marker sprite restyled as an
  alligator clip, so it stays anchored to the copper through orbit/zoom and
  keeps the marker declutter/anchor machinery.

## 2. Lead gesture

- **Attach:** pointerdown on a jack → a dashed lead follows the cursor →
  release over copper attaches that terminal to the hit net (over a
  component, for the current-probe). Release over nothing = cancel, lead
  snaps back. This **replaces** the drag-card-from-rack gesture.
- **Re-attach:** pointerdown on a clip → same drag, drop on new target.
- **Detach:** drag a clip and release off-board → that terminal unwires
  (instrument stays on the shelf).
- **Remove instrument:** ✕ on the panel (existing `removeInstrument`).
- During a lead drag the existing hover highlight shows the candidate net
  (component highlight for current-probe drags). OrbitControls stay
  enabled — drags start on a jack (a shelf DOM element) or a clip **hit
  circle** (an invisible SVG circle the LeadLayer places at each clip's
  projected position, `pointerEvents: 'auto'`), so pointerdown never
  reaches the canvas. The visible clip remains the in-scene sprite; the
  SVG circle is only the pointer target.

## 3. Architecture

New module `src/renderer/src/bench/`, following the codebase's
data-layer/scene split (`markers.ts`/`picking.ts` precedent):

- **`leadGeometry.ts`** — pure math, headless-testable, no DOM/GL:
  - `projectAnchor(worldPos, camera, w, h): {px, py}` — same projection as
    the annotation declutter.
  - `leadPath(jack: {px,py}, clip: {px,py}): string` — SVG cubic-bézier
    path. Sag: both control points drop below the chord midpoint by
    `sag = clamp(0.15 · chordLen, 12, 80)` px, control x at 25% / 75% of
    the chord.
- **`LeadLayer.tsx`** — one absolutely-positioned SVG spanning viewport +
  shelf (`pointerEvents: 'none'` except jack/clip hit targets). Renders
  committed leads + the drag lead. Dumb: props in, paths out.
- **`BenchShelf.tsx`** — shelf container, palette popover, panel ordering
  (instrument insertion order; no persistence).
- **`panels/`** — `SupplyPanel.tsx`, `FunctionGenPanel.tsx`,
  `LogicInputPanel.tsx`, `PotPanel.tsx`, `ProbePanel.tsx` (voltage +
  current variants), `GroundPanel.tsx`.
- **`DragKnob.tsx`** — moved out of `InstrumentProps.tsx` unchanged
  (value/min/max/step/label/unit/onChange/log) and shared by all panels.

Changed:
- **`scene.ts` (SceneController):** add
  `pickAttachTargetAt(xPx, yPx, w, h): {netId: number} | {ref: string} | null`
  (generalizes `pickNetAt`, which stays and delegates), and
  `onAfterRender(cb): unsubscribe` so the bench can re-project anchors
  exactly when a frame actually rendered (render-on-demand friendly).
  Net anchor world positions come from the existing `netPositionsMap`;
  component anchors from the component box centroid.
- **`Viewport.tsx`:** hosts `LeadLayer`, feeds it projected anchors from
  `onAfterRender`, and routes lead-drop coordinates through
  `pickAttachTargetAt`.
- **`App.tsx`:** the right-dock `InstrumentRack` (and `InstrumentProps`)
  are **retired**; `BenchShelf` mounts below the viewport.

**Unchanged: the entire `Instrument` union, spicegen, alter planning, and
the sim path.** A lead drop is `updateInstrument(id, {...inst, netId})` (or
`netA`/`netW`/`netLo`/`ref` for the multi-terminal kinds); a knob turn is
the same `updateInstrument` flood the store already coalesces.

## 4. Data flow

store `instruments` → shelf renders panels; each panel derives its jack
wiring from its instrument's net fields. Scene render → `onAfterRender` →
re-project the (small) set of wired anchors → `LeadLayer` state. Camera
moves already invalidate/render, so leads track orbit/zoom with zero new
render loops. Lead drop → `pickAttachTargetAt` → store action → existing
`alterPlan` decides alter vs reload, exactly as today.

## 5. Edge cases

- Anchor projects offscreen → draw to the offscreen coordinate; SVG clips.
- Net id no longer exists after board reload → dangling lead style; the
  store's existing reload semantics for instruments are unchanged (the
  shelf renders whatever the store holds — it is derivational).
- Only one ground panel; palette never creates one.
- Pot mode switch drops/adds the **Lo** jack; an orphaned `netLo` wire is
  discarded on switch to rheostat (matches the instrument record).
- Shelf overflow scrolls horizontally; leads originate from the jack's
  current on-screen position, so scrolled-away panels' leads run from the
  shelf edge (acceptable; no special casing in v1).

## 6. Testing

- **Unit (`bench/__tests__`):** `leadPath` sag formula (monotone in chord
  length, clamped 12–80 px, exact control points at fixed inputs);
  `projectAnchor` against a known camera (same fixtures as markers tests).
- **Panels:** SSR via `renderToStaticMarkup` (existing no-jsdom pattern):
  each panel renders its jacks per wiring state; knob shows the value;
  wired vs unwired vs dangling styling markers present.
- **Scene:** `pickAttachTargetAt` headless raycast tests (copper hit →
  netId, component hit → ref, miss → null) alongside existing picking
  tests.
- **Store:** lead-drop updates land on the right net field per kind
  (netId / netA / netW / netLo / ref) — table-driven.
- **E2E (extends First Light):** after Energize, assert one lead path per
  wired jack in the SVG; pointer-drag a voltage-probe lead from its jack
  onto copper → probe attaches (lead count +1); drag the supply panel's
  voltage knob down → LED dims (replaces the current set-value step, so
  the tactile path is what the gate exercises).

## 7. Non-goals (v1)

- Wire physics/animation, occlusion-correct wires, lead collision routing.
- New instrument kinds (multimeter etc.).
- Ground *designation* UX — GroundSetup stays as-is; the ground panel only
  mirrors and re-attaches an already-designated ground.
- Persisting shelf layout/order across sessions.
- The June spec's 3D on-part knob (superseded by this design).
