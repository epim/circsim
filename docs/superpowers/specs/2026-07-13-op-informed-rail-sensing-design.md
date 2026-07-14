# Op-informed rail sensing — design

> Status: **DRAFT for user review** (incorporates Gemini/Antigravity design-review feedback, 2026-07-13). Motivating case: the lantern board's U7/U8 (CD4000 logic) behind `/VGATED`.

## Problem

circsim generates a SPICE deck from a routed PCB + BOM and simulates it with ngspice. Digital logic chips (CD4000 / 74HC families) need a supply-rail voltage `vHigh` to set their output swing and input threshold fractions. Today the rail is chosen (in `expandXspiceDigital`, `src/core/spicegen/generate.ts`) as:

1. **M10 direct-supply rule** (`deriveSupplyVHigh`): if exactly one `dc-supply` instrument sits *directly* on the chip's VDD pad net (and VSS is grounded), use its volts. Deliberately **no tracing through components**.
2. Otherwise, the **family default** (`vHighDefault`: 12 V for CD4000, 5 V for 74HC).

A chip whose VDD sits on a **switched / derived rail** — e.g. `/VGATED`, driven through a high-side FET fed from the battery — has no directly-attached supply, so it falls back to the 12 V default. That default may be wrong (the real rail could be a 16.8 V battery, a regulated 3.3 V, etc.), giving the wrong swing and thresholds for that chip.

We cannot read the true rail statically without tracing through the FET/regulator — which M10 deliberately forbids (fragile, needs per-device drop models). But ngspice already *computes* that rail voltage when it solves the operating point. Core idea: **let the operating-point solve tell us the rail, then regenerate the digital models from the measured rail** — with a manual user override as an escape hatch when the DC snapshot is wrong (dynamically-powered rails).

## Rail-voltage precedence (the heart of the design)

`vHigh` for a digital chip is chosen by the first tier that applies:

| Tier | Source | Known when |
|------|--------|-----------|
| 1 | **Direct DC supply** on the VDD net (M10, `deriveSupplyVHigh`) | deck-gen (from instruments) |
| 2 | **Manual rail override** — a user-set voltage for the VDD net | deck-gen (from project state) |
| 3 | **Measured-op rail** — the DC voltage the operating point puts on the VDD net | after pass-1 op |
| 4 | **Family default** (`vHighDefault`) | always |

Tiers 1, 2, 4 are known before any sim, so they fold into pass-1 deck generation directly. Tier 3 is what needs the two-pass. A chip that lands via tier 1 or 2 is **excluded from op sensing** (its rail is already authoritative).

## Approach: two-pass operating-point solve (for tier 3)

1. **Pass 1** — generate the deck (tiers 1/2/4 applied) and run op as today. Switched-rail chips with no supply/override use the family default; the op still converges (verified on the lantern board).
2. **Sense** — before committing the op result, for each digital chip that resolved to the *family default* in pass 1 (no direct supply, no manual override), read the **measured DC voltage on its VDD net** from the pass-1 op result. If it clears the floor and VSS is grounded, re-derive `vHigh` from it (tier 3).
3. **Pass 2 (conditional)** — if *any* chip's derived `vHigh` differs from what pass 1 used (> 0.1 V epsilon), regenerate the deck with the measured rails and run op **once more**; commit the pass-2 result. Otherwise commit pass 1 unchanged.

**Why one extra pass converges** (confirmed in review): the rail voltage on a switched node is set by upstream power (battery → FET/regulator), which is essentially independent of the negligible static current a CMOS logic chip's own output swing draws. So measured VDD in pass 1 (chip at 12 V) ≈ measured VDD in pass 2 (chip at the true rail). One correction reaches the fixpoint; we do **not** iterate, and pass 2 never triggers a pass 3.

