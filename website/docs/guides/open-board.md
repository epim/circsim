# Open a routed board

circsim's one required input is a routed **`.kicad_pcb`** file (KiCad 6 to 10). There are three ways to open one.

## From the start screen

With no board loaded, the viewport offers:

- **Open sample project**: the bundled 555 blinker.
- **Open First Light demo**: the bundled one-LED dimmer.
- **Open…**: a file picker for your own board.
- **Recent boards**: the boards you opened before, newest first (see [Save your setup & export a report](./save-and-report)).

## From the header

The **Open…** button in the top bar opens a file picker at any time. Opening a new board replaces the current one.

## If the board does not load cleanly

- A **KiCad 5 or older** file is refused with a message to save it from KiCad 6 to 10 first.
- A missing or broken **board outline** does not stop the board from opening. The 3D view then shows no substrate or a bounding-box substrate, and a warning row above the viewport says why. See [supported files](../reference/file-formats#kicad-pcb-the-routed-board-required).

## By drag and drop

Drag a `.kicad_pcb` from your file manager straight onto the circsim window. (You can also drop a `.kicad_sch` this way to [attach a schematic](./attach-schematic) to an already-open board.)

## What happens next

The moment a board loads, circsim:

1. renders it in **3D** (drag to orbit, scroll to zoom);
2. rebuilds the **circuit** from the copper and fills the **Parts** panel; each part gets a colored dot for its [model status](../concepts/models);
3. auto-suggests a **ground** net and **supply** nets in the Ground & Power panel;
4. restores the **setup saved beside the board** (`my-board.circsim.json`: ground, bench, overrides, models), if there is one, replacing those suggestions, and tells you what it restored;
5. runs the static [Board Critic](./run-critic) checks (floating nets, clearance, decoupling, loop area).

Parsing, netlist extraction, model resolution and the Board Critic run in a background worker, so the window stays responsive while a large board opens. A strip under the toolbar names the stage (parsing, extracting, resolving, then running the Board Critic). The board appears as soon as it is resolved; the Board Critic panel fills in when its checks finish, which on a very large board (thousands of parts, tens of thousands of tracks) takes a second or two longer than the board itself. If you open another board in the meantime, the earlier open is abandoned.

The header shows a live summary, `"12 parts · 10 ok · 2 unresolved"`, so you immediately see whether anything needs attention.

::: tip It parsed but something's off?
If circsim can't parse the file it shows a specific error (with a line/column). If it parses but a part is unresolved, that's normal: head to the [Model Doctor](./model-doctor). If the netlist is unusable (no parts or nets), circsim shows the board read-only with a **viewer-only** badge.
:::

## Next

- **[Attach a schematic](./attach-schematic)** for higher-fidelity models and correct diode polarity.
- **[Set ground & supply](./ground-and-supply)**, then **[Energize](./energize)**.
