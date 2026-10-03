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

The solve API has an opt-in physical copper mode (`copperAware: true`). Tracks, vias, pours and netted copper graphics on all nets, including signals, become resistor networks in the same ngspice circuit as the parts. Pads on one net can have different solved voltages. The [Board Critic](./board-critic) does estimate copper resistance through this shared network and reads pad voltages and segment currents from the full operating-point network; its rail checks still distinguish power and ground from signal nets. Ideal nets remain the default, and their generated decks are unchanged.

Track resistance uses length, width, and an assumed 1 oz copper weight (35 µm), configurable through the solve options. A 5 cm, 0.25 mm trace on 1 oz copper is about 0.1 Ω. Via resistance assumes 20 µm barrel plating. Pours use an approximately 2 mm sheet-resistance mesh of their outlines, refined when a pad's thin copper feature would otherwise be omitted and coarsened to a cell budget. Touching pour items connect through resistive links whose entire path lies in their copper union. Thermal-relief spokes, fill clearance islands, and keepouts are not extracted. Missing copper leaves pads disconnected, and a lead position selects its nearest physical pad; without a position the source pad is guessed.

The network and solve result expose pads without copper contacts or a path from the supply entry, and the Critic names them even at zero current. A failed solve retains that geometry but supplies no electrical readings. A transient-fallback result is labelled as a bias snapshot rather than a converged DC operating point. Connected idle parts can have known zero dissipation; missing model terminals or physically unpowered parts remain not assessed for power.

For a transient, circsim eliminates internal resistor nodes with Kron reduction and keeps the pad terminals. This preserves the mesh's terminal resistance while reducing what ngspice solves at each step. It does not add inductance, capacitance or a more detailed copper geometry model. Full and reduced native operating points agree within 0.1 µV at every tested pad and 1 µA on reconstructed segment currents on the pour-only fixture and a lantern-shaped synthetic board. The connectivity gate checks 950 multi-pad nets across 24 corpus, sample and synthetic boards. It skips and counts 546 single-pad nets, which need no route between terminals; 12 pad gaps on tiny-tapeout and the dialect probes have independent KiCad DRC evidence in the corpus baseline.

The earlier fixed-step measurements below used Windows native ngspice, one fresh process per board and mode, three warmups then 15 runs. Each run simulated 0.1 s with a requested 100 µs step. The medians include solving and reading saved vectors; cost per saved time point is not the cost of an internal adaptive solver step. These measurements exclude deck construction, reduction setup and live rendering.

- **Bundled 555:** ideal 23.29 ms, full copper 26.48 ms, reduced copper 26.32 ms. Copper nodes: 27 full, 20 reduced.
- **Lantern-shaped synthetic:** ideal 4.99 ms, full copper 4,241.13 ms, reduced copper 669.04 ms. Copper nodes: 1,733 full, 90 reduced.

Per saved time point, the medians are 22.92 / 26.19 / 26.03 µs for the 555 and 4.94 / 4,194.98 / 661.76 µs for the lantern (ideal / full / reduced). The lantern has 1,011 saved time points in every mode; the 555 has 1,016 ideal and 1,011 physical. Reduction was about 6.3 times faster than the full lantern mesh, with the reduced physical solve about 7 times slower than real time and about 130 times the ideal deck's cost at that fixed step.

The live bench uses 5 ms only as an upper bound. Literal SIN/PULSE source periods, including SPICE engineering suffixes, lower the bound to period/200. Explicit timing and feedback capacitors lower it to 1/10 of an RC estimate from their attached part resistors, with a 10 us floor on this RC-derived bound: recognised nodes include timer TRIG/THRES pins, analog model input ports, voltage-expression inputs and ADC bridge inputs. A floating capacitor uses the sum of its two terminal resistances; ground and recognised power rails act as AC ground for the estimate. Copper connections are grouped as wire for this estimate; recognised model power rails and generated bench supply rails identify bypass capacitors, which remain under ngspice error control and source breakpoints. Passive RC decks use their unforced capacitor nodes. Discrete BJT, MOSFET and JFET terminals are also recognised as signal nodes. This prevents the reviewed BJT astable from being skipped and flat-lining, but does not calibrate its nonlinear oscillation period: the deterministic test measured about 1.63 ms at the derived 480 us step versus 6.84 ms at an independent 1 us step. Its period needs an explicit 1 us comparison; the distortion is a separate investigation. The 10 us floor reuses the former bench cap to limit forced quiet-region work to 100,000 points per simulated second; faster poles remain under native LTE and breakpoints. Source-period bounds and explicit finer requests can still go below 10 us. The rule does not expand model-local poles, parameter expressions or unknown port roles. An oscillator built from parts the rule does not recognise can fall back to the 5 ms ceiling and native error control, so its timing needs a finer-step comparison. Native tests preserve nanosecond pulse edges and fast sine resolution, compare the 138 Hz 555 astable with an independent 100 us reference within 3 percent, and resolve a 1 ms RC charge with a 100 us maximum step. Finer explicit analysis steps remain finer.

Calibration used independent native analyses with explicit 1 us maximum steps. The fast 555 reference period was 7.2203 ms. The ideal feedback control settled rather than oscillating: its last crossing into a 100 mV band about its final value was 3.5052 ms. Crossing times were interpolated between samples; peak differences below are normalised to 5 V. RC/10 is the coarsest of the tested 10/20/50 factors that keeps both period and settling error below 2 percent. Coarser RC/2 distorted loop settling by 14.6 percent, and RC/1 by 80.7 percent.

