# circsim Live Bench — Design Spec

**Status:** design (2026-06-19). The headline of the post-P&R pivot: make the core simulator *astonishing* for people who have only ever breadboarded.

**Goal:** Turn circsim from "press Run → wait → read annotations" into a **living bench**: power the board and it runs continuously; attach a supply, a **potentiometer**, an LED; **turn the knob and watch the LED respond in real time in 3D.** Recreate the breadboard feeling — physical cause → immediate effect — for a newcomer with little or no formal electronics training.

**Non-goals (v1):** photoreal component models (placeholder bodies that emit light are fine); full optical LED simulation (brightness is *qualitative/proportional*, labeled as such); audio for buzzers; haptics.

---

## 1. What already exists (so we build only the gap)

Per a capability audit of the codebase, the interactive engine is **already production-ready**:

- **Continuous transient streaming** with bounded "bench windows", 16 ms / 4096-sample flush, ring buffers per probe (`src/simhost/index.ts`, `src/renderer/src/scope/ringBuffer.ts`).
- **Mid-run `alter`** of source values, coalesced over a 30 ms window, arbitrated by a HaltCoordinator (user > alter > pacing). A knob drag already updates the live sim (`appStore.updateInstrument` → `alterPlan` → `alter`).
- **Instruments** (`dc-supply`, `function-gen`, `logic-input`, `voltage-probe`, `current-probe`, `ground-ref`) attached to nets by **drag-and-drop onto copper** in 3D; auto-attach of a 5 V supply on open.
- **Real-time voltage tinting** of copper (blue→red) updated every sample batch; op-point node-voltage labels; pick/hover/select of nets and components.
- **Operating point** yields per-node DC voltages **and** `i(device)` branch currents.

So "turn a knob → the sim updates live" is **solved at the engine level**. What's missing is (a) turning *current* into a believable **visual** (the LED glow), (b) a **potentiometer** you can dial, and (c) a newcomer **on-ramp**.

## 2. The experience (target)

1. Open (or start a) board. circsim auto-detects power/ground and shows a single inviting **Energize** control.
2. Energize → the board is *live* (continuous transient). Copper shows voltage; **the LED visibly glows.**
3. A **potentiometer** sits on the bench with a knob. **Drag the knob** → the LED dims and brightens in real time, exactly like turning a pot on a breadboard.
4. Plain-language readouts on hover: *"LED1: 12 mA — bright. R2 drops 3.2 V."* SPICE is never shown.

**The bench-instrument framing** (preserves the "*I* connected it" feeling without board editing): the supply, the **potentiometer**, and an **LED indicator** are *bench instruments the user clips onto the board's nets* — exactly like clipping your own pot and LED to a device under test. The user attaches them by dragging onto copper (the existing instrument-attach gesture), so they did the connecting.

