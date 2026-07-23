# Bench instruments reference

Every instrument you can add from the [bench shelf](../guides/bench-and-leads), its front-panel controls, and how it maps into the SPICE simulation. For the *how-to* of adding and wiring instruments, see [use the bench & draw leads](../guides/bench-and-leads).

All instruments start **unwired**: their net terminals are unconnected and they don't appear in the simulation until you draw a lead to a net (or, for the current probe, clamp a component). Editing any parameter while the board is energized triggers a live re-solve.

## DC Supply: `PSU`

A constant-voltage source with a series resistance.

| Control | Range / default | Notes |
| --- | --- | --- |
| **Volts** (knob) | 0 to 30 V, step 0.1 | Same value as the Voltage field |
| **Voltage** (field) | 0 to 30 V | Type an exact value |
| **Series R** | ≥ 0.001 Ω, default 0.1 Ω | The supply's internal resistance; raise it to model a weak/limited source |

- **Jack:** red **+**. Return is through your designated ground.
- **SPICE:** a voltage source and a series resistor spliced between a synthetic internal node and your net, so the net keeps its name for the voltage overlay.
- **Live edit:** changing the voltage is an in-place `alter` (no reload).

## Function Generator: `FUNC GEN`

A periodic source with a 50 Ω default output resistance.

| Control | Range / default | Notes |
| --- | --- | --- |
| **Wave** | sine / square / pulse / triangle | |
| **Freq** (knob) | 1 Hz to 1 MHz, logarithmic | Log scale gives fine low-frequency control |
| **Amp** (knob) | 0 to 20 V | Amplitude |
| **Offset** (knob) | ±20 V | DC offset |
| **Duty** (knob) | 1 to 99 % | Square/pulse only |

- **Jack:** yellow **out**.
- **SPICE:** `SIN(...)` for sine, `PULSE(...)` for square/pulse; triangle is a sine approximation.
- **Live edit:** frequency, amplitude, and offset changes `alter` in place *for the same wave type*. Changing the wave type reloads the circuit.

## Logic Input: `LOGIC`

A digital high/low driver, for poking logic inputs and MCU-stub pins.

| Control | Range / default | Notes |
| --- | --- | --- |
| **LO / HI** toggle | | Drives 0 or the high level |
| **V High** | 0 to 30 V, default 3.3 V | Set it to match your logic rail |

- **Jack:** purple **out**.
- **SPICE:** a DC source (level = V High when HI, else 0) with a 50 Ω series resistor.
- **Live edit:** toggling the level is an in-place `alter`.

## Potentiometer: `POT`

A variable resistor, in two modes.

| Control | Range / default | Notes |
| --- | --- | --- |
| **Rheostat / Divider** | rheostat default | Mode toggle |
| **Wiper** (knob) | 0 to 100 % | Wiper position |
| **Total R** | ≥ 1 Ω, default 10 kΩ | End-to-end resistance |

- **Rheostat** (2 terminals, **A** + **W**): a single variable resistor between A and W, value = `Total R × wiper%`. This is the classic dimmer wiring.
- **Divider** (3 terminals, **A** + **W** + **Lo**): a true voltage divider. An upper resistor A→W of `Total R × (1 − wiper%)` and a lower resistor W→Lo of `Total R × wiper%`, with W as the tap.
- Each leg is clamped to a minimum of 1 Ω so a fully-turned pot never shorts a node (which would wreck convergence).
- **Live edit:** turning the wiper is an in-place `alter`. Switching mode or changing Total R reloads. Switching modes keeps the A and W wires and only adds/drops the Lo terminal.

## Voltage Probe: `V PROBE`

Reads a net's voltage and feeds the [scope](../guides/probe-and-scope).

- **Jack:** **tip**, in the probe's trace color, clips to a net.
- Front panel shows a color swatch (its scope trace color) and the net's last operating-point voltage.
- **SPICE:** no element. The node voltage is read from the saved results.
- Fastest way to attach one: select a net and click **`⌖ Probe this net`** in the bench header.

## Current Probe: `I PROBE`

Clamps onto a *component* to read its current.

- **Jack:** **clamp**, dropped on a **component** (not a net).
- **SPICE:** for a primitive part, the device current is read natively; for a subcircuit part, a 0 V ammeter is spliced at the designated pad.
- **Live edit:** adding or removing a current probe always reloads (it changes the netlist).

## Ground: `GND`

Not in the palette: it mirrors the ground net you designate in the [Ground & Power](../guides/ground-and-supply) panel and appears on the shelf automatically.

- **Jack:** black **GND**. (You re-designate ground in Ground & Power, not by dragging this off the board.)
- **SPICE:** the global reference, node `0`. No element is emitted.

## Live edit: `alter` vs. reload

circsim always picks the cheaper correct update:

- **`alter` (instant, in place)**: changing a *value*, such as supply voltage, logic level, function-gen amplitude/frequency/offset (same wave), or pot wiper.
- **Reload (rebuild the netlist)**: changing *topology*, such as moving a lead to a different net, changing a function-gen wave type, changing pot mode or Total R, or adding/removing a current probe.

You don't choose: circsim detects which happened and does the right thing. See [architecture](./architecture) for the mechanism.
