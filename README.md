# circsim

Desktop app (Windows / macOS / Linux) that loads a Quilter-routed KiCad board (`.kicad_pcb`), renders it in 3D, and lets you validate it with an interactive SPICE simulation — apply power, toggle inputs, and probe nets on the physical board before sending it for fabrication.

**Status:** design complete; implementation not started.

| Document | Purpose |
|---|---|
| [`docs/superpowers/specs/2026-06-10-circsim-design.md`](docs/superpowers/specs/2026-06-10-circsim-design.md) | Architecture & design specification (canonical) |
| [`docs/superpowers/plans/2026-06-10-circsim-implementation-plan.md`](docs/superpowers/plans/2026-06-10-circsim-implementation-plan.md) | Task-by-task implementation plan for executing agents |

**Stack (decided):** Electron + TypeScript + React + Three.js (WebGL2) for the 3D UI; ngspice ≥ 46 as `libngspice` via koffi FFI in a crash-isolated utility process; CPU SPICE solving (GPU is for rendering/overlays — see spec §5.1 decision record).
