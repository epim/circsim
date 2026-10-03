# The validation bench

circsim is built around one idea: **you already have the board, so let's validate *that*, not a redrawn abstraction of it.**

## The gap circsim fills

You have a routed `.kicad_pcb` and you are one "order" button away from spending real money on fabrication. The board might be your own KiCad layout, a contractor's delivery, an LLM-assisted design, or the output of an autorouter such as [Quilter](https://quilter.ai). circsim has no Quilter-specific code: a KiCad board is a KiCad board, whoever routed it.

Schematic simulators such as LTspice and KiCad's own ngspice integration run on the drawing. They never see the copper, so a rail routed through a thin track or a decoupling capacitor placed far from its pin is invisible to them, and you assign a model to each symbol before they run.

circsim takes the routed board as its input. It reads the net connectivity straight out of the copper, reconstructs the circuit, and lets you validate the thing you're about to fabricate.

### Where the schematic fits

The schematic is an optional input, and it makes the result better. Keep the `.kicad_sch` next to the board with the same name and circsim attaches it when you open the board. Its `Sim.*` fields are the first model source circsim tries, and its pin names decide diode and LED polarity instead of a footprint guess. Only the root sheet is read today, so parts on hierarchical sub-sheets get neither. See [attach a schematic](../guides/attach-schematic).

### Where the copper fits

The Board Critic reads tracks, vias, pours, and part placement. The solve API can include power and ground copper as resistor networks with `copperAware: true`. Parts and the Critic then share one ngspice result: the simulated supply pads sag, return pads shift, and each track is rated against its solved current. Each signal net retains one ideal node. The live bench still uses ideal nets while its physical-mode controls are being added; its copper IR-drop and ampacity checks remain explicitly not assessed.

## Two complementary jobs

circsim does two things, and it's worth understanding them as separate promises.

### 1. The live bench: "does it do what I want?"

Load the board, apply power, and watch it work. Clip a supply, a function generator, a potentiometer, and probes onto real nets. Turn a knob and the LED responds live. This answers the *functional* question: given ideal-ish components, does the circuit behave the way I intended? Is the bias point (another name for the [operating point](../guides/energize): the resting DC voltages and currents) right? Does the oscillator oscillate? Does the logic do the truth table?

This is the "plug it in on a breadboard and see" experience, for a board you can't breadboard because it's already routed.

### 2. The read-only board critic: "will it survive fabrication and physics?"

Before you send it off, the [Board Critic](./board-critic) audits the board circsim did **not** design. Are there floating nets? Is the decoupling capacitor (the small cap placed right next to a chip's power pin to steady its supply) too far from the pin to do its job? Is the power trace thin enough to sag or overheat under the load the simulation just measured? These are *physical* risks that a schematic-level simulation can't see, because they live in the layout.

The Critic is strictly read-only. It reports risks to check. It never edits your files and never re-routes anything.

## Why it never designs the board

There's a deliberate line circsim will not cross: **it never generates a board and then blesses that same board.**

An earlier version of circsim was going to include auto place-and-route. A design review killed it, unanimously, for a specific reason. If circsim both *creates* the layout and *grades* the layout, it manufactures false confidence: it's marking its own homework. The one thing a validator must never do is tell you a board is fine because it's the board the validator itself produced.

So circsim only ever validates layouts *you* brought to it. The Critic runs exclusively on user-supplied boards. This is what makes circsim trustworthy as a last check before fabrication: it has no stake in the design being right.

## The honesty principle

The target user might have zero formal electronics training. They cannot debug a simulation that is silently wrong. So circsim's third commitment, as important as the other two, is that **it is always honest about what it knows.**

Unresolved parts, stubbed ICs, convergence fallbacks, and fidelity limits are never hidden. The fidelity banner can't be dismissed. When an operating point comes back through a numerical fallback, circsim tells you the voltages might not be trustworthy. When an LED stays dark, it coaches you through why.

A validator you can't trust is worse than no validator, because it converts "I don't know" into false confidence. circsim would rather show you a gap than paper over it. Read [what circsim can and can't tell you](./fidelity): it's the design philosophy, not a disclaimer.

## What it is not

To keep the promise sharp, circsim deliberately does **not**:

- edit schematics or boards, route, or run DRC;
- do signal-integrity, EM, or crosstalk analysis, or extract inductance and capacitance from the layout (signal nets remain ideal; the solve API can model power and ground resistance);
- run MCU firmware (microcontrollers are [supply-load stubs, or interactive pins](./models#stubs-and-interactive-pins) if you choose);
- import Altium, IPC-2581, or Gerbers (KiCad only, for now);
- talk to the cloud: it is fully offline, and the "ask your LLM" helper is copy-and-paste, not an API call.

## Where to go next

- **[From routed board to circuit](./board-to-circuit)**: how circsim rebuilds a netlist from copper.
- **[Models & resolution](./models)**: how each part gets a SPICE model, and what happens when it can't.
- **[The Board Critic](./board-critic)**: the read-only pre-fab audit in depth.
- **[Fidelity](./fidelity)**: the honest limits.
