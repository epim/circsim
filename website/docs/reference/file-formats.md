# Supported files

circsim opens **KiCad** design files. This page is the precise account of what it reads, what it extracts, and the current limits.

## `.kicad_pcb` — the routed board (required)

The one required input. circsim parses the board's S-expression format (KiCad 6 and newer) and extracts:

- the **net table** and every pad's net assignment — this is the [circuit connectivity](../concepts/board-to-circuit);
- **footprints** — reference, value, library id, layer (front/back), position, pads, and properties (including MPN and datasheet fields where present);
- **tracks, vias, zones**, the board **outline** (edge cuts), and **silkscreen** text;
- board thickness.

Both net formats are supported transparently:

- **KiCad 6–8** carry a numeric net table (`(net 3 "VCC")`) and tag pads by id.
- **KiCad 9 / 2026** dropped the numeric ids — nets are referenced by **name only**. circsim synthesizes stable internal ids per net name so everything downstream behaves identically.

Older (`F.SilkS`) and newer (`F.Silkscreen`) layer names are both handled.

::: tip Quilter users
Quilter returns your routed layout in the same native format it received. For KiCad projects that's a `.kicad_pcb` — exactly circsim's input. Note that Quilter does **not** emit a BOM, netlist, or Gerbers; the board file alone is enough for circsim to rebuild the circuit.
:::

## `.kicad_sch` — the schematic (optional, recommended)

Connectivity comes entirely from the board, so the schematic is optional — but it unlocks higher-fidelity modeling. From it circsim reads:

- the six **KiCad `Sim.*` fields** (`Sim.Device`, `Sim.Type`, `Sim.Params`, `Sim.Pins`, `Sim.Library`, `Sim.Name`) — the highest-priority [model source](../concepts/models#how-a-part-finds-its-model);
- each symbol's **Value** and its **pin list** (number, name, electrical type);
- **no-connect** markers.

The pin names are what let circsim resolve [diode/LED polarity](./pin-maps#diode-polarity) from the design instead of guessing from the footprint.

Attach a schematic to an already-open board by dragging the `.kicad_sch` onto the window, or via **Attach schematic…** in the Ground & Power panel. See [attach a schematic](../guides/attach-schematic).

::: warning Top-level symbols only
This version flat-scans a schematic's top-level symbols. **Hierarchical designs** — symbols on sub-sheets — aren't fully read yet, so parts on sub-sheets won't get `Sim.*` fields or pin names. Connectivity is unaffected (it always comes from the board).
:::

## BOM CSV — the bill of materials (optional)

A BOM sharpens part *identification* — most usefully by supplying manufacturer part numbers. The importer is deliberately tolerant:

- **auto-detects** the delimiter (comma, semicolon, or tab);
- **aliases** common column headers — `Reference`/`Designator`/`Ref` → ref, `Value` → value, `Footprint`/`Package` → footprint, `MPN`/`Manufacturer Part Number`/`Part Number` → mpn;
- **expands grouped references** (`R1, R2, R3` → three rows);
- handles quoted fields.

Where a BOM row and the board disagree, the **BOM wins** — you curated it on purpose. A precise MPN is the single most useful thing for [matching a part to a model](../concepts/models).

## Not supported

- **Altium, IPC-2581, Gerbers** — KiCad only, for now.
- **A standalone `.net` netlist file** — not needed; connectivity is read straight from the `.kicad_pcb`.
- **3D `.wrl` models** — components render as placeholders. (KiCad's 3D models are share-alike licensed, so circsim never bundles or caches them.)

## Related

- [From routed board to circuit](../concepts/board-to-circuit) — what circsim does with these files.
- [Open a routed board](../guides/open-board) · [Attach a schematic](../guides/attach-schematic)
