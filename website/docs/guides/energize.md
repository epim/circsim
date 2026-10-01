# Energize & read the operating point

The **operating point** is the DC steady state of your circuit: the voltage on every net and the current through every part when nothing is changing. It's the "plug it in and measure with a multimeter" view, and it's the fastest way to see whether your board is doing roughly the right thing.

## Two ways to power up

- **`⚡ Energize`**: the one-click path. It designates a ground net, clips a 5 V supply onto the best power net if you haven't attached a source, then solves. Great for a board you just opened.
- **`Power On`**: the deliberate path. It rigs *nothing*: it needs you to have [set ground and a supply](./ground-and-supply) yourself, then solves exactly the bench you built.

Use Energize to get going; use Power On once you're driving the bench on purpose.

## When a button can't proceed

Neither button ever fails silently. If circsim can't start the solve, a card appears over the board telling you what to do next, and the toolbar shows the same reason as text beside **Power On** and **Run** (the buttons stay focusable, so keyboard users reach them too):

- **Designate a ground net first.** Energize picks a ground from net names like `GND`, `AGND`, or `VSS`. A board whose nets all carry KiCad's auto-generated names (`Net-(R1-Pad1)` and so on) gives it nothing to go on, and circsim will not guess which net is 0 V. Click the net you want in the **Ground & Power** panel, or click it on the board, then press the button again.
- **Attach a power supply or signal source.** Ground is set but no source drives the circuit. Use a suggested supply chip in **Ground & Power**, or add a DC Supply or Function Generator from the [bench](./bench-and-leads) and draw its lead to a net. A source that has not been wired to a net yet does not count.

The card closes by itself once the problem is fixed, or you can dismiss it.

## What you'll see

When the solve lands:

- **Voltage labels** float over every net on the board.
- The copper **tints by voltage**: the overlay auto-switches to `Voltage` the first time. A **Copper voltage** legend at the bottom right of the board prints the lowest and highest voltage and the color between them (dark violet = low, yellow = high; lighter always means higher, so it works for red-green color blindness too). Switch back to `Realistic` or `Highlight` in the toolbar any time.
- **LEDs glow** at a brightness driven by their real forward current.
- The **Net Voltages** tab (bottom-right) lists every net's voltage, and shows a yellow dot cue the first time results land.

The classic reassurance is a rail reading close to what you set ("5 V rail at 4.98 V") and an output where you expect it.

## Read it honestly

circsim tells you *how* it solved, because that governs how much to trust the numbers. If the solve needed a **numerical fallback** (a *gentler solve*, called *gmin stepping*, or a *ramped solve*, called *source stepping*, two techniques the solver falls back on when a straight solve won't settle, or a transient assist), a **caveat** appears: *"Check these voltages. These voltages needed a workaround to solve; treat 0.000 V readings as unknown."* A fallback op can report a misleading 0.000 V on nets it couldn't resolve, so treat those numbers as suspect. A clean direct solve carries no caveat, and the bundled op-amp, 555, and regulator models are written to solve directly, so the bundled sample and ordinary boards built from them open without one. (You don't need to know how those techniques work, just that seeing the caveat means "double-check." The banner's **Details** disclosure names which workaround ran.)

**A latch shows its power-up state.** An op-amp wired as a Schmitt trigger (a thermostat or battery-monitor comparator with hysteresis) has two valid outputs while its input sits inside the hysteresis band, plus a balance point between the rails where a real circuit never rests. A straight solve tends to land on that balance point, so circsim checks every bundled-model op-amp the solve leaves between its rails. When one is balanced there, circsim re-solves it from the state the board powers up in: output low, the same state **Run** settles to. Energize solves each setting fresh from power-up, so it does not remember which way the input last crossed a threshold. To watch the hysteresis itself, drive the input from the function generator and press **Run**.

If the solve fails entirely, you get a plain-language card explaining the likely cause (a missing DC path to ground, a floating node, or an unstable feedback loop) rather than a raw ngspice error. See [reading the warnings](./warnings).

::: tip LED stays dark?
circsim surfaces a **💡 coach note** explaining why: usually a reversed diode or a missing current-limit path. A dark LED is a diagnosis, not a dead end.
:::

## Turn a knob, re-solve live

While the board is energized, editing any bench instrument re-solves automatically. Drag the supply voltage down and watch an LED dim; sweep a pot and watch a divider output move. No "run again": the operating point tracks your changes live. This is the same mechanism the [bench](./bench-and-leads) uses throughout.

## What the operating point unlocks

A solved operating point also feeds the simulation-informed [Board Critic](./run-critic) checks: **ampacity** and **IR-drop** run against the branch currents of the solve (every part, not only LEDs), through your tracks, vias and copper pours, so you find out whether your power copper is wide enough for the load you just measured. Anything the solve could not measure is named in the panel rather than counted as zero.

## Next

- **[Probe nets & read the scope](./probe-and-scope)**: go from a frozen instant to live waveforms.
- **[Run the Board Critic audit](./run-critic)**: now with real currents.
- **[Fidelity](../concepts/fidelity)**: when to trust an operating point, and when not to.
