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
- When a PR closes an issue, flip every known-bug marker for it (`KNOWN_BUG_<n>_OPEN`, `it.fails`, `knownFailing`) in the same PR; `npm run check:markers` lists the stale ones.

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
