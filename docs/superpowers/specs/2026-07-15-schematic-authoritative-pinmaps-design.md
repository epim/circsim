# Schematic-Authoritative Diode Pin Maps — Design

**Date:** 2026-07-15
**Status:** approved (brainstorm 2026-07-15)
**Motivating incident:** D7 / led_lantern rev B (fixed for footprint regexes in f6680b6; guard test in 6090117)

## 1. Motivation

circsim maps footprint pads to SPICE device terminals (diode: 1 = anode,
2 = cathode) using footprint-NAME regexes in `resources/models/index.json`.
Those regexes encode *beliefs* about library pad-numbering conventions
(KiCad `D_*`: pad 1 = cathode; JLC/EasyEDA: pad 1 = anode). The D7 incident
showed a belief being confidently wrong: circsim modeled a correct board's
charge path as dead and raised what amounted to a false board-risk flag,
costing a designer round-trip. For a pre-fab validator, false alarms are the
most corrosive failure mode — they teach the user to distrust real findings.

When the user attaches the schematic (existing picker flow), the design
files themselves state what each pad means: `lib_symbols` pin names
(`pin 1 = "A"`, `pin 2 = "K"`), already parsed into
`SymbolSimInfo.pins: {number, name, type}[]` by `src/core/kicad/schematic.ts`.
That is ground truth about pad *semantics* — the same fact the assembler
resolves from the footprint library when placing the physical part.

**Key property that shapes the whole design:** in the KiCad flow the
schematic and PCB are netlist-linked, so a mismatch between circsim's
footprint-derived pin map and the schematic's pin names can ONLY mean
circsim's convention belief is wrong — never that the board is wrong. A real
polarity error (anode routed to the wrong net) lives in pad→net
connectivity, which this feature does not touch; it still surfaces through
simulation as a true finding. Hence: **auto-correct the model, do not raise
a Critic finding** (a Critic finding asserts board risk, which is false by
construction for this class). Decided over "Critic flag only" and "both" in
brainstorm.

## 2. What it does

When a schematic is attached, symbol pin names become an authoritative pin-map
source for two-terminal polarized model-card parts (diodes/LEDs), sitting
above footprint regexes and below the user's Model Doctor override. When the
schematic *contradicts* a confident footprint-regex map, a fidelity note
surfaces in the WarningsBar. Nothing is ever written to the user's design
files (read-only-validator principle) and nothing is persisted: schematic-derived
maps and notes are re-derived on every resolution pass, so a revised
schematic re-export is picked up automatically.

## 3. Pin-map precedence (final)

For a tier-3 library-resolved part, highest wins:

