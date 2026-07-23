# Pin-map precedence

A SPICE model has *terminals* (a diode's anode and cathode; a transistor's collector, base, emitter). A footprint has *pads* (numbered 1, 2, 3…). A **pin map** says which pad is which terminal. Get it wrong and the simulation is wrong in a way that's easy to miss. A backwards diode still "simulates," it just gives you the wrong answer.

circsim resolves the pin map from several sources, in a strict order of trust. This page explains that order and the one place it bites most often: diode polarity.

## The precedence, highest to lowest

1. **Your Model Doctor override.** If you edited the pin map by hand, that's final. It beats everything below. See [fix an unresolved part](../guides/model-doctor#pin-map).
2. **Schematic pin names.** For two-terminal polarized parts (diodes and LEDs), if a matching `.kicad_sch` names the symbol's pins `A` (anode) and `K` (cathode), circsim derives the polarity from the *design* rather than guessing from the footprint. This is ground truth: the schematic is where the designer's intent lives.
3. **Footprint-name convention.** circsim recognizes footprint naming patterns and applies the pad convention that library uses.
4. **Default order,** with a *"verify pin order"* warning, used only when nothing above applies, so you know to double-check.

## The diode-polarity trap {#diode-polarity}

Here's a real one worth understanding, because it will silently reverse a diode if you're not aware of it.

Different footprint libraries number diode pads with **opposite conventions**:

- **KiCad's** standard diode footprints put **pad 1 = cathode**.
- **JLCPCB / EasyEDA** libraries put **pad 1 = anode**: the symbol pin 1 is literally labeled "A".

A routed board often carries footprints as bare dimension-pattern names (something like `SMC_L7.1-W6.2-...`) with no "KiCad" or "JLC" label to tell them apart. So circsim keys off the dimension pattern that EasyEDA/JLC libraries use and applies the anode-first convention for those. Otherwise every JLC-sourced diode on your board would simulate backwards.

### How the schematic saves you

This is exactly why **attaching the schematic matters** for diodes and LEDs. If the schematic's symbol names its pins `A`/`K`, circsim takes the polarity from there and *ignores* the footprint-name guess. When the schematic and the footprint convention disagree, circsim trusts the schematic and posts an informational note:

> ⓘ D7: pin map corrected from schematic (A/K): footprint convention was reversed. Override in Model Doctor if the schematic is stale.

That note is circsim telling you it caught a would-be-reversed diode and fixed it from the design. If your schematic is the thing that's out of date, you can override in the Model Doctor.

## Checking and fixing a pin map

Open the **Model Doctor**, find the part, and click **Pin map** to see the pad ↔ terminal table. Each terminal is editable, with a datalist of the model's terminal names. Every edit commits immediately and becomes your override (precedence #1), so it survives re-resolution.

For an imported `.lib` model, the import flow walks you through verifying the map against the datasheet before binding, because a wrong pin map on a model you brought is the easiest way to get confidently-wrong results.

## Related

- [Attach a schematic](../guides/attach-schematic): how to give circsim the pin names.
- [Fix an unresolved part](../guides/model-doctor): the pin-map editor.
- [Models & resolution](../concepts/models): the full resolution pipeline.
