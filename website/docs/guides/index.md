# How-to guides

Task-oriented walkthroughs for specific jobs. If you're new, do the [First Light tutorial](../start/first-light) first — it strings the basics together on the simplest board.

## Getting a board simulating

- **[Open a routed board](./open-board)** — load a `.kicad_pcb`, from a file or a drag-and-drop.
- **[Attach a schematic](./attach-schematic)** — add `Sim.*` fields and pin names for higher fidelity.
- **[Set ground & supply](./ground-and-supply)** — designate the reference and power nets.
- **[Energize & read the operating point](./energize)** — power it up and read every net's voltage.

## Driving the bench

- **[Use the bench & draw leads](./bench-and-leads)** — add instruments and wire them onto the board.
- **[Probe nets & read the scope](./probe-and-scope)** — watch live waveforms, use cursors, read frequencies.
- **[Drive a microcontroller's pins](./interactive-pins)** — check MCU hardware without running firmware.

## Fixing and checking

- **[Fix an unresolved part](./model-doctor)** — the Model Doctor: import, stub, or pin-map a part.
- **[Run the Board Critic audit](./run-critic)** — the read-only pre-fab check.
- **[Read the warnings & fidelity banner](./warnings)** — what every honesty surface is telling you.

## See also

- [Concepts](../concepts/validation-bench) — the ideas behind the tool.
- [Reference](../reference/) — exact models, instruments, checks, and formats.
