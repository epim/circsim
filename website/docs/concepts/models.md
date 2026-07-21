# Models & resolution

To simulate a part, circsim needs a SPICE model for it. This page explains how a part on your board gets matched to a model, what the different "kinds" of model mean, and — just as importantly — what happens when no model fits.

If you just want to *fix* an unresolved part, jump to the [Model Doctor guide](../guides/model-doctor). This page is the concept behind it.

## How a part finds its model

circsim resolves every part through a **tiered pipeline**. The first tier that produces a confident match wins, and circsim records which tier it used so you can see how it decided.

1. **Your Model Doctor overrides** win over everything. If you've stubbed a part, imported a model for it, or hand-edited its pin map, that's final.
2. **Schematic `Sim.*` fields** — if a matching `.kicad_sch` gives a part explicit KiCad simulation fields, circsim uses them. This is the highest-fidelity automatic source.
3. **Primitive inference** — a reference starting with `R`, `C`, or `L` plus a parseable value becomes a resistor, capacitor, or inductor directly. (Values like `DNP`, `N/A`, or `TBD` are treated as "not fitted" and stubbed open.)
4. **The bundled model library** — the main path. circsim matches the part against its [built-in library](../reference/model-library) of diodes, LEDs, transistors, op-amps, the 555, logic, regulators, and more.
5. **Your imported `.lib`/`.sub` files** — models you [import through the Model Doctor](../guides/model-doctor#import-a-lib) are prepended to the library, so your model for a given part number beats the bundled one.
6. **Stub fallback** — anything still unmatched is flagged for you (red "no model," or a documented "open by design").

### Matching against the library

Within the bundled library, circsim tries three things in order and stops at the first that yields **exactly one** match:

- **By manufacturer part number.** The MPN (from a BOM, a board property, or the value field) is normalized — uppercased, with package and reel suffixes stripped (`-TR`, `DBV`, reel codes) but guarded so it never eats real part-number digits: `2N3904` stays `2N3904`. This is the most reliable match.
- **By value pattern.** Some parts are recognized by their value field — an LED color, `NE555`, `3.0V` for a zener.
- **By refdes prefix + footprint.** A last-resort fallback. Many library entries deliberately *skip* this tier to avoid false positives — a generic "U-prefixed 14-pin chip" rule once misidentified a CD4011 as an op-amp, so parts like the LM339 and CD4011 match by part number only.

If two entries match at the same tier, circsim does **not** guess — it marks the part *ambiguous* and asks you to pin it down with an MPN. Silence beats a coin-flip.

## The kinds of model

Not all models are equal, and circsim is explicit about which kind each part gets — because it changes how much you should trust the result.

### Primitive-level models

Diodes, LEDs, bipolar transistors, and discrete MOSFETs are modeled as **ngspice primitives** — real `.model` cards with device physics parameters (saturation current, forward voltage, Gummel-Poon betas, VDMOS thresholds) fitted from datasheets. These are as good as SPICE gets at the hobbyist level.

### Behavioral macromodels

Op-amps, comparators, the NE555, linear regulators, the TL431 reference, and a few power-management ICs are **behavioral subcircuits**. They reproduce the part's terminal behavior — gain, bandwidth, slew rate, saturation voltages, current limit — without simulating the internal transistors. A behavioral op-amp will clip at the right rail and slew at the right rate, but its high-frequency and thermal quirks are approximate. Good enough to catch design mistakes; not a substitute for the real chip. See [fidelity](./fidelity).

Some behavioral models are deliberately *simplified operating-point stubs* — a battery-protection IC modeled in its normal (non-tripped) state, a switching LED driver modeled as its DC-average current sink. circsim documents exactly what each one does and doesn't capture.

### Digital logic

The 74HC and CD4000 logic families are **XSPICE behavioral digital** — the gate does the right truth table with datasheet-typical thresholds and delays, bridged into the analog simulation. Schmitt-trigger parts (the 74HC14, CD40106) carry true hysteresis, so an RC astable built around one actually oscillates.

## Stubs and interactive pins {#stubs-and-interactive-pins}

Some parts *can't* be modeled, and circsim represents them honestly rather than faking it.

- **Open stub** — the part's pins are left electrically open. Right for a part that isn't fitted, or one you want to remove from the simulation.
- **Short stub** — the pins are tied together. Useful for modeling a jumper, a fitted zero-ohm, or a closed switch.
- **Interactive pins** — the model for microcontrollers and other complex digital ICs. There's no SPICE model and **the firmware does not run**. Instead, each pin becomes a control you drive by hand: set it high, low, or high-impedance, or watch its voltage. This lets you answer "if GPIO5 goes high, does the LED turn on?" without pretending to simulate the chip. Drive the pins from the [Interactive Pins panel](../guides/model-doctor#interactive-pins).
- **Documented open** — a known part that circsim deliberately doesn't model because there's no meaningful SPICE analog (a USB-PD negotiation controller, say). It shows as grey "open by design," not red "unresolved," and carries a note explaining why.

Connectors get special treatment: a bare-board connector is electrically open (power arrives through your bench instruments, not the connector), so J/P parts resolve to a clean open stub with an "ok" status rather than nagging you.

## What you see, and what to do

Each part shows a status in the **Parts** panel and, if it needs attention, in the **Model Doctor**:

| Status | Dot | Meaning |
| --- | --- | --- |
| OK | green | Modeled, or intentionally open (connector) |
| Open by design | grey | A documented part with no meaningful model |
| Stubbed | amber | You (or a heuristic) stubbed it open/short/interactive |
| No model | red | Nothing matched — needs your attention |

A red "no model" part contributes nothing to the simulation and appears in the fidelity banner. The [Model Doctor](../guides/model-doctor) is where you fix it: import a `.lib`, get one from an LLM and validate it against ngspice, stub it, or set an interactive-pin panel.

## Related

- [Model library reference](../reference/model-library) — the full list of built-in parts.
- [Pin-map precedence](../reference/pin-maps) — how circsim decides which pad is which terminal (and the JLC/EasyEDA diode-polarity story).
- [Fix an unresolved part](../guides/model-doctor) — the hands-on workflow.
