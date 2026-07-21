# Attach a schematic

The board file gives circsim the full circuit connectivity — but the matching **`.kicad_sch`** schematic adds fidelity the board can't: KiCad `Sim.*` model fields, symbol pin names, and no-connect markers. Attaching it is optional but recommended, especially if your board has diodes, LEDs, or parts you've annotated with simulation fields.

## Why bother

Two concrete payoffs:

- **Correct diode/LED polarity.** A schematic symbol names its pins `A` (anode) and `K` (cathode). circsim uses that to override the footprint's pad-numbering convention — which is the difference between a diode that simulates correctly and one that's silently reversed. This is the single biggest reason to attach a schematic. See [the diode-polarity trap](../reference/pin-maps#diode-polarity).
- **Higher-fidelity models.** Any `Sim.Device` / `Sim.Type` / `Sim.Model` fields you (or KiCad) set on a symbol are the highest-priority [model source](../concepts/models#how-a-part-finds-its-model) circsim has.

## How to attach

Two ways, with a board already open:

- **Drag and drop** the `.kicad_sch` onto the circsim window.
- Click **Attach schematic…** (or **Replace schematic…**) in the **Ground & Power** panel and pick the file.

The Ground & Power panel's schematic row shows the attached filename in green once it's loaded — or *"No schematic — no Sim.\* fields"* in red when none is attached.

## What you'll notice

If a diode's schematic polarity disagrees with its footprint convention, circsim corrects it and posts an informational note:

> ⓘ D7: pin map corrected from schematic (A/K) — footprint convention was reversed. Override in Model Doctor if the schematic is stale.

That's the system working — it caught a would-be-reversed diode and fixed it from your design. Re-energize to see the corrected behavior.

::: warning Hierarchical schematics
This version reads only the **top-level** symbols of a schematic. If your design uses hierarchical sheets, parts on sub-sheets won't get `Sim.*` fields or pin names yet. Connectivity is unaffected — that always comes from the board.
:::

## Next

- **[Set ground & supply](./ground-and-supply)** · **[Energize](./energize)**
- **[Pin-map precedence](../reference/pin-maps)** — the full trust order for pad↔terminal mapping.
