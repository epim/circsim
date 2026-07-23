# Architecture

How circsim is built, for the curious and for anyone who might contribute. You don't need any of this to *use* circsim, but if you want to know what's running when you press Energize, here it is.

## The stack

circsim is a desktop application built on **Electron** with **TypeScript** throughout. The UI is **React** for the panels and chrome, with an imperative **Three.js** (WebGL2) renderer for the 3D board. State lives in a **zustand** store. The whole app is offline: no servers, no telemetry, no network calls.

The pure logic (parsing KiCad files, rebuilding the circuit, resolving models, generating SPICE decks, running the Board Critic) lives in a framework-free `core` layer that's unit-tested without Electron. That separation is why the behavior is testable and why this documentation could be verified against the code so precisely.

## The simulation engine

circsim runs **ngspice 46** (the same open-source SPICE engine behind KiCad's simulator) embedded as a shared library and called through the **koffi** foreign-function interface. It's fully bundled per platform; there's nothing to install.

ngspice runs in a **separate, isolated process** (an Electron utility process), talking to the app over a message channel. This matters for reliability:

- A solver crash or hang takes down only the sim process, not your app or your unsaved work. circsim restarts the engine automatically and tells you it did.
- A watchdog catches a wedged engine (a 60-second stall) and respawns it.
- The engine is driven entirely through koffi's async interface with a strict command serializer, which is what avoids a class of background-thread deadlocks that can otherwise hang SPICE under FFI.

The SPICE deck is loaded into ngspice **from memory**: every model definition is inlined into the deck, never included by file path. That's part of what keeps circsim fully self-contained.

## What happens when you press Energize

1. circsim generates a **SPICE deck** from the current circuit and your wired bench instruments.
2. The deck is loaded into the isolated ngspice process.
3. ngspice solves the **operating point** (a DC steady-state solve) with a convergence **retry ladder**: a plain solve first, then with *gmin-stepping* (temporarily adding a tiny conductance across every node to give the solver a path, then removing it), then with *source-stepping* (ramping the supplies up from zero). Both are standard numerical aids for circuits that won't converge directly.
4. The result comes back tagged with the **method** it succeeded by. A `direct` solve is trustworthy; a `gmin`, `source`, or transient fallback means the numbers may be unreliable, and circsim shows you a caveat rather than presenting shaky voltages as fact.
5. Net voltages tint the copper, float as labels, and drive the LED glow; the operating-point currents feed the simulation-informed [Board Critic checks](./critic-checks).

Pressing **Run** instead starts a **transient** simulation streaming to the scope. It runs from the circuit's initial state (so you watch it "come alive"), streams samples to the oscilloscope, paces itself toward real time, and (to bound memory on a long continuous run) restarts in ~30-second windows, keeping your scope history.

::: info AC analysis
An AC (frequency-sweep) analysis is scaffolded in the protocol but not implemented in this version. Today circsim does DC operating point and transient.
:::

## Live parameter changes

When you turn a knob on the bench, circsim doesn't restart the simulation. A *value* change (a supply voltage, a pot wiper) becomes an in-place ngspice `alter`, coalesced over a short window so a fast knob-drag doesn't flood the engine. A *topology* change (rewiring a lead, changing a function-gen wave type) rebuilds and reloads the deck, because the circuit itself changed. circsim detects which happened and picks the right path: see [instruments](./instruments#live-edit-alter-vs-reload).

## Rail sensing {#rail-sensing}

Digital logic needs to know its supply voltage to place its thresholds, but a chip's VDD rail is sometimes derived or switched rather than fed directly. So for boards with digital logic, circsim can solve in two passes: the first with the family-default rail, then, if the measured rail would actually change the result, a second pass using the rail voltage it read from the first solve. A rail sitting near 0 V is reported as "gated off" (with a coach note) rather than silently used. You can always override a rail manually.

This is resolved **per chip, from that chip's own VDD net**, so a board that mixes families (74HC parts at 5 V and CD4000 parts at 12 V, say) senses each one independently. The precedence for a chip's high level: a DC supply directly on its VDD net wins; then your manual override; then the op-measured rail; then the family default (5 V for 74HC, 12 V for CD4000).

## Offline & licensing

circsim is **MIT-licensed** and fully offline. It bundles ngspice (BSD-style) and an in-house SPICE model library written from datasheet parameters. It never bundles vendor SPICE models or KiCad's share-alike 3D assets. Every bundled model file carries a provenance header, and CI enforces the licensing rules (including excluding the GPL-encumbered `table.cm` code model) so a violation fails a build rather than shipping. The "Ask your LLM" model helper is copy-and-paste; it makes no API calls. The **About** dialog in the app shows the full license and provenance details.

## Where the code lives

circsim is open source at [github.com/epim/circsim](https://github.com/epim/circsim). The high-level layout:

- `src/core/` is framework-free logic: KiCad parsing, netlist extraction, model resolution, SPICE-deck generation, the Board Critic. Fully unit-tested.
- `src/simhost/` is the isolated ngspice process and its koffi FFI bindings.
- `src/renderer/` is the React UI, the zustand store, the Three.js viewport, and the bench.
- `src/main/` is the Electron main process.
- `resources/models/` is the bundled SPICE model library and its index.
