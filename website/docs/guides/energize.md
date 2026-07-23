# Energize & read the operating point

The **operating point** is the DC steady state of your circuit: the voltage on every net and the current through every part when nothing is changing. It's the "plug it in and measure with a multimeter" view, and it's the fastest way to see whether your board is doing roughly the right thing.

## Two ways to power up

- **`⚡ Energize`**: the one-click path. It designates a ground net, clips a 5 V supply onto the best power net if you haven't attached a source, then solves. Great for a board you just opened.
- **`Power On`**: the deliberate path. It rigs *nothing*: it stays disabled until you've [set ground and a supply](./ground-and-supply) yourself, then solves exactly the bench you built.

Use Energize to get going; use Power On once you're driving the bench on purpose.

## What you'll see

When the solve lands:

- **Voltage labels** float over every net on the board.
- The copper **tints by voltage**: the overlay auto-switches to `Voltage` the first time (blue = low, red = high). Switch back to `Realistic` or `Highlight` in the toolbar any time.
- **LEDs glow** at a brightness driven by their real forward current.
- The **Net Voltages** tab (bottom-right) lists every net's voltage, and shows a yellow dot cue the first time results land.

The classic reassurance is a rail reading close to what you set ("5 V rail at 4.98 V") and an output where you expect it.

## Read it honestly

circsim tells you *how* it solved, because that governs how much to trust the numbers. If the solve needed a **numerical fallback** (*gmin-stepping* or *source-stepping*, two techniques the solver falls back on when a straight solve won't settle, or a transient assist), a **caveat** appears: *"Check these voltages."* A fallback op can report a misleading 0.000 V on nets it couldn't resolve, so treat those numbers as suspect. A clean direct solve carries no caveat. (You don't need to know how those techniques work, just that seeing the caveat means "double-check.")

If the solve fails entirely, you get a plain-language card explaining the likely cause (a missing DC path to ground, a floating node, or an unstable feedback loop) rather than a raw ngspice error. See [reading the warnings](./warnings).

::: tip LED stays dark?
circsim surfaces a **💡 coach note** explaining why: usually a reversed diode or a missing current-limit path. A dark LED is a diagnosis, not a dead end.
:::

## Turn a knob, re-solve live

While the board is energized, editing any bench instrument re-solves automatically. Drag the supply voltage down and watch an LED dim; sweep a pot and watch a divider output move. No "run again": the operating point tracks your changes live. This is the same mechanism the [bench](./bench-and-leads) uses throughout.

## What the operating point unlocks

A solved operating point also feeds the simulation-informed [Board Critic](./run-critic) checks: **ampacity** and **IR-drop** run against the real currents, so you find out whether your power traces are wide enough for the load you just measured.

## Next

- **[Probe nets & read the scope](./probe-and-scope)**: go from a frozen instant to live waveforms.
- **[Run the Board Critic audit](./run-critic)**: now with real currents.
- **[Fidelity](../concepts/fidelity)**: when to trust an operating point, and when not to.
