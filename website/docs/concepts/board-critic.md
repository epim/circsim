# The Board Critic

The **Board Critic** is circsim's read-only, pre-fabrication audit of the layout you brought it. Where the [live bench](./validation-bench) answers "does it *work*?", the Critic answers "will it survive *fabrication and physics*?" Those are the risks that live in the copper, not the schematic.

It runs automatically when you open a board (for the checks that need no simulation) and again after each [operating-point solve](../guides/energize) (for the checks that need to know the currents).

## Findings are risks to check, not verdicts

This framing matters, so it's worth stating plainly: **every Critic finding is a risk to check, not a defect it's certain about.** A board layout is full of intentional choices: an exposed pad that's genuinely a no-connect, a wide-tolerance spacing that's fine for your fab. The Critic can't know your intent, so it flags things worth a second look and hands you the numbers and assumptions behind each one, so *you* can judge.

Every finding carries:

- a **title** with the specific parts, nets, and numbers involved;
- a **detail** explaining what it measured and why it matters;
- an **"Assumes: …"** line stating the key assumption (copper weight, an IPC formula's temperature rise, a heuristic's coarseness), so you can see whether the finding applies to your situation;
- a **suggestion**: advice only, *never* auto-applied.

That "Assumes" line is the honesty mechanism. The Critic never over-claims; it shows its work.

## Strictly read-only

The Critic **never touches your design files, and never edits the board**: not the copper, not the components, not a single track. It only reads the layout and *adds* its own markers to a separate overlay. When you click a finding, circsim flies the camera to it and highlights the involved net or part using the same read-only highlight as hovering. Nothing in your board changes.

You act on a finding by reading it, deciding whether it applies, and (if it does) fixing it in *your* PCB tool. circsim reports; you decide; your CAD tool edits.

This is more than politeness. It's the same principle that keeps circsim from [designing the board it grades](./validation-bench#why-it-never-designs-the-board): a trustworthy validator has no hand in the artifact.

## Static vs. simulation-informed checks

The checks split into two groups by what they need.

**Static checks** run the moment you open a board (no power, no simulation):

- **Floating / dangling connectivity**: pads on no net, likely-unconnected exposed pads, nets that reach only one pad.
- **Copper clearance**: different-net tracks whose copper (track width included) is too close together or too near the board edge. Pads, vias and zones are not assessed.
- **Decoupling proximity**: IC power pins whose nearest bypass capacitor is missing or too far away.
- **Loop area**: a coarse estimate of how much area high-speed signal nets enclose against their ground return.

**Simulation-informed checks** need an operating point first, because they depend on the currents circsim just measured:

- **Trace ampacity**: is each trace wide enough for the current the solve puts through it?
- **IR-drop / rail sag**: how much voltage does the copper's own resistance drop between the supply entry and the load, counting copper pours and the ground return?
- **Thermal proximity**: a first-order relative look at where heat concentrates.

Before you energize, these appear as *needs simulation*. After Power On or Energize, the Critic always solves physical power and ground copper, regardless of the bench toggle. Ampacity, IR-drop and thermal use physical pad voltages, segment currents and terminal power. Missing current or power remains not assessed. Pads without copper contact or a path to the entry appear as located routing-gap findings, even at zero current.

::: info A note on the thermal check
The thermal check runs when solved terminal voltages and currents supply per-part power. Its heat-spread proxy uses arbitrary units: it compares where heat concentrates and which hot parts crowd each other, **never an absolute temperature in °C**. It does not model copper pour, layer stack, airflow, or thermal vias. Parts without assessed power are named as not assessed. Read placement findings as relative concerns; an explicit `PowerRating` board field also lets the check flag dissipation above that rating.
:::

Two limits are worth knowing before you lean on the copper-carrying checks:

- **Copper weight defaults to 1 oz** and is not read from your board. The physical solve options can change it; the Critic uses the same network weight. The choice changes resistance and trace capacity.
- **Loop area can't run without ground copper**. It measures distance to a ground plane. On a board with high-speed nets but no ground plane at all, rather than silently reporting nothing (which would read as "clean"), the panel shows an explicit *"loop area: not assessed (no ground copper)"* line, so you know it couldn't check the return path.

The [checks reference](../reference/critic-checks) states every threshold and assumption in full.

For the exact check thresholds, formulas, and the verbatim messages, see the [Board Critic checks reference](../reference/critic-checks).

## How to read the panel

The **Board Critic** panel (right dock) shows a summary line (`N error`, `N warn`, `N info`) and the findings grouped by severity. Severity is about how likely the risk is to bite, not how certain the Critic is:

- **error** (red) is a strong signal: touching tracks, a rail sagging past 5 %, an IC with no decoupling at all.
- **warn** (amber) is worth attention: tight-but-not-touching clearance, a cap a bit too far, a rail sagging 2-5 %.
- **info** (grey) is a heads-up: a single-pad net, the warmest part.

Click any finding to fly the 3D view to it and light up the net or part involved. Read the detail and the "Assumes" line, decide whether it's real for your board, and if so, go fix it in your layout tool.

An empty panel reads *"No risks flagged. Findings are checks, not verdicts."* That's the good outcome, stated with the same humility as everything else here.

## Related

- [Run the Board Critic audit](../guides/run-critic): the hands-on walkthrough.
- [Board Critic checks reference](../reference/critic-checks): every check in detail.
- [The validation bench](./validation-bench): why the Critic only ever audits boards you brought.
