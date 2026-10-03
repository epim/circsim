# Probe nets & read the scope

An [operating point](./energize) is a single frozen instant. To watch a circuit *move* (an oscillator running, a filter responding, a logic line toggling), you run a live **transient** simulation and watch it on the **scope** in the bottom dock.

## Attach a probe

The scope draws one trace per **voltage probe**, so you need at least one on a net:

- **Fastest:** click a net on the board, then click **`⌖ Probe this net`** in the bench header. A probe clips on with the next free trace color.
- **From the palette:** add a **V Probe** from **`＋ Add instrument`** and [draw its lead](./bench-and-leads) onto a net.

Attach as many as you like: each gets its own color and its own trace.

## Run it

Press **`Run`**. circsim streams a live transient simulation and the scope starts drawing. Use the toolbar **Pace** control to run at `0.1×` (slow enough to watch a fast signal), `1×` (real time), or `max` (as fast as it solves). The pace you pick before pressing Run is the pace the run starts at. Press **`Pause`** to freeze, **`Resume`** (or `Run`) to continue.

On a small board such as the 555 sample, `1×` is held steadily (a 1 Hz blinker takes one second per blink). A larger board can fall short of `1×`: a lantern-class board runs at about 1× to 2× real time on a desktop machine and below 1× on a slower one. The readout next to Pace shows the factor actually achieved; when it is less than the pace you asked for, the simulation itself is the limit (the size of the board and its part models, a fast function generator that needs a finer time step, or a switching circuit that makes ngspice take many small steps). See [how the live bench keeps up](../reference/architecture#live-sample-channel).

::: info Why it "comes alive"
The transient starts from the circuit's initial state rather than a pre-solved DC point, so you watch capacitors charge and oscillators start up: the "power on and see it come alive" moment. For very long runs, circsim restarts the window every ~30 seconds to bound memory; your scope history is kept. A window is shorter than 30 seconds when its samples would not fit the simulator's 1.5 GB memory budget: a fast function generator sets a fine time step (1/200 of its period), and a board with many nets saves more per step. circsim then restarts at the shorter boundary and the log says how long the windows are (*"Transient windows are limited to …"*). At the default 100 µs step the bundled 555 blinker needs about 60 MB per window, so it keeps the full 30 seconds.
:::

## Copper-aware runs

The bench's copper-aware control arrives with PR #162; this network reduction is implemented in PR #165.

With copper-aware solving enabled, the transient includes resistance on signal, supply and return nets. It uses a reduced copper network that retains pad terminals and eliminates internal mesh nodes. The operating-point audit keeps the full network. Missing routes remain disconnected, so an unrouted sample can behave differently from its ideal-net simulation; the bundled 555 has this limitation. Reduction lowers the cost of a large copper mesh, but physical mode can still run below real time. See the measured costs and geometry limits in [Fidelity](../concepts/fidelity#copper-resistance-and-remaining-parasitics).

## Frame the waveform

- **Time/div**: the dropdown sets the horizontal scale, from `1µs` to `5s` (default `1ms`). Pick a value that shows a few cycles. When the window holds fewer simulated points than the scope has pixels across (at the default 100 µs step, `1ms`/div or finer), the trace joins the simulated points with straight lines; a function generator on the bench sets a finer step for a fast signal.
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
