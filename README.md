# circsim

**The validation bench for routed boards.** circsim is a desktop app (Windows / macOS / Linux) that loads a routed KiCad board (`.kicad_pcb`), rebuilds the circuit from the copper, renders it in 3D, and lets you validate it with an interactive SPICE simulation — apply power, turn a knob, and probe nets on the physical board — before you send it for fabrication.

Every other hobbyist simulator wants a schematic. circsim starts from the finished, routed board you got back from [Quilter](https://quilter.ai) or KiCad. It is fully offline, MIT-licensed, and **never modifies your design files.**

📖 **Documentation: [epim.github.io/circsim](https://epim.github.io/circsim/)** — install guide, the First Light tutorial, task how-tos, and full reference.
⬇️ **Download: [latest release](https://github.com/epim/circsim/releases/latest)** (Windows `.exe`, macOS `.dmg` ×2, Linux `.AppImage` / `.deb`).

## What it does

- **Reads a routed board, not a schematic.** Full net connectivity comes straight out of the `.kicad_pcb` (KiCad 6–9). An optional `.kicad_sch` adds `Sim.*` fields and pin names; an optional BOM CSV pins down exact parts.
- **A real bench.** Clip a DC supply, function generator, potentiometer, logic input, and voltage/current probes onto the board by drawing leads from front-panel jacks to the copper. Turn a knob and the simulation re-solves live.
- **Honest about what it knows.** Behavioral vs. primitive models, stubbed ICs, MCUs as interactive-pin panels (firmware doesn't run), convergence fallbacks, and fidelity limits are always visible. See [what circsim can and can't tell you](https://epim.github.io/circsim/concepts/fidelity).
- **A read-only Board Critic.** A pre-fabrication audit of the board circsim did *not* design — floating nets, clearance, decoupling distance, loop area, IR-drop, ampacity, thermal — that never edits your files.

Powered by [ngspice](https://ngspice.sourceforge.io/) 46, bundled per platform and run crash-isolated in a separate process. Nothing to install; no network calls, ever.

## Develop

```sh
npm install
npm run fetch:ngspice   # download the bundled SPICE engine for your platform
npm run dev             # run the app in dev mode
npm test                # vitest unit + integration suite
npm run typecheck       # tsconfig.node.json + tsconfig.web.json (what CI runs)
npm run test:e2e        # Playwright E2E (requires npm run build first)
npm run build           # build the app
npm run package         # produce installers for the current platform
```

Architecture: Electron + TypeScript + React (panels) + imperative Three.js/WebGL2 (3D viewport) + zustand (state). The framework-free `src/core/` layer (KiCad parsing, netlist extraction, model resolution, SPICE-deck generation, the Board Critic) is fully unit-tested without Electron. See the [architecture reference](https://epim.github.io/circsim/reference/architecture).

## Documentation source

The docs site is a VitePress project under [`website/`](website/), deployed to GitHub Pages by [`.github/workflows/docs.yml`](.github/workflows/docs.yml) on every push touching `website/`. To work on it:

```sh
cd website && npm install && npm run docs:dev
```

## License

MIT. circsim bundles ngspice (BSD-style) and an in-house SPICE model library written from datasheet parameters; it never bundles vendor SPICE models or KiCad's share-alike 3D assets. See [`docs/licensing.md`](docs/licensing.md) and the in-app **About** dialog for full provenance.
