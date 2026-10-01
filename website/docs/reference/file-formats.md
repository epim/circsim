# Supported files

circsim opens **KiCad** design files. This page is the precise account of what it reads, what it extracts, and the current limits.

## `.kicad_pcb`: the routed board (required)

The one required input. circsim parses the board's S-expression format (KiCad 6 to 10) and extracts:

- the **net table** and every pad's net assignment, which is the [circuit connectivity](../concepts/board-to-circuit);
- **footprints**: reference, value, library id, layer (front/back), position, pads, and properties (including MPN and datasheet fields where present);
- **tracks, vias, zones**, the board **outline** (edge cuts), and **silkscreen** text;
- board thickness.

Both net formats are supported transparently:

- **KiCad 6 to 9** (formats 20211014 to 20241229) carry a numeric net table (`(net 3 "VCC")`) and tag pads by id.
- **KiCad 10** (format 20260206) dropped the numeric ids. Nets are referenced by **name only**. circsim synthesizes stable internal ids per net name so everything downstream behaves identically.

circsim picks the net reader from the file's content, not its version stamp. Older (`F.SilkS`) and newer (`F.Silkscreen`) layer names are both handled.

::: tip Boards from an autorouter such as Quilter
circsim opens a routed `.kicad_pcb` the same way whoever routed it, and it contains no Quilter-specific code. If the autorouter hands back a KiCad board, open it. If you also have the project's `.kicad_sch`, keep it next to the board so circsim can attach it.
:::

## KiCad version support

circsim supports KiCad 6 to 10. The claim rests on a corpus of boards that KiCad itself wrote: demo boards from KiCad's source repository at the release tags 6.0.11, 7.0.11, 8.0.9, 9.0.9, and 10.0.3. The list, with the URL and SHA-256 of every file, is `scripts/corpus-manifest.json`. The boards are fetched when the tests run and never committed to this repository. For each board, `npm run test:corpus` runs the whole pipeline (parse, netlist, model resolution, deck generation, a real ngspice operating point) and checks that circsim's pad-to-net connectivity matches the one `kicad-cli` exports for the same file.

| KiCad | File format versions | Boards | Open and pass |
|---|---|---|---|
| KiCad 6 | 20211014 | 3 | 3 |
| KiCad 7 | 20221018 | 3 | 3 |
| KiCad 8 | 20240108 | 3 | 3 |
| KiCad 9 | 20241229 | 4 | 3 |
| KiCad 10 | 20241229, 20250513, 20260206 | 3 | 3 |

Two things in that table need a note:

- One KiCad 9 board does not open. The shipped `RoyalBlue54L-Feather` demo has an unbalanced parenthesis (`(curved_edges no)filter_ratio 0.9)`) that KiCad tolerates and circsim's parser rejects with an error. The corpus suite requires that failure, so it is tracked and not hidden.
- The KiCad 10 demo boards were not all re-saved by 10.0. Two still carry older format stamps, and only the file written as 20260206 has the name-only nets. Five small synthetic boards in `fixtures/synthetic/`, one per KiCad generation, add a unit test that parses all five dialects and compares the results field by field.

KiCad releases after 10 are untested until their boards join the corpus. A board saved by a newer KiCad may still open, but nothing here shows it.

## `.kicad_sch`: the schematic (optional, recommended)

Connectivity comes entirely from the board, so the schematic is optional, but it is the highest-fidelity input circsim has. If the `.kicad_sch` has the same name as the `.kicad_pcb` and sits in the same folder, circsim attaches it when the board opens. From it circsim reads:

- the six **KiCad `Sim.*` fields** (`Sim.Device`, `Sim.Type`, `Sim.Params`, `Sim.Pins`, `Sim.Library`, `Sim.Name`): the highest-priority [model source](../concepts/models#how-a-part-finds-its-model);
- each symbol's **Value** and its **pin list** (number, name, electrical type);
- **no-connect** markers.

The pin names are what let circsim resolve [diode/LED polarity](./pin-maps#diode-polarity) from the design instead of guessing from the footprint.

Attach a schematic to an already-open board by dragging the `.kicad_sch` onto the window, or via **Attach schematic…** in the Ground & Power panel. See [attach a schematic](../guides/attach-schematic).

::: warning Top-level symbols only
This version flat-scans a schematic's top-level symbols. **Hierarchical designs** (symbols on sub-sheets) aren't fully read yet, so parts on sub-sheets won't get `Sim.*` fields or pin names. Connectivity is unaffected (it always comes from the board).
:::

## BOM CSV: the bill of materials (optional)

A BOM sharpens part *identification*, most usefully by supplying manufacturer part numbers. The importer is deliberately tolerant:

- **auto-detects** the delimiter (comma, semicolon, or tab);
- **aliases** common column headers: `Reference`/`Designator`/`Ref` → ref, `Value` → value, `Footprint`/`Package` → footprint, `MPN`/`Manufacturer Part Number`/`Part Number` → mpn;
- **expands grouped references** (`R1, R2, R3` → three rows);
- handles quoted fields.

Where a BOM row and the board disagree, the **BOM wins**. You curated it on purpose. A precise MPN is the single most useful thing for [matching a part to a model](../concepts/models).

::: warning JLCPCB / LCSC part numbers won't resolve
circsim matches on the **manufacturer** part number (`1N4148`, `2N3904`, `NE555`), not on **LCSC / "JLCPCB Part#" codes** (`C25804`-style). A BOM exported from JLCPCB's assembly tool or the EasyEDA/KiCad JLC plugin often carries *only* the LCSC code, in a column circsim doesn't recognize, so those parts will show up as **"no model"** for a completely mundane reason. Two fixes: add a manufacturer-MPN column to the BOM (most JLC BOM tools can include one), or set the MPN directly in the [Model Doctor](../guides/model-doctor). Good news: on JLC-fabbed boards the manufacturer part number is often already sitting in the footprint's **Value** field, which circsim *does* read.
:::

## Not supported

- **Altium, IPC-2581, Gerbers**: KiCad only, for now.
- **A standalone `.net` netlist file**: not needed; connectivity is read straight from the `.kicad_pcb`.
- **3D `.wrl` models**: components render as placeholders. (KiCad's 3D models are share-alike licensed, so circsim never bundles or caches them.)

## Related

- [From routed board to circuit](../concepts/board-to-circuit): what circsim does with these files.
- [Open a routed board](../guides/open-board) · [Attach a schematic](../guides/attach-schematic)
