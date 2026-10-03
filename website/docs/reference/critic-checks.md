# Board Critic checks reference

The complete list of [Board Critic](../concepts/board-critic) checks: what each measures, its thresholds, its severity, and the assumption behind it. For the concept and how to use the panel, see [the Board Critic](../concepts/board-critic) and [run the Board Critic audit](../guides/run-critic).

Every finding is a **risk to check, not a verdict**, and every one carries an *"Assumes: …"* line so you can judge whether it applies to your board.

## When each check runs

| Check | Needs a simulation? | Runs |
| --- | --- | --- |
| Floating / dangling | No | On board open |
| Clearance | No | On board open |
| Decoupling | No | On board open |
| Loop area | No | On board open |
| Ampacity | **Yes** (physical copper operating point) | After a copper-aware solve |
| IR-drop | **Yes** (physical copper operating point) | After a copper-aware solve |
| Thermal | **Yes** (operating point with solved terminal currents) | After a solve with complete per-part power |

Before you energize, the three simulation-informed checks show as *"needs simulation"* in the panel.

::: warning Two fixed assumptions worth knowing up front
- **Copper weight is assumed to be 1 oz (35 µm) on every layer.** This is a fixed default: it is **not** read from your board's stackup and can't currently be changed. The ampacity and IR-drop numbers are computed against 1 oz. If your board is heavier (2 oz), those checks are conservative (they'll over-warn); if it's lighter (0.5 oz), they're optimistic. Trust them less.
- **Design-rule numbers are circsim's defaults, not your project's.** The clearance minimum (0.2 mm) is a generic default, not your KiCad net-class rules. Treat the Critic as a second opinion, not a substitute for your CAD tool's own DRC.
:::

## Floating / dangling connectivity

Surfaces connectivity gaps found while [rebuilding the circuit](../concepts/board-to-circuit).

- **Unconnected named pad** *(warn)*: a numbered pad on no net. Could be a missing/unrouted connection, or an intentional no-connect. *Suggestion: confirm it's intentionally a no-connect.*
- **Unconnected unnumbered pad** *(warn)*: often a QFN/DFN exposed thermal pad, which usually should tie to ground for heat-sinking and a solid reference. *Suggestion: if it's an exposed thermal pad, connect it to GND.*
- **No-connect pads** are skipped. A pad whose pin type in the board file carries KiCad's `no_connect` flag (written as `(pintype "...+no_connect")` by KiCad 8 and newer when the board is updated from the schematic) is open on purpose, so the check stays quiet about it. Boards saved by older KiCad versions carry no such flag and will still list those pads.
- **Single-pad net** *(info)*: a net that reaches only one pad goes nowhere; often a stub, a test point, or a missing connection worth a glance.

KiCad's intentional `unconnected-(...)` nets are deliberately ignored. Reporting them would just be noise.

## Copper clearance

Flags different-net tracks on the same layer whose copper comes too close, and tracks whose copper runs too near the board edge. Gaps are measured between copper edges, not centerlines: the gap between two tracks is the centerline distance minus half of each track's width, and the gap to the board edge is the centerline distance minus half the track's width. Two 1.0 mm tracks with centerlines 0.6 mm apart overlap by 0.4 mm and are reported as a short. Minimum clearance **0.2 mm**: a generic default, **not** read from your project's net-class or design rules. Capped at 50 findings (with an overflow note if there are more).

- **Tracks touch or overlap** *(error)*. The copper of different-net tracks touches or overlaps (copper gap of zero or less): a short.
- **Tracks too close** *(warn)*: copper gap positive but under the minimum clearance. *Suggestion: increase spacing or reroute one track.*
- **Track touches or crosses the board edge** *(error)*: the copper reaches or crosses the board outline.
- **Track near board edge** *(warn)*: copper closer than the minimum to the edge risks exposure/shorting after the board is cut. *Suggestion: pull the track in from the edge.*

**Not assessed.** Only track-to-track and track-to-edge clearance are checked. Clearance to pads, pad to pad, vias (annulus against tracks) and zone (pour) edges is **not** assessed; a clean clearance result does not cover them. Arc tracks are approximated by their chord. Use your CAD tool's DRC for those cases.

The check uses a spatial index, so it stays fast on dense boards (tens of thousands of track segments). Clearance, like the other static checks, is computed once per opened board: a new operating point re-runs only the simulation-informed checks.

## Decoupling proximity

For each IC power pin, finds the nearest qualifying bypass cap (≤ 1 µF bridging the rail to ground) and checks the distance. ICs are U-prefixed parts or footprints with ≥ 8 pads. Thresholds: near ≤ 5 mm, far > 15 mm.

- **No decoupling cap** *(error)*: no bypass cap near this power pin; the rail can sag during the IC's fast current transients.
- **Cap too far, > 15 mm** *(error)*: beyond ~15 mm a bypass cap is largely ineffective at high frequency.
- **Cap somewhat far, > 5 mm** *(warn)*: bypass caps work best within ~5 mm of the pin they serve.

*Suggestion (all three): place a 0.1 µF cap within a few mm of the power pin.* **Assumes:** the bypass heuristic (a C-reference of ≤ 1 µF), and that layer stack / via inductance aren't modeled. The 5 mm / 15 mm distances are generic defaults: a fast switching regulator wants sub-2 mm decoupling, and some modern parts use 2.2 to 4.7 µF as primary bypass (above the 1 µF cutoff, so they won't be counted as the bypass cap here).

