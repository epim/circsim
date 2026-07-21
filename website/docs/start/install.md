# Install circsim

circsim is a desktop app for **Windows, macOS, and Linux**. It is fully offline — nothing you open is ever uploaded, and the app makes no network calls. Download one file, run it, and you're on the bench.

## Download

Grab the latest installer for your platform from the [releases page](https://github.com/epim/circsim/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| **Windows (x64)** | `circsim-<version>-x64-setup.exe` | NSIS installer |
| **macOS (Apple Silicon)** | `circsim-<version>-arm64.dmg` | M1/M2/M3/M4 Macs |
| **macOS (Intel)** | `circsim-<version>-x64.dmg` | Intel Macs |
| **Linux (AppImage)** | `circsim-<version>-x86_64.AppImage` | Portable, runs anywhere |
| **Linux (Debian/Ubuntu)** | `circsim-<version>-amd64.deb` | `sudo dpkg -i …` |

Each installer bundles its own SPICE engine and model library — there is nothing else to install, no toolchain, no Python, no ngspice on your PATH.

## First-run security prompts

The installers are **unsigned**. That's a deliberate choice, not an oversight — code-signing certificates tie a build to a legal identity, and circsim ships without one for now. The app itself is unchanged by this; you just have to tell your OS you trust it the first time.

::: details Windows — SmartScreen
On first launch Windows SmartScreen may show *"Windows protected your PC."* Click **More info → Run anyway**. This appears once.
:::

::: details macOS — Gatekeeper
Gatekeeper blocks unsigned apps by default. After dragging circsim to Applications:

- **Right-click** the app → **Open** → **Open** in the dialog, **or**
- remove the quarantine flag from a terminal:
  ```sh
  xattr -dr com.apple.quarantine /Applications/circsim.app
  ```

This is a one-time step per install.
:::

::: details Linux — AppImage
Mark it executable and run it:
```sh
chmod +x circsim-*-x86_64.AppImage
./circsim-*-x86_64.AppImage
```
On some distros you may need FUSE (`sudo apt install libfuse2`).
:::

## What you'll need to feed it

circsim opens a **routed KiCad board** — a `.kicad_pcb` file (KiCad 6 or newer). That's the one required input; the circuit is rebuilt straight from the copper. Two optional inputs make the simulation sharper:

- the matching **`.kicad_sch` schematic** — the only source of KiCad `Sim.*` fields and of symbol pin names (which resolve diode/LED polarity from the design instead of a guess), and
- a **BOM CSV** with a manufacturer part-number column, to pin down exact parts.

Don't have a board handy? That's fine — circsim ships with two sample projects you can open from the start screen. Head to [your first five minutes](./first-run) next.

## System requirements

- A GPU that supports WebGL2 (any integrated graphics from the last decade). The 3D board renders at 60 fps on integrated graphics.
- ~250 MB of disk for the installed app.
- No internet connection required, ever.
