# What circsim can and can't tell you

circsim runs a SPICE simulation of your circuit. SPICE simulations are powerful, but they model an idealized version of your circuit. This page explains honestly what you can trust and what you should verify by other means.

---

## What circsim CAN reliably tell you

**DC operating point voltages.** When you press "Power On", circsim solves the circuit for all steady-state node voltages. "Rail at 4.98 V" and "output at 2.49 V" are reliable for circuits with good SPICE models. The copper overlay and floating voltage labels show you where current is (and isn't) flowing — exactly the "plug it in and watch it work" experience.

**Signal waveforms at the schematic level.** Resistors, capacitors, inductors, standard diodes, BJTs, and op-amps are modeled accurately enough to catch the major design mistakes: wrong RC time constants, op-amp clipping, oscillator frequency off by a factor of 10.

**Logic gate behavior.** The bundled 74HC library uses datasheet-typical propagation delays and drive strengths. Truth tables and simple timing diagrams are trustworthy.

**The NE555 timer.** The bundled NE555 model is a behavioral subcircuit derived from the datasheet block diagram. Oscillation frequency and duty cycle match the RC formula within a few percent.

**Relative comparisons.** "If I change R1 from 10k to 4.7k, does the output voltage double?" — yes, circsim answers this correctly.

---

## What circsim CANNOT reliably tell you (and why)

### Behavioral models, not transistor-level physics

Most IC models in circsim (op-amps, the 555, linear regulators) are **behavioral macromodels**: they reproduce the terminal behavior (gain, bandwidth, saturation voltages) without modeling the internal transistors. This means:

- Slew rate and GBW of op-amps are set from datasheet numbers, but high-frequency parasitic behavior is approximate.
- Thermal effects on bias current and offset voltage are not modeled.
- Power supply rejection, common-mode rejection, and output impedance vary from the real part.

A behavioral model is a good check — but it is not the real chip.

### MCUs and complex ICs are stubs

Microcontrollers (ESP32, STM32, ATmega, RP2040, and anything similar) have no SPICE model that circsim can use. They are represented as **interactive-pin stubs**: you can set each GPIO high/low/Hi-Z and watch what happens to the rest of the circuit, but the MCU firmware does not execute. This is enough to verify:

- "If GPIO5 goes high, does the LED turn on?"
- "Is the pull-up on this I2C line going to work?"

It is NOT enough to verify timing relationships between MCU-driven signals and analog peripherals.

### No parasitics

circsim does not model:

- **Trace resistance and inductance.** A 5 cm long 0.25 mm trace on 1 oz copper has about 0.07 Ω — negligible at DC but relevant at RF.
- **Via inductance.** Typically 0.5–1 nH per via — invisible to circsim.
- **Pad and lead frame capacitance.** Chip-scale packages have picofarads of parasitic capacitance that affect high-speed signals.
- **Coupling between traces.** Crosstalk, EMI pickup, and differential-pair imbalance are not simulated.

If your design operates above about 10 MHz, or involves switching power supplies at moderate frequencies, or requires precise timing, you need a tool with parasitics extraction (e.g., Sigrity, HyperLynx, or full-wave EM solvers).

### Convergence failures are not design failures

If the simulator reports "couldn't find a stable solution," this usually means the SPICE solver ran into a numerical problem, not that your circuit is wrong. Common causes:

- A part has no model (appears in the fidelity banner).
- A node has no DC path to ground.
- Component values are far apart in scale (e.g., a 1 GΩ resistor next to a 1 mΩ resistor).

Try assigning ground to the correct net, stub out unresolved parts, and check the circuit for floating nodes.

---

## When to trust the results

Trust circsim results for:

- Checking bias points in audio and DC circuits.
- Verifying RC filters, voltage dividers, and simple amplifiers.
- Spotting "the LED will always be off because the base resistor is 10 MΩ" mistakes.
- Getting the rough oscillation frequency of an astable timer circuit.
- Checking whether a linear regulator will be in dropout.

Be cautious about circsim results for:

- RF circuits above 10 MHz.
- Switching power supplies (the inductor and diode models are simplified).
- Circuits with significant temperature effects.
- Anything where trace parasitics matter.
- Timing margins tighter than about 10× the simulation time-step.

---

## The fidelity banner

When the fidelity banner appears at the bottom of the screen ("Results approximate: U2 stubbed, D3 unresolved"), the simulation is running with incomplete information. The voltages and waveforms you see are correct for the modeled subset of the circuit, but the actual board behavior may differ wherever a stubbed or unresolved part plays a role.

The banner is persistent and non-dismissable because hiding it would misrepresent what circsim is telling you.

---

## Further reading

- [ngspice documentation](https://ngspice.sourceforge.io/docs.html) — the simulation engine behind circsim.
- Your part's datasheet — the real reference for behavioral limits.
- KiCad's Simulation documentation — for `Sim.*` schematic properties that give circsim higher-fidelity starting models.