## Key design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Scope: digital `vHigh` only.** Not a general "measured rail" facility for other model kinds. | YAGNI. U7/U8 are the motivating case. |
| 2 | **Four-tier precedence** (table above): Direct DC > manual override > measured-op > family default. | A bench supply on VDD is unambiguous hardware truth; an explicit user override beats an inferred DC snapshot (the user knows a dynamically-powered rail's intended voltage); measured-op beats a blind family constant. |
| 3 | **Floor + validity.** Tier 3 applies only if measured rail `> 2 V`, finite, and `< ~30 V` sanity cap. Skip pass 2 when the sensed rails don't actually change the deck — detected by regenerating the pass-2 deck and comparing it to pass-1 with `*` comment lines stripped (a measured rail equal to the family default leaves the device cards identical, so no re-solve). | Guards against deriving a dead ~0 V rail (see #4) or an absurd value from a marginal op; the deck-content diff is the source of truth for "did anything change", so it can't spuriously skip a real change or (beyond a sub-mV band) re-run needlessly. |
| 6a | **Cache invalidation.** The cached measured rails (and gated-off notes) are cleared on any deck-dirtying edit (ground reassignment, pin-map/model/override change) so a stale rail — sensed under a different topology/ground frame — can't leak into a later transient deck. | `measuredRails` is netId→volts relative to the sensing-time ground; a topology change invalidates it, so the next op must re-sense. |
| 6b | **Single committed op result.** During `powerOn`'s two-pass, the global op-result listener is suppressed so only the final (pass-2, or pass-1 if no re-run) result is ever committed as "current" state — the interim family-default pass-1 result never reaches the voltage readout, coach notes, or the critic report. | Otherwise the critic would momentarily run on the wrong (family-default) swing before self-correcting. |
| 4 | **Gated-OFF ⇒ family default + a surfaced warning.** If the switched rail measures below the floor (FET off → chip unpowered at DC), keep the family-default swing AND emit a fidelity note naming the chip: *"VDD (`/VGATED`) is ~0 V at the operating point; using the 12 V default swing. If this rail is powered during a transient, the chip's logic thresholds may be inaccurate — set a rail voltage to override."* | (User-confirmed to keep the default.) A rail off at DC is often *on* during the transient the user cares about; the warning flags the exact failure mode Gemini identified (thresholds locked to the wrong rail) and points the user at the tier-2 override as the fix. |
| 5 | **Manual override discoverability + tie-in.** The gated-off warning (and any family-default fallback on a non-grounded/ambiguous rail) links the user to setting a rail override for that net. | Turns the warning into an actionable escape hatch rather than a dead-end caveat. |
| 6 | **Transient reuse.** The op pass derives the measured rails and **caches** them; transient (and subsequent op) decks reuse tiers 1/2 always and the cached tier-3 rails when present. No op yet → tiers 1/2/4 only. | The op is the sensing pass; transient benefits without its own sense pass. |

## Architecture & data flow

Four isolated units plus a UI surface:

1. **`digitalVddNet(tpl, pinMap, part, netIdToNode) → { vddNetId?, vssGrounded }`** (new, `generate.ts`). Extracted from the existing `deriveSupplyVHigh` (its steps 1–2): resolves a digital chip's VDD net and whether VSS is grounded. Shared by `deriveSupplyVHigh` and the new derivation — removes duplication, independently testable.

2. **`railOverrides` project state** — `Record<string /*net kicadName, e.g. "/VGATED"*/, number /*volts*/>`, persisted in the project like the existing Model-Doctor pin-map overrides. Set/edited/cleared by the user (unit 5). Threaded into `generateDeck`.

3. **`deriveMeasuredRailVHigh(opValues, circuit, resolutions, instruments, groundNetId, railOverrides, modelTexts) → { rails: Map<netId, number>, gatedOff: Array<{ ref, net }> }`** (new, exported from `core/spicegen`). Pure. For each `xspice-digital` resolution: resolve its VDD net via `digitalVddNet`; skip if it has a direct dc-supply (tier 1) or a manual override (tier 2) or VSS not grounded; look up measured VDD in `opValues`; if `> floor` and in range → add to `rails`; if `< floor` (gated off) → add to `gatedOff` (drives the tier-4 warning).

4. **`generateDeck` gains optional `railOverrides?: Map<number, number>` and `measuredRailVHigh?: Map<number, number>`** (both keyed by netId) in `GenerateOptions`, threaded into `expandXspiceDigital`. Selection becomes:
   ```
   const vHigh = deriveSupplyVHigh(...)              // tier 1
              ?? railOverrides?.get(vddNetId)        // tier 2
              ?? measuredRailVHigh?.get(vddNetId)    // tier 3
              ?? logic.family.vHighDefault           // tier 4
   ```
   The vhigh-provenance comment names the source (`dc-supply on VDD net` / `user rail override` / `op-measured rail` / family default).

5. **UI surface** (`src/renderer/src`): a per-net **rail-voltage override** control — settable from the net context (the Net-Voltages readout row and/or a selected net on the 3D board): "Set rail voltage… / Clear". Writes `railOverrides[kicadName]` in the store. The gated-off warning (unit 3 → coach/fidelity note) is rendered in the existing readout caveat channel (same mechanism as "open by design" / "results approximate") and offers a one-click affordance to set the override for the named net.

**Orchestration** (`appStore.powerOn`, `src/renderer/src/store/appStore.ts`): resolve `railOverrides` (kicadName→volts) to a netId map once. After `result = await waitFor('opResult')` and *before* the state commit:
- `const { rails, gatedOff } = deriveMeasuredRailVHigh(result.values, circuit, resolutions, instruments, groundNetId, railOverrideNetMap, modelTexts)`.
- If `rails` changes any chip's `vHigh` vs pass 1: regenerate with `measuredRailVHigh: rails`, `loadCircuit` + `runOp`, `await opResult` → replace `result` with pass 2. Guard: at most one re-run (a boolean; pass 2 does not re-sense).
- Cache `rails` in store for transient reuse; refresh when the circuit / overrides change.
- Set the `gatedOff` warnings into the readout caveat channel.
- Continue the existing commit path (net voltages, currents, coach, critic) with the final `result`.

## Error handling

- **Pass-2 op timeout / convergence failure:** fall back to the pass-1 `result`; the existing `convergenceFailure` card path still applies.
- **Missing / NaN measured voltage for a VDD net:** skip that chip (family default); never derive from a non-number.
- **Manual override that is non-finite / ≤ 0:** ignored (treated as unset), same guard as a bench supply.
- **No digital chips / all resolve via tiers 1–2:** `rails` empty → no second pass, byte-identical to today.

## Testing

- **Unit — `digitalVddNet`:** returns the same VDD-net / grounded verdicts `deriveSupplyVHigh` relied on (regression guard on the refactor).
- **Unit — `deriveMeasuredRailVHigh`:** (a) FET-fed net measuring 12.6 V → `rails` has 12.6; (b) chip with a direct dc-supply → skipped; (c) chip with a manual override → skipped; (d) rail below floor → not in `rails`, present in `gatedOff`; (e) VSS not grounded → skipped from both; (f) two chips sharing one rail → one `rails` entry.
- **Unit — `generateDeck` precedence:** for one VDD net, assert tier order — direct supply beats a manual override beats a measured rail beats the family default; provenance comment names each source.
- **Integration (real ngspice):** high-side FET gated ON feeding a CD4000 VDD from a non-12 V rail → two-pass yields the measured swing where a single pass used 12 V; a gated-OFF variant keeps the family default and reports a `gatedOff` entry; a manual-override variant pins the user's voltage regardless of the measured op.
- **Store-level (mocked sim):** `powerOn` runs pass 2 only when a measured rail changes a chip's `vHigh`; a pass-2 failure falls back to pass-1 voltages; a gated-off rail surfaces the warning caveat.
- **UI:** setting/clearing a net rail override updates `railOverrides` and re-runs; the gated-off caveat renders and its "set rail voltage" affordance targets the named net.

## Rejected alternatives

- **Static netlist tracing** through the FET/regulator to infer the drop. Fragile: needs per-device drop models (FET `Rds·I`, regulator setpoint), is topology-specific, and breaks the deliberate M10 "no component tracing" invariant.
- **Unconditional bias pre-solve** for every board. Doubles op time for the ~99 % of boards with no switched-rail digital chip, for no benefit.

## Resolved review points (Gemini/Antigravity, 2026-07-13)

- Two-pass convergence confirmed solid for CMOS (negligible static current) → no third pass. Caveat noted: floating CMOS inputs can draw crowbar current, but circsim's island-detection bleeds floating nets toward ground (not mid-rail), so this is not a practical convergence risk here.
- Gated-off transient hazard → addressed by decision #4 (warning) + #5 (override tie-in).
- Manual `VRAIL` override (their supplement) → adopted as tier 2 (decision #2, units 2 + 5).
