# The Board Critic

The **Board Critic** is circsim's read-only, pre-fabrication audit of the layout you brought it. Where the [live bench](./validation-bench) answers "does it *work*?", the Critic answers "will it survive *fabrication and physics*?" — the risks that live in the copper, not the schematic.

It runs automatically when you open a board (for the checks that need no simulation) and again after each [operating-point solve](../guides/energize) (for the checks that need to know the currents).

## Findings are risks to check, not verdicts

This framing matters, so it's worth stating plainly: **every Critic finding is a risk to check, not a defect it's certain about.** A board layout is full of intentional choices — an exposed pad that's genuinely a no-connect, a wide-tolerance spacing that's fine for your fab. The Critic can't know your intent, so it flags things worth a second look and hands you the numbers and assumptions behind each one, so *you* can judge.

Every finding carries:

- a **title** with the specific parts, nets, and numbers involved;
- a **detail** explaining what it measured and why it matters;
- an **"Assumes: …"** line stating the key assumption (copper weight, an IPC formula's temperature rise, a heuristic's coarseness) — so you can see whether the finding applies to your situation;
- a **suggestion** — advice only, *never* auto-applied.

That "Assumes" line is the honesty mechanism. The Critic never over-claims; it shows its work.

## Strictly read-only

The Critic **never touches your design files, and never edits the board** — not the copper, not the components, not a single track. It only reads the layout and *adds* its own markers to a separate overlay. When you click a finding, circsim flies the camera to it and highlights the involved net or part using the same read-only highlight as hovering — nothing in your board changes.

You act on a finding by reading it, deciding whether it applies, and — if it does — fixing it in *your* PCB tool. circsim reports; you decide; your CAD tool edits.

This isn't just politeness. It's the same principle that keeps circsim from [designing the board it grades](./validation-bench#why-it-never-designs-the-board): a trustworthy validator has no hand in the artifact.

## Static vs. simulation-informed checks

The checks split into two groups by what they need.

**Static checks** run the moment you open a board — no power, no simulation:

- **Floating / dangling connectivity** — pads on no net, likely-unconnected exposed pads, nets that reach only one pad.
- **Copper clearance** — different-net tracks too close together or too near the board edge.
- **Decoupling proximity** — IC power pins whose nearest bypass capacitor is missing or too far away.
- **Loop area** — a coarse estimate of how much area high-speed signal nets enclose against their ground return.

**Simulation-informed checks** need an operating point first, because they depend on the currents circsim just measured:

- **Trace ampacity** — is a power trace wide enough for the current it's actually carrying?
- **IR-drop / rail sag** — how much voltage does the copper's own resistance drop between the supply entry and the load?
- **Thermal proximity** — a first-order relative look at where heat concentrates.

Before you energize, these appear in the panel as *"needs simulation"* so you know what an operating-point solve would add. Press [Energize](../guides/energize) and they run against real currents.

::: info A note on the thermal check
The thermal check is a *relative* heat-spread proxy in arbitrary units — it tells you which parts sit at the hot end and which hot parts crowd each other, **never an absolute temperature in °C**. It doesn't model copper pour, layer stack, airflow, or thermal vias. In this version it also needs per-part power data that isn't fully wired up yet, so it's the quietest of the checks — treat the other six as the working set today. When it does fire, read it strictly as "these are relatively hotter," not "this reaches N degrees."
:::

Two limits are worth knowing before you lean on the copper-carrying checks:

- **Copper weight is assumed to be 1 oz** everywhere — it's a fixed default, not read from your board. Ampacity and IR-drop are computed against that, so they're conservative on heavier copper and optimistic on lighter. 
- **Loop area goes silent on a board with no ground copper** — it measures distance to a ground plane, so with no plane to measure against it produces nothing, which can look like "clean." If you have fast signals and no ground pour, read a silent result as "not assessed."

The [checks reference](../reference/critic-checks) states every threshold and assumption in full.

For the exact check thresholds, formulas, and the verbatim messages, see the [Board Critic checks reference](../reference/critic-checks).

## How to read the panel

The **Board Critic** panel (right dock) shows a summary line — `N error`, `N warn`, `N info` — and the findings grouped by severity. Severity is about how likely the risk is to bite, not how certain the Critic is:

- **error** (red) — a strong signal: touching tracks, a rail sagging past 5 %, an IC with no decoupling at all.
- **warn** (amber) — worth attention: tight-but-not-touching clearance, a cap a bit too far, a rail sagging 2–5 %.
- **info** (grey) — a heads-up: a single-pad net, the warmest part.

Click any finding to fly the 3D view to it and light up the net or part involved. Read the detail and the "Assumes" line, decide whether it's real for your board, and if so, go fix it in your layout tool.

An empty panel reads *"No risks flagged. Findings are checks, not verdicts."* — which is the good outcome, stated with the same humility as everything else here.

## Related

- [Run the Board Critic audit](../guides/run-critic) — the hands-on walkthrough.
- [Board Critic checks reference](../reference/critic-checks) — every check in detail.
- [The validation bench](./validation-bench) — why the Critic only ever audits boards you brought.
