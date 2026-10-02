# Model library reference

circsim ships a built-in SPICE model library, written in-house from datasheet parameters (every model file carries a provenance header; nothing is copied from vendor libraries). The diode, LED, TVS and bipolar-transistor cards are derived from datasheet operating points (forward voltage at a stated current, gain at a stated collector current, transition frequency, capacitances) by a script checked into the repository (the Schottky, zener and LED cards added later are fitted by hand with that script's helper functions, and are held to the same test), and a CI test fails if any of them reproduces a known third-party library card. The datasheet figures are transcribed from the datasheet families and have not yet been re-verified against vendor PDFs row by row. This page lists what's bundled so you can tell at a glance whether a part on your board will resolve automatically.

For *how* a part gets matched to one of these, see [Models & resolution](../concepts/models). To add a part that isn't here, see [Fix an unresolved part](../guides/model-doctor).

::: tip Modeling kind matters
- **Primitive** models (diodes, LEDs, BJTs, discrete MOSFETs) are real device-physics `.model` cards, the most trustworthy.
- **Behavioral** models (op-amps, 555, regulators, power ICs) reproduce terminal behavior, not internal transistors. Good checks, not the real chip. See [fidelity](../concepts/fidelity).
:::

## Diodes: primitive

Two-terminal, anode = pin 1, cathode = pin 2. Zeners are modeled as silicon diodes with a reverse-breakdown voltage. The TVS is a small two-branch subcircuit: a forward diode and a separate reverse clamp, so its forward drop (about 1 V at 1 A) does not inherit the clamp slope.

| Part | Matches (examples) | Notes |
| --- | --- | --- |
| 1N4148 | 1N4148, 1N914, 1N4148W/WS, BAS16/BAS16W | small-signal, Vf ≈ 0.67 V @ 5 mA, 0.9 V @ 100 mA |
| 1N4001 | 1N4001-1N4007 | 1 A / 50 V rectifier |
| 1N5819 | 1N5819, 1N5817/18, SB5819, B5819W, **SS14** | Schottky 1 A / 40 V |
| SS54 | SS54, SS52, SS56, SB540 | 5 A / 40 V Schottky (MPN only) |
| SS34 | SS34, SS33, SS32, SK34, B340A/B | 3 A / 40 V-class Schottky, Vf ≈ 0.45 V @ 3 A (MPN only) |
| 1N5822 | 1N5822, 1N5821, 1N5820, SB340, MBR340 | 3 A / 40 V Schottky rectifier, Vf ≈ 0.47 V @ 3 A (MPN only) |
| Zener 5.1 V | BZX55C5V1, BZX84C5V1, 1N4733A, "5V1" | Vz 5.1 V @ 5 mA |
| Zener 3.0 V | BZX84C3V0, "3V0" | Vz 3.0 V @ 1 mA |
| Zener 3.3 V | BZX55C3V3, BZX84C3V3, 1N4728A | Vz 3.3 V @ 5 mA (part numbers only: a bare "3V3" is usually a rail name) |
| Zener 12 V | BZX55C12, BZX84C12, 1N4742A | Vz 12 V @ 5 mA (part numbers only) |
| TVS SMAJ24A | SMAJ24A | 24 V unidirectional (MPN only) |

## LEDs: primitive

Matched by value (the word "LED" plus a color, such as `Green`, `LED_green` or `Green LED`). Forward voltage is fitted per color to the middle of the typical datasheet band at 20 mA, and checked at 10 mA and 20 mA by the characterization suite. An LED on an `LED_*` footprint whose value is not one of these colors (`Amber`, `LED 0805`) resolves to the generic LED with a fallback warning. LEDs get a current sense that drives their [3D glow](../guides/energize).

| Part | Matches | Vf at 20 mA (10 mA) |
| --- | --- | --- |
| Red LED | LED, "red" | 1.90 V (1.85 V) |
| Green LED | "green" | 2.15 V (2.09 V) |
| Blue LED | "blue" | 3.10 V (3.00 V) |
| White LED | "white" | 3.20 V (3.09 V) |
| Yellow LED | "yellow" | 2.10 V (2.04 V) |
| Orange LED | "orange" | 2.00 V (1.95 V) |

## Bipolar transistors (BJTs): primitive

Gummel-Poon models. Terminal order: collector = 1, base = 2, emitter = 3 (pin maps handle SOT-23 / TO-92 conventions).

| Part | Matches (examples) | Type |
| --- | --- | --- |
| 2N2222 | 2N2222(A), PN2222(A), MMBT2222(A) | NPN |
| 2N3904 | 2N3904, MMBT3904, PZT3904 | NPN |
| 2N3906 | 2N3906, MMBT3906, PZT3906 | PNP |
| BC547 | BC547(A/B/C), BC847, MMBT5551 ⚠️ | NPN |
| BC557 | BC557(A/B/C), BC857 | PNP |

::: warning Approximate alias: MMBT5551
The BC547 card is fitted to BC547B parameters; BC847 is genuinely the SMD BC547. **MMBT5551** (SMD 2N5551) is a ~160 V high-voltage transistor with a different gain curve and fT, matched here only as a rough stand-in, not a true equivalent. If your circuit relies on the 2N5551's actual voltage headroom or gain, don't trust this model: [import the real one](../guides/model-doctor#import-a-lib).
:::

## MOSFETs: primitive (VDMOS)

Terminal order: drain = 1, gate = 2, source = 3 (bulk tied to source). The power parts (IRLZ44N, IRF540N, IRF3205, IRF9540N) are matched by part number only, and their TO-220 / TO-247 / D2PAK / DPAK pin map is gate = pad 1, drain = pad 2, source = pad 3; Rds(on) is fitted to the stated datasheet points (0.9 x the maximum).

| Part | Matches (examples) | Channel |
| --- | --- | --- |
| 2N7002 | 2N7002(K/E), BSS138 | N |
| AO3400 | AO3400(A), SI2302, DMN2075U | N (low Rds) |
| PMOS generic | DMP2305U, SI2301, BSS84 ⚠️ | P |
| AO3401 | AO3401(A) | P |
| NCE4012S | NCE4012S | N (power) |
| NCE6005AS | NCE6005AS | dual N (subckt) |
| IRLZ44N | IRLZ44N(PBF), IRLZ44NS | N, logic-level 55 V, 22 mohm @ 10 V |
| IRF540N | IRF540N(PBF), IRF540NS | N, 100 V, 44 mohm max @ 10 V |
| IRF3205 | IRF3205(PBF), IRF3205S | N, 55 V, 8 mohm max @ 10 V |
| IRF9540N | IRF9540N(PBF), IRF9540NS | P, 100 V, 117 mohm max @ -10 V |
| IRLML6402 | IRLML6402(TRPBF) | P, logic-level 20 V (SOT-23), 65 mohm max @ -4.5 V |

::: warning "PMOS generic" is a wide bucket
This one card covers a big range: DMP2305U and SI2301 are amp-class load switches, while **BSS84** is a ~130 mA small-signal part. The card's on-resistance is tuned toward the higher-current members, so treat BSS84's numbers (and any current-sensitive result) as rough. When Rds(on) or current capability actually matters, [import the specific part's model](../guides/model-doctor#import-a-lib). (AO3401 got its own dedicated card precisely because the generic bucket was too coarse for it.)
:::

## Op-amps & comparators: behavioral

Model one channel (e.g. channel A of a dual/quad) at the pinned pads, except the MCP6002 and NE5532, which model both channels. Node order: `in+ in− out V+ V−`.

| Part | Matches (examples) | Character |
| --- | --- | --- |
| LM358 | LM358(A/N/D), LM2904 | dual, single-supply, GBW 1.1 MHz |
| LM324 | LM324(A/N/D), LM2902 | quad |
| TL072 | TL072/071/082 | JFET-input, GBW 3 MHz |
| LM393 | LM393(A/D/N), LM2903 | comparator, **open-collector** (needs external pull-up) |
| LM339 | LM339(D/N), LM2901 | quad comparator (MPN only) |
| MCP6001 | MCP6001 (SOT-23-5 / SC-70-5) | single rail-to-rail, GBW 1 MHz, 100 uA (the MCP6001R/U variants swap pins and are not matched) |
| MCP6002 | MCP6002 | **dual** rail-to-rail, both channels modeled |
| NE5532 | NE5532(P/D/N) | **dual** low-noise audio, GBW 10 MHz, SR 9 V/us, both channels modeled |
| LM741 | LM741(C/CN), UA741 | single general-purpose, GBW 1 MHz, 1.7 mA |

## NE555 timer: behavioral

| Part | Matches | Notes |
| --- | --- | --- |
| NE555 | NE555(P/N), LM555, TLC555, ICM7555, "555" | From the datasheet block diagram; period within 3 percent and duty within 2 points of the RC formula (see [fidelity](../concepts/fidelity#where-each-claim-is-checked)) |

## Regulators & references: behavioral

| Part | Matches (examples) | Output |
| --- | --- | --- |
| 7805 | 7805, LM7805, L7805, 78M05 | 5 V |
| 7812 | 7812, LM7812, 78M12 | 12 V |
| 7833 | 7833, 78M33 | 3.3 V |
| AMS1117-3.3 | AMS1117-3.3 / -3V3 | 3.3 V LDO |
| AMS1117-5.0 | AMS1117-5.0 / -5V0 | 5 V LDO |
| TL431 | TL431(A), TL432, AZ431 | 2.495 V shunt reference (MPN only) |
| LM317 | LM317(T/AT), LM317MDT | adjustable, 1.25 V between OUT and ADJ, 50 uA ADJ current, 1.5 A (MPN only) |
| AP2112K-3.3 | AP2112K-3.3, AP2112K | 3.3 V / 600 mA LDO with enable, 250 mV dropout |
| MCP1700-3302 | MCP1700-3302E | 3.3 V / 250 mA LDO, 1.6 uA quiescent (SOT-23 pinout trusted) |
| XC6206-3.3 | XC6206P332MR | 3.3 V / 200 mA LDO, 1 uA quiescent (Torex part numbers only) |

## Power-management ICs: simplified behavioral stubs

These are deliberately simplified operating-point stubs: they model a single steady state, not switching or protection dynamics. Each documents its own simplifications.

| Part | Matches | Models | Does **not** model |
| --- | --- | --- | --- |
| BQ7791502 | BQ7791502/500/503/505, BQ77915 | normal mode; CHG/DSG held at VDD | protection trips, balancing, current sensing |
| LTC4020 | LTC4020 | idle/off; 5 V INTVCC LDO | switching, charging |
| AL8860 | AL8860 | DC-averaged constant-current sink | switching ripple |
| TP4056 | TP4056, TP4056-42-ESOP8 | 1 A CC/CV Li-ion charge: Ibat = 1200 x 1.0 V / Rprog, 4.2 V float, trickle below 2.9 V, open-drain CHRG and STDBY | TEMP input, thermal foldback, charge timer, recharge hysteresis |

## Digital logic: behavioral (XSPICE)

Correct truth tables with datasheet-typical thresholds. The plain gates carry datasheet-typical propagation delays; the Schmitt-trigger parts carry true hysteresis (so RC astables built around them oscillate) but no propagation delay, and the flip-flops and shift registers carry the datasheet-typical clock-to-output delay once (clock, preset and clear to output each take the part's delay; see [fidelity](../concepts/fidelity)). Outputs are not ideal: each gate drives its pin through a source resistance and a drive-current limit (74HC about 40 ohm and 25 mA at 5 V, CD4000 about 400 ohm and 3 mA at 5 V, scaled with the rail), so an unbuffered LED or a heavy load pulls the pin down. Asynchronous controls (`PRE_N`, `CLR_N`, `MR_N`) are active low. All match by part number.

**74HC family** (default rail 5 V): `74HC00` NAND, `74HC02` NOR, `74HC04` inverter, `74HC08` AND, `74HC10` triple 3-input NAND, `74HC14` Schmitt inverter, `74HC20` dual 4-input NAND, `74HC32` OR, `74HC74` dual D flip-flop, `74HC86` XOR, `74HC164` shift register, `74HC595` shift register + latch. Accepts 74HCT / SN74HC / 74LS aliases.

**CD4000 family** (default rail 12 V): `CD40106` hex Schmitt inverter, `CD4011` quad NAND. Accepts CD4011B, HEF4011, MC14011, etc.

::: warning CD4000 rail voltage
CD4000 parts model their outputs at the 12 V family default *unless* circsim can sense the real rail from a supply on the VDD net or you override it. If your CMOS logic runs at 5 V, either put a supply directly on its VDD net or set the rail manually. Otherwise logic thresholds will be off. See [rail sensing](./architecture#rail-sensing).
:::

## Optocouplers: behavioral

An input LED, a transistor, and a current-controlled current source: the collector current is the current transfer ratio (CTR) times the LED current until the transistor saturates. The two sides share no node, so the part stays galvanically isolated. The CTR is a constant: no dependence on LED current, collector voltage, temperature or age, and no response-time limit beyond the junction capacitances.

| Part | Matches | LED / output |
| --- | --- | --- |
| PC817 | PC817(A-D), EL817, LTV-817 | VF 1.2 V @ 20 mA; CTR 170 percent (the datasheet window is 50 to 600 percent, so design for 50) |
| 4N35 | 4N35, 4N36, 4N37, CNY17-3, MOC8050 | VF 1.15 V @ 10 mA; CTR 100 percent (the datasheet minimum); base pin not modeled |

## Automatic stubs: supply loads for controllers and similar parts {#automatic-stubs}

These parts have no simulable model. Rather than leave them red, circsim stubs them by name (MPN property, BOM MPN, value or footprint) as a two-terminal **supply load**: the figure below is drawn from the supply pad to the ground pad once the rail is above the minimum operating voltage, and nothing else happens. They are matched after the library and your own models, so a real model always wins. A library entry chosen only because a part has an IC refdes and a generic package (a SOIC-8 or SOIC-14) does not count as a model for these parts: an ATtiny85 in a DIP-8 or an ATtiny84 in a SOIC-14 is stubbed, not given an op-amp. The status is **stubbed** (amber). How the pads are chosen and what the stub does and does not do is on the [Models page](../concepts/models#supply-load-stubs).

| Family | Matches | Load | Datasheet condition |
| --- | --- | --- | --- |
| ESP32 | ESP32, -S2/-S3/-C3 chips and modules | 100 mA | Wi-Fi receive, 95 to 100 mA (transmit reaches 240 mA) |
| ESP8266 | ESP8266EX, ESP-01/07/12 | 60 mA | receive, 56 to 62 mA |
| STM32F1 | STM32F1xx, "Blue Pill" | 36 mA | Run mode, 72 MHz, all peripherals enabled, typical |
| STM32F4 | STM32F4xx | 100 mA | Run mode, 168 MHz, all peripherals enabled |
| STM32 low-power | STM32 C0, F0, G0, L0, L4 | 10 mA | Run mode, 48 to 80 MHz |
| ATmega | ATmega328P, 168, 32U4, 2560, Arduino Nano/Uno/Pro Mini | 10 mA | active, 16 MHz, 5 V |
| ATtiny | ATtiny85, 45, 25, 13, 84, 1614 | 5 mA | active, 8 MHz, 5 V |
| RP2040 | RP2040, Raspberry Pi Pico | 25 mA | both cores at 125 MHz |
| nRF52 | nRF52832, nRF52840 | 6 mA | radio receive, 1 Mbps BLE, DC/DC at 3 V |
| SAMD21 | ATSAMD21 | 6 mA | active, 48 MHz, 3.3 V |
| CH32V003 | CH32V003 | 8 mA | run mode, 48 MHz |
| MSP430 | MSP430G2xxx and kin | 230 uA | active, 1 MHz, 2.2 V |
| WS2812B | WS2812B/11/13, NeoPixel | 1 mA | **idle** (dark); the datasheet figure for a lit LED is 20 mA per colour, 60 mA at full white, so add that as a bench load if it matters |
| CH340 | CH340C, CH340G | 12 mA | operating, 5 V |

A part that looks like a controller (an STM32 of another series, a PIC, an LPC, a GD32, ...) but has no row here becomes **interactive pins** with no supply current, and its warning says so. The figures are transcribed from the datasheet families and are not yet re-verified against vendor PDFs row by row; each has a characterization row checked by `npm run test:characterization`.

## Documented opens: known, intentionally not modeled

These resolve to a grey "open by design" with a note, not a red "no model."

| Part | Matches | Why not modeled |
| --- | --- | --- |
| CH224K | CH224K | USB-PD negotiation has no SPICE analog; passive at a fixed bench supply |
| CD4538 | CD4538 | dual monostable needs edge-triggered events the digital family doesn't support yet |
| LM2596 | LM2596(S/T), -ADJ / -5.0 / -3.3 | a 150 kHz current-mode buck has no DC-averaged stand-in that stays stable for every inductor and capacitor |
| MT3608, XL6009 | MT3608(L), XL6009(E1) | boost converters, same reason |
| MP1584 | MP1584(EN) | buck converter, same reason |
| Crystals, resonators | a `Y` or `X` part on a `Crystal_` or `Resonator_` footprint, or a frequency value (`8MHz`) | the resonance matters only to the oscillator inside the controller model that does not exist; matched by name rules, not the library |

A switching converter left open has no output: drive its output rail from a bench supply to test the load.

## Not in the library?

That's expected. No bundled library covers every part. A part that doesn't match shows as red "no model" in the [Model Doctor](../guides/model-doctor), where you can import a `.lib`, generate one with an LLM and validate it, or stub it. Microcontrollers and complex digital ICs won't ever have a bundled model: the common ones are stubbed automatically as a supply load (see [Automatic stubs](#automatic-stubs)), and you can drive their pins as [interactive pins](../concepts/models#stubs-and-interactive-pins) instead.
