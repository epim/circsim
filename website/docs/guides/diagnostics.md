# Save a diagnostic bundle

When a voltage, an LED, or a warning looks wrong, the most useful thing you can attach to a bug report is a **diagnostic bundle**: one zip that holds what circsim believed about your board at that moment. Without it, nobody but you can reproduce a "reads wrong" report.

## Save one

Click **Save diagnostics**. It appears in two places:

- In the **Simulator restarted** toast, after the engine stops or crashes.
- At the bottom of the warnings area, whenever any other warning is showing (the [fidelity banner](./warnings), a convergence failure, a rail note).

A save dialog asks where to put `circsim-diagnostics-<board>-<date>.zip`. Saving never changes your board or any design file.

## What is in the zip

| File | What it holds |
| --- | --- |
| `manifest.json` | circsim and ngspice versions, the board file name, its sha256, the KiCad file version, the latest engine crash, and a summary of the decks. |
| `decks/pass1.cir` | The SPICE deck of the first operating-point solve. |
| `decks/pass2.cir` | The second solve, present only when a measured rail changed the circuit. |
| `decks/run.cir` | The deck the last transient run or crash replay loaded. |
| `ngspice.log` | The Sim Log (up to the last 2000 lines), oldest first. |
| `op.json` | The operating point on screen and which solver method converged it. |
| `resolutions.json` | For each part, which model tier resolved it and to what, plus warnings. |
| `instruments.json` | Your bench: supplies, generators, probes, and leads. |
| `environment.json` | Electron, Chromium, Node, and operating-system versions. |
| `simhost-output.log` | Recent stdout and stderr of the simulation engine process. |
| `crashes.json` | Every engine exit this session, with its exit code. |

A deck or log file is missing when there is nothing to put in it yet. For example, `decks/pass1.cir` appears after you [energize the board](./energize).

## What it does not contain

The board file itself is **not** included, only its name and sha256, so you can say which board you mean without sending it. The decks and `resolutions.json` do contain part references, values, and net names, because they are the point of the bundle. Read them before you post the zip somewhere public if the design is private.

## Reading the crash reason

The **Simulator restarted** toast says why the engine stopped:

- **Watchdog timeout (exit code 86).** A solve stopped making progress and circsim's watchdog ended the engine. Check the `ngspice.log` and `decks/` for the circuit that hung.
- **Crashed (any other exit code).** The engine died outright. The exit code and the tail of `simhost-output.log` are the first things a maintainer will look at.

The same code and reason are in `crashes.json`. See [read the warnings](./warnings#simulator-restarted-bench-restarted) for the rest of the toasts.
