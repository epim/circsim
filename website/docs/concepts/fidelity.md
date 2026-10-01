# Fidelity: what circsim can and can't tell you

circsim runs a real **SPICE** simulation of your circuit: SPICE is the standard numerical method for solving a circuit's equations (circsim uses the open-source [ngspice](https://ngspice.sourceforge.io/) engine). SPICE is capable, but it models an *idealized* version of your board. A validator you can't trust is worse than no validator at all. This page is the honest account of what to believe and what to verify by other means.

All of it runs at a fixed 27 °C, with no temperature sweep, so temperature-dependent behavior (drift, thermal runaway, a regulator's thermal shutdown) isn't simulated.

This isn't fine print. It's the core of the product. circsim's job is to catch the mistakes it *can* catch and to be loud about the ones it can't.

## What circsim CAN reliably tell you

**DC operating-point voltages.** When you [energize the board](../guides/energize), circsim solves for every steady-state node voltage, for example "Rail at 4.98 V" or "output at 2.49 V." These are reliable for circuits built from well-modeled parts. The copper tints by voltage and floating labels show you where current is (and isn't) flowing. This is the "plug it in and watch it work" moment.

**Signal waveforms at the schematic level.** Resistors, capacitors, inductors, standard diodes, BJTs, and op-amps are modeled well enough to catch the big design mistakes: a wrong RC time constant, an op-amp clipping, an oscillator off by 10×.

**Logic-gate behavior.** The bundled 74HC and CD4000 libraries use datasheet-typical propagation delays and a simple output stage: a source resistance plus a drive-current limit, so a gate output sags under load and a bare LED or a short to ground draws a bounded current instead of amps. Truth tables and simple timing are trustworthy. The output stage is a typical-value approximation: it does not model the difference between source and sink strength, temperature, or the exact shape of the datasheet output curves.

**The NE555 timer.** The bundled 555 is a behavioral subcircuit from the datasheet block diagram. Oscillation frequency and duty cycle match the RC formula within a few percent.

**Relative comparisons.** "If I drop R1 from 10 k to 4.7 k, does the output roughly double?" For a circuit built entirely from resolved, well-modeled parts, circsim answers that reliably. (The reliability stops exactly where a stubbed part, a saturating behavioral model, or a convergence-fallback caveat enters the loop: see below.)

## What circsim CANNOT reliably tell you (and why)

### Behavioral models, not transistor-level physics

Most ICs in circsim (op-amps, the 555, regulators) are **behavioral macromodels**. They reproduce the terminal behavior (gain, bandwidth, saturation voltages) without modeling the internal transistors. That means:

- Op-amp slew rate and gain-bandwidth come from datasheet numbers, but high-frequency parasitic behavior is approximate.
- **Supply pins carry the load.** An op-amp, the 555, a linear regulator, or a logic gate draws the current its output delivers, plus the datasheet quiescent current, from its supply pin. So a bench supply's series resistance, a reverse-protection diode, a polyfuse, or the rail copper sees the real load, and a current probe on the supply reads it.
- **Saturation recovers on the datasheet clock.** An op-amp driven into a rail leaves it as soon as its input reverses, limited by its slew rate (a saturated LM358 comparator crosses mid-supply about 11 µs after its input crosses, not as long as it spent saturated). Its output low level meets the datasheet figure (an LM358 pulling down a 10 kΩ pull-up to 5 V reads about 15 mV).
- **A latch rests on a rail.** An op-amp with positive feedback (a Schmitt trigger) whose input sits inside its hysteresis band reads at its power-up state, output low, rather than at the unstable point between the rails. See [Energize](../guides/energize#read-it-honestly).
- **Dropout follows the load.** A linear regulator's dropout is the datasheet's light-load figure at light load and rises to the rated-load figure at full current (AMS1117: about 1.0 V at 100 mA, 1.2 V at 1 A; 78xx: about 1.5 V and 2 V), interpolated in a straight line between the two. An AMS1117-3.3 fed from a 4.2 V Li-ion cell at 90 mA reads about 3.2 V.
- Thermal effects on bias current and offset are not modeled.
- Power-supply and common-mode rejection (PSRR = power-supply rejection ratio, CMRR = common-mode rejection ratio: how well the part ignores noise on its supply and shifts in its input common-mode level) and output impedance differ from the real part.

A behavioral model is a good check. It is not the real chip.

### MCUs and complex ICs are stubs

Microcontrollers (ESP32, STM32, ATmega, RP2040, anything similar) have no SPICE model circsim can use, and **the firmware does not run.** circsim recognizes the common ones by name and stubs them automatically, so they never sit there as an unexplained red part: each becomes an amber **supply-load stub** that draws the family's datasheet supply current from its supply pad and does nothing else (see [supply-load stubs](./models#supply-load-stubs)). The rail sags and loads like the real board, which is what a power check needs; the chip's pins are not simulated. A controller circsim recognizes but has no supply figure for is stubbed as interactive pins with no load, and says so.

To play the part of the firmware, choose **Interactive pins** in the [Model Doctor](../guides/model-doctor#interactive-pins): you can then set each GPIO high, low, or Hi-Z and watch the rest of the circuit respond (the part then draws no supply current). That's enough to verify:

- "If GPIO5 goes high, does the LED turn on?"
- "Will the pull-up on this I²C line actually pull up?"

It is *not* enough to check timing relationships between firmware-driven signals and analog peripherals.

### No parasitics

circsim does not model:

- **Trace resistance and inductance**: a 5 cm, 0.25 mm trace on 1 oz copper is about 0.1 Ω, negligible at DC but real at RF. *(Note: the [Board Critic](./board-critic) does estimate copper resistance for its IR-drop check, including copper pours and the ground return, but the SPICE simulation itself treats nets as ideal nodes; the critic reads each part's current from that ideal-net solve and then solves the copper with those currents.)*
- **Via inductance**: ~0.5 to 1 nH each, invisible to the simulation.
- **Pad and lead-frame capacitance**: picofarads that matter for high-speed signals.
- **Coupling between traces**: crosstalk, EMI pickup, differential-pair imbalance.

If your design runs above ~10 MHz, switches power at moderate frequencies, or needs precise timing, you need a tool with parasitic extraction (Sigrity, HyperLynx, a full-wave EM solver).

### Convergence failures are not design failures

If circsim reports it "couldn't find a stable solution," that usually means the solver hit a numerical problem, not that your circuit is broken. Common causes:

- A part has no model (it's in the fidelity banner).
- A node has no DC path to ground. (circsim ties such a net to ground through 1 GOhm so the solve can finish. When no chip output drives the net either, circsim lists it in an "Undriven nets held at 0 V" note, because its 0 V is not a measurement. See [reading the warnings](../guides/warnings#undriven-nets-held-at-0-v).)
- Component values span a huge range (a 1 GΩ resistor next to a 1 mΩ one).

Assign ground to the right net, stub out unresolved parts, and check for floating nodes. See [reading the warnings](../guides/warnings).

## When to trust the results

::: tip Trust circsim for
- Bias points in audio and DC circuits
- RC filters, voltage dividers, simple amplifiers
- Spotting "the LED is always off because the base resistor is 10 MΩ" mistakes
- The rough oscillation frequency of an astable timer
- Whether a linear regulator is in dropout (the dropout voltage follows the load, per the datasheet curves)
:::

::: warning Be cautious about circsim for
- RF above ~10 MHz
- Switching power supplies (simplified inductor/diode models)
- Circuits with significant temperature effects
- Anything where trace parasitics matter
- Timing margins tighter than ~10× the simulation time-step
:::

## The fidelity banner

When the amber fidelity banner appears (*"Results approximate: U2 stubbed, D3 unresolved"*), the simulation is running with incomplete information. The voltages and waveforms are correct for the *modeled* part of the circuit, but the real board may differ wherever a stubbed or unresolved part plays a role.

You can minimize the banner to a compact header badge (**⚠ N approximate** / **ⓘ N open by design**), but you can't dismiss it: hiding it would misrepresent what circsim is telling you. It re-expands on its own whenever the set of affected parts changes.

## Further reading

- [ngspice documentation](https://ngspice.sourceforge.io/docs.html): the engine behind circsim.
- Your part's datasheet: the real reference for behavioral limits.
- [KiCad's simulation docs](https://docs.kicad.org/): for the `Sim.*` schematic properties that give circsim higher-fidelity starting models.
- [Models & resolution](./models): how circsim decides what model each part gets.
