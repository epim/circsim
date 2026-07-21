# Board Critic checks reference

The complete list of [Board Critic](../concepts/board-critic) checks — what each measures, its thresholds, its severity, and the assumption behind it. For the concept and how to use the panel, see [the Board Critic](../concepts/board-critic) and [run the Board Critic audit](../guides/run-critic).

Every finding is a **risk to check, not a verdict**, and every one carries an *"Assumes: …"* line so you can judge whether it applies to your board.

## When each check runs

| Check | Needs a simulation? | Runs |
| --- | --- | --- |
| Floating / dangling | No | On board open |
| Clearance | No | On board open |
| Decoupling | No | On board open |
| Loop area | No | On board open |
| Ampacity | **Yes** (operating point) | After each solve |
| IR-drop | **Yes** (operating point) | After each solve |
| Thermal | **Yes** (operating point) | After each solve |

Before you energize, the three simulation-informed checks show as *"needs simulation"* in the panel.

::: warning Two fixed assumptions worth knowing up front
- **Copper weight is assumed to be 1 oz (35 µm) on every layer.** This is a fixed default — it is **not** read from your board's stackup and can't currently be changed. The ampacity and IR-drop numbers are computed against 1 oz. If your board is heavier (2 oz), those checks are conservative (they'll over-warn); if it's lighter (0.5 oz), they're optimistic — trust them less.
- **Design-rule numbers are circsim's defaults, not your project's.** The clearance minimum (0.2 mm) is a generic default, not your KiCad net-class rules. Treat the Critic as a second opinion, not a substitute for your CAD tool's own DRC.
:::

## Floating / dangling connectivity

Surfaces connectivity gaps found while [rebuilding the circuit](../concepts/board-to-circuit).

- **Unconnected named pad** *(warn)* — a numbered pad on no net. Could be a missing/unrouted connection, or an intentional no-connect. *Suggestion: confirm it's intentionally a no-connect.*
- **Unconnected unnumbered pad** *(warn)* — often a QFN/DFN exposed thermal pad, which usually should tie to ground for heat-sinking and a solid reference. *Suggestion: if it's an exposed thermal pad, connect it to GND.*
- **Single-pad net** *(info)* — a net that reaches only one pad goes nowhere; often a stub, a test point, or a missing connection worth a glance.

KiCad's intentional `unconnected-(...)` nets are deliberately ignored — reporting them would just be noise.

## Copper clearance

Flags different-net tracks on the same layer that come too close, and tracks too near the board edge. Minimum clearance **0.2 mm** — a generic default, **not** read from your project's net-class or design rules. Capped at 50 findings (with an overflow note if there are more).

- **Tracks touch or overlap** *(error)* — different-net tracks with essentially zero gap: a short or an etch risk.
- **Tracks too close** *(warn)* — closer than the minimum clearance. *Suggestion: increase spacing or reroute one track.*
- **Track near board edge** *(warn)* — copper closer than the minimum to the edge risks exposure/shorting after the board is cut. *Suggestion: pull the track in from the edge.*

## Decoupling proximity

For each IC power pin, finds the nearest qualifying bypass cap (≤ 1 µF bridging the rail to ground) and checks the distance. ICs are U-prefixed parts or footprints with ≥ 8 pads. Thresholds: near ≤ 5 mm, far > 15 mm.

- **No decoupling cap** *(error)* — no bypass cap near this power pin; the rail can sag during the IC's fast current transients.
- **Cap too far, > 15 mm** *(error)* — beyond ~15 mm a bypass cap is largely ineffective at high frequency.
- **Cap somewhat far, > 5 mm** *(warn)* — bypass caps work best within ~5 mm of the pin they serve.

*Suggestion (all three): place a 0.1 µF cap within a few mm of the power pin.* **Assumes:** the bypass heuristic (a C-reference of ≤ 1 µF), and that layer stack / via inductance aren't modeled. The 5 mm / 15 mm distances are generic defaults — a fast switching regulator wants sub-2 mm decoupling, and some modern parts use 2.2–4.7 µF as primary bypass (above the 1 µF cutoff, so they won't be counted as the bypass cap here).