1. **Model Doctor `pinMapOverrides`** — applied post-resolution in
   `appStore.reResolve()` (existing mechanism, unchanged; it maps over
   `resolveAll`'s output, so it wins over every tier below by construction).
2. **Schematic pin names** (NEW) — only when ALL guard rails in §5 hold.
3. **Footprint-regex `pinMaps`** — existing `selectPinMap` first-match-wins,
   including the JLC/EasyEDA anode-first keys from f6680b6. Unchanged; this
   remains the entire story when no schematic is attached.
4. **`defaultPinMap`** + `pinmap-unverified` warning (existing).

Note emission:

- Tier 2 **disagrees** with a *confident* tier 3 (regex matched, no warning):
  apply tier 2, push the note warning (§6). This is exactly a D7.
- Tier 2 **agrees** with tier 3: apply (identical map), no note.
- Tier 3 had no regex match (would have fallen to tier 4): apply tier 2
  silently and DROP the `pinmap-unverified` warning — the schematic filled a
  gap; there is no contradicted belief to report and the map is verified.
- Tier 2 unavailable (no schematic / guard rails fail): tiers 3–4 exactly as
  today, byte-for-byte.

## 4. Core change

### 4.1 New helper — `src/core/models/libraryMatch.ts`

```ts
/** Symbol pin as parsed from lib_symbols (schematic.ts SymbolSimInfo.pins). */
export interface SchematicPin {
  number: string
  name: string
  type: string
}

/**
 * Derive a diode/LED pin map from schematic symbol pin names (A/K).
 * Returns null unless every guard rail holds (§5) — null means "fall
 * through to footprint-regex selection", never an error.
 */
export function pinMapFromSchematicPins(
  entry: LibraryEntry,
  pins: SchematicPin[] | undefined,
  padNumbers: ReadonlySet<string>,
): PinMap | null
```

Behavior: dedupe `pins` by `number`; require exactly two; normalize names
(`trim().toUpperCase()`); require exactly one `A` and one `K`; require both
numbers ∈ `padNumbers`; require the entry to qualify (§5.1). Result:
`{ [anodePin.number]: '1', [cathodePin.number]: '2' }`.

Also export the entry qualifier so tests target it directly:

```ts
/** True iff every map in the entry is a permutation of {1,2} (diode/LED shape). */
export function isTwoTerminalPolarizedEntry(entry: LibraryEntry): boolean
```

### 4.2 Threading — `src/core/models/resolve.ts`

`tryTier3` gains an optional param:

```ts
function tryTier3(
  part: Part,
  library: LibraryEntry[],
  schematicPins?: SchematicPin[],   // NEW: schematicSimData.get(part.ref)?.pins
): Resolution | null
```

Call site in `resolveAll` (currently `tryTier3(part, _library)`):

```ts
const tier3 = tryTier3(part, _library, schematicSimData?.get(part.ref)?.pins)
```

Inside `tryTier3`, replace the single `selectPinMap` call:

```ts
const regexResult = selectPinMap(entry, part.libId)
const padNumbers = new Set(part.padNet.keys())
const schemMap = pinMapFromSchematicPins(entry, schematicPins, padNumbers)

let pinMap: PinMap
if (schemMap) {
  pinMap = schemMap
  const regexConfident = regexResult.warnings.length === 0
  if (regexConfident && !pinMapsEqual(schemMap, regexResult.pinMap)) {
    warnings.push(SCHEMATIC_PINMAP_NOTE)   // §6 exact string
  }
  // regex fallback warnings intentionally dropped: map is now verified
} else {
  pinMap = regexResult.pinMap
  warnings.push(...regexResult.warnings)
}
```

`pinMapsEqual` is a tiny local key/value comparison (maps are 2 entries).

## 5. Guard rails

### 5.1 Entry qualifies

- `entry.model.type === 'model-card'`, AND
- `isTwoTerminalPolarizedEntry(entry)`: every map among
  `Object.values(entry.pinMaps)` and `defaultPinMap` (when present) is a
  permutation of `{'1','2'}`.

This restricts the feature to the diode/LED family; subckt parts, XSPICE
digital, and multi-terminal model cards are untouched in v1.

### 5.2 Symbol qualifies

- Exactly two distinct pin numbers after dedup (lib_symbols can repeat pins
  across body styles/units).
- Names normalize to exactly one `A` and one `K` (case-insensitive,
  whitespace-trimmed). Any other naming (e.g. `+`/`-`, `AN`/`CAT`, blank)
  → null, silent fall-through.

### 5.3 Schematic-vs-board sanity (stale-schematic protection)

- Both pin numbers must exist in the part's `padNet` keys. A schematic whose
  symbol doesn't line up with the routed part's pads (revision skew, wrong
  ref) fails this and falls through silently to tier 3.
- Residual risk — a stale schematic that still passes the pad check — is
  accepted: the note (§6) names the source and the Model Doctor override
  (precedence 1) is the escape hatch.

## 6. The fidelity note

Encoded as a `Resolution.warnings` entry with a stable machine prefix (house
idiom — same mechanism as `pinmap-unverified`):

```
schematic-pinmap: pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale
```

Exact constant, exported from `libraryMatch.ts`:

```ts
export const SCHEMATIC_PINMAP_NOTE =
  'schematic-pinmap: pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale'
```

(The `pin 1 = A` fragment is fixed copy, not templated — the note's job is
to say what happened and where the escape hatch is; the ref is displayed by
the UI row, and per-pin detail is visible in Model Doctor's pin map.)

### 6.1 UI surface — `src/renderer/src/panels/WarningsBar.tsx`

A new derived row group, same visual family as `RailNoteRow` (grey-blue
informational, NOT amber — nothing is approximate; the model got *better*):

- Derivation (no new store state):
  `resolutions.filter(r => r.warnings.some(w => w.startsWith('schematic-pinmap:')))`
  → one row per ref.
- Row content (informational text only, no actions in v1):
  `ⓘ D7: pin map corrected from schematic (A/K) — footprint convention was
  reversed. Override in Model Doctor if the schematic is stale.` The ref is
  interpolated; the rest is fixed copy.
- testid: `schematic-pinmap-note` (one per row).
- The row participates in the existing `anything` visibility gate in
  WarningsBar the way `railNotes` does.
- NOT part of the fidelity banner / `FidelityBadge` counts — those track
  approximations; this is an accuracy upgrade notice.

## 7. What this deliberately does NOT do

- **No writes to user design files** (.kicad_pcb/.kicad_sch/BOM/CPL) — the
  read-only-validator council principle. The correction affects only
  circsim's in-memory SPICE model; fab files were never wrong in this class.
- **No Critic finding** — §1; the Critic critiques boards, not circsim's
  own beliefs.
- **No persistence** — maps and notes re-derive each resolution pass.
- **No index.json changes** — the JLC keys and the convention-guard corpus
  test (tier 3) stay exactly as landed; they remain the whole story for
  schematic-less boards.
- **No subckt / multi-terminal support** — v1 is A/K two-terminal only.
- **No electrolytic-capacitor polarity** (`+`/`-` pin names) — capacitor
  model cards are not polarized in circsim's SPICE decks today; nothing to
  correct. Revisit only if polarized cap models ever land.

## 8. Testing

House idiom: vitest node env, no jsdom; panels SSR-tested via
`renderToStaticMarkup` with the `getServerState` store hack.

### 8.1 Unit — `src/core/models/__tests__/schematicPinMap.test.ts` (new)

`pinMapFromSchematicPins` / `isTwoTerminalPolarizedEntry`:

- A/K normal order → `{1:'1', 2:'2'}`; K/A reversed numbers → `{2:'1', 1:'2'}`
  (i.e. anode pad keyed to terminal 1 regardless of which pad number it is).
- Lowercase `a`/`k`, padded names → accepted (normalization).
- Non-A/K names (`+`/`-`, `AN`/`CAT`), 1 pin, 3 pins, duplicate numbers
  collapsing to ≠2 → null.
- Pin number missing from `padNumbers` → null (stale-schematic rail).
- Entry not two-terminal-polarized (a SOT-23 BJT map, an LM339 map) → null.
- documented-open / subckt entry → null.

### 8.2 Resolution integration — extend `src/core/models/__tests__/resolve.test.ts`

Fixtures via the existing `makePart`/`makeCircuit` helpers plus a
`SchematicSimData` map:

- **D7 replay:** part `D7`, value `SS54`, libId `SMC_L7.1-W6.2-LS8.1-R-RD`,
  schematic pins `[{1,A},{2,K}]`, resolved against a KiCad-convention-ONLY
  entry (local fixture reproducing the pre-f6680b6 shape): pin map is
  anode-first AND warnings contain `SCHEMATIC_PINMAP_NOTE`. (Proves the tier
  stands alone even where the regex belief is wrong.)
- **Agreement:** same part against the REAL index (JLC keys present): map
  anode-first, NO `schematic-pinmap:` warning.
- **Gap-fill:** entry with no matching regex key and a defaultPinMap:
  schematic map applied, `pinmap-unverified` NOT present.
- **No schematic:** `resolveAll(circuit, undefined, …)` output identical to
  today for the same fixtures (regression pin).
- **Precedence 1:** store-level test (8.3) since overrides apply in the store.

### 8.3 Store — extend `src/renderer/src/store/__tests__/appStore.test.ts`

- `reResolve` with both a schematic-derived map and a `pinMapOverrides`
  entry for the same ref → the override's map is what lands in
  `resolutions[..].model.pinMap` (precedence 1 over 2).

### 8.4 Panel — extend `src/renderer/src/panels/__tests__/WarningsBar.test.tsx`

- A resolution carrying `SCHEMATIC_PINMAP_NOTE` → SSR markup contains
  `schematic-pinmap-note` testid, the ref, and the corrected-from-schematic
  copy; absent when no resolution carries the prefix.
- The note does NOT alter fidelity-banner/badge counts (assert alongside the
  existing fidelity tests).

### 8.5 E2E

None — no bundled sample project attaches a schematic; existing E2E remains
the gate for the unchanged no-schematic path.

## 9. Non-goals recorded elsewhere

`docs/backlog.md`'s "schematic polarity audit as a Critic check" entry is
SUPERSEDED by this design (same motivation, better mechanism) — the backlog
entry is updated to point here rather than deleted, preserving the D7
rationale trail.
