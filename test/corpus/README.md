# Real-board corpus

`npm run test:corpus` runs circsim against KiCad-written boards it did not author and
against KiCad itself. It exists because every v0.2.x fix came from one private board and
CI only ever saw seven-part fixtures (issue #22).

## What runs

| File | What it checks |
|---|---|
| `pipeline.corpus.test.ts` | Per board: header format version matches the manifest, `parseBoard`, `extract`, `resolveAll`, `generateDeck` finish inside a time budget, the deck has no NaN or undefined numbers, and pad-to-net connectivity equals KiCad's. Writes per-board metrics. |
| `op.corpus.test.ts` | The generated deck goes through the real bundled libngspice for an operating point inside a time budget; values are finite and the bench supply node is sane. |
| `padpos.corpus.test.ts` | `padWorldPos` against KiCad's pad centres on every corpus pad. Marked as a known defect (#3) until the pad rotation fix lands. |
| `synthetic.corpus.test.ts` | The synthetic boards (below) against kicad-cli: KiCad loads all five syntax dialects, agrees on every pad position and net, and reports zero unconnected items on the routed board. |
| `private.corpus.test.ts` | Your own boards, from `CIRCSIM_PRIVATE_BOARDS_DIR`. |

## The corpus

`scripts/corpus-manifest.json` lists 16 boards from the KiCad source repository's demo
directory at fixed release tags (6.0.11, 7.0.11, 8.0.9, 9.0.9, 10.0.3), so each KiCad format
generation from 20211014 to 20260206 is represented by files that generation wrote. Each entry
has a URL, a sha256, a license, the KiCad major and the file format version.
`node scripts/fetch-corpus.mjs` downloads them into `.corpus-cache/` (gitignored) and refuses
a file whose hash differs. Nothing from the corpus is committed: the repository holds no
third-party board files. Licenses recorded as `none-declared` mean the demo directory has no
LICENSE file; those boards are fetch-only inputs and are never redistributed. The one
NC-licensed demo (StickHub) is deliberately not in the list.

Add a board: append an entry with an empty `sha256`, run `node scripts/fetch-corpus.mjs --pin`,
then `CIRCSIM_CORPUS_UPDATE_ORACLE=1 npm run test:corpus` and `npm run corpus:baseline`, and
commit `scripts/corpus-manifest.json`, `test/corpus/oracle.json` and `test/corpus/baseline.json`.

A board circsim rejects today carries `knownFailing` in the manifest (stage, issue, message
substring). The suite then requires that exact failure, so a fix shows up as a test failure that
says to delete the marker. Currently: `k9-royalblue-feather` (a missing paren KiCad tolerates, #22).

## The KiCad oracle

`kicad-cli pcb export ipc2581` lists every pad with its net (untruncated) and its world position
as KiCad computed it. IPC-D-356 is not used: it truncates net names to 14 characters.
kicad-cli is found from `CIRCSIM_KICAD_CLI`, then `PATH`, then the default install locations;
`CIRCSIM_KICAD_CLI=none` forces the no-KiCad path.

- With kicad-cli, connectivity is compared live. The comparison is by partition (a bijection
  between circsim nets and KiCad nets), because KiCad may rename a net, for example GND to GND_2
  when an inner copper layer is called GND.
- Without kicad-cli (CI), `test/corpus/oracle.json` holds a sha256 of KiCad's partition for each
  board, and circsim's partition must hash to the same value. Regenerate with
  `CIRCSIM_CORPUS_UPDATE_ORACLE=1 npm run test:corpus` on a machine with kicad-cli.

## Metrics and drift

Each run writes `test-results/corpus/metrics/<id>.json` and `scripts/corpus-metrics.mjs` merges
them into `test-results/corpus/metrics.json` (upload that as the CI artifact) and prints every
figure that differs from `test/corpus/baseline.json`: parts, resolved percent per tier, islands,
outline warnings, deck size, op supply voltage. Drift is a review item, not a failure. Run
`npm run corpus:baseline` to accept it. `node scripts/corpus-metrics.mjs --check` exits non-zero on drift.

## Synthetic boards

`scripts/gen-synthetic-board.mjs` writes deterministic, hand-authored boards in the syntax of
KiCad 6, 7, 8, 9 or 10: rotated footprints at 30, 45, 90 and 270 degrees, back-side parts,
B.Cu tracks, vias, pours, and a lantern-shaped connectivity preset. They are committed under
`fixtures/synthetic/` (regenerate with `node scripts/gen-synthetic-board.mjs --write-fixtures`)
and are only trusted because `synthetic.corpus.test.ts` proves with kicad-cli that KiCad reads
them the way the generator says. `fixtures/synthetic/routed-rotated-kicad10.kicad-pads.json`
holds KiCad's pad centres for the routed board so the unit suites can assert against KiCad's
numbers without KiCad installed.

## Private boards

Set `CIRCSIM_PRIVATE_BOARDS_DIR` to a directory of `.kicad_pcb` files (optionally with a
`.kicad_sch` of the same name). Unset, the private suites skip and print a warning. Set to a
missing or empty directory, a test fails. The real led_lantern deck invariants
(`src/simhost/__tests__/floating-island.integration.test.ts`) read
`led_lantern-revb-headers-only-handtuned.kicad_pcb` from the same directory.
