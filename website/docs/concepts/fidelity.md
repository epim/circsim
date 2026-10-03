# Fidelity: what circsim can and can't tell you

circsim runs a real **SPICE** simulation of your circuit: SPICE is the standard numerical method for solving a circuit's equations (circsim uses the open-source [ngspice](https://ngspice.sourceforge.io/) engine). SPICE is capable, but it models an *idealized* version of your board. A validator you can't trust is worse than no validator at all. This page is the honest account of what to believe and what to verify by other means.

All of it runs at a fixed 27 °C, with no temperature sweep, so temperature-dependent behavior (drift, thermal runaway, a regulator's thermal shutdown) isn't simulated.

This isn't fine print. It's the core of the product. circsim's job is to catch the mistakes it *can* catch and to be loud about the ones it can't.

## What circsim CAN reliably tell you

**DC operating-point voltages.** When you [energize the board](../guides/energize), circsim solves for every steady-state node voltage, for example "Rail at 4.98 V" or "output at 2.49 V." These are reliable for circuits built from well-modeled parts. The copper tints by voltage and floating labels show you where current is (and isn't) flowing. This is the "plug it in and watch it work" moment.

**Signal waveforms at the schematic level.** Resistors, capacitors, inductors, standard diodes, BJTs, and op-amps are modeled well enough to catch the big design mistakes: a wrong RC time constant, an op-amp clipping, an oscillator off by 10×. An RC charge curve matches the exact exponential within 2 percent.

**LED and diode forward voltage.** The bundled LED cards reproduce the datasheet typical forward voltage at 10 mA to within 0.05 V (red 1.85 V, green 2.09 V, blue 3.0 V, white 3.1 V) and sit inside the datasheet band at 20 mA. The signal diodes (1N4148, 1N4001, 1N5819, SS54) are held to the datasheet's own forward-voltage, breakdown and leakage bands, which are wider than the LED figure: a 1N4148 reads 0.67 V at 5 mA against a 0.72 V typical, inside its 0.64 to 0.80 V band.

**Logic-gate behavior.** The bundled 74HC and CD4000 libraries use datasheet-typical propagation delays and a simple output stage: a source resistance plus a drive-current limit, so a gate output sags under load and a bare LED or a short to ground draws a bounded current instead of amps. Truth tables are trustworthy. Propagation delay is gated for the plain gates, the flip-flop and the shift registers: the 74HC00, 04, 08, 32 and 86 land within 25 percent of the datasheet-typical value (measured from the input's mid-rail crossing, they read 1 to 2 ns above it, because the input stage switches at 30 and 70 percent of the rail), the 74HC74, 74HC164 and 74HC595 clock-to-output delays land within 15 percent, and the CD4011 lands within 10 percent. One thing is not modeled to the datasheet: the Schmitt-trigger inverters (74HC14, CD40106) are modeled with no propagation delay at all, by design. The output stage is a typical-value approximation: it does not model the difference between source and sink strength, temperature, or the exact shape of the datasheet output curves.

**The NE555 timer.** The bundled 555 is a behavioral subcircuit from the datasheet block diagram. Oscillation frequency matches the RC formula within 3 percent and duty cycle within 2 percentage points. For R1 = 1 kΩ, R2 = 10 kΩ, C = 100 nF the model measures 1.6 percent on the period at both 5 V and 12 V, and 0.8 points on the duty cycle.

**Relative comparisons.** "If I drop R1 from 10 k to 4.7 k, does the output roughly double?" For a circuit built entirely from resolved, well-modeled parts, circsim answers that reliably. (The reliability stops exactly where a stubbed part, a saturating behavioral model, or a convergence-fallback caveat enters the loop: see below.)

## What circsim CANNOT reliably tell you (and why)

### Behavioral models, not transistor-level physics

Most ICs in circsim (op-amps, the 555, regulators) are **behavioral macromodels**. They reproduce the terminal behavior (gain, bandwidth, saturation voltages) without modeling the internal transistors. That means:

- Op-amp slew rate and gain-bandwidth come from datasheet numbers: the LM358 and TL072 slew rates, and the LM358 small-signal rise time (0.35 divided by the gain-bandwidth product), land within 5 percent of the library values. High-frequency parasitic behavior is approximate.
- **Supply pins carry the load.** An op-amp, the 555, a linear regulator, or a logic gate draws the current its output delivers, plus the datasheet quiescent current, from its supply pin. So a bench supply's series resistance, a reverse-protection diode, a polyfuse, or the rail copper sees the real load, and a current probe on the supply reads it. Measured: a 10 Ω resistor in an LM358's supply lead drops 207 mV with 20 mA of load; a 5 V 555 driving 100 Ω draws its load current plus its quiescent current to within 2 percent; a regulator draws at least its load current plus its quiescent current. The quiescent current itself lands inside the datasheet's minimum-to-maximum band for the op-amps, comparators, regulators and 555.
- **Saturation recovers on the datasheet clock.** An op-amp driven into a rail leaves it as soon as its input reverses, limited by its slew rate (a saturated LM358 comparator crosses mid-supply about 9 µs after its input crosses, not as long as it spent saturated). Its output low level meets the datasheet figure (an LM358 pulling down a 10 kΩ pull-up to 5 V reads about 17 mV, inside the datasheet's 20 mV maximum).
- **A latch rests on a rail.** An op-amp with positive feedback (a Schmitt trigger) whose input sits inside its hysteresis band reads at its power-up state, output low, rather than at the unstable point between the rails. See [Energize](../guides/energize#read-it-honestly).
- **Dropout follows the load.** A linear regulator's dropout is the datasheet's light-load figure at light load and rises to the rated-load figure at full current (AMS1117: about 1.0 V at 100 mA, 1.2 V at 1 A; 7805 and 7812: about 1.5 V and 2.0 V; 7833: about 1.3 V and 1.7 V), interpolated in a straight line between the two; the modeled figures sit within 0.1 V of these (0.05 V for the AMS1117). An AMS1117-3.3 fed from a 4.2 V Li-ion cell at 90 mA reads about 3.2 V, to within 0.05 V.
- Thermal effects on bias current and offset are not modeled.
- Power-supply and common-mode rejection (PSRR = power-supply rejection ratio, CMRR = common-mode rejection ratio: how well the part ignores noise on its supply and shifts in its input common-mode level) and output impedance differ from the real part.

A behavioral model is a good check. It is not the real chip.

### MCUs and complex ICs are stubs

Microcontrollers (ESP32, STM32, ATmega, RP2040, anything similar) have no SPICE model circsim can use, and **the firmware does not run.** circsim recognizes the common ones by name and stubs them automatically, so they never sit there as an unexplained red part: each becomes an amber **supply-load stub** that draws the family's datasheet supply current from its supply pad and does nothing else (see [supply-load stubs](./models#supply-load-stubs)). The rail sags and loads like the real board, which is what a power check needs; the chip's pins are not simulated. A controller circsim recognizes but has no supply figure for is stubbed as interactive pins with no load, and says so.

To play the part of the firmware, choose **Interactive pins** in the [Model Doctor](../guides/model-doctor#interactive-pins): you can then set each GPIO high, low, or Hi-Z and watch the rest of the circuit respond (the part then draws no supply current). That's enough to verify:

- "If GPIO5 goes high, does the LED turn on?"
- "Will the pull-up on this I²C line actually pull up?"

It is *not* enough to check timing relationships between firmware-driven signals and analog peripherals.

### Copper resistance and remaining parasitics

The solve API has an opt-in physical copper mode (`copperAware: true`). Power and ground tracks, vias, and pours become resistor networks in the same ngspice circuit as the parts. Each supply and return pad has its own solved voltage. The [Board Critic](./board-critic) does estimate copper resistance through this shared network and reads pad voltages and segment currents from that operating point. Signal nets retain ideal connectivity. The bench UI still uses the default ideal-net mode while its physical-mode controls are being added; copper IR-drop and ampacity require a physical solve.

Track resistance uses length, width, and an assumed 1 oz copper weight (35 µm), configurable through the solve options. A 5 cm, 0.25 mm trace on 1 oz copper is about 0.1 Ω. Via resistance assumes 20 µm barrel plating. Pours use an approximately 2 mm sheet-resistance mesh of their outlines; thermal-relief spokes, fill clearance islands, and keepouts are not extracted. Missing copper leaves pads disconnected, and a lead position selects its nearest physical pad; without a position the source pad is guessed.

circsim still does not model:

- **Trace inductance and signal-net resistance**: these matter for RF and fast edges.
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

## Where each claim is checked

Every number on this page is held by a test that fails when the model drifts from it. The row names below are datasheet rows in `resources/models/characterization.json`, run in real ngspice by `npm run test:characterization`; the file names are tests under `src/`. A claim with no test here is not a promise.

- **NE555 period and duty.** Rows `timer-ne555-period-5v`, `timer-ne555-period-12v` (3 percent) and `timer-ne555-duty` (2 points); also `library-ic.integration.test.ts`, which compares the period with 0.693 (R1 + 2 R2) C and the duty with (R1 + R2) / (R1 + 2 R2).
- **Logic propagation delay.** Rows `logic-74hc00-tpd-rise`, `logic-74hc00-tpd-fall`, `logic-74hc04-tpd-rise`, `logic-74hc04-tpd-fall`, `logic-74hc08-tpd-rise`, `logic-74hc08-tpd-fall`, `logic-74hc32-tpd-rise`, `logic-74hc32-tpd-fall`, `logic-74hc86-tpd-rise`, `logic-74hc86-tpd-fall` (25 percent), `logic-cd4011-tpd-rise`, `logic-cd4011-tpd-fall` (10 percent). Flip-flop and shift-register clock to output: `logic-74hc74-tpd-clk-q`, `logic-74hc164-tpd-clk-q0` and `logic-74hc595-tpd-stcp-q0` (15 percent). The zero-delay Schmitt gates are pinned by `logic-74hc14-tpd-rise`, `logic-74hc14-tpd-fall`, `logic-cd40106-tpd-rise` and `logic-cd40106-tpd-fall` (within 2 ns for the 74HC14, 5 ns for the CD40106).
- **Logic output stage.** Rows `logic-74hc00-voh-4ma`, `logic-cd4011-voh-drive`, `logic-74hc00-icc-loaded`, `logic-cd4011-icc-loaded`, and `logic-output-drive.integration.test.ts` for the bounded current into a bare LED and a short.
- **Op-amp slew, rise time, saturation.** Rows `opamp-lm358-slew`, `opamp-tl072-slew`, `opamp-lm358-risetime` (5 percent), `opamp-lm358-comparator-crossing` (10 percent), `opamp-lm358-vol` (14 to 20 mV), `opamp-lm358-voh`, `opamp-lm358-pole-node-bounded`.
- **Latches rest on a rail.** `bistable-settle.integration.test.ts`.
- **Supply pins carry the load.** Rows `opamp-lm358-supply-series-drop`, `opamp-lm358-icc-sourcing-40ma`, `timer-ne555-icc-loaded` (2 percent), `reg-7805-iin-1a`, `reg-7805-iin-100ma`, `reg-ams1117-3v3-iin-1a`; quiescent bands in `opamp-lm358-icc-quiescent`, `comparator-lm393-icc`, `reg-7805-iq`, `reg-ams1117-3v3-iq`, `timer-ne555-icc`.
- **Regulator dropout.** Rows `reg-7805-dropout-100ma`, `reg-7805-dropout-1a`, `reg-7812-dropout-100ma`, `reg-7812-dropout-1a`, `reg-7833-dropout-100ma`, `reg-7833-dropout-1a` (0.1 V), `reg-ams1117-3v3-dropout-100ma`, `reg-ams1117-3v3-dropout-1a`, `reg-ams1117-5v0-dropout-100ma`, `reg-ams1117-5v0-dropout-1a`, `reg-ams1117-3v3-liion-90ma` (0.05 V).
- **LED and diode forward voltage.** Rows `led-red-vf-10ma`, `led-green-vf-10ma`, `led-blue-vf-10ma`, `led-white-vf-10ma` (0.05 V), `led-red-vf-20ma`, `diode-1n4148-vf-5ma`, `diode-1n4001-vf-1a`, `diode-1n5819-vf-1a`, `schottky-ss54-vf-5a`.
- **DC operating point and RC waveforms.** `op.integration.test.ts` (a divider reads 2.5 V to 5 mV) and `transient.integration.test.ts` (an RC charge curve within 2 percent).
- **Undriven nets.** `generate.test.ts` (the 1 GΩ tie), `floating-supply-pin.integration.test.ts`, and `WarningsBar.test.tsx` (the "Undriven nets held at 0 V" note).
- **Fixed 27 °C.** `fidelity-claims.test.ts` checks that no generated deck carries a temperature card or sweep.
- **Trace resistance figure.** `geom.test.ts` (100 mm by 0.5 mm on 1 oz copper is 0.0966 Ω, the same 200 squares as the 5 cm by 0.25 mm trace quoted above) and `copper.integration.test.ts` for the shared physical solve. The pour-only corpus assertion checks that the fixture's pad voltages agree with Critic IR-drop.
- **Stubs and the fidelity banner.** `resolve.test.ts` (which parts are stubbed) and `WarningsBar.test.tsx` (the banner, its minimized badge, and its re-expansion when the affected set changes).
- **Convergence fallbacks.** `library-op-convergence.integration.test.ts`.

Statements about what is not modeled (parasitics, temperature drift, supply and common-mode rejection, firmware) are claims of absence and have no gate; they are listed so you can verify them by other means.

## Further reading

- [ngspice documentation](https://ngspice.sourceforge.io/docs.html): the engine behind circsim.
- Your part's datasheet: the real reference for behavioral limits.
- [KiCad's simulation docs](https://docs.kicad.org/): for the `Sim.*` schematic properties that give circsim higher-fidelity starting models.
- [Models & resolution](./models): how circsim decides what model each part gets.