- **RC/10 (chosen):** fast 555 step 470 us, period error 0.90 percent; ideal loop step 100 us, settling error 1.34 percent.
- **RC/20:** fast 555 step 235 us, period error 0.90 percent; ideal loop step 50 us, settling error 2.39 percent.
- **RC/50:** fast 555 step 94 us, period error 0.24 percent; ideal loop step 20 us, settling error 0.73 percent.

The loop peak-voltage difference was below 0.001 percent of 5 V in every row.

Live measurements include sample delivery and window restarts: a one-second warmup followed by three seconds at pace max. With the refined rule, the routed test decks have three distributed 100 nF capacitors across resistor pads. They exercise the active-deck skip path, rather than a rail-to-ground bypass; separate step-rule tests cover actual supply bypasses. The effective step is 5 ms and copper counts are unchanged (1,733 nodes / 3,368 resistors full; 90 / 1,980 reduced). An isolated Windows run reached 0.95x full and 7.11x reduced. An earlier concurrent two-suite run reached 0.58x full; full-mesh real time is not guaranteed. Full and ideal control plots use one-second windows to bound retained samples; reduced and physical 555 plots use 30 seconds.

Four-platform CI at W2.3 head 763d19c measured these factors. The ideal feedback control uses its calibrated 100 us step; the physical fixtures use 5 ms:

- **Windows:** ideal 1.12x; routed full 0.96x, reduced 6.23x; physical 555 156.91x.
- **macOS ARM:** ideal 0.89x; routed full 0.76x, reduced 6.08x; physical 555 135.99x.
- **Linux (coverage), retry:** ideal 0.87x; routed full 0.92x, reduced 5.11x; physical 555 108.67x. The loaded first attempt measured ideal 0.37x and failed the 0.6 CPU-ratio gate at 0.583; the unchanged retry passed at 0.94.
- **macOS Intel:** ideal 0.20x; routed full 0.27x, reduced 2.39x; physical 555 45.85x.

The original ideal lantern is a separate model/channel-cost control with a stated 0.20x to 1.12x CI limit. Its earlier roughly 60x figure at 5 ms was under-resolved and no longer applies. These are calibrated fixture observations, not an error bound for arbitrary circuits. Tests require at least 1x only for the reduced routed lantern and bundled physical 555, print effective steps and factors on every CI platform, and check the 0.6 live/bare CPU ratio for the 555 and ideal control. Larger or faster circuits can still fall below real time.

The 555 supply and return leads were placed directly on U1 pads 8 and 1. That sample is unrouted (#160), and its all-net physical network reports 16 pad gaps, so its physical run is not a validation of the ideal oscillator waveform. These are observations, not timing guarantees.

circsim still does not model:

- **Trace inductance**: this matters for RF and fast edges.
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

A rejected circuit cannot be simulated. Loading a valid circuit after a failed load or a fallback operating point starts with fresh solver state, so the earlier attempt cannot poison the next circuit. The convergence caveats still apply to the failed or fallback result itself.

## When to trust the results

::: tip Trust circsim for
- Bias points in audio and DC circuits
- RC filters, voltage dividers, simple amplifiers
- Spotting "the LED is always off because the base resistor is 10 MΩ" mistakes
- Oscillation frequency of the bundled astable timer when its timing RC is recognised; unfamiliar oscillators need a finer-step comparison
- Whether a linear regulator is in dropout (the dropout voltage follows the load, per the datasheet curves)
:::

::: warning Be cautious about circsim for
- RF above ~10 MHz
- Switching power supplies (simplified inductor/diode models)
- Circuits with significant temperature effects
- Anything where trace parasitics matter
- Timing margins tighter than about 10 times the effective maximum step, or oscillator dynamics the step rule does not recognise
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
- **Trace resistance figure.** `geom.test.ts` (100 mm by 0.5 mm on 1 oz copper is 0.0966 Ω, the same 200 squares as the 5 cm by 0.25 mm trace quoted above) and `copper.integration.test.ts` for the shared physical solve. The pour-only corpus assertion checks that the fixture's pad voltages agree with Critic IR-drop. `kron.integration.test.ts` checks full/reduced pad voltage and segment-current equivalence; the all-net connectivity test in `npm run test:corpus` checks routing with KiCad-confirmed gap evidence; `measurements.test.ts` supplies the opt-in transient measurements above.
- **Stubs and the fidelity banner.** `resolve.test.ts` (which parts are stubbed) and `WarningsBar.test.tsx` (the banner, its minimized badge, and its re-expansion when the affected set changes).
- **Convergence fallbacks.** `library-op-convergence.integration.test.ts`.

Statements about what is not modeled (parasitics, temperature drift, supply and common-mode rejection, firmware) are claims of absence and have no gate; they are listed so you can verify them by other means.

## Further reading

- [ngspice documentation](https://ngspice.sourceforge.io/docs.html): the engine behind circsim.
- Your part's datasheet: the real reference for behavioral limits.
- [KiCad's simulation docs](https://docs.kicad.org/): for the `Sim.*` schematic properties that give circsim higher-fidelity starting models.
- [Models & resolution](./models): how circsim decides what model each part gets.
