# Contributing to circsim

circsim is a validation bench for routed KiCad boards. Read `CLAUDE.md` for the
project conventions; they apply to human contributors too.

## Setup

- Node 24 and npm.
- `npm ci`
- `npm run fetch:ngspice` (Windows) or `bash scripts/build-ngspice.sh` (macOS, Linux)
  to place the ngspice shared library under `resources/ngspice/<platform>/`.

## Checks

Run these before opening a PR:

- `npm run typecheck`
- `npm run lint` (zero errors and zero warnings)
- `npm test` (unit tests plus the real-ngspice integration tests; each test file runs in its own process because libngspice is a process-global singleton)
- `npm run test:e2e` after `npm run build`, when you touch the app shell or renderer

## Architecture rule

`src/core` is pure TypeScript. It must not import `electron`, `react`, or
`three`. The lint config enforces this.

## Pull requests

- Branch per change: `fix/<issue>-<slug>` or `feat/<issue>-<slug>`.
- Reproduce the problem first, write a failing test, then fix the root cause.
- Update `website/docs` in the same PR when behavior or a claim changes.
- No emojis and no em-dashes in code, docs, commits, or PR text.
- circsim never modifies a user's design files, and makes no network calls at runtime.
- Do not commit third-party board files or vendor SPICE model text. See `docs/licensing.md`.
- PRs are squash-merged. Fill in the PR template: What, Why, How verified, Out of scope, Risk.

## License

By contributing you agree that your contribution is licensed under the MIT
license in `LICENSE`.
