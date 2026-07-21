# Model library reference

circsim ships a built-in SPICE model library, written in-house from datasheet parameters (every model file carries a provenance header; nothing is copied from vendor libraries). This page lists what's bundled so you can tell at a glance whether a part on your board will resolve automatically.

For *how* a part gets matched to one of these, see [Models & resolution](../concepts/models). To add a part that isn't here, see [Fix an unresolved part](../guides/model-doctor).

::: tip Modeling kind matters
- **Primitive** models (diodes, LEDs, BJTs, discrete MOSFETs) are real device-physics `.model` cards — the most trustworthy.
- **Behavioral** models (op-amps, 555, regulators, power ICs) reproduce terminal behavior, not internal transistors. Good checks, not the real chip. See [fidelity](../concepts/fidelity).
:::

## Diodes — primitive

Two-terminal, anode = pin 1, cathode = pin 2. Zeners and the TVS are modeled as silicon diodes with a reverse-breakdown voltage.

| Part | Matches (examples) | Notes |
| --- | --- | --- |
| 1N4148 | 1N4148, 1N914, 1N4148W/WS, BAS16/BAS16W | small-signal, Vf ≈ 0.72 V @ 5 mA |
| 1N4001 | 1N4001–1N4007 | 1 A / 50 V rectifier |
| 1N5819 | 1N5819, 1N5817/18, SB5819, B5819W, **SS14** | Schottky 1 A / 40 V |
| SS54 | SS54, SS52, SS56, SB540 | 5 A / 40 V Schottky (MPN only) |
| Zener 5.1 V | BZX55C5V1, BZX84C5V1, 1N4733A, "5V1" | Vz 5.1 V @ 5 mA |
| Zener 3.0 V | BZX84C3V0, "3V0" | Vz 3.0 V @ 1 mA |
| TVS SMAJ24A | SMAJ24A | 24 V unidirectional (MPN only) |

## LEDs — primitive

Matched by value (the word "LED" plus a color). Forward voltage is tuned per color. LEDs get a current sense that drives their [3D glow](../guides/energize).

| Part | Matches | Approx. Vf character |
| --- | --- | --- |
| Red LED | LED, "red" | lowest Vf |
| Green LED | "green" | |
| Blue LED | "blue" | |
| White LED | "white" | highest Vf |

## Bipolar transistors (BJTs) — primitive

Gummel-Poon models. Terminal order: collector = 1, base = 2, emitter = 3 (pin maps handle SOT-23 / TO-92 conventions).

| Part | Matches (examples) | Type |
| --- | --- | --- |
| 2N2222 | 2N2222(A), PN2222(A), MMBT2222(A) | NPN |
| 2N3904 | 2N3904, MMBT3904, PZT3904 | NPN |
| 2N3906 | 2N3906, MMBT3906, PZT3906 | PNP |
| BC547 | BC547(A/B/C), BC847, MMBT5551 ⚠️ | NPN |
| BC557 | BC557(A/B/C), BC857 | PNP |

::: warning Approximate alias: MMBT5551
The BC547 card is fitted to BC547B parameters; BC847 is genuinely the SMD BC547. **MMBT5551** (SMD 2N5551) is *not* an equivalent — it's a ~160 V high-voltage transistor with a different gain curve and fT, matched here only as a rough stand-in. If your circuit relies on the 2N5551's actual voltage headroom or gain, don't trust this model — [import the real one](../guides/model-doctor#import-a-lib).
:::

## MOSFETs — primitive (VDMOS)

Terminal order: drain = 1, gate = 2, source = 3 (bulk tied to source).

| Part | Matches (examples) | Channel |
| --- | --- | --- |
| 2N7002 | 2N7002(K/E), BSS138 | N |
| AO3400 | AO3400(A), SI2302, DMN2075U | N (low Rds) |
| PMOS generic | DMP2305U, SI2301, BSS84 ⚠️ | P |
| AO3401 | AO3401(A) | P |

