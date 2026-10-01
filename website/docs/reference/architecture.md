# Architecture

How circsim is built, for the curious and for anyone who might contribute. You don't need any of this to *use* circsim, but if you want to know what's running when you press Energize, here it is.

## The stack

circsim is a desktop application built on **Electron** with **TypeScript** throughout. The UI is **React** for the panels and chrome, with an imperative **Three.js** (WebGL2) renderer for the 3D board. State lives in a **zustand** store. The whole app is offline: no servers, no telemetry, no network calls.

The pure logic (parsing KiCad files, rebuilding the circuit, resolving models, generating SPICE decks, planning the operating-point solve, running the Board Critic) lives in a framework-free `core` layer that's unit-tested without Electron. That separation is why the behavior is testable and why this documentation could be verified against the code so precisely.

## The simulation engine

circsim runs **ngspice 46** (the same open-source SPICE engine behind KiCad's simulator) embedded as a shared library and called through the **koffi** foreign-function interface. It's fully bundled per platform; there's nothing to install.

ngspice runs in a **separate, isolated process** (an Electron utility process), talking to the app over a message channel. This matters for reliability:

- A solver crash or hang takes down only the sim process, not your app or your unsaved work. circsim restarts the engine automatically and tells you it did.
- A watchdog catches a wedged engine (a 60-second stall) and respawns it.
- The engine is driven entirely through koffi's async interface with a strict command serializer, which is what avoids a class of background-thread deadlocks that can otherwise hang SPICE under FFI.

The SPICE deck is loaded into ngspice **from memory**: every model definition is inlined into the deck, never included by file path. That's part of what keeps circsim fully self-contained.

## What happens when you press Energize

1. circsim generates a **SPICE deck** from the current circuit and your wired bench instruments. Energize, Run, and the automatic replay after an engine restart all build their deck through the same code from a snapshot of the bench, so they can't disagree about what's on it.
2. The deck is loaded into the isolated ngspice process.
3. ngspice solves the **operating point** (a DC steady-state solve) with a convergence **retry ladder**: a plain solve first, then with *gmin-stepping* (temporarily adding a tiny conductance across every node to give the solver a path, then removing it), then with *source-stepping* (ramping the supplies up from zero). Both are standard numerical aids for circuits that won't converge directly.
4. The result comes back tagged with the **method** it succeeded by. A `direct` solve is trustworthy; a `gmin`, `source`, or transient fallback means the numbers may be unreliable, and circsim shows you a caveat rather than presenting shaky voltages as fact.
5. Net voltages tint the copper, float as labels, and drive the LED glow; the operating-point currents feed the simulation-informed [Board Critic checks](./critic-checks).

Pressing **Run** instead starts a **transient** simulation streaming to the scope. It runs from the circuit's initial state (so you watch it "come alive"), streams samples to the oscilloscope, paces itself to the Pace setting, and (to bound memory on a long continuous run) restarts in ~30-second windows, keeping your scope history.

### How the live bench keeps up with real time {#live-sample-channel}

Two choices decide whether the live bench can hold 1× real time, and both used to cap it well below 1× (about 0.02× on the 555 sample and 0.15× on a lantern-class board):

- **Samples are read from ngspice's result vectors, not pushed per timepoint.** ngspice can call back into the app once for every accepted time step, but each call crosses the process boundary and decodes every saved vector, which cost more than solving the step itself. circsim registers no per-step callback. Instead, every 15 ms the engine host reads the new points straight out of ngspice's result vectors in one bulk copy (while ngspice holds those vectors still) and sends them to the app as one batch, so samples reach the scope about 60 times a second. The scope probes' nets are sent as full time series; every other net is sent as its newest value about 30 times a second, which is what tints the copper and drives the LED glow.
- **The time step follows the signals on the bench.** The step is `min(1 / (200 × fastest function-generator frequency), 100 µs)`, so a bench with no fast source runs at 100 µs. ngspice still refines below the step by itself wherever the circuit needs it (an edge, a switching node), so the step only bounds the quiet stretches. A function generator makes the step smaller, and a very fast one can put real time out of reach again, which is physics rather than overhead.

Pacing works on delivery rather than on the solver: ngspice may run a little ahead, and the host releases its points to the app on the wall clock, so `1×` is a steady stream instead of fast bursts and pauses. The solver is halted only when it gets more than about 0.3 s ahead, which also bounds how long a knob turn waits before the board shows it.

Pausing, a knob turn (which halts the solver for a moment) and the pacing halt all go through one ordered queue. ngspice's background thread must never be halted while it is still starting, and a resumed thread needs a moment before it is halted again, so circsim spaces halts and resumes by a fixed settle time (about 50 to 120 ms). Without it a fast simulation crashed ngspice on the resume after such a halt.

A knob turn's new values travel in that same queue, after its halt and before its resume, so a value never reaches ngspice while the solver's thread is starting (that aborted the run). One halt and resume takes about a third of a second, so a knob dragged faster than that is applied in batches: values that arrive while a batch waits for its halt join that batch. Pause and Stop do not wait behind a drag, and a resume that a pause has overtaken is dropped rather than started and halted again. A run that is over (it reached its stop time, or ngspice gave up on it) is not resumed again, so turning a knob after the end never holds back the last samples or keeps the toolbar on Running.

On measured benches (a 555 astable at the default step, a lantern-shaped board of about 70 vectors) the achieved factor is far above 1×, so `1×` is held rather than missed; the integration test `realtime.integration.test.ts` pins that.

::: info AC analysis
An AC (frequency-sweep) analysis is scaffolded in the protocol but not implemented in this version. Today circsim does DC operating point and transient.
:::

## Live parameter changes

When you turn a knob on the bench, circsim doesn't restart the simulation. A *value* change (a supply voltage, a pot wiper) becomes an in-place ngspice `alter`, coalesced over a short window so a fast knob-drag doesn't flood the engine. A *topology* change (rewiring a lead, changing a function-gen wave type) rebuilds and reloads the deck, because the circuit itself changed. circsim detects which happened and picks the right path: see [instruments](./instruments#live-edit-alter-vs-reload).

## Rail sensing {#rail-sensing}

Digital logic needs to know its supply voltage to place its thresholds, but a chip's VDD rail is sometimes derived or switched rather than fed directly. So for boards with digital logic, circsim can solve in two passes: the first with the family-default rail, then, if the measured rail would actually change the result, a second pass using the rail voltage it read from the first solve. A rail sitting near 0 V is reported as "gated off" (with a coach note) rather than silently used. You can always override a rail manually. The two-pass plan lives in the framework-free core, so the code that runs when you press Energize is the same code circsim's tests run against a real ngspice.

This is resolved **per chip, from that chip's own VDD net**, so a board that mixes families (74HC parts at 5 V and CD4000 parts at 12 V, say) senses each one independently. The precedence for a chip's high level: a DC supply directly on its VDD net wins; then your manual override; then the op-measured rail; then the family default (5 V for 74HC, 12 V for CD4000).

## Offline & licensing

circsim is **MIT-licensed** and fully offline. It bundles ngspice (BSD-style) and an in-house SPICE model library written from datasheet parameters. It never bundles vendor SPICE models or KiCad's share-alike 3D assets. Every bundled model file carries a provenance header, and CI enforces the licensing rules (including excluding the GPL-encumbered `table.cm` code model) so a violation fails a build rather than shipping. The "Ask your LLM" model helper is copy-and-paste; it makes no API calls. The **About** dialog in the app shows the full license and provenance details.

## Where the code lives

circsim is open source at [github.com/epim/circsim](https://github.com/epim/circsim). The high-level layout:

- `src/core/` is framework-free logic: KiCad parsing, netlist extraction, model resolution, SPICE-deck generation, the solve pipeline (`src/core/solve`: the one place every deck's inputs are assembled, and the two-pass operating-point plan), the Board Critic. Fully unit-tested.
- `src/simhost/` is the isolated ngspice process and its koffi FFI bindings, plus an in-process engine that runs the solve pipeline without Electron.
- `src/renderer/` is the React UI, the zustand store, the Three.js viewport, and the bench.
- `src/main/` is the Electron main process.
- `resources/models/` is the bundled SPICE model library and its index.