**First Light demo** (the proof slice): a **pot-dimmed LED**. Proof-of-life ordering matters — **on/off first, then dimming**: a binary blink/toggle is unmistakable "it's alive" (dimming alone can read as a render gradient), then the pot establishes "and *I'm* controlling it." Energize, watch it light, then dial the pot and watch brightness track the knob. One verb only — **"Energize"** (retire the separate "Power On"/op-check vocabulary so newcomers aren't choosing between two power buttons).

## 3. Gaps to fill → components

### G1. Current into the store (`src/renderer/src/store/appStore.ts`, `src/simhost`)
Today the op→store mapping keeps node voltages but drops `i(...)` keys, and transient ingestion feeds only voltage probes. Add:
- **Op path:** keep `i(device)` values → `currentsByDevice: Map<string, number>` and derive `partPower` (`P = Σ|V·I|`) — also feeds the Board Critic's ampacity/thermal checks.
- **Transient path:** auto-create a **current probe** for each component we want to animate (LEDs first), route its `i(...)` sample column into a ring buffer like voltage probes, and expose the latest value to the viewport.
- Tests: op result with `i(vd1)` → `currentsByDevice` populated; a transient batch with a current vector → ring buffer fed.

### G2. LED glow (`src/renderer/src/viewport/*`)
- **Classify LEDs**: footprint libId/value/refdes (`D*` + "LED", `LED_*`). Capture LED color (from value/props; default red).
- **Current → intensity curve**: `intensity = clamp((I − I_on)/(I_full − I_on), 0, 1)`, defaults `I_on ≈ 0.5 mA`, `I_full ≈ 15 mA`; gamma for perceptual feel. Document it; brightness is *proportional/qualitative*, not photometric.
- **`updateComponentEmissive(ref, intensity, color)`** on the scene: drive the LED body's `emissive`/`emissiveIntensity` (+ a soft bloom/halo sprite) each sample batch. Throttle to changed LEDs only.
- Tests: curve is monotonic and clamped; `updateComponentEmissive` sets material `emissiveIntensity`; LED classifier matches real LED footprints, not generic diodes-as-rectifiers where avoidable.

### G3. Potentiometer instrument (`src/core/spicegen/instruments.ts`, `generate.ts`, store, UI)
- New `Instrument` kind `potentiometer`:
  - **Rheostat mode** (2 terminals): `{ id, netA, netW, totalOhms, wiperPct }` → emits **one** resistor `netA–netW` of `totalOhms·wiperPct` (series dimming).
  - **Divider mode** (3 terminals): `{ id, netHi, netW, netLo, totalOhms, wiperPct }` → emits **two** resistors (`netHi–netW` = `R·(1−p)`, `netW–netLo` = `R·p`).
  - Guard a tiny `Rmin` (e.g. 1 Ω) so resistance never hits 0 (convergence).
- **Live**: dialing `wiperPct` is **alter-safe** — emit `alter` on the resistor value(s); no deck reload (`alterPlan`).
- UI: a labeled **knob** bound to `wiperPct` (reuse `DragKnob`); on-canvas, prominent, breadboard-styled.
- Tests: spicegen golden for both modes at `wiperPct` 0/0.5/1; `alterPlan` returns `alter` (not reload) when only `wiperPct` changes; `Rmin` clamp.

### G4. Newcomer on-ramp (`src/renderer/src/panels/*`)
- **Energize** button (one click): ensure a ground + a sensible supply are attached (reuse auto-supply), start the live session. Replaces the hunt for Power/Run.
- **Plain-language readouts**: hover a component/net → human sentence built from live values ("getting 12 mA — bright"; "dropping 3.2 V"). No SPICE node names.
- **First Light demo** bundled as a sample the user can open in one click.

### G5 (stretch). Current overlay, 3D grabbable knob, time control
- Animate copper by current magnitude (flow arrows / pulse); current-probe markers on the board.
- A **3D grabbable knob** mesh in the viewport (picking + drag-to-rotate) as an upgrade over the 2D knob.
- **Time control**: slow-mo / scrub to *watch* a cap charge or a 555 oscillate ("bullet-time for circuits").

## 4. Phased build (revised per council, 2026-06-19)

- **L0 — de-risk spike + current lane (G1). DO THIS FIRST.** The council flagged this as the load-bearing unknown. Spike: build the First Light deck, `bg_tran`, and assert the LED branch current (`@d_d1[i]` → `i(d_d1)`) actually streams as a transient vector **with the correct sign**. Then add a device-keyed **current lane** to the transient ingestion path — today `ingestSamples` maps vectors to *nets only* and silently drops branch currents — plus op-path current/power (also unblocks the Critic's ampacity/thermal). Note: auto-probing a component injects a current-probe and currently forces a deck reload; resolve how LEDs get probed without a reload-on-energize hitch. Tests.
- **L1 — LED glow WITH bloom (G2).** Classify LEDs; current→intensity curve; drive the LED body emissive **and a bloom/halo sprite** so the eye reads "bright," not a value field. **Bloom is core, not stretch.** Tests.
- **L2 — potentiometer + grabbable 3D knob (G3).** The pot instrument (alter-safe resistor) **and a grabbable 3D knob ON the part** (picking + drag-to-rotate). The on-part 3D knob is core to the tactile feeling — **not deferred**; a 2D knob is only a fallback. Add the resistor `alter` branch to `alterPlan` (today it falls through to a reload). Tests.
  **[2026-07-17] The 3D on-part knob half is SUPERSEDED** by `2026-07-17-bench-leads-design.md` — the bench pivot puts controls on 2D front panels with drawn leads to the board, keeping the tactile feel without in-scene manipulation. The pot instrument + alter branch shipped as specced.
- **L3 — First Light + on-ramp (G4).** Demo + the single **"Energize"** verb + plain-language readouts + the **"why isn't it glowing?" coach** for the dark-LED case (wrong polarity / no current-limit). On/off before dimming. E2E gate.
- **L4 — gallery + your-own-board (power/comprehensiveness).** A curated gallery of delightful demos (555 blink, voltage divider, transistor switch) **and "energize MY OWN KiCad board."** Surface the op-fed Critic findings (ampacity/thermal) as the visible "this is powerful" signal — don't stake the whole product on one toy.
- **L5 — stretch:** current-flow overlay, time control (slow-mo / scrub).

**First deliverable (vertical proof):** L0+L1+L2+L3 = the pot-dimmed LED you energize and dial live, with a blooming LED whose brightness tracks a grabbable on-part knob in 3D.

## 5. Testing & gates

- Unit: current extraction (op + transient), the LED intensity curve, the pot spicegen golden + alter-plan, the LED classifier.
- Viewport: `updateComponentEmissive` drives material intensity (headless THREE, no WebGL — matches existing geometry tests).
- **E2E gate (First Light):** launch the app, open the demo, Energize → an LED's emissive intensity > 0; dial the pot from min→max → the LED's intensity strictly increases (or decreases for series dimming). This is the single test that proves the whole experience.

## 6. Risks & mitigations

1. **Real-time perf** — emissive updates only for LEDs/probed parts, throttled to the 16 ms batch; reuse the existing overlay cadence.
2. **Capturing the right LED branch current** — model the LED's series path explicitly; verify current sign via a unit test on the demo deck.
3. **Pot convergence at extremes** — `Rmin` clamp; alter (not reload) keeps it smooth.
4. **Believable glow without photoreal models** — emissive placeholder body + halo sprite reads clearly as "lit"; photoreal models are a later upgrade, not a blocker.
5. **Honesty** — brightness is proportional/qualitative; readouts state real numbers (mA, V) and never imply photometric accuracy. Consistent with circsim's trust-as-validator stance.

## 7. Council refinements (2026-06-19)

A three-member design council (newcomer-UX, technical-feasibility, product/astonishment) reviewed this spec. All voted **REFINE** (direction right, execution needs changes). Folded in above:

- **3D grabbable on-part knob + LED bloom → core** (L1/L2), not stretch — the 2D-knob/emissive-only version reads as "a slider lit a cube," missing the tactile breadboard magic that is the entire point.
- **Current lane is the load-bearing risk → de-risk first** (L0): the transient `ingestSamples` path maps vectors to nets only and drops branch currents; auto-probing a part forces a deck reload. Prove the LED current streams (correct sign) before any viewport work.
- **`alterPlan` needs a resistor branch** — without it the pot forces a reload instead of a smooth live `alter`.
- **"Why isn't it glowing?" coach** — a silent dark LED is a beginner's worst moment; convert it to plain-language teaching.
- **Bench-instrument framing** — the pot/LED-indicator are clipped on by the user (preserves "I connected it" without board editing).
- **Don't stake everything on one toy** (L4) — curated demo gallery + "energize MY OWN board"; surface the op-fed Critic (ampacity/thermal) as the visible "powerful" signal.
- **On/off before dimming**; unify on a single **"Energize"** verb.

Open question deferred to L4: a true "build it yourself" placement gesture (add a part to a net) edges toward the board-editing/P&R territory we deliberately dropped — the bench-instrument framing is the v1 answer; revisit only if users ask.
