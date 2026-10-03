# Run circsim from the command line

The `circsim` command runs the same pipeline as the app (parse the board, extract the netlist, resolve models, solve the operating point, run the [Board Critic](../concepts/board-critic)) with no window. Use it to gate a pull request on the critic, to attach a reproducible report to a bug, or to run a folder of boards through the model library.

It is read-only: it never modifies your board or schematic, and `deck` writes only the new files you ask for.

::: warning Source checkout only
The command ships with the source tree, not with the installers. Build it from a checkout with `npm ci`, `npm run fetch:ngspice` (or a copy of `resources/ngspice/<platform>`), and `npm run build:cli`. After that, `node out/cli/index.js` runs it, and `npm link` puts `circsim` on your PATH.
:::

## Commands

```
circsim audit <board.kicad_pcb> [options]
circsim deck  <board.kicad_pcb> [options]
circsim op    <board.kicad_pcb> [options]
```

### audit

Runs the Board Critic. By default it first solves an ideal-net operating point, as **Energize** does in the app. Thermal can run from solved terminal power. Ampacity and IR-drop remain not assessed because they require a physical copper solve. The solve API supports `copperAware: true`; bench and CLI controls for that mode are still being added. Findings print grouped by severity, each with its detail, assumption, and suggestion.

```
circsim audit board.kicad_pcb --schematic
circsim audit board.kicad_pcb --json > report.json
```

The exit code is the gate:

| Code | Meaning |
| --- | --- |
| 0 | No error-severity findings. |
| 1 | At least one error-severity finding. |
| 2 | Usage error, or a board, schematic, or net you named could not be read. |
| 3 | The simulation failed or could not run, so the report is static-only. |

A gate must not pass clean when the simulation it asked for did not run, so code 3 is nonzero. If you really want the static checks only, say so with `--no-op`, which exits 0 or 1 on the static findings alone.

### op

Solves the operating point and prints every net's voltage and how the solve converged (`direct`, `gmin`, `source`, or `tran-fallback`). A solve that needed a fallback prints the same caution the app's amber banner shows: double-check the voltages.

```
circsim op board.kicad_pcb --supply VIN=12
```

### deck

Writes the SPICE decks circsim would load. Pass 1 is the family-default baseline. Pass 2 exists only when a rail measured off pass 1's operating point changed the deck (see [rail sensing](../reference/architecture#rail-sensing)). Files land in `--out` (default: the current directory) as `<board>.pass1.cir` and `<board>.pass2.cir`.

```
circsim deck board.kicad_pcb --out decks
circsim deck board.kicad_pcb --pass1-only     # no ngspice needed
```

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--schematic[=PATH]` | all | Read `Sim.*` fields and pin names from the sibling `.kicad_sch`, or from `PATH`. Same effect as [attaching a schematic](./attach-schematic) in the app. Off by default so a run is reproducible from the flags alone. |
| `--json` | all | Machine-readable output (schema below). |
| `--ground NET` | all | Ground net. Default: the GND, AGND, DGND, VSS, 0V name heuristic. |
| `--supply NET=VOLTS` | all | Attach a DC supply (0.1 ohm series, as in the app). Repeatable. Default: 5 V on the top suggested supply rail, like the app's open-time default. |
| `--no-op` | audit | Static checks only; no simulation. |
| `--out DIR` | deck | Output directory. |
| `--pass1-only` | deck | Build the family-default deck without running ngspice. |
| `--ngspice-dir DIR` | all | Base directory holding `<platform>/` ngspice resources. |
| `--models-dir DIR` | all | Model library directory (holds `index.json`). |
| `--verbose` | all | Echo ngspice log lines to stderr. |

Net names match exactly first, then case-insensitively, then by their last path segment when that is unambiguous, so `--supply VCC=5` finds `/Power/VCC`.

### Environment

| Variable | Meaning |
| --- | --- |
| `CIRCSIM_NGSPICE_DIR` | Same as `--ngspice-dir`. The flag wins. An explicit directory that does not hold ngspice is an error; it never falls back to another copy. |
| `CIRCSIM_MODELS_DIR` | Same as `--models-dir`. The flag wins. |

## JSON report

`--json` prints one document to stdout and nothing else; diagnostics go to stderr. Every document carries `schemaVersion` (currently `1`) and `command`. A change that removes or renames a field bumps the version.

`audit` adds:

- `board`, `schematic`, `ground`, `supplies` (net, volts, and whether it came from a flag or the default).
- `parts`, `nets`, and `models` (counts of ok, stubbed, unresolved, and documented-open parts, plus an `attention` list of the ones that are not ok, with their warnings).
- `solve`: `ran`, and when it ran, `method`, `pass2` (`not-needed`, `solved`, or `failed`), `measuredRails`, and `gatedOff`; when it did not, `reason`.
- `critic`: the Board Critic report, the same data the app shows: `findings` (each with `id`, `check`, `severity`, `title`, `detail`, `assumption`, `refs`, `location`, `suggestion`, `metrics`), `ranBy`, `skipped`, and `summary` counts.
- `exitCode`.

`op` adds `solve` and `nets`, a list of `{ id, name, spiceNode, volts }` where `volts` is `null` for a net the solve did not report.

`deck` adds `solve` and `files`, the absolute paths written.

## Using it in CI

```yaml
- run: npm ci && npm run fetch:ngspice && npm run build:cli
- run: node out/cli/index.js audit hardware/board.kicad_pcb --schematic
```

The step fails on error-severity findings (exit 1) and when the simulation could not run (exit 3). Findings are checks, not verdicts, so treat a red run as "read the report", the same as in the app.

## Related

- [Run the Board Critic audit](./run-critic): reading the findings.
- [Energize & read the operating point](./energize): what the `op` command computes.
- [Board Critic checks reference](../reference/critic-checks): thresholds and assumptions.
