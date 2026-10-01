# Save your setup & export a report

Rigging a real board takes a few minutes: pick the ground, wire a supply, teach the Model Doctor a pin map, stub the MCU. circsim saves that work beside your board so reopening it (for example after fixing the board in KiCad) puts everything back, and it can write the result down as a report you can paste or print.

## The setup file

The setup lives in one small text file next to your board, named after it:

```
my-board.kicad_pcb
my-board.circsim.json     <- circsim's saved setup
```

It holds:

- the **ground** net, and where on the board its lead was clipped;
- every **bench instrument** with its settings and its **leads**, each lead with the board position (in millimetres) where you clipped it;
- the Model Doctor's **stub** and **pin-map** overrides;
- **rail-voltage** overrides;
- the **models** you imported or pasted from an LLM.

It never holds the board, simulation results, or anything copied from your design. circsim does not modify your `.kicad_pcb`; the setup file is the only file it creates beside it. Nets are stored by *name*, not by internal number, so the setup still lines up after you edit and reopen the board.

### Restoring

If `my-board.circsim.json` exists, circsim restores it automatically every time you open the board (from **Open...**, the recent list, or drag and drop). A bar under the toolbar tells you what happened:

> Restored 9 saved settings from my-board.circsim.json.

If something could not be restored, the bar lists it. If you removed a part or renamed a net in KiCad, the override or lead that pointed at it is dropped and named in the notes; an instrument whose net is gone stays on the shelf, unwired, so you can wire it again.

### Saving: you opt in, once per board

circsim does not drop a file into your project folder unasked. With no setup file on disk, the bar offers **Save setup**. Click it once and circsim writes the file and keeps it up to date as you work (changes are saved a moment after you make them). If you would rather not have the file, never click it; nothing is written.

The bundled sample and First Light demo are never saved, since they live in the app's own folder.

::: tip Version control
If your KiCad project is in git, decide whether to commit `my-board.circsim.json` (share your rigging with collaborators) or add `*.circsim.json` to `.gitignore` (keep it personal). The file is plain, sorted JSON, so diffs are readable.
:::

### If the file is old, damaged, or from a newer circsim

Opening a board never fails because of its setup file.

| The file is... | circsim does |
| --- | --- |
| from an early build with no version number | loads it, and upgrades it on your next change, keeping the original as `my-board.circsim.json.bak` |
| cut off or partly damaged | loads the complete part at the start, lists what was lost, and keeps the original as `.bak` when it next saves |
| unreadable or not a circsim file | opens the board with the default bench and leaves the file alone; **Replace and save** overwrites it and keeps the old one as `.bak` |
| written by a newer circsim | loads the settings it understands and does not overwrite the file unless you choose **Replace and save** |

Models in a setup file are checked before use: a saved model that contains an ngspice `.control` block, an `.include` or `.lib` line, or other directives outside a small allowlist is skipped, because a setup file can arrive with a cloned repository and ngspice can run commands from such blocks.

## Recent boards

The start screen lists the boards you opened recently, newest first. Click one to open it (with its saved setup). **Clear** empties the list. The list is stored in the app's own data folder, not beside your boards, and entries for files that no longer exist are dropped.

## Export a report

With a board open, the **Export report** button in the top bar saves a report as:

- **Markdown (.md)**: paste it into a forum thread, an issue, or the chat with the LLM that helped design the board ("here is what the sim says; what is wrong?").
- **PDF (.pdf)**: for a reviewer, or as a record of the pre-fab check.

Both come from the same document. It contains:

1. **Board and tool**: the board file name and its **SHA-256**, the KiCad file-format version, the attached schematic, the circsim version and when the report was made, so a result can be tied to the exact file it came from.
2. **Bench and overrides**: the ground net, every instrument with its connections, settings and lead positions, and every stub, pin-map, rail and model override. This is enough to reproduce the run.
3. **Part models**: one row per part with its status, resolution tier, the model it got, and where that model came from (schematic `Sim.*` fields, inferred from the reference and value, the bundled library, or a model you supplied).
4. **Fidelity caveats**: every stubbed or unresolved part, the digital-model caveat, any warnings on resolved parts, and a note if the operating point came from a fallback solve or is from a previous run.
5. **Operating point**: the voltage on every net.
6. **Board Critic findings**: each with its detail, **assumption line** and suggestion, plus the checks that were not assessed.

The report is a record of a setup and what it produced, not a verdict: findings are risks to check, and the numbers are only as good as the models listed in it.

## Related

- [Open a routed board](./open-board)
- [Use the bench & draw leads](./bench-and-leads)
- [Fix an unresolved part](./model-doctor)
- [Run the Board Critic audit](./run-critic)