## Loop area

A **coarse v1 heuristic** for high-speed nets (names matching clock/SPI/USB/oscillator patterns). Estimates the signal↔return loop area as the sum over each track segment of its length times its distance to the nearest ground copper (a ground pour under a segment counts as zero). Thresholds: warn > 100 mm², error > 500 mm².

- **Large loop area** *(warn / error)* — big signal↔return loops radiate and pick up EMI in proportion to their area. *Suggestion: route a ground return alongside the signal or add a ground pour under it.*

**Assumes:** it's a coarse first pass — it doesn't model the layer stack or actual return-current spread.

::: warning No ground copper → "not assessed"
The loop-area check measures distance *to ground copper*. If your board has **no ground plane or pour at all**, it has nothing to measure against. Rather than silently producing zero findings (which would read as "checked and clean"), the panel then shows an explicit **"loop area: not assessed — no ground copper"** line whenever the board actually has high-speed nets — so the worst case (a fast signal with no return plane anywhere) is called out as *not checked* instead of implied fine.
:::

## Ampacity *(needs operating point)*

For each power/ground rail, estimates the rail current from the operating-point currents (roughly half the sum of the connected parts' current magnitudes), then checks the rail's narrowest track against IPC-2221 external-layer capacity at a 10 °C rise.

- **Undersized trace** *(warn, or error if current exceeds ~1.5× the rated capacity)* — narrow copper carrying more than it's rated for runs hot and can fuse. *Suggestion: widen the trace or add copper.*

**Assumes:** 1 oz external copper, ΔT 10 °C, using the IPC-2221 charts method (the classic derating standard — coarser than the newer IPC-2152, and it doesn't distinguish inner from outer layers, so an inner-layer "pass" is optimistic). Rail current is estimated as **Σ|part currents| / 2** — the factor of ½ is because that sum counts each rail current twice, once leaving the source and once entering the load; this is a lumped estimate that won't hold for heavily branched or star topologies, and it compares that single current against the rail's *narrowest* track without distinguishing a series bottleneck from a parallel branch.

## IR-drop / rail sag *(needs operating point)*

Builds a resistive model of each power rail's copper (tracks as resistors, vias ≈ 0.5 mΩ), injects the operating-point load currents, solves it, and reports the worst supply→load voltage sag as a percentage of the nominal rail. The supply entry is inferred (a connector-like reference, else the widest incident track). Thresholds: warn > 2 %, error > 5 %.

- **Rail sags** *(warn / error)* — copper resistance drops voltage between the supply entry and the load; sagging rails brown-out ICs and shift analog references. *Suggestion: widen or shorten the supply trace, add a copper pour or second feed, or move the load closer to the supply entry.*

**Assumes:** 1 oz copper (a fixed default — not read from your stackup, see the callout above); vias ≈ 0.5 mΩ each; the inferred supply entry; sink currents from the operating-point sim (parts without a solved current aren't counted).

## Thermal *(needs operating point)*

A **first-order, relative** heat-spread proxy — not absolute temperature. It relaxes a 2D heat map from each part's dissipation and reports where heat concentrates.

- **Warmest part** *(info)* — the part at the peak of the proxy. Value is in arbitrary units, **not °C**.
- **Hot cluster** *(warn)* — two hot parts close together reinforce each other in the proxy. *Suggestion: spread high-power parts apart or add copper/thermal relief.*

**Assumes:** a first-order 2D heat-spread proxy; relative units, not absolute °C.

::: warning Thermal is the quietest check today
The thermal check needs per-part power dissipation, which this version doesn't fully compute yet — so in practice it produces little output. Ampacity and IR-drop run on real operating-point currents and are the working simulation-informed checks. Read any thermal finding strictly as a *relative* placement concern, never a temperature prediction.
:::

## Severity summary

| Severity | Colour | Meaning |
| --- | --- | --- |
| error | red | A strong signal worth fixing before fab |
| warn | amber | Worth a look |
| info | grey | A heads-up |

Severity reflects how likely the risk is to bite — not how certain the Critic is. Certainty lives in the finding's detail and its "Assumes" line.