## Loop area

A **coarse v1 heuristic** for high-speed nets (names matching clock/SPI/USB/oscillator patterns). Estimates the signal↔return loop area as the sum over each track segment of its length times its distance to the nearest ground copper (a ground pour under a segment counts as zero). Thresholds: warn > 100 mm², error > 500 mm².

- **Large loop area** *(warn / error)*: big signal↔return loops radiate and pick up EMI in proportion to their area. *Suggestion: route a ground return alongside the signal or add a ground pour under it.*

**Assumes:** it's a coarse first pass. It doesn't model the layer stack or actual return-current spread.

::: warning No ground copper → "not assessed"
The loop-area check measures distance *to ground copper*. If your board has **no ground plane or pour at all**, it has nothing to measure against. Rather than silently producing zero findings (which would read as "checked and clean"), the panel then shows an explicit **"loop area: not assessed (no ground copper)"** line whenever the board actually has high-speed nets, so the worst case (a fast signal with no return plane anywhere) is called out as *not checked* instead of implied fine.
:::

## Ampacity *(needs operating point)*

Rates **each track against the current it actually carries**. The check shares the ngspice operating point with the parts and IR-drop check: power and ground copper are resistor networks in the circuit, every segment gets its solved current, and a track is flagged when that current exceeds its IPC-2221 external-layer capacity at a 10 °C rise. A bypass-capacitor stub sees the milliamps it really carries, a thin track under a pour sees only its share of the pour's current, and a one-amp LED feed on a 0.15 mm track is rated against one amp (earlier versions estimated a lumped half of the rail's summed currents, which under-called exactly that case).

- **Undersized trace** *(warn, or error if current exceeds ~1.5× the rated capacity)*: narrow copper carrying more than it's rated for runs hot and can fuse. *Suggestion: widen the trace or add copper.*

**Assumes:** 1 oz external copper, ΔT 10 °C, using the IPC-2221 charts method (the classic derating standard, coarser than the newer IPC-2152, and it doesn't distinguish inner from outer layers, so an inner-layer "pass" is optimistic). The supply entry is taken from your bench lead where one is attached, else guessed (see IR-drop). Copper pours are not rated: a pour is a sheet, and its current density is an IR-drop question.

**Where the currents come from.** The copper-aware deck measures every resolved model terminal with a series 0 V meter. Pad voltages and segment currents come from the same ngspice operating point as the components, including the ground return. The critic uses the copper weight and mesh pitch of that solve. Signal nets retain ideal connectivity.

**Not assessed.** An ideal-net operating point is listed as *not assessed*; enable `copperAware` in the solve API to assess copper. If the operating point carries no branch currents at all, the check is listed as *not assessed* instead of passing. Parts with unresolved model currents are named in the not-assessed line. The same line names any pad that carries current but that no modelled copper connects to the supply entry. A rail whose pads carry current but that could not be solved at all (no copper on the net, no pad touching any copper, or a solve that did not converge) is named there too, so it is never listed as assessed and clean.

## IR-drop / rail sag *(needs operating point)*

Reads physical pad voltages and segment currents from the copper-aware ngspice operating point and reports the worst supply-to-load sag as a percentage of the source-entry voltage. The model contains:

- **Tracks** as resistors.
- **Vias** as barrel resistors derived from the drill, 20 µm plating and the board thickness (about 1.4 mΩ for a 0.3 mm drill on a 1.6 mm board), joining every copper layer they span that the rail has copper on.
- **Copper pours** as a mesh of sheet-resistance cells (about 2 mm, coarser on very large pours) clipped to the zone outline and its holes. A track lying in a same-net pour is in parallel with the pour cells it crosses (it is joined to one cell per cell it passes through), so a thin stub under a pour no longer reads as if it carried the whole load and does not short the pour out either. Multi-layer zones are one fill per layer. A pour with no track to a load is still a path: loads that sit on it are real sinks, and a neck or a slot in the pour shows up as resistance or as a split.
- **Pads**, snapped onto the track endpoints, via barrels and pour cells they sit on.

**The ground return is solved too.** Each load's return current enters the ground copper at its ground pad, and the shift from the return entry is the ground shift. A load's drop is its supply sag plus the ground shift toward its rail (a *round trip*); the rail finding reports both parts, and a ground net is reported on its own when its shift alone crosses the thresholds (judged against the highest rail on the board). The supply entry is the pad nearest where you clipped the bench supply's lead (the position circsim records when you drop the clip, and saves in the board's setup file); the ground clip sets the return entry the same way. If a rail has no supply lead, or the lead has no recorded position (a setup file saved by an older circsim, say), the check guesses instead: a connector-like reference, else the widest incident track, else the first pad that touches copper. A finding always says which one it used, in its assumption line: either "entry taken from the bench lead clipped at (x, y) mm" with the pad it snapped to, or "entry is a guess" with the reason. A guess can pick a pad you did not clip to, so treat a guessed sag as approximate and clip the supply where your board is really fed. Thresholds: warn > 2 %, error > 5 %.

