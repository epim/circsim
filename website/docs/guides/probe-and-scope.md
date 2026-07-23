# Probe nets & read the scope

An [operating point](./energize) is a single frozen instant. To watch a circuit *move* (an oscillator running, a filter responding, a logic line toggling), you run a live **transient** simulation and watch it on the **scope** in the bottom dock.

## Attach a probe

The scope draws one trace per **voltage probe**, so you need at least one on a net:

- **Fastest:** click a net on the board, then click **`⌖ Probe this net`** in the bench header. A probe clips on with the next free trace color.
- **From the palette:** add a **V Probe** from **`＋ Add instrument`** and [draw its lead](./bench-and-leads) onto a net.

Attach as many as you like: each gets its own color and its own trace.

## Run it

Press **`Run`**. circsim streams a live transient simulation and the scope starts drawing. Use the toolbar **Pace** control to run at `0.1×` (slow enough to watch a fast signal), `1×` (real time), or `max` (as fast as it solves). Press **`Pause`** to freeze, **`Resume`** (or `Run`) to continue.

::: info Why it "comes alive"
The transient starts from the circuit's initial state rather than a pre-solved DC point, so you watch capacitors charge and oscillators start up: the "power on and see it come alive" moment. For very long runs, circsim restarts the window every ~30 seconds to bound memory; your scope history is kept.
:::

## Frame the waveform

- **Time/div**: the dropdown sets the horizontal scale, from `1µs` to `5s` (default `1ms`). Pick a value that shows a few cycles.
- **Follow / Pause** (scope toolbar): Follow tracks the latest data; Pause lets you **scrub** back through history with the Scroll slider.

## Measure with cursors

Click the scope canvas to drop a cursor; drop a second and circsim shows the delta readout:

> ΔT: … | ΔV: … | f: …

That `f` is `1/ΔT`: a quick frequency measurement straight off the trace. **Clear Cursors** removes them.

Under each trace, circsim also shows **Vpp**, **Mean**, and a measured **frequency** per probe, so you can read the basics without placing cursors at all.

## Reading multiple traces

Each probe's trace uses the probe's color, listed with its net name below the canvas. Because they share the same vertical scale, you can line up cause and effect (a function-generator input against the filtered output, a clock against the flip-flop it drives).

## Tips

- No traces? The scope says *"Add voltage probes to see traces."* Attach a probe as above.
- Nothing moving? A transient needs a *changing* source: a [function generator](./bench-and-leads#function-gen-func-gen), an astable oscillator, or a logic input you toggle. A purely DC circuit is a flat line (that's correct; use the operating point for DC).
- Trace clipping or flat at a rail? That may be real (the circuit *is* saturating); check the [operating point](./energize) and the [fidelity](../concepts/fidelity) notes.

## Next

- **[Use the bench & draw leads](./bench-and-leads)**: drive the input with a function generator.
- **[Fidelity](../concepts/fidelity)**: how far to trust a waveform on a real design.
