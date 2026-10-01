# Install circsim

circsim is a desktop app for **Windows, macOS, and Linux**. It is fully offline: nothing you open is ever uploaded, and the app makes no network calls. Download one file, run it, and you're on the bench.

## Download

Grab the latest installer for your platform from the [releases page](https://github.com/epim/circsim/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| **Windows (x64)** | `circsim-<version>-x64-setup.exe` | Standard Windows installer: run it and follow the prompts |
| **macOS (Apple Silicon)** | `circsim-<version>-arm64.dmg` | M1/M2/M3/M4 Macs |
| **macOS (Intel)** | `circsim-<version>-x64.dmg` | Intel Macs |
| **Linux (AppImage)** | `circsim-<version>-x86_64.AppImage` | Portable, runs anywhere |
| **Linux (Debian/Ubuntu)** | `circsim-<version>-amd64.deb` | `sudo dpkg -i …` |

Each installer bundles its own SPICE engine and model library. There is nothing else to install: no toolchain, no Python, no ngspice on your PATH.

## Verify your download

Every release includes a `SHA256SUMS` file next to the installers. Download it from the same release page and compare before you run anything. The installers are not signed yet (see below), so the checksum is the way to confirm the file is the one that was published.

::: details Windows (PowerShell)
```powershell
Get-FileHash .\circsim-<version>-x64-setup.exe -Algorithm SHA256
```
Compare the `Hash` value with the line for that file in `SHA256SUMS`.
:::

::: details macOS
```sh
shasum -a 256 circsim-<version>-arm64.dmg
```
Compare the output with the line for that file in `SHA256SUMS`. Or check everything you downloaded at once, from the folder that holds both:
```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```
:::

::: details Linux
```sh
sha256sum -c SHA256SUMS --ignore-missing
```
:::

## First-run security prompts

The installers are **not signed or notarized** yet. Code-signing certificates tie a build to a legal identity, and circsim has not bought one. The pipeline that will sign and notarize releases is in place and switches on when the certificates exist; until then your OS will warn you the first time you open the app, and you decide whether to allow it. The app itself is the same either way.

::: details Windows: SmartScreen
On first launch Windows SmartScreen may show *"Windows protected your PC."* Click **More info**, then **Run anyway**. This appears once.
:::

::: details macOS 15 (Sequoia) and later: Privacy & Security
macOS 15 no longer offers an Open choice when you Control-click an app that is not signed and notarized. Allow it from System Settings instead:

1. Drag circsim to Applications and open it. macOS shows a dialog saying it could not verify circsim is free of malware. Click **Done** (do not choose Move to Bin).
2. Open **System Settings > Privacy & Security** and scroll down to the **Security** section.
3. Find the message that circsim was blocked and click **Open Anyway**. The button is only offered for a limited time after the blocked launch, so if it is missing, open circsim again and return here.
4. Enter your password or use Touch ID, then click **Open Anyway** in the confirmation dialog.

macOS remembers the choice for that copy of the app. A new download asks again.

If you would rather do it from a terminal, this removes the download's quarantine flag, which is the marker macOS uses to decide whether to check the app. Only run it on a file whose checksum you verified above:
```sh
xattr -dr com.apple.quarantine /Applications/circsim.app
```
:::

::: details macOS 14 (Sonoma) and earlier
After dragging circsim to Applications, Control-click the app, choose **Open**, then click **Open** in the dialog. You only do this once per install. The Privacy & Security steps above also work on these versions.
:::

::: details Linux: AppImage
Mark it executable and run it:
```sh
chmod +x circsim-*-x86_64.AppImage
./circsim-*-x86_64.AppImage
```
On some distros you may need FUSE (`sudo apt install libfuse2`).

The Debian package (`.deb`) and the AppImage bundle everything circsim needs beyond the standard C and C++ runtime.

**Already on v0.2.x?** Those Linux builds link the FFTW library without shipping it. If the app opens but never powers on (the log shows `SimHost start failed` and a missing `libfftw3.so.3`), install it once and relaunch:
```sh
sudo apt install libfftw3-double3
```
Newer builds no longer need it.
:::

## What you'll need to feed it

circsim opens a **routed KiCad board**: a `.kicad_pcb` file (KiCad 6 to 10). That's the one required input; the circuit is rebuilt straight from the copper. Two optional inputs make the simulation sharper:

- the matching **`.kicad_sch` schematic**, found automatically when it has the same name as the board and sits in the same folder: the only source of KiCad `Sim.*` fields and of symbol pin names (which resolve diode/LED polarity from the design instead of a guess), and
- a **BOM** (bill of materials, a spreadsheet listing every part) as a CSV with a manufacturer part-number column, to pin down exact parts.

Don't have a board handy? That's fine: circsim ships with two sample projects you can open from the start screen. Head to [your first five minutes](./first-run) next.

## System requirements

- A GPU that supports WebGL2 (any integrated graphics from the last decade). The 3D board renders at 60 fps on integrated graphics.
  Without a usable GPU (some virtual machines, remote desktops), circsim falls back to a software renderer. If WebGL cannot start at all, the 3D view shows a notice and the parts list, bench, and simulation results keep working.
- A display of at least 1280 x 800. The window opens at that size and has no smaller layout, so a smaller screen will clip it.
- ~250 MB of disk for the installed app.
- No internet connection required, ever.
