# From routed board to circuit

A `.kicad_pcb` file looks like a physical artifact: footprints, tracks, vias, copper pours. But it also contains everything circsim needs to reconstruct the *electrical* circuit. This page explains how circsim gets from copper to a SPICE netlist, because understanding that makes the rest of the tool make sense.

## The board file already knows the netlist

A KiCad board file carries full net connectivity. Every connected pad is tagged with the net it belongs to, and tracks, vias, and zones carry net references too. So the circuit (which component pin connects to which net) is fully reconstructable from the board file alone. You do not need a schematic or a separate netlist file for connectivity.

circsim parses the board into a structured model: the net table, every footprint (reference, value, library id, layer, position, pads, and any properties like an MPN), the tracks, vias, zones, board outline, and silkscreen. From the footprints and their net-tagged pads it builds a **circuit**: a list of nets and a list of parts, where each part knows which of its pads lands on which net.

::: info Two net formats, one pipeline
KiCad 6 to 8 boards carry a numeric net table (for example, `(net 3 "VCC")`) and tag pads by id. KiCad 9 (and the 2026 format) dropped the numeric ids entirely: nets are referenced by **name only**. circsim reads both. For name-only boards it synthesizes a stable internal id per distinct net name, so everything downstream is identical regardless of which KiCad version routed the board. It also handles the older `F.SilkS` and newer `F.Silkscreen` layer spellings.
:::

## Nets become SPICE nodes

SPICE wants node *names*, and it has rules (case-insensitive, limited character set, and node `0` is sacred: it's the global ground reference). circsim translates each KiCad net name into a safe SPICE node name: lowercased, non-alphanumeric characters replaced with underscores, runs collapsed, and collisions disambiguated with a numeric suffix. Your designated ground net becomes node `0`.

This is why the voltage overlay can label copper with real net names while the solver underneath works in SPICE nodes. circsim keeps the mapping and shows you the human name.

## Ground and supply are guesses you confirm

To simulate, circsim needs to know which net is ground and which nets are supplies. It guesses from the names:

- **Ground candidates**: the net name's leaf matches `GND`, `AGND`, `DGND`, `VSS`, or `0V`.
- **Supply candidates**: leaves like `VCC`, `VDD`, `VIN`, `VBUS`, `3V3`, `+5V`, and similar, while deliberately *excluding* sense/feedback/reference taps (a net called `VREF` or `VSENSE` isn't a rail).

These are suggestions, surfaced in the **Ground & Power** panel and as clickable chips. You confirm them (or click the actual net on the 3D board) because a name heuristic is a starting point, not an authority. See [set ground & supply](../guides/ground-and-supply).

## What the schematic adds (optionally)

Connectivity comes from the board, but a matching `.kicad_sch` schematic adds three things the board file can't provide:

- **KiCad `Sim.*` fields**: if you (or KiCad) set `Sim.Device`, `Sim.Type`, `Sim.Params`, `Sim.Library`, `Sim.Name`, or `Sim.Pins` on a symbol, that's the highest-fidelity model source circsim has. It's the first thing [model resolution](./models) tries.
- **Symbol pin names**: a diode symbol names its pins `A` (anode) and `K` (cathode). That's ground truth for polarity, and circsim uses it to override footprint-convention guesses (see [pin-map precedence](../reference/pin-maps)).
- **No-connect markers**: pins the designer explicitly marked as intentionally unconnected.

::: warning Hierarchical schematics
In this version circsim flat-scans only the **top-level** symbols of a schematic. If your design uses hierarchical sheets, symbols on sub-sheets aren't seen yet. Connectivity is unaffected (that always comes from the board); you just won't get `Sim.*` fields or pin names for parts that live on sub-sheets.
:::

## What a BOM adds (optionally)

A BOM CSV enriches part *identification*. Real boards often carry the manufacturer part number in the footprint value field, but not always. circsim's BOM importer is tolerant: it autodetects the delimiter, aliases common column headers (`Reference`/`Designator`→ref, `MPN`/`Manufacturer Part Number`→mpn, and so on), and expands grouped references like `R1, R2, R3` into individual rows. Where a BOM row and the board disagree, the **BOM wins**, on the theory that you curated it deliberately.

A precise MPN is the single most useful thing for [matching a part to a model](./models#how-a-part-finds-its-model).

## The result

After all this, circsim holds a **circuit**: nets (with SPICE node names, ground and supplies identified) and parts (each with pads mapped to nets, and as much identity as the board, schematic, and BOM together provide). Every part is then run through [model resolution](./models) to get a SPICE model, or an honest "no model" flag. That circuit, plus your bench instruments, is what becomes a SPICE deck each time you energize or run.

Connectivity issues found along the way (a pad on no net, a net reaching only one pad) become [Board Critic](./board-critic) findings and fidelity warnings, so nothing is silently dropped.
