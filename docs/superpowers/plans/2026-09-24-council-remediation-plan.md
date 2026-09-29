# circsim Council Remediation Plan

> **For agentic workers:** this plan is executed by ONE master orchestrator that fans out subagents per task. The master reads this file and `2026-09-24-remediation-master-prompt.md`, then follows the protocol in sections 4 to 7 for every task. Each task is a GitHub issue on epim/circsim; the issue carries the evidence, the reproduction, and the suggested direction. The per-task cycle (reproduce, failing test, fix, two reviews, merge, canary) is section 4. Steps use checkbox syntax for tracking in the ledger.

**Goal:** close all 79 council issues (#2 through #80, indexed in #81) and ship circsim v0.3.0 as a validation bench whose numbers can be trusted, verified against external oracles, installable on all three platforms, and documented truthfully.

**Architecture of the work:** four waves. Wave 0 builds the external oracles and the two seams everything else depends on (the pad geometry fix and the solve-pipeline extraction). Wave 1 runs eight lanes in parallel with disjoint file ownership. Wave 2 delivers the thesis (copper in the deck, live bench at 1x, persistence, CLI). Wave 3 re-audits with a mini council, hardens, and releases.

**Tech stack:** unchanged. Electron (upgraded in lane R), TypeScript, React 18, Three.js, zustand, ngspice 46 via koffi in a utilityProcess, vitest (pool: forks), Playwright, VitePress. Node 24. KiCad 10 `kicad-cli` as a test oracle.

**Spec:** issues #2 to #80 and the verdict in #81. Founding spec `docs/superpowers/specs/2026-06-10-circsim-design.md`; product direction in the memory note `product-direction-validation-bench` (validation bench, read-only critic, never author and grader).

## Global constraints

- No emojis anywhere: code, docs, commits, PR bodies, issue comments. No em-dashes; use commas, periods, or colons (the docs site was deliberately de-em-dashed in 282324e).
- circsim never modifies a user's design files. The Board Critic stays read-only. circsim never generates a board it then grades.
- No network calls at runtime. After #38 this is enforced by the session layer, not promised in prose.
- No vendor SPICE model text in the repo. A card that is a copied vendor card is rewritten from datasheet parameters or attributed with its license (#14). A fingerprint test against known vendor cards guards this.
- No third-party board files committed to the repo. The corpus is fetched at test time from pinned URLs with sha256 (#22). The private lantern board is referenced only through the `CIRCSIM_PRIVATE_BOARDS_DIR` environment variable (#23).
- master is never force-pushed. Tags are never moved. The v0.3.0 tag is created only in wave 3.
- Every change goes through a branch and a PR, squash-merged. Commit trailer: the `Co-Authored-By` line for the model that wrote the change. Branch names: `fix/<issue>-<slug>` or `feat/<issue>-<slug>`.
- Every behavior or claim change updates `website/docs` and, where relevant, `docs/what-circsim-can-tell-you.md` in the same PR.
- CI green on every matrix leg (see `.github/workflows/ci.yml`) before merge.
- Commands: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run lint` (added in F0.1), `npm run test:e2e` (after `npm run build`), `npm run test:corpus` (added in F0.2), `npm run test:characterization` (added in F0.2).

## Review focus

The failure modes most likely to bite a real user that no single issue's test covers. Each line names the task that must add the test.

1. A rotated footprint on B.Cu after #3: pads must mirror and rotate correctly. The geometry oracle (F0.3) includes a B.Cu part at 90 degrees and asserts track endpoints land on same-net pads.
2. A rail that enters through a pour with no track (after #10 and #20): the operating point and IR-drop must not report a false error or a false zero. C1 adds a pour-only rail fixture; W2.1 asserts the copper-aware op matches the critic on it.
3. A part whose value is "4,7k" and whose BOM row carries an MPN (after #4 and #8): resolution prefers the MPN, and no part shows status ok after ngspice prints "could not find a valid modelname" for it. P2 adds this fixture and the log-to-status promotion test.
4. Reopening a board after the sidecar format changed (after #27): an older or corrupt sidecar loads what it can or reports, and never breaks the open. U2 adds a versioned-sidecar test with a v0 sidecar and a truncated file.
5. A SimHost crash mid-transient while paused (after #16 and #75): the bench returns with instruments and leads, and Run works. S4 adds an integration test that kills the child while paused and asserts port re-delivery and a working resume.

---

## 1. Roles, models, effort

The rule is the cheapest model that passes the gate. The review gate stays constant; the implementer tier moves. Model names below are the Claude Code aliases, so `sonnet` resolves to the newest Sonnet the account has.

| Role | Model | Effort | Why |
|---|---|---|---|
| Master orchestrator | `fable` | high | Long-horizon judgment on verdicts and merge order. Its token use stays small if it follows section 1a. |
| Implementer, default | `sonnet` | high | The issues carry file:line evidence, a reproduction, and a direction. That is the well-specified work Sonnet does well at a fifth of the Fable price. |
| Implementer, design-heavy task (#2, #10, #14, #20, #25, #34, #53, and the P2 bundle) | `opus` | xhigh | These need design, not just a fix. Starting them on Sonnet and failing twice costs more than starting one rung up. |
| Mechanical task (F0.1, docs copy edits, dependency bumps) | `sonnet` | medium | No deliberation needed. |
| Reviewer, medium and low severity issues | `opus` | high | One combined reviewer runs the whole section 5 checklist including the mutation check. |
| Reviewers, critical and high severity issues and every design-heavy task | `fable` adversary plus `opus` fidelity | high | Two fresh reviewers. This is where a cheaper implementer's mistakes are caught, so the adversary stays on the strongest model. |
| Wave 3 mini council | `opus` lenses, `fable` verifiers | xhigh, high | Four lenses, each finding verified before filing. |

**Escalation ladder.** An implementer that fails two review rounds is replaced one rung up: `sonnet` at high, then `opus` at xhigh, then `fable` at xhigh. The replacement gets the prior diff and the review histories. Record the rung in the ledger notes. If one lane escalates on more than a third of its tasks, start the rest of that lane one rung up.

**Severity lookup.** The issue's `severity:*` label decides the review tier: `severity:critical` and `severity:high` get two reviewers, `severity:medium` and `severity:low` get one.

## 1a. Token discipline

Usage on a subscription plan is one pool shared by the master and every subagent, weighted by model. These rules are binding.

- **Calibrate before scaling.** Run wave 0 at concurrency 4. Record the usage shown by the status command before and after in the ledger header, along with the agent count. Size wave 1 concurrency from that measurement, and tell the human the projected total before launching wave 1.
- **The master's context is the most expensive context.** The master never reads diffs, source files, or full issue bodies. It consumes ledger rows and the section 5 verdict objects, and delegates all reading. Workflow scripts return small structured objects, not prose.
- **Prompts carry pointers, not payloads.** An implementer prompt holds the issue number, the lane file list, the branch name, and one line pointing at `CLAUDE.md` for the protocol. The implementer runs `gh issue view N` itself. The protocol lives in `CLAUDE.md` so it sits in every subagent's cached prefix instead of being repeated.
- **Read narrowly.** Start from the files and lines cited in the issue. Grep before Read. Read ranges, not whole files, in `generate.ts`, `appStore.ts`, and `simhost/index.ts`.
- **Test narrowly, then once fully.** Run the touched test files while iterating. Run `npm run typecheck && npm run lint && npm test` once before the PR and once after rebase. Cross-platform runs happen only in CI. E2E runs locally only for E2E tasks.
- **One agent per file cluster.** Serial tasks in the same files go to the same agent, continued, so it does not reload the files: M1 then M2 then M3 then M7 in the macromodel libraries; V2 then V3 then V7 in the viewport; R3 then R4 in the main process; U6 with U9, and U7 with U8 and U10, in the panels; D1, D3, and D4 as one docs task.
- **Reviewers review the diff.** A reviewer reads the issue, the PR diff, and only the surrounding code it needs to judge the change. It returns the verdict object and nothing else.
- **No speculative work.** No refactor beyond the issue, no cleanup in passing, no new abstraction without a second caller. Scope creep is a REQUEST_CHANGES.
- **Stop cleanly at a limit.** On a usage-limit message: launch nothing new, let in-flight reviews finish, update the ledger, and stop. Resume from the ledger in the next window. If usage credits are enabled, the human set the cap; do not ask to raise it.

## 2. Wave plan

Issue numbers are GitHub issue numbers on epim/circsim. Read the issue before starting the task; it has the file:line evidence and the reproduction.

### Wave 0: foundations

Four tracks. F0.1, F0.2, F0.3 start together. F0.4 starts after the golden decks from F0.2 land, and runs alone in `generate.ts` and `appStore.ts`.

| Track | Issues | Deliverable | Model / effort |
|---|---|---|---|
| F0.1 Conventions and CI hygiene | #31, #54, #80 | LICENSE file; `npm run lint` with eslint fixed to zero errors and a CI step; CI runs the integration suite once per leg and uploads coverage; `CLAUDE.md` (content in section 10), `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug.md`, `.github/PULL_REQUEST_TEMPLATE.md` | sonnet / medium |
| F0.2 Oracles | #24, #22, #23, #63, #21, #67, #48 | Sample boards and schematics load in `kicad-cli`; `scripts/fetch-corpus.mjs` with a manifest (url, sha256, license, KiCad version) and `npm run test:corpus` that parses, extracts, cross-checks pad-to-net connectivity against `kicad-cli pcb export netlist`, generates the deck, and runs the op through the real-ngspice harness; a synthetic board generator `scripts/gen-synthetic-board.mjs` (rotated parts on both sides, zones, 6/8/9/10 syntax variants); private-board tests keyed on `CIRCSIM_PRIVATE_BOARDS_DIR` with a visible skip message; `resources/models/characterization.json` plus `src/simhost/__tests__/characterization.integration.test.ts` (entry, circuit, quantity, datasheet value, tolerance, source) seeded with every library entry, with `knownFailing: "#N"` entries for what lane M will fix; whole-deck goldens for the 555 sample; property tests for `sexpr/parse.ts` and `values/parseValue.ts`; critic fixtures with rotation, zones, and B.Cu | sonnet / high; three agents by file group (kicad-cli fixtures, corpus and generator, characterization and goldens) |
| F0.3 Geometry | #3 | Correct pad transform in `src/core/critic/geom.ts`, `src/renderer/src/viewport/copperGeometry.ts`, `componentGeometry.ts`, `scene.ts` (one shared helper, three call sites); the geometry oracle test in the corpus suite: for every corpus board, every pad center lies within half the pad size plus 0.1 mm of a same-net track endpoint or via, on both sides, at all rotations | sonnet / high, two reviewers |
| F0.4 Solve seam | #53 | `src/core/solve/` with `buildSolveInputs(board, circuit, resolutions, instruments, groundNetId, overrides): SolveInputs`, `runSolvePlan(inputs, engine: SolveEngine): Promise<SolveResult>` (two-pass rail sensing lives here), and `interface SolveEngine { loadCircuit(deckLines: string[]): Promise<void>; runOp(): Promise<OpResult>; runTran(tstep: number, tstop: number): Promise<TranResult> }` with two implementations: the SimHost client (renderer) and a direct in-process ngspice engine (tests and the CLI). `appStore.powerOn` becomes a thin caller. The three deck-assembly sites collapse to one. Golden decks from #67 must be byte-identical before and after. | opus / xhigh, serial |

Wave 0 exit: corpus, characterization, goldens, and geometry oracle run in CI; `#3` and `#53` merged; every later PR is gated on them.

### Wave 1: parallel lanes

Lanes run concurrently. Inside a lane, tasks that share a file run serially in the listed order. Cross-lane files (section 3) are serialized by the master.

**Lane M: model physics.** Files: `resources/models/*.lib`, `resources/models/logic*.json`, `resources/models/index.json`, `resources/models/characterization.json`, `src/core/models/__tests__/library-content.test.ts`, the digital and island sections of `src/core/spicegen/generate.ts`, `src/core/solve/`.

| Task | Issue | Notes |
|---|---|---|
| M1 | #2 | Supply-pin current conservation for opamp_core, NE555, reg_lin, dac_bridge outputs: add controlled current sources from the supply pin proportional to output current. Flip the `knownFailing` characterization entries for supply current. Hard task. |
| M2 | #13 | opamp_core pole clamp; recovery time entry in characterization. |
| M3 | #42 | Load-dependent regulator dropout; entry per regulator. |
| M4 | #41 | LED cards hit their own stated Vf targets; per-card Vf at 10 mA entry. |
| M5 | #12 | Output resistance for logic families in `logic74hc.json` and `logic4000.json` and the emitter in `generate.ts`; entry: bare LED on a CD40106 pin draws datasheet-bounded current. |
| M6 | #14 | Rewrite BJT and diode cards from datasheet parameters or attribute them; fingerprint test against the classic PSpice eval-library cards; update provenance headers, About, licensing.md, website. Hard task. |
| M7 | #19 | After M1 to M3: the 555 sample and LM358 boards converge without the fallback; the op caveat fires only when a fallback was actually used; raw stderr hidden behind a details control. |
| M8 | #44 | Undriven islands surfaced in WarningsBar with the bled nets listed; never silently 0 V. |
| M9 | #43 | Rail sensing rejects a pass-1 rail that an output loads; regression in `src/core/solve/` tests. |

**Lane C: Board Critic.** Files: `src/core/critic/**` and its tests.

| Task | Issue | Notes |
|---|---|---|
| C1 | #10 | Zones and ground in the IR-drop graph: mesh pours at a few mm; ground participates. Add the pour-only rail fixture (review focus 2). Hard task. |
| C2 | #9, #45 | All branch currents from the solve, not LED sense currents; ampacity uses per-segment current from the solved graph; remove sum/2. Consumes `SolveResult` from F0.4. |
| C3 | #11, #56 | Width-aware clearance with a spatial index; no rerun after every op unless geometry changed. |
| C4 | #46 | Thermal check either runs with real power or reports not-assessed. |
| C5 | #47 | Supply entry pad from the lead's copper position; needs the lead position field from U2 (coordinate: C5 waits for the store field, added by lane U first). |
| C6 | #69 | Tests that see copper-weight scaling and the pin-map regex case flag. |

**Lane P: parsers and resolution.** Files: `src/core/values/parseValue.ts`, `src/core/models/resolve.ts`, `src/core/models/libraryMatch.ts`, `resources/models/index.json` (pinMaps only), `src/core/bom/parseBom.ts`, `src/core/kicad/board.ts`, `src/core/kicad/outline.ts`, `src/core/kicad/schematic.ts`, `src/core/netlist/spiceNames.ts`, `src/core/netlist/extract.ts`, their tests.

| Task | Issue | Notes |
|---|---|---|
| P1 | #8 | parseValue accepts "10 kΩ", "4,7k", "100 nF", Greek mu, uppercase U/N/P; "2m2" is 2.2 milliohm; property tests extended. |
| P2 | #4, #5, #6, #7, #51 | One agent, serial: BOM rows feed resolution (MPN wins; header aliases; range expansion; errors surfaced); JLC pinMap rule replaced by schematic-first with an unverified status when no second source exists; Sim.Device D/V without params never emits a model-less card; KiCad-written Sim.Params forms handled; value-as-MPN respects refdes; ngspice "ignored" and "could not find a valid modelname" lines promoted to per-part status. Add the review-focus-3 fixture. Hard task. |
| P3 | #49, #50 | no_connect parser matches what KiCad writes; outline parser handles gr_poly and footprint Edge.Cuts; outline warnings reach the UI. |
| P4 | #52 | buildSpiceNames reserves generated suffixes; collision test. |

**Lane S: SimHost and bench engine.** Files: `src/simhost/**`, `src/main/supervisor.ts`, `src/preload/index.ts`, the crash path in the store, `src/core/spicegen/instruments.ts`, `src/core/spicegen/sanitize.ts` (new).

| Task | Issue | Notes |
|---|---|---|
| S1 | #25, #78 | Sample channel redesign: `.save` only probed nets, LED sense ammeters, and rails; typed-array decode; poll bulk node voltages at display rate via `ngGet_Vec_Info`; tstep derived from signal bandwidth instead of the 10 us cap; flush at the documented cadence. Measured target: 1x real time on the 555 sample and a lantern-class deck. Hard task. |
| S2 | #18 | validateSubckt sends multi-line subckts as separate cards; LLM paste path works end to end against real ngspice. |
| S3 | #35 | Deck gate: `sanitizeDeck(lines)` in `src/core/spicegen/sanitize.ts` rejects `.control`, `shell`, `write`, `source`, `load`, `.include`, `.lib` with path, and SimHost refuses unsanitized decks; tests with a hostile user model. |
| S4 | #16, #75 | Respawn re-delivers the port; replayAfterCrash handles paused; add the review-focus-5 integration test. |
| S5 | #74 | Triangle wave as PULSE. |

**Lane R: release, security, platform.** Files: `src/main/index.ts`, `src/preload/index.ts`, `electron-builder.yml`, `scripts/fetch-ngspice.mjs`, `scripts/build-ngspice.sh`, `scripts/license-hygiene.mjs`, `.github/workflows/ci.yml` (release job), `package.json` dependencies, `website/docs/start/install.md`, `docs/licensing.md`.

| Task | Issue | Notes |
|---|---|---|
| R1 | #34 | Electron to current stable; replace drag-drop sibling discovery with `webUtils.getPathForFile`; verify koffi and troika; packaged smoke on all legs. Hard task, serial, first in the lane. |
| R2 | #36, #15 | Pinned sha256 for the ngspice download and the source tarball; libfftw3 either statically linked or bundled and declared in deb depends; packaged Linux and macOS smoke actually launch the app. |
| R3 | #37, #39 | One CSP (no unsafe-inline), navigation guards, readFile scoped to opened-board directories; troika workers and fonts bundled so silkscreen renders offline. After R1. |
| R4 | #38 | Offline enforcement: spellchecker off, `webRequest` deny-all except `file:` and app resources, permission handler denies everything; a test asserts zero network requests during open, energize, and critic. |
| R5 | #79 | Remove electron-updater; licensing gate covers the shipped npm tree. |
| R6 | #40 | Signing and notarization pipeline in electron-builder and the release job, reading secrets if present and skipping cleanly if not; SHA256SUMS in every release; install docs rewritten for macOS 15 (no bypass claims). Certificates come from the human (section 8). |

**Lane U: UX and product surface.** Files: `src/renderer/src/**` (panels, bench, store except the crash path), `src/cli/**` (new), `src/core/persist/**` (new), `src/core/report/**` (new), `website/docs/guides/**`.

| Task | Issue | Notes |
|---|---|---|
| U1 | #28 | `src/cli/index.ts` with `circsim audit <board> [--schematic] [--json]`, `circsim deck <board>`, `circsim op <board>`, using `src/core/solve` with the in-process engine; `bin` entry; nonzero exit on error-severity findings; docs page. After F0.4. |
| U2 | #27 | Versioned sidecar `<board>.circsim.json` (ground, instruments with leads and copper position, stub, pin-map, rail overrides, user models); restore on open with a visible note; recent boards; `Export report` (markdown and print-to-PDF) via `src/core/report/`; the review-focus-4 test. After F0.4. |
| U3 | #26 | Diagnostics bundle: deck, ngspice log, board hash, crash reason, app version, as a zip; button in WarningsBar and the crash toast. |
| U4 | #32 | Energize and Power On never no-op silently; the guided states from the spec are mounted. |
| U5 | #33 | Viewport minimum size and layout at 1280x720 and the default window. |
| U6 | #70 | Voltage legend, non-color status encoding, AA contrast. |
| U7 | #71 | Clickable convergence culprit; crash toast offers restart. |
| U8 | #72 | Grouping, virtualization, ranked pickers. |
| U9 | #73 | Plain-language labels with a glossary; in-app links to the docs pages. |
| U10 | #62 | openDocs surfaces shell.openPath errors. |
| U11 | #29 | Automatic MCU stubbing by refdes, footprint, and MPN patterns; library expansion plan executed for the top 30 hobbyist parts with characterization entries. After P2. |
| U12 | #17 | Import .lib binds the real model text, never the comment stub (`src/core/models/userLibrary.ts`, `LibImport.tsx`); imported models and Model Doctor overrides persist through the U2 sidecar; real-ngspice test loads an imported subckt end to end. After U2 and S2. |

**Lane V: performance.** Files: `src/renderer/src/viewport/**`, `src/renderer/src/scope/**`, `src/core/sexpr/parse.ts`, a worker entry for board open.

| Task | Issue | Notes |
|---|---|---|
| V1 | #55 | Parse, extract, resolve, and critic off the UI thread (worker or deferred), with progress. After F0.4. |
| V2 | #57 | Instanced or merged meshes; draw-call count test on the synthetic 1500-part board. |
| V3 | #58 | Spatial index for picking; throttled pointermove. |
| V4 | #59 | Scope readWindow bounded; ring reuse. |
| V5 | #60 | Parser allocation reduction; measured on the synthetic 17 MB board. |
| V6 | #76 | Remove parts x nets and parts x library loops. After P2. |
| V7 | #77 | Uniform updates without needsUpdate. |

**Lane D: docs and positioning.** Files: `README.md`, `website/docs/**`, `docs/what-circsim-can-tell-you.md`, `resources/sample/**`.

| Task | Issue | Notes |
|---|---|---|
| D1 | #61 | One fidelity source rendered in-app and on the site. |
| D2 | #68 | After lane M: tighten test gates to match claims, or soften claims to match tests; never leave a gap. |
| D3 | #64, #65 | Reposition per the council: copper-aware validation for any routed KiCad board; the schematic is a first-class optional input; Quilter is one path in, not the hero. |
| D4 | #63 | KiCad 6 to 10 support statement backed by the corpus. |
| D5 | #30 | Screenshots and a short GIF from the E2E screenshot spec in the README; a gallery page built from the corpus boards; release-notes template. Video is for the human. |

**Lane T: tests.** Files: `e2e/**`.

| Task | Issue | Notes |
|---|---|---|
| T1 | #66 | Scope test asserts non-zero samples; critic and Model Doctor E2E paths; macOS launch in CI. |

### Wave 2: the thesis

Starts when wave 0 and lanes C, P, S1, U1, U2 are merged.

| Task | Issue | Deliverable | Model / effort |
|---|---|---|---|
| W2.1 | #20 phase 1 | `src/core/copper/` with `buildCopperNetwork(board, circuit, opts): CopperNetwork` (nodes, edges, `padNode(ref, pad)`), `emitCopperCards(network): string[]`; power and ground nets emitted as resistor networks behind `copperAware: true`; per-pad SPICE nodes; the critic's IR-drop and ampacity consume the same solve and the private solver is deleted; overlay shows per-pad voltages with an ideal-nets toggle; docs and fidelity page updated. Two agents with the interface above fixed first: core plus critic, and renderer overlay. Corpus assertion: copper-aware op matches the critic on the pour-only fixture. | opus / xhigh |
| W2.2 | #20 phase 2 | Kron-reduce each net's resistive network onto its pad terminals for the transient deck; all nets once the graph builder passes the corpus. | opus / xhigh |
| W2.3 | #25 (closure) | Live bench measured at 1x on the 555 sample and a lantern-class board with copper-aware DC; numbers recorded in the issue. | sonnet / high |

### Wave 3: re-audit, harden, release

| Task | Deliverable |
|---|---|
| W3.1 | Mini council: four lenses (analog EE, copper physics, bug hunter, security and release) over master, restricted to two questions per closed issue: is it fixed as filed, and did it regress anything. Findings verified adversarially and filed as new issues; fixed with the same protocol. |
| W3.2 | Full matrix green: corpus, characterization, unit, integration, E2E, packaged smoke on every leg; `npm audit` shows zero runtime-reachable high or critical. |
| W3.3 | Docs truth pass: one agent walks every claim in README and the website with a checklist and cites the code or test that makes it true; anything unprovable is rewritten. |
| W3.4 | Release v0.3.0: CHANGELOG grouped by council theme, version bump, tag, installers, SHA256SUMS, release notes linking #81. Signed and notarized if the human supplied certificates; otherwise unsigned with the install docs saying so plainly. |

## 3. File ownership map

| Owner | Files |
|---|---|
| Lane M | `resources/models/**` except `index.json` match blocks; `generate.ts` digital and island sections; `src/core/solve/**` rail sensing |
| Lane C | `src/core/critic/**` |
| Lane P | `src/core/values/**`, `src/core/models/resolve.ts`, `libraryMatch.ts`, `index.json` match and pinMaps blocks, `src/core/bom/**`, `src/core/kicad/**`, `src/core/netlist/**` |
| Lane S | `src/simhost/**`, `src/main/supervisor.ts`, `src/core/spicegen/instruments.ts`, `src/core/spicegen/sanitize.ts`, store crash path |
| Lane R | `src/main/index.ts`, `src/preload/index.ts`, `electron-builder.yml`, `scripts/**`, `package.json` dependencies, CI release job |
| Lane U | `src/renderer/src/**` except viewport, scope, and crash path; `src/cli/**`; `src/core/persist/**`; `src/core/report/**` |
| Lane V | `src/renderer/src/viewport/**`, `src/renderer/src/scope/**`, `src/core/sexpr/**` |
| Lane D | `README.md`, `website/**`, `docs/*.md`, `resources/sample/**` |
| Lane T | `e2e/**` |
| Master (serialized queue) | `src/core/spicegen/generate.ts` outside the M sections, `src/renderer/src/store/appStore.ts`, `src/simhost/protocol.ts`, `.github/workflows/ci.yml` test job, `package.json` scripts |

A task that must touch a file outside its lane asks the master, who either serializes it behind the owning lane's in-flight task or approves a minimal, additive change.

## 4. Per-task protocol

Every task, no exceptions.

- [ ] **Step 1: Master opens the task.** Creates worktree and branch `fix/<issue>-<slug>` from current master. Records the task in the ledger with status `in-progress`.
- [ ] **Step 2: Implementer reproduces.** Runs `gh issue view <N>` and executes the reproduction from the issue. If it no longer reproduces on master, the implementer reports that with evidence and stops; the master closes or re-scopes the issue.
- [ ] **Step 3: Failing test first.** Encodes the reproduction as a test at the right level (unit, integration against real ngspice, corpus, characterization, or E2E). Runs it and confirms it fails for the stated reason.
- [ ] **Step 4: Minimal fix.** Root cause, not symptom. If the issue's suggested direction turns out wrong on contact with the code, do the right thing and write why in the PR and as an issue comment.
- [ ] **Step 5: Verify.** `npm run typecheck && npm run lint && npm test`, plus the lane's integration suites, plus `npm run test:corpus` and `npm run test:characterization` once F0.2 exists. Paste the summary lines into the PR.
- [ ] **Step 6: Docs in the same PR** when behavior or a claim changed.
- [ ] **Step 7: Commit and push.** Small conventional commits, `fix(scope): ...` or `feat(scope): ...`, with the trailer.
- [ ] **Step 8: Open the PR.** Title `<type>(<scope>): <summary> (fixes #N)`. Body sections: What, Why (link the issue), How verified (commands and output excerpts), Out of scope, Risk.
- [ ] **Step 9: Reviewer A, the adversary.** Fresh context, model per section 1. On medium and low severity issues this reviewer also performs step 10, and step 10 is skipped. Reads the issue and the diff, tries to break the fix, reruns the reproduction, and performs the mutation check: in a scratch worktree, reverts the source change while keeping the test and confirms the test fails. Returns the structured verdict in section 5.
- [ ] **Step 10: Reviewer B, fidelity and quality.** Critical and high severity issues and design-heavy tasks only. Fresh context, model per section 1. Confirms the root cause named in the issue is addressed, no unrelated changes, docs updated, no emojis or em-dashes, no new lint errors, no corpus performance regression. Returns the structured verdict.
- [ ] **Step 11: Fix loop.** Only the requesting reviewer re-reviews. Two failed rounds trigger the ladder in section 6.
- [ ] **Step 12: Master merges.** Implementer rebases on master and re-runs step 5. Master waits for CI green on every leg, squash-merges, closes the issue via the PR, posts a one-line issue comment with the PR link and the verification evidence, updates the ledger.
- [ ] **Step 13: Canary.** On master after every merge: `npm run typecheck && npm test && npm run test:corpus && npm run test:characterization`. Any failure: immediate revert PR, issue reopened, task reassigned with the failure attached.

## 5. Reviewer verdict schema

Both reviewers return exactly this object.

```json
{
  "verdict": "APPROVE | REQUEST_CHANGES",
  "blocking": [{ "file": "", "line": 0, "problem": "", "evidence": "" }],
  "non_blocking": [{ "file": "", "line": 0, "suggestion": "" }],
  "repro_rerun": "PASS | FAIL | NOT_APPLICABLE",
  "mutation_check": { "performed": true, "test_failed_without_fix": true },
  "docs_updated": "YES | NO | NOT_NEEDED",
  "scope_creep": "NONE | <description>"
}
```

A PR merges only with an APPROVE from every reviewer its tier requires, `repro_rerun` not FAIL, and `mutation_check.test_failed_without_fix` true where a test was added.

## 6. Escalation and retry

- Two failed review rounds: the master replaces the implementer one rung up the ladder in section 1, with the prior diff, the review histories, and the issue; the old branch is kept for reference.
- Failure at the top rung: the master splits the issue into sub-issues (filed on GitHub, linked to the parent) or marks it `blocked` with a rationale comment and moves on. Never merge on REQUEST_CHANGES.
- Canary failure that the revert does not clear: the master stops the lane, runs `git bisect` between the last green canary and HEAD, and files the finding.
- An implementer that stops early, claims completion without pasted verification output, or modifies files outside its lane is replaced, not argued with.

## 7. Ledger and reporting

- `docs/superpowers/plans/2026-09-24-remediation-ledger.md`: one row per issue with lane, status (`todo`, `in-progress`, `in-review`, `merged`, `reverted`, `blocked`, `wontfix`), branch, PR, review rounds, merged sha, notes. Updated on every transition. This is the resume point after any crash.
- At the end of each wave, a comment on #81 with counts by status, what was deferred and why, and the measured numbers that changed (corpus pass count, characterization pass count, live-bench real-time factor, npm audit).
- The master does not ask the human anything except the items in section 8. Product decisions the issues leave open are decided the way the issue recommends and recorded in the PR.

## 8. Needs the human

- Code-signing certificates: Apple Developer ID Application certificate and notarytool credentials; Windows Authenticode certificate. R6 builds the pipeline to use them from CI secrets and skips cleanly without them.
- `CIRCSIM_PRIVATE_BOARDS_DIR` set locally if the lantern board should be exercised on this machine (it is never committed).
- A demo video for #30, if wanted. The README GIF is produced by D5.
- Token budget approval if the run should be capped.

## 9. Definition of done: v0.3.0

- Every issue from #2 to #80 is `merged`, or `blocked`/`wontfix` with a rationale comment the human could disagree with.
- `npm run test:corpus` passes on at least eight KiCad-written boards spanning KiCad 6 to 10, both copper sides, rotated parts, and zones; pad-to-net connectivity matches `kicad-cli` on every one.
- `npm run test:characterization` covers every library entry with at least one datasheet quantity, including supply-pin current and output drive for every IC, and passes with zero `knownFailing` entries.
- Copper-aware operating point ships behind a toggle; the critic reads currents from the same solve; the private solver is gone.
- The live bench sustains 1x real time on the bundled sample and a lantern-class board, measured and recorded.
- The bundled sample opens with no fallback, no error toast, and no raw stderr.
- Electron is a supported version; `npm audit` shows zero runtime-reachable high or critical; zero network requests during a full session, asserted by a test.
- Bench state survives reopen and restart; a report can be exported; `circsim audit` runs headless.
- Every claim in README and the website is backed by a cited test or code path.
- Installers for all three platforms, with SHA256SUMS, and signed if certificates were provided.

## 10. Task F0.1 deliverable: repository `CLAUDE.md`

Write this file at the repo root verbatim (adjust only if a command name changes).

```markdown
# circsim conventions

circsim is a validation bench for routed KiCad boards: Electron + TypeScript + React + Three.js, ngspice 46 via koffi in a crash-isolated utilityProcess. `src/core` is pure TypeScript with no Electron, React, or Three imports; keep it that way.

## Commands
- `npm run typecheck` (both tsconfigs, what CI runs)
- `npm run lint` (eslint, zero errors required)
- `npm test` (vitest unit + integration; pool forks, one ngspice per process)
- `npm run test:integration` (real ngspice)
- `npm run test:corpus` (KiCad-written boards, fetched with pinned hashes)
- `npm run test:characterization` (model library vs datasheet values)
- `npm run test:e2e` after `npm run build`

## Rules
- No emojis in code, docs, commits, or PR text. No em-dashes; use commas, periods, or colons.
- circsim never modifies a user's design files. The Board Critic is read-only. circsim never generates a board it then grades.
- No network calls at runtime. No vendor SPICE model text in the repo.
- No third-party board files committed; the corpus is fetched at test time.
- Every behavior change updates `website/docs` in the same PR.
- Branch per task: `fix/<issue>-<slug>`; squash-merge; commit trailer is the `Co-Authored-By` line for the model that wrote the change.
- Reproduce first, write the failing test, then fix. Paste verification output in the PR.

## Task protocol (every task)
1. `gh issue view N`; run the reproduction. If it no longer reproduces on master, report with evidence and stop.
2. Write a test that encodes the reproduction; confirm it fails for the stated reason.
3. Fix the root cause named in the issue. If the direction in the issue is wrong on contact with the code, do the right thing and say why in the PR.
4. Iterate on the touched test files. Then run `npm run typecheck && npm run lint && npm test` once, plus the corpus and characterization suites.
5. Update docs in the same PR when behavior or a claim changed.
6. Open the PR: title `<type>(<scope>): <summary> (fixes #N)`; body sections What, Why, How verified, Out of scope, Risk.
7. Stay inside the files your lane owns. No refactors beyond the issue. Grep before Read; read ranges in the large files.

## Where things are
- KiCad parsing: `src/core/kicad`, `src/core/sexpr`. Netlist: `src/core/netlist`. Models: `src/core/models`, `resources/models`. Deck: `src/core/spicegen`. Solve pipeline: `src/core/solve`. Critic: `src/core/critic`. Copper network: `src/core/copper`.
- SimHost (ngspice FFI): `src/simhost`. Main process: `src/main`. Preload bridge: `src/preload`. Renderer: `src/renderer/src` (store, viewport, panels, bench, scope). CLI: `src/cli`.
- Specs and plans: `docs/superpowers`. Council review and index: GitHub issue #81.
```
