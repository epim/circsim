# Council remediation ledger

Resume point for the master orchestrator. One row per issue. Status values: todo, in-progress, in-review, merged, reverted, blocked, wontfix. Update on every transition.

Baseline on master (2026-09-29): commit 53524e3, typecheck clean, unit tests 1633 passing (87 files), integration 43 passing (9 files), corpus n/a, characterization n/a.

Setup notes: Node v24.14.0. kicad-cli 10.0.3 is installed at `C:Program FilesKiCad.0inkicad-cli.exe` and is not on PATH. `resources/ngspice/win32-x64/` is gitignored, so fresh worktrees copy it from the main checkout or run `npm run fetch:ngspice`.

Usage: the master cannot read the status command. Wave 0 usage before: not recorded by the agent (human reading requested). Agent counts are recorded per wave below.

| Issue | Lane | Status | Branch | PR | Rounds | Merged sha | Notes |
|---|---|---|---|---|---|---|---|
| #31 No LICENSE file in the repo: MIT is claimed everywhere but GitHub reports no license | W0/F0.1 | merged | fix/31-conventions-ci | #82 | 1 | 6a66cc7 | both reviewers APPROVE, sonnet rung; merged 2026-09-30, canary green (typecheck, lint, 1641 unit) |
| #54 eslint is configured but never run: no lint script, no CI step, 12 errors today | W0/F0.1 | merged | fix/31-conventions-ci | #82 | 1 | 6a66cc7 | both reviewers APPROVE, sonnet rung; merged 2026-09-30, canary green (typecheck, lint, 1641 unit) |
| #80 CI runs the ngspice integration suite twice per leg; coverage is configured but never run | W0/F0.1 | merged | fix/31-conventions-ci | #82 | 1 | 6a66cc7 | both reviewers APPROVE, sonnet rung; merged 2026-09-30, canary green (typecheck, lint, 1641 unit) |
| #21 Model library tests check text, not physics: add a datasheet characterization suite as the shipping gate | W0/F0.2 | in-review | fix/21-characterization-goldens | #88 | 1 | | both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #22 No real-board regression corpus: CI validates on 7 parts and no realistic sample board ships | W0/F0.2 | in-review | fix/22-corpus-generator | #89 | 1 | | both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #23 Real-board regression tests hard-code a C:\Users\bear path and skip silently in CI | W0/F0.2 | in-review | fix/22-corpus-generator | #89 | 1 | | both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #24 Shipped sample boards and both schematics fail to load in KiCad (kicad-cli 10.0.3) | W0/F0.2 | merged | fix/24-kicad-cli-fixtures | #83 | 2 | 9d8d74a | both reviewers APPROVE after 1 fix round, sonnet rung; merged 2026-09-30, canary green (1662 unit); kicad-load CI job still owed (master-owned ci.yml) |
| #48 Critic tests use only unrotated, zone-free, F.Cu-only boards; fixtures have no real layout | W0/F0.2 | in-review | fix/22-corpus-generator | #89 | 1 | | both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #63 KiCad 10 unmentioned; name-only net format misattributed to KiCad 9; no 6/8/9 fixtures | W0/F0.2 | in-review | fix/22-corpus-generator | #89 | 1 | | fixtures here; support statement closes in D4; both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #67 Deck generation has no whole-deck golden for a shipped sample and no property tests | W0/F0.2 | in-review | fix/21-characterization-goldens | #88 | 1 | | both reviewers APPROVE, sonnet rung; master merged in, CI green on all 6 legs 2026-09-29; MERGE-READY, waiting on the human go-ahead |
| #3 Footprint pad rotation has the wrong handedness: rotated parts get mirrored pads in critic, picking and 3D view | W0/F0.3 | merged | fix/3-pad-rotation | #84 | 1 | 772f7e7 | both reviewers APPROVE, sonnet rung; merged 2026-09-30, canary green (typecheck, lint, 1650 unit) |
| #53 Extract the solve pipeline from appStore and generate.ts into core: deck inputs are assembled in three places | W0/F0.4 | todo | | | 0 | | |
| #2 IC macromodels draw no load current from their supply pins (KCL violated) | M | todo | | | 0 | | |
| #12 Logic outputs have no output resistance: a bare LED on a CD40106 pin sims at 1.5 A | M | todo | | | 0 | | |
| #13 opamp_core pole node winds up to hundreds of volts; saturation recovery is 100x too slow | M | todo | | | 0 | | |
| #14 Bundled BJT and diode .model cards are copied PSpice/LTspice library cards, not in-house datasheet fits | M | todo | | | 0 | | |
| #19 Convergence fallback is the normal path for NE555/LM358 boards; the bundled 555 sample opens on errors | M | todo | | | 0 | | |
| #41 Bundled LED model cards miss the Vf targets stated in led.lib and no test checks them | M | todo | | | 0 | | |
| #42 Linear regulator dropout is a load-independent constant while the docs say to trust dropout | M | todo | | | 0 | | |
| #43 Floating islands are bled to 0 V silently; undriven nets are never surfaced to the user | M | todo | | | 0 | | |
| #44 Rail sensing commits a biased pass-1 rail when an output loads the sensed VDD | M | todo | | | 0 | | |
| #9 Critic currents are LED-only: IR-drop and ampacity report clean on LED-less rails while claiming real currents | C | todo | | | 0 | | |
| #10 IR-drop check ignores copper zones and ground: silent on pour-fed rails, false error on pour plus stub | C | todo | | | 0 | | |
| #11 Clearance check compares track centerlines and ignores width, so overlapping copper passes | C | todo | | | 0 | | |
| #45 Ampacity misses a 1 A LED on a 0.6 A track: sum/2 halves the current when the source has none | C | todo | | | 0 | | |
| #46 Thermal check can never fire in the app but is reported as run, not as not-assessed | C | todo | | | 0 | | |
| #47 IR-drop check guesses the supply entry pad because bench leads store no board position | C | todo | | | 0 | | |
| #56 Clearance check is quadratic in track count and reruns synchronously after every op | C | todo | | | 0 | | |
| #69 Core suite cannot see copper-weight scaling in IR-drop and ampacity or the pin-map regex case flag | C | todo | | | 0 | | |
| #4 BOM import is a no-op: resolvePart never reads the BOM although docs say it wins | P | todo | | | 0 | | |
| #5 JLC pad-1-anode footprint rule is wrong for 3 of 4 JLC diodes on the reference board | P | todo | | | 0 | | |
| #6 Tier 1 emits model-less diode and valueless source cards for Sim.Device D/V without params | P | todo | | | 0 | | |
| #7 KiCad-written Sim.Params (c="", lowercase keys, Sim.Device=SPICE) yield ignored or blocked parts | P | todo | | | 0 | | |
| #8 parseValue rejects common real-world spellings (10 kΩ, 4,7k, 100 nF, Greek mu, uppercase U/N/P) and misreads 2m2 | P | todo | | | 0 | | |
| #49 Floating check warns on every NC-marked IC pin; no_connect parser matches a format KiCad never writes | P | todo | | | 0 | | |
| #50 Outline parser ignores gr_poly and footprint Edge.Cuts; outline warnings never reach the UI | P | todo | | | 0 | | |
| #51 Value-as-MPN matching ignores refdes and the LED fallback tier is always ambiguous | P | todo | | | 0 | | |
| #52 buildSpiceNames does not reserve generated _N suffixes, so two nets can share a SPICE node | P | todo | | | 0 | | |
| #16 SimHost respawn never re-delivers the port; the bench stays dead until app restart | S | todo | | | 0 | | |
| #18 Ask-your-LLM validation always fails: multi-line subckt sent to ngspice as one card | S | todo | | | 0 | | |
| #25 Live bench tops out near 0.5x real time for any deck; 1x pace is unreachable at the 10 us tstep cap | S | todo | | | 0 | | |
| #35 Deck has no gate: a .control block inside a user model executes in SimHost on load | S | todo | | | 0 | | |
| #74 Function generator triangle wave is emitted as SIN; an exact PULSE form is available | S | todo | | | 0 | | |
| #75 replayAfterCrash has no paused branch; Run after a crash-while-paused sends a dead resume | S | todo | | | 0 | | |
| #78 Samples flush at 50 ms, not the documented 16 ms: the age check lives in the pacing tick | S | todo | | | 0 | | |
| #15 Linux deb and AppImage ship a libngspice.so that needs libfftw3.so.3 but never declare or bundle it | R | todo | | | 0 | | |
| #34 Electron 30.5.1 is 23 months past EOL; upgrading past 32 breaks drag-drop sibling discovery | R | todo | | | 0 | | |
| #36 ngspice download and source build have no pinned hash; CI cache and release trust the network | W0 prereq (from R2) | merged | fix/36-ngspice-pinned-download | #90 | 1 | 4a943b6 | pulled forward 2026-09-29 (SourceForge moved ngspice 46 to old-releases); merged on the human's instruction; canary green (typecheck, 1641 unit); #15 stays in R2 |
| #37 Renderer hardening: header CSP allows unsafe-inline, no navigation guards, readFile IPC reads any path | R | todo | | | 0 | | |
| #38 Offline promise is unenforced: the spellchecker dictionary download path to gvt1.com is live | R | todo | | | 0 | | |
| #39 Silkscreen text never renders: CSP blocks troika's worker scripts and CDN fonts | R | todo | | | 0 | | |
| #40 macOS install docs describe a Gatekeeper bypass Sequoia removed; no checksums or signing plan | R | todo | | | 0 | | |
| #79 electron-updater is a never-imported prod dependency packed into app.asar and missing from licensing.md | R | todo | | | 0 | | |
| #17 Model Doctor: Import .lib stores a comment stub as the model text, and imports and overrides are never persisted | U | todo | | | 0 | | |
| #26 No way to export the deck, ngspice log, or crash reason when a board reads wrong | U | todo | | | 0 | | |
| #27 Nothing survives reopen or restart: ground, bench, stubs, pin-map and rail overrides, and results exist only on screen | U | todo | | | 0 | | |
| #28 No headless CLI: critic, deck generation and op solve are reachable only through the GUI | U | todo | | | 0 | | |
| #29 No automatic MCU stubbing and a 51-entry model library leave target boards mostly unmodeled | U | todo | | | 0 | | |
| #32 Energize and Power On no-op silently on auto-named nets; the spec's guided states were never mounted | U | todo | | | 0 | | |
| #33 3D board collapses to 84 px at the default window size and to 4 px at 720p | U | todo | | | 0 | | |
| #62 openDocs discards shell.openPath's error string; the fidelity link can fail silently | U | todo | | | 0 | | |
| #70 Color-only status and voltage encoding, no voltage legend, and sub-AA contrast on hints | U | todo | | | 0 | | |
| #71 Convergence culprit is not clickable and the fatal crash toast offers no restart | U | todo | | | 0 | | |
| #72 List panels have no grouping or virtualization; supply picker and ground quick-picks are unranked | U | todo | | | 0 | | |
| #73 Primary-flow labels use untranslated SPICE jargon and the app never links to its docs | U | todo | | | 0 | | |
| #55 Board open runs parse, resolve, critic and copper build synchronously on the UI thread | V | todo | | | 0 | | |
| #57 Viewport draw calls scale with nets, footprints and silkscreen strings (about 4300 on a 1500-part board) | V | todo | | | 0 | | |
| #58 Hover picking raycasts every copper triangle on every unthrottled pointermove | V | todo | | | 0 | | |
| #59 Scope frame cost grows with run length: linear readWindow, per-column net search, duplicate rings | V | todo | | | 0 | | |
| #60 Board parse allocates about 30x the file size on the renderer thread, mostly discarded | V | todo | | | 0 | | |
| #76 resolveAll and generateDeck have parts x nets and parts x library quadratic loops | V | todo | | | 0 | | |
| #77 Overlay tint and hover write material.needsUpdate for uniform-only changes | V | todo | | | 0 | | |
| #30 One installer download across nine releases: the project has no discovery or trust path | D | todo | | | 0 | | |
| #61 Bundled fidelity doc drifted from the website page and opens as raw markdown | D | todo | | | 0 | | |
| #64 Hero narrative is Quilter-first while the product and half the docs already serve any KiCad board | D | todo | | | 0 | | |
| #65 Positioning says no schematic needed, but the Quilter user has one and fidelity depends on it | D | todo | | | 0 | | |
| #68 Fidelity page promises NE555 few-percent accuracy and 74HC timing; tests gate at 20 percent | D | todo | | | 0 | | |
| #66 E2E gaps: scope pixel check passes with zero samples, no critic path, no mac launch | T | todo | | | 0 | | |
| #20 Put the routed copper into the SPICE deck: op-point cost is small and it delivers the thesis | W2 | todo | | | 0 | | |
| #85 74HC74, 74HC164 and 74HC595 active-low PRE_N, CLR_N and MR_N controls behave active-high | M | todo | | | 0 | | filed by F0.2c characterization (knownFailing) |
| #86 DSMAJ24A TVS forward path inherits the 1.16 ohm clamp series resistance: 1.87 V at 1 A | M | todo | | | 0 | | filed by F0.2c characterization (knownFailing) |
| #87 LM358 output low level is 69 mV against a 20 mV maximum (rout=100 ohm in the output stage) | M | todo | | | 0 | | filed by F0.2c characterization (knownFailing) |

## Wave log

- Wave 0 workflow A (F0.1, F0.2a, F0.2b, F0.2c, F0.3): 18 agents, 1,978,450 subagent tokens, 48 min wall clock, concurrency 4. One fix round total (F0.2a), zero escalations.
- Wave 0 CI unblock (#36, PR #90): 2 agents, 189,090 subagent tokens, 28 min. One review round, sonnet rung.
- 2026-09-29 12:45 PDT: master attempted the squash-merge of #90; the session permission layer denied merges. Merge queue on hold: #90, then rebase and re-verify #82, #84, #83, #89, #88 in that order. F0.4 (#53) not started.
- 2026-09-29 14:25 PDT: #90 merged on the human's instruction, canary green. Each later merge needs the human's go-ahead unless a permission rule is added. PR branches are updated by merging master in (no force-push), then squash-merged.
- Wave 0 branch update (#82, #84, #83, #89, #88): 5 agents, 241,853 subagent tokens, 21 min. No conflicts. All five PRs CI green on every leg, verified by the master with gh pr checks. Merge order: #82, #84, #83, #89, #88; merge master into the next branch and re-verify after each.
