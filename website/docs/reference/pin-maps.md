# Pin-map precedence

A SPICE model has *terminals* (a diode's anode and cathode; a transistor's collector, base, emitter). A footprint has *pads* (numbered 1, 2, 3…). A **pin map** says which pad is which terminal. Get it wrong and the simulation is wrong in a way that's easy to miss. A backwards diode still "simulates," it just gives you the wrong answer.

circsim resolves the pin map from several sources, in a strict order of trust. This page explains that order and the one place it bites most often: diode polarity.

## The precedence, highest to lowest

1. **Your Model Doctor override.** If you edited the pin map by hand, that's final. It beats everything below. See [fix an unresolved part](../guides/model-doctor#pin-map).
2. **Schematic pin names.** For two-terminal polarized parts (diodes and LEDs), if a matching `.kicad_sch` names the symbol's pins `A` (anode) and `K` (cathode), circsim derives the polarity from the *design* rather than guessing from the footprint. This is ground truth: the schematic is where the designer's intent lives.
3. **Footprint-name convention, KiCad footprints only.** For KiCad's own footprint names (`Diode_SMD:D_SMA`, `LED_SMD:LED_0805_2012Metric`), circsim applies the pad convention KiCad uses. For JLCPCB / EasyEDA footprint names it applies **no** convention at all, because none exists (see below).
4. **Default order,** with a *"pinmap-unverified"* warning, used when nothing above applies, so you know to double-check. JLC/EasyEDA diode footprints always land here unless the schematic (precedence #2) says otherwise.

## The diode-polarity trap {#diode-polarity}

Here's a real one worth understanding, because it will silently reverse a diode if you're not aware of it.

- **KiCad's** standard diode footprints put **pad 1 = cathode**, every time.
- **JLCPCB / EasyEDA** footprints have **no fixed convention**. Pad numbering follows whatever the part's own datasheet drawing used, so pad 1 is the anode on some and the cathode on others. On one real board (an LED lantern charger), the SMC Schottky has pad 1 = anode, while the SMA Schottkys and the SOD-123 diode on the same board have pad 1 = cathode.

A routed board often carries footprints as bare dimension-pattern names (something like `SMC_L7.1-W6.2-...` or `SMA_L4.2-W2.6-LS5.0-RD_1`) with no "KiCad" or "JLC" label. circsim recognizes that dimension-pattern shape, and recognizes that it cannot tell polarity from the name. For those footprints it uses KiCad's default order, instead of presenting a guess as fact, and attaches a `pinmap-unverified` polarity warning that the [sim log](../guides/warnings#polarity-unverified) shows when the board opens. The part keeps its model and simulates with that default, so its dot stays green and it has no Model Doctor card, until the schematic confirms which pad is the anode.

### How the schematic saves you

This is exactly why **attaching the schematic matters** for diodes and LEDs. If the schematic's symbol names its pins `A`/`K`, circsim takes the polarity from there, and the unverified warning goes away. When the schematic contradicts a confident KiCad-footprint convention, circsim trusts the schematic and posts an informational note:

> ⓘ D7: pin map corrected from schematic (A/K): footprint convention was reversed. Override in Model Doctor if the schematic is stale.

If your schematic is the thing that's out of date, you can override in the Model Doctor. Without a schematic, check each diode the sim log names with a `pinmap-unverified: polarity` warning against your board (its datasheet drawing or the silkscreen) before you trust a converter or charger result.

## Checking and fixing a pin map

Open the **Model Doctor**, find the part, and click **Pin map** to see the pad ↔ terminal table. Each terminal is editable, with a datalist of the model's terminal names. Every edit commits immediately and becomes your override (precedence #1), so it survives re-resolution.

For an imported `.lib` model, the import flow walks you through verifying the map against the datasheet before binding, because a wrong pin map on a model you brought is the easiest way to get confidently-wrong results.

## Related

- [Attach a schematic](../guides/attach-schematic): how to give circsim the pin names.
- [Fix an unresolved part](../guides/model-doctor): the pin-map editor.
- [Models & resolution](../concepts/models): the full resolution pipeline.