**Negative rails.** Sag is measured toward 0 V, so a negative rail (one the operating point solves below 0 V, such as a -5 V VEE) is checked the same way as a positive one. Its load current flows from ground through the part and back into the rail, so the rail *rises* toward 0 V at the load and the ground under that load *falls*; the round trip adds the two. With only per-part current magnitudes (no pad signs), a part's current is taken as returned into a negative rail's pads. If every pad carrying current on a rail feeds it the way a supply does (pushes current into a positive rail, or pulls it out of a negative one), nothing draws from the supply entry, so there is no sag to measure: the rail is named in the not-assessed line rather than passed.

- **Rail sags** *(warn / error)*: copper resistance drops voltage between the supply entry and the load; sagging rails brown-out ICs and shift analog references. *Suggestion: for a path through a pour, widen its narrowest section, stitch it to a second layer or move the load closer to the entry; for a track path, widen or shorten the trace, add a copper pour or a second feed, or move the load.*
- **Ground return rises or falls** *(warn / error)*: the same, for the ground net: it rises under a positive rail's loads and falls under a negative rail's.

**Assumes:** 1 oz copper (a fixed default, not read from your stackup, see the callout above); the zone *outline* stands in for the fill, so thermal-relief spokes, clearance islands around other nets' pads and keepouts are not modelled and a pour reads slightly better here than KiCad's fill will be; a neck narrower than the mesh pitch can be lost (the loads behind it are then reported as not reached); a track that ends on the middle of another track's body is not treated as joined; the supply entry (your lead, or a guess when none is recorded); currents as described under Ampacity.

**Not assessed.** An ideal-net operating point cannot assess physical sag. With no branch currents in the operating point the check is listed as *not assessed*. Parts whose current the solve could not resolve, and pads the modelled copper does not connect to the supply entry, are named in the check's not-assessed line, and so is a rail that carries current but could not be solved at all, or whose only current feeds it; none of them is silently counted as zero or dropped.

## Thermal *(needs operating point)*

A **first-order, relative** heat-spread proxy, not absolute temperature. It relaxes a 2D heat map from each part's dissipation and reports where heat concentrates.

- **Above explicit power rating** *(error)*: solved DC dissipation exceeds the part's `PowerRating` field.
- **Warmest part** *(info)*: the part at the peak of the proxy. Value is in arbitrary units, **not °C**.
- **Hot cluster** *(warn)*: two hot parts close together reinforce each other in the proxy. *Suggestion: spread high-power parts apart or add copper/thermal relief.*

**Assumes:** a first-order 2D heat-spread proxy; relative units, not absolute °C.

::: warning Thermal is not active today
Power is derived from solved terminal voltages and signed currents: resistor dissipation agrees with I squared R; a two-terminal diode or LED uses its voltage drop times current; an IC uses the signed sum of terminal V times I, subtracting power delivered through its outputs. Copper-aware solves meter each terminal of a model actually emitted into the deck. Ideal solves can supply power when their currents are unambiguous. Unresolved or unpowered parts, unavailable digital templates, and skipped incomplete primitive cards have unknown power and are listed as not assessed. A board field `PowerRating` such as `0.25W` enables an error when solved dissipation exceeds that explicit rating; package ratings are not guessed. For example, a 50 ohm resistor at 5 V dissipates 0.5 W and exceeds a 0.25 W rating. Read thermal placement findings strictly as a relative concern, never a temperature prediction.
:::

## Severity summary

| Severity | Colour | Meaning |
| --- | --- | --- |
| error | red | A strong signal worth fixing before fab |
| warn | amber | Worth a look |
| info | grey | A heads-up |

Severity reflects how likely the risk is to bite, not how certain the Critic is. Certainty lives in the finding's detail and its "Assumes" line.
