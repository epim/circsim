# Fidelity: what circsim can and can't tell you

circsim runs a real **SPICE** simulation of your circuit: SPICE is the standard numerical method for solving a circuit's equations (circsim uses the open-source [ngspice](https://ngspice.sourceforge.io/) engine). SPICE is capable, but it models an *idealized* version of your board. A validator you can't trust is worse than no validator at all. This page is the honest account of what to believe and what to verify by other means.

All of it runs at a fixed 27 °C, with no temperature sweep, so temperature-dependent behavior (drift, thermal runaway, a regulator's thermal shutdown) isn't simulated.

This isn't fine print. It's the core of the product. circsim's job is to catch the mistakes it *can* catch and to be loud about the ones it can't.

## What circsim CAN reliably tell you

**DC operating-point voltages.** When you [energize the board](../guides/energize), circsim solves for every steady-state node voltage, for example "Rail at 4.98 V" or "output at 2.49 V." These are reliable for circuits built from well-modeled parts. The copper tints by voltage and floating labels show you where current is (and isn't) flowing. This is the "plug it in and watch it work" moment.

**Signal waveforms at the schematic level.** Resistors, capacitors, inductors, standard diodes, BJTs, and op-amps are modeled well enough to catch the big design mistakes: a wrong RC time constant, an op-amp clipping, an oscillator off by 10×.

**Logic-gate behavior.** The bundled 74HC library uses datasheet-typical propagation delays and drive strengths. Truth tables and simple timing are trustworthy.

**The NE555 timer.** The bundled 555 is a behavioral subcircuit from the datasheet block diagram. Oscillation frequency and duty cycle match the RC formula within a few percent.

**Relative comparisons.** "If I drop R1 from 10 k to 4.7 k, does the output roughly double?" For a circuit built entirely from resolved, well-modeled parts, circsim answers that reliably. (The reliability stops exactly where a stubbed part, a saturating behavioral model, or a convergence-fallback caveat enters the loop: see below.)

## What circsim CANNOT reliably tell you (and why)

### Behavioral models, not transistor-level physics

Most ICs in circsim (op-amps, the 555, regulators) are **behavioral macromodels**. They reproduce the terminal behavior (gain, bandwidth, saturation voltages) without modeling the internal transistors. That means:

- Op-amp slew rate and gain-bandwidth come from datasheet numbers, but high-frequency parasitic behavior is approximate.
- Thermal effects on bias current and offset are not modeled.
- Power-supply and common-mode rejection (PSRR = power-supply rejection ratio, CMRR = common-mode rejection ratio: how well the part ignores noise on its supply and shifts in its input common-mode level) and output impedance differ from the real part.

A behavioral model is a good check. It is not the real chip.

### MCUs and complex ICs are stubs

Microcontrollers (ESP32, STM32, ATmega, RP2040, anything similar) have no SPICE model circsim can use. They appear as **interactive-pin stubs**: you can set each GPIO high, low, or Hi-Z and watch the rest of the circuit respond, but **the firmware does not run.** That's enough to verify:

- "If GPIO5 goes high, does the LED turn on?"
- "Will the pull-up on this I²C line actually pull up?"

It is *not* enough to check timing relationships between firmware-driven signals and analog peripherals.

### No parasitics

circsim does not model:

- **Trace resistance and inductance**: a 5 cm, 0.25 mm trace on 1 oz copper is about 0.1 Ω, negligible at DC but real at RF. *(Note: the [Board Critic](./board-critic) does estimate copper resistance for its IR-drop check, but the SPICE simulation itself treats nets as ideal nodes.)*
- **Via inductance**: ~0.5 to 1 nH each, invisible to the simulation.
- **Pad and lead-frame capacitance**: picofarads that matter for high-speed signals.
- **Coupling between traces**: crosstalk, EMI pickup, differential-pair imbalance.

If your design runs above ~10 MHz, switches power at moderate frequencies, or needs precise timing, you need a tool with parasitic extraction (Sigrity, HyperLynx, a full-wave EM solver).

### Convergence failures are not design failures

If circsim reports it "couldn't find a stable solution," that usually means the solver hit a numerical problem, not that your circuit is broken. Common causes:

- A part has no model (it's in the fidelity banner).
- A node has no DC path to ground.
- Component values span a huge range (a 1 GΩ resistor next to a 1 mΩ one).

Assign ground to the right net, stub out unresolved parts, and check for floating nodes. See [reading the warnings](../guides/warnings).

## When to trust the results

::: tip Trust circsim for
- Bias points in audio and DC circuits
- RC filters, voltage dividers, simple amplifiers
- Spotting "the LED is always off because the base resistor is 10 MΩ" mistakes
- The rough oscillation frequency of an astable timer
- Whether a linear regulator is in dropout
:::

::: warning Be cautious about circsim for
- RF above ~10 MHz
- Switching power supplies (simplified inductor/diode models)
- Circuits with significant temperature effects
- Anything where trace parasitics matter
- Timing margins tighter than ~10× the simulation time-step
- **Triangle-wave sources**: the function generator renders a triangle as a smoothed sine, so its slope linearity and harmonic content differ from a real triangle (relevant for ramp comparators, PWM, and slew tests)
:::

## The fidelity banner

When the amber fidelity banner appears (*"Results approximate: U2 stubbed, D3 unresolved"*), the simulation is running with incomplete information. The voltages and waveforms are correct for the *modeled* part of the circuit, but the real board may differ wherever a stubbed or unresolved part plays a role.

You can minimize the banner to a compact header badge (**⚠ N approximate** / **ⓘ N open by design**), but you can't dismiss it: hiding it would misrepresent what circsim is telling you. It re-expands on its own whenever the set of affected parts changes.

## Further reading

- [ngspice documentation](https://ngspice.sourceforge.io/docs.html): the engine behind circsim.
- Your part's datasheet: the real reference for behavioral limits.
- [KiCad's simulation docs](https://docs.kicad.org/): for the `Sim.*` schematic properties that give circsim higher-fidelity starting models.
- [Models & resolution](./models): how circsim decides what model each part gets.
