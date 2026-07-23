# Use the bench & draw leads

The **bench shelf** sits under the 3D board. It holds your instruments as front panels (a supply, a function generator, probes, a potentiometer), and you connect each one to the board by **drawing a lead from its jack onto the copper**, exactly like clipping a probe onto a device under test.

This is the heart of circsim. Everything here happens live: turn a knob and the simulation re-solves without a restart.

![The bench shelf with a Ground panel and a PSU panel side by side. The PSU shows a Volts knob at 5 V, a Voltage field, a Series R field, and a red plus-jack with a lead running up to the board.](/img/bench-shelf.png)

## Add an instrument

Click **`＋ Add instrument`** in the bench header and pick one:

| Instrument | Front-panel title | What it is |
| --- | --- | --- |
| **DC Supply** | `PSU` | A constant voltage source with a series resistance |
| **Function Gen** | `FUNC GEN` | A sine / square / pulse / triangle source |
| **Logic Input** | `LOGIC` | A digital HI/LO driver |
| **V Probe** | `V PROBE` | Reads a net's voltage (feeds the scope) |
| **I Probe** | `I PROBE` | Clamps a component to read its current |
| **Potentiometer** | `POT` | A variable resistor (rheostat or divider) |

A new instrument lands on the shelf **unwired**: its jacks are hollow, and it isn't in the simulation yet. It joins the circuit the moment you wire its required terminals.

::: info Where's the ground instrument?
Ground isn't in the palette. It mirrors whatever net you designate in the **Ground & Power** panel, and shows up on the shelf as a `GND` panel automatically. See [set ground & supply](./ground-and-supply).
:::

## Draw a lead

Every jack is a small circle on the front panel: **filled** when wired, **hollow** when open, and color-coded by instrument.

1. **Press and hold** a jack. A dashed lead follows your cursor up into the 3D view.
2. **Move over the board.** circsim highlights the net (or, for a current probe, the component) you're about to land on.
3. **Release on copper** to clip the lead to that net. The jack fills in and a solid wire is drawn from the panel to an alligator-clip marker on the board.

![A voltage probe's dashed lead being dragged from its jack on the bench up toward the board, mid-gesture, before it's dropped on a net.](/img/drawing-a-lead.png)

*(Above: a lead in mid-drag. The dashed wire follows the cursor from the V-Probe's jack up to the board. Drop it on copper to clip it on.)*

The lead stays attached to that copper as you orbit and zoom. It tracks the board in 3D.

::: tip Leads attach even under a component
If a net's only exposed copper sits directly under a component body, don't worry: circsim's hit-test sees the net *through* the part, so the lead still clips to the net. You don't have to hunt for a bare stretch of trace.
:::

### Re-route or detach

- **Re-route:** grab the alligator-clip marker on the board and drag it to a different net.
- **Detach:** drag the clip off the board and release. The lead comes off (the instrument stays on the shelf). *Ground never detaches this way. Change it in Ground & Power.*
- **Cancel a drag:** press **Escape** mid-drag.
- **Remove the whole instrument:** the **`×`** on its front-panel title bar.

## The front panels

Every control drives the running simulation immediately.

### DC Supply (`PSU`)
- **Volts** knob (0 V to 30 V) and a matching **Voltage** field: drag the knob or type a value.
- **Series R**: the supply's internal resistance (default 0.1 Ω). Raise it to model a current-limited or weak source.
- Jack: red **+**. (Return is through your designated ground.)
- A supply that Energize attached for you carries an amber *"Auto-attached"* note until you touch it.

### Function Gen (`FUNC GEN`)
- **Wave**: `sine` / `square` / `pulse` / `triangle`.
- **Freq** knob: 1 Hz to 1 MHz, logarithmic (so low frequencies get fine control).
- **Amp** knob: amplitude, 0 V to 20 V.
- **Offset** knob: DC offset, ±20 V.
- **Duty** knob: 1% to 99%, shown only for square/pulse.
- Jack: yellow **out**.

### Logic Input (`LOGIC`)
- **LO / HI** toggle: drives the net to 0 or to your high level.
- **V High**: the logic-high voltage (default 3.3 V; set it to match your rail).
- Jack: purple **out**.

### Potentiometer (`POT`)
- **Rheostat / Divider** mode toggle.
  - **Rheostat** (2 terminals A, W): a variable resistor, the classic dimmer wiring.
  - **Divider** (3 terminals A, W, Lo): a true three-terminal voltage divider; W is the wiper tap.
- **Wiper** knob: 0% to 100%.
- **Total R**: the full end-to-end resistance (default 10 kΩ).
- Switching modes keeps the A and W wires and only adds or drops the Lo terminal.

### V Probe / I Probe
- **V Probe**: a color swatch (its scope trace color) and a live readout of the probed net's last operating-point voltage. Its **tip** jack clips to a net.
- **I Probe**: clamps onto a *component* (drop its **clamp** jack on the part, not a net) and reads that part's current.

## Turn a knob, watch it change

Once the board is energized (an operating point is showing), editing any instrument triggers a live re-solve. Drag the supply down and an LED dims; sweep a pot wiper and a divider output moves; retune a function generator and the scope trace follows. No restart, no "run again."

Under the hood, a value change becomes a SPICE `alter` (an in-place tweak to a value, no rebuild); a *wiring* change (moving a lead to a different net) reloads the circuit, because the topology actually changed. circsim picks the right one for you.

::: info The bench is per-session
Instruments and the leads you draw live for the current session. They're never written into your board file (circsim doesn't touch your design files) and don't yet persist across restarts: reopen a board and you'll rebuild the bench. It's quick, and it keeps your `.kicad_pcb` untouched.
:::

## Next

- **[Probe nets & read the scope](./probe-and-scope)**
- **[Energize & read the operating point](./energize)**
- **[Bench instruments reference](../reference/instruments)**: every parameter and its SPICE mapping.