::: warning "PMOS generic" is a wide bucket
This one card covers a big range: DMP2305U and SI2301 are amp-class load switches, while **BSS84** is a ~130 mA small-signal part. The card's on-resistance is tuned toward the higher-current members, so treat BSS84's numbers (and any current-sensitive result) as rough. When Rds(on) or current capability actually matters, [import the specific part's model](../guides/model-doctor#import-a-lib). (AO3401 got its own dedicated card precisely because the generic bucket was too coarse for it.)
:::
| NCE4012S | NCE4012S | N (power) |
| NCE6005AS | NCE6005AS | dual N (subckt) |

## Op-amps & comparators — behavioral

Model one channel (e.g. channel A of a dual/quad) at the pinned pads. Node order: `in+ in− out V+ V−`.

| Part | Matches (examples) | Character |
| --- | --- | --- |
| LM358 | LM358(A/N/D), LM2904 | dual, single-supply, GBW 1.1 MHz |
| LM324 | LM324(A/N/D), LM2902 | quad |
| TL072 | TL072/071/082 | JFET-input, GBW 3 MHz |
| LM393 | LM393(A/D/N), LM2903 | comparator, **open-collector** (needs external pull-up) |
| LM339 | LM339(D/N), LM2901 | quad comparator (MPN only) |

## NE555 timer — behavioral

| Part | Matches | Notes |
| --- | --- | --- |
| NE555 | NE555(P/N), LM555, TLC555, ICM7555, "555" | From the datasheet block diagram; frequency & duty within a few percent of the RC formula |

## Regulators & references — behavioral

| Part | Matches (examples) | Output |
| --- | --- | --- |
| 7805 | 7805, LM7805, L7805, 78M05 | 5 V |
| 7812 | 7812, LM7812, 78M12 | 12 V |
| 7833 | 7833, 78M33 | 3.3 V |
| AMS1117-3.3 | AMS1117-3.3 / -3V3 | 3.3 V LDO |
| AMS1117-5.0 | AMS1117-5.0 / -5V0 | 5 V LDO |
| TL431 | TL431(A), TL432, AZ431 | 2.495 V shunt reference (MPN only) |

## Power-management ICs — simplified behavioral stubs

These are deliberately simplified operating-point stubs — they model a single steady state, not switching or protection dynamics. Each documents its own simplifications.

| Part | Matches | Models | Does **not** model |
| --- | --- | --- | --- |
| BQ7791502 | BQ7791502/500/503/505, BQ77915 | normal mode; CHG/DSG held at VDD | protection trips, balancing, current sensing |
| LTC4020 | LTC4020 | idle/off; 5 V INTVCC LDO | switching, charging |
| AL8860 | AL8860 | DC-averaged constant-current sink | switching ripple |

## Digital logic — behavioral (XSPICE)

Correct truth tables with datasheet-typical thresholds. Schmitt-trigger parts carry true hysteresis, so RC astables built around them oscillate. All match by part number.

**74HC family** (default rail 5 V): `74HC00` NAND, `74HC04` inverter, `74HC08` AND, `74HC14` Schmitt inverter, `74HC32` OR, `74HC74` dual D flip-flop, `74HC86` XOR, `74HC164` shift register, `74HC595` shift register + latch. Accepts 74HCT / SN74HC / 74LS aliases.

**CD4000 family** (default rail 12 V): `CD40106` hex Schmitt inverter, `CD4011` quad NAND. Accepts CD4011B, HEF4011, MC14011, etc.

::: warning CD4000 rail voltage
CD4000 parts model their outputs at the 12 V family default *unless* circsim can sense the real rail from a supply on the VDD net or you override it. If your CMOS logic runs at 5 V, either put a supply directly on its VDD net or set the rail manually — otherwise logic thresholds will be off. See [rail sensing](./architecture#rail-sensing).
:::

## Documented opens — known, intentionally not modeled

These resolve to a grey "open by design" with a note, not a red "no model."

| Part | Matches | Why not modeled |
| --- | --- | --- |
| CH224K | CH224K | USB-PD negotiation has no SPICE analog; passive at a fixed bench supply |
| CD4538 | CD4538 | dual monostable needs edge-triggered events the digital family doesn't support yet |

## Not in the library?

That's expected — no bundled library covers every part. A part that doesn't match shows as red "no model" in the [Model Doctor](../guides/model-doctor), where you can import a `.lib`, generate one with an LLM and validate it, or stub it. Microcontrollers and complex digital ICs won't ever have a bundled model — drive them as [interactive pins](../concepts/models#stubs-and-interactive-pins) instead.
