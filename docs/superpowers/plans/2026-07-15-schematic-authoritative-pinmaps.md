# Schematic-Authoritative Diode Pin Maps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a schematic is attached, symbol pin names (A/K) become an authoritative pin-map source for two-terminal polarized parts (diodes/LEDs), above footprint regexes and below Model Doctor overrides, with a WarningsBar note when the schematic contradicts a confident footprint belief.

**Architecture:** A pure helper (`pinMapFromSchematicPins`) in `libraryMatch.ts` derives the map from schematic pins under strict guard rails; `tryTier3` in `resolve.ts` prefers it over `selectPinMap`'s regex result and pushes a prefixed warning on disagreement; WarningsBar derives an informational row from that warning prefix. Nothing is persisted, nothing is written to design files, no Critic involvement.

**Tech Stack:** TypeScript, vitest (node env, no jsdom; SSR panel tests via `renderToStaticMarkup`), React 18 inline-style renderer.

**Spec:** `docs/superpowers/specs/2026-07-15-schematic-authoritative-pinmaps-design.md`

## Global Constraints

- The note warning constant is EXACTLY:
  `schematic-pinmap: pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale`
  (exported as `SCHEMATIC_PINMAP_NOTE` from `src/core/models/libraryMatch.ts`; the machine prefix is `schematic-pinmap:`).
- WarningsBar row testid is EXACTLY `schematic-pinmap-note`; row copy is
  `ⓘ <ref>: pin map corrected from schematic (A/K) — footprint convention was reversed. Override in Model Doctor if the schematic is stale.`
- Row colors (grey-blue informational, matches FidelityBadge's open-by-design palette): background `#1c2733`, color `#bcd3e8`, borderTop `1px solid #2c4152`.
- Renderer styling is inline `React.CSSProperties` ONLY — no CSS files, no `<style>` tags.
- Do NOT modify `resources/models/index.json` or `src/core/models/__tests__/library-convention-guard.test.ts` — the footprint-regex tier and its guard stay exactly as landed.
- Do NOT write to user design files and do NOT add store persistence — schematic maps/notes re-derive every resolution pass.
- The schematic tier applies ONLY when: entry is `model-card` AND all its maps permute `{'1','2'}`; symbol has exactly two distinct pin numbers named A and K (case-insensitive, trimmed); both pin numbers exist in the part's `padNet` keys. Anything else falls through silently.
- Verification gate per task: named vitest file(s) green; final task adds full `npx vitest run` + `npm run typecheck` (NEVER `tsc -p tsconfig.json` — that is a no-op solution-style config).
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## File Structure

- `src/core/models/libraryMatch.ts` — add `SchematicPin`, `SCHEMATIC_PINMAP_NOTE`, `isTwoTerminalPolarizedEntry`, `pinMapFromSchematicPins` (Task 1).
- `src/core/models/__tests__/schematicPinMap.test.ts` — NEW unit tests for the helpers (Task 1).
- `src/core/models/resolve.ts` — thread schematic pins through `tryTier3` (Task 2).
- `src/core/models/__tests__/resolve.test.ts` — integration tests (Task 2).
- `src/renderer/src/panels/WarningsBar.tsx` — informational note row (Task 3).
- `src/renderer/src/panels/__tests__/WarningsBar.test.tsx` — SSR tests (Task 3).
- `src/renderer/src/store/__tests__/appStore.test.ts` — override-beats-schematic precedence test (Task 4).
- `docs/backlog.md` — supersession note (Task 4).

---

### Task 1: Core helpers in libraryMatch.ts

**Files:**
- Modify: `src/core/models/libraryMatch.ts` (append after `selectPinMap`, which ends near line 329)
- Test: `src/core/models/__tests__/schematicPinMap.test.ts` (create)

**Interfaces:**
- Consumes: existing `LibraryEntry`, `PinMap` from `../types` (already imported in libraryMatch.ts).
- Produces (Tasks 2–4 rely on these exact names):
  - `export interface SchematicPin { number: string; name: string; type: string }`
  - `export const SCHEMATIC_PINMAP_NOTE: string` (exact value in Global Constraints)
  - `export function isTwoTerminalPolarizedEntry(entry: LibraryEntry): boolean`
  - `export function pinMapFromSchematicPins(entry: LibraryEntry, pins: SchematicPin[] | undefined, padNumbers: ReadonlySet<string>): PinMap | null`

- [ ] **Step 1: Write the failing test file**

Create `src/core/models/__tests__/schematicPinMap.test.ts`:

```tsx
/**
 * schematicPinMap.test.ts — schematic-authoritative diode pin maps (unit).
 *
 * pinMapFromSchematicPins derives a diode/LED pin map from schematic symbol
 * pin names (A/K — design-file ground truth). null = "fall through to the
 * footprint-regex tier", never an error. Guard rails per spec §5:
 * two-terminal polarized model-card entry; exactly two distinct pin numbers
 * named A and K; both numbers present in the routed part's pads.
 * Spec: docs/superpowers/specs/2026-07-15-schematic-authoritative-pinmaps-design.md
 */

import { describe, it, expect } from 'vitest'

import {
  pinMapFromSchematicPins,
  isTwoTerminalPolarizedEntry,
  type SchematicPin,
} from '../libraryMatch'
import type { LibraryEntry } from '../types'

const DIODE_ENTRY: LibraryEntry = {
  id: 'test-diode',
  match: { mpn: ['SS54'] },
  model: { type: 'model-card', file: 'diodes.lib', name: 'DSS54' },
  pinMaps: { 'D_SMC.*': { '1': '2', '2': '1' } },
  defaultPinMap: { '1': '2', '2': '1' },
  provenance: 'test fixture',
}

const BJT_ENTRY: LibraryEntry = {
  id: 'test-bjt',
  match: { mpn: ['2N3904'] },
  model: { type: 'model-card', file: 'bjt.lib', name: 'Q2N3904' },
  pinMaps: { 'SOT-23.*': { '1': '3', '2': '1', '3': '2' } },
  defaultPinMap: { '1': '3', '2': '1', '3': '2' },
  provenance: 'test fixture',
}

const SUBCKT_ENTRY: LibraryEntry = {
  id: 'test-subckt',
  match: { mpn: ['NE555'] },
  model: { type: 'subckt', file: 'timer.lib', name: 'NE555' },
  pinMaps: { 'DIP-8.*': { '1': '1', '2': '2' } },
  provenance: 'test fixture',
}

const pads12 = new Set(['1', '2'])

function pins(...list: Array<[string, string]>): SchematicPin[] {
  return list.map(([number, name]) => ({ number, name, type: 'passive' }))
}

describe('isTwoTerminalPolarizedEntry', () => {
  it('diode entry (all maps permute {1,2}) → true', () => {
    expect(isTwoTerminalPolarizedEntry(DIODE_ENTRY)).toBe(true)
  })

  it('3-terminal BJT entry → false', () => {
    expect(isTwoTerminalPolarizedEntry(BJT_ENTRY)).toBe(false)
  })

  it('entry with one polarized map but a non-polarized defaultPinMap → false', () => {
    const mixed: LibraryEntry = {
      ...DIODE_ENTRY,
      defaultPinMap: { '1': 'a', '2': 'k' },
    }
    expect(isTwoTerminalPolarizedEntry(mixed)).toBe(false)
  })
})

describe('pinMapFromSchematicPins — happy paths', () => {
  it('pin 1 = A, pin 2 = K → {1:"1", 2:"2"} (anode pad → terminal 1)', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)
    expect(map).toEqual({ '1': '1', '2': '2' })
  })

  it('pin 1 = K, pin 2 = A → {2:"1", 1:"2"} (KiCad-convention symbol)', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'K'], ['2', 'A']), pads12)
    expect(map).toEqual({ '2': '1', '1': '2' })
  })

  it('names normalize: lowercase + padded " a "/" k " accepted', () => {
    const map = pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', ' a '], ['2', ' k ']), pads12)
    expect(map).toEqual({ '1': '1', '2': '2' })
  })

  it('duplicate pin entries (lib_symbols body styles) dedupe by number', () => {
    const dup = pins(['1', 'A'], ['1', 'A'], ['2', 'K'])
    expect(pinMapFromSchematicPins(DIODE_ENTRY, dup, pads12)).toEqual({ '1': '1', '2': '2' })
  })
})

describe('pinMapFromSchematicPins — guard rails → null', () => {
  it('undefined pins (no schematic) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, undefined, pads12)).toBeNull()
  })

  it('non-A/K names (+/-, AN/CAT) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', '+'], ['2', '-']), pads12)).toBeNull()
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'AN'], ['2', 'CAT']), pads12)).toBeNull()
  })

  it('two A pins (no K) → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'A']), pads12)).toBeNull()
  })

  it('one pin / three distinct pins → null', () => {
    expect(pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A']), pads12)).toBeNull()
    expect(
      pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K'], ['3', 'NC']), pads12),
    ).toBeNull()
  })

  it('pin number missing from the routed pads (stale schematic) → null', () => {
    const padsOnly1 = new Set(['1'])
    expect(
      pinMapFromSchematicPins(DIODE_ENTRY, pins(['1', 'A'], ['2', 'K']), padsOnly1),
    ).toBeNull()
  })

  it('non-polarized entry (BJT) → null even with A/K pins', () => {
    expect(pinMapFromSchematicPins(BJT_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)).toBeNull()
  })

  it('subckt entry → null (v1 is model-card only)', () => {
    expect(pinMapFromSchematicPins(SUBCKT_ENTRY, pins(['1', 'A'], ['2', 'K']), pads12)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/core/models/__tests__/schematicPinMap.test.ts`
Expected: FAIL — `pinMapFromSchematicPins` / `isTwoTerminalPolarizedEntry` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/core/models/libraryMatch.ts` (after `selectPinMap`):

```ts
// ─── Schematic-authoritative pin maps (diodes/LEDs) ──────────────────────────
//
// Spec: docs/superpowers/specs/2026-07-15-schematic-authoritative-pinmaps-design.md
// Footprint-name regexes encode BELIEFS about pad-numbering conventions; an
// attached schematic's symbol pin names (A/K) are the design files' own
// statement of what the pads mean. When available and unambiguous, they win
// over the regex tier (and lose to the user's Model Doctor override, which
// the store applies post-resolution).

/** Symbol pin as parsed from lib_symbols (kicad/schematic.ts SymbolSimInfo.pins). */
export interface SchematicPin {
  number: string
  name: string
  type: string
}

/**
 * Warning pushed onto a Resolution when the schematic-derived map CONTRADICTS
 * a confident footprint-regex map (a "D7"). The `schematic-pinmap:` prefix is
 * the machine handle WarningsBar filters on. Agreement and gap-filling are
 * silent — there is no contradicted belief to report.
 */
export const SCHEMATIC_PINMAP_NOTE =
  'schematic-pinmap: pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale'

function isPolarityPermutation(map: PinMap | undefined): boolean {
  if (!map) return false
  const keys = Object.keys(map).sort()
  const values = Object.values(map).sort()
  return keys.join(',') === '1,2' && values.join(',') === '1,2'
}

/**
 * True iff EVERY map on the entry (pinMaps values + defaultPinMap when
 * present) is a permutation of {'1','2'} — the diode/LED model-card shape.
 * Restricts the schematic tier to parts where "A/K" fully determines wiring.
 */
export function isTwoTerminalPolarizedEntry(entry: LibraryEntry): boolean {
  const maps = Object.values(entry.pinMaps ?? {})
  if (entry.defaultPinMap) maps.push(entry.defaultPinMap)
  return maps.length > 0 && maps.every(isPolarityPermutation)
}

/**
 * Derive a diode/LED pin map from schematic symbol pin names.
 *
 * Returns { anodePad: '1', cathodePad: '2' } (SPICE diode terminal order:
 * 1 = anode, 2 = cathode) when ALL guard rails hold, else null — null means
 * "fall through to footprint-regex selection", never an error:
 *   - entry is a model-card whose maps all permute {'1','2'};
 *   - pins dedupe (by number) to exactly two, named A and K
 *     (case-insensitive, trimmed);
 *   - both pin numbers exist in the routed part's pads (stale-schematic fuse).
 */
export function pinMapFromSchematicPins(
  entry: LibraryEntry,
  pins: SchematicPin[] | undefined,
  padNumbers: ReadonlySet<string>,
): PinMap | null {
  if (!pins || pins.length === 0) return null
  if (entry.model.type !== 'model-card' || !isTwoTerminalPolarizedEntry(entry)) return null

  const byNumber = new Map<string, string>()
  for (const p of pins) {
    if (!byNumber.has(p.number)) byNumber.set(p.number, p.name.trim().toUpperCase())
  }
  if (byNumber.size !== 2) return null

  let anodePad: string | undefined
  let cathodePad: string | undefined
  for (const [number, name] of byNumber) {
    if (name === 'A') anodePad = number
    else if (name === 'K') cathodePad = number
    else return null
  }
  if (anodePad === undefined || cathodePad === undefined) return null
  if (!padNumbers.has(anodePad) || !padNumbers.has(cathodePad)) return null

  return { [anodePad]: '1', [cathodePad]: '2' }
}
```

Note: `PinMap` and `LibraryEntry` are already imported at the top of libraryMatch.ts — do not re-import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/models/__tests__/schematicPinMap.test.ts`
Expected: PASS (14 tests). Also run the neighbors to prove no regression:
`npx vitest run src/core/models/__tests__/libraryMatch.test.ts src/core/models/__tests__/library-convention-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/models/libraryMatch.ts src/core/models/__tests__/schematicPinMap.test.ts
git commit -m "feat(models): schematic A/K pin-map derivation helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Thread schematic pins through tier-3 resolution

**Files:**
- Modify: `src/core/models/resolve.ts` (`tryTier3` at ~line 474; its `selectPinMap` call at ~line 536; the call site `tryTier3(part, _library)` at ~line 631)
- Test: `src/core/models/__tests__/resolve.test.ts` (append a describe block)

**Interfaces:**
- Consumes (from Task 1, module `./libraryMatch`): `pinMapFromSchematicPins`, `SCHEMATIC_PINMAP_NOTE`, `SchematicPin`.
- Consumes (existing): `selectPinMap` (already imported), `SchematicSimData` (already imported at line 26), `resolveAll(circuit, schematicSimData, bom, library, userOverrides)`.
- Produces: `tryTier3(part, library, schematicPins?)` — third param `schematicPins?: SchematicPin[]`. Resolutions whose map came from a contradicting schematic carry `SCHEMATIC_PINMAP_NOTE` in `warnings` (Task 3 filters on the `schematic-pinmap:` prefix).

- [ ] **Step 1: Write the failing tests**

Append to `src/core/models/__tests__/resolve.test.ts`. Add to the EXISTING import from `'../libraryMatch'` if one exists, otherwise add a new import line; also note this file already imports `SchematicSimData` and `SymbolSimInfo` from `'../../kicad/schematic'` (line 11) and defines `makePart`/`makeCircuit`/`makeSimInfo` helpers — reuse them.

```tsx
// ─── Schematic-authoritative diode pin maps (spec 2026-07-15) ────────────────

import { SCHEMATIC_PINMAP_NOTE } from '../libraryMatch'
import type { LibraryEntry } from '../types'

describe('tier 3 — schematic A/K pins override footprint-convention pin maps', () => {
  /** Pre-f6680b6 SS54 entry shape: KiCad-convention key that ALSO matches the
   *  bare EasyEDA dimension-pattern name — the exact D7 bug. */
  const KICAD_ONLY_SS54: LibraryEntry = {
    id: 'test-ss54-kicad-only',
    match: { mpn: ['SS54'] },
    model: { type: 'model-card', file: 'diodes.lib', name: 'DSS54' },
    pinMaps: { '(D_)?(SMC|SMB|SMA|DO-214|DO-201).*': { '1': '2', '2': '1' } },
    defaultPinMap: { '1': '2', '2': '1' },
    provenance: 'test fixture — pre-fix entry shape',
  }

  function d7SchData(pinNames: [string, string]): SchematicSimData {
    const info: SymbolSimInfo = {
      value: 'SS54',
      sim: {},
      pins: [
        { number: '1', name: pinNames[0], type: 'passive' },
        { number: '2', name: pinNames[1], type: 'passive' },
      ],
      noConnects: [],
    }
    return new Map([['D7', info]])
  }

  it('D7 replay: schematic (1=A,2=K) beats a wrong-confident regex map + note pushed', () => {
    const circuit = makeCircuit([makePart('D7', 'SS54', 'SMC_L7.1-W6.2-LS8.1-R-RD')])
    const [r] = resolveAll(circuit, d7SchData(['A', 'K']), undefined, [KICAD_ONLY_SS54])
    expect(r.status).toBe('ok')
    expect(r.tier).toBe(3)
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '1', '2': '2' })
    } else {
      expect.fail('expected a model with a pinMap')
    }
    expect(r.warnings).toContain(SCHEMATIC_PINMAP_NOTE)
  })

  it('agreement: schematic matches the regex map → same map, NO note', () => {
    // KiCad-convention symbol (1=K, 2=A) agrees with the entry's cathode-first map.
    const circuit = makeCircuit([makePart('D7', 'SS54', 'Diode_SMD:D_SMC')])
    const [r] = resolveAll(circuit, d7SchData(['K', 'A']), undefined, [KICAD_ONLY_SS54])
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '2', '2': '1' })
    }
    expect(r.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(false)
  })

  it('agreement against the REAL index (JLC keys present): anode-first, NO note', async () => {
    // Post-f6680b6 the real ss54 entry maps the bare EasyEDA name anode-first,
    // agreeing with the schematic — the correction note must NOT appear.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const entries = (
      JSON.parse(
        readFileSync(join(process.cwd(), 'resources/models/index.json'), 'utf8'),
      ) as { entries: LibraryEntry[] }
    ).entries
    const circuit = makeCircuit([makePart('D7', 'SS54', 'SMC_L7.1-W6.2-LS8.1-R-RD')])
    const [r] = resolveAll(circuit, d7SchData(['A', 'K']), undefined, entries)
    expect(r.status).toBe('ok')
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '1', '2': '2' })
    }
    expect(r.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(false)
  })

  it('gap-fill: no regex match → schematic map applied, pinmap-unverified DROPPED', () => {
    const circuit = makeCircuit([makePart('D7', 'SS54', 'WeirdLib:NoMatchName')])
    const [r] = resolveAll(circuit, d7SchData(['A', 'K']), undefined, [KICAD_ONLY_SS54])
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '1', '2': '2' })
    }
    expect(r.warnings.some(w => w.includes('pinmap-unverified'))).toBe(false)
    expect(r.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(false)
  })

  it('no schematic → regex tier behavior unchanged (regression pin)', () => {
    const circuit = makeCircuit([makePart('D7', 'SS54', 'SMC_L7.1-W6.2-LS8.1-R-RD')])
    const [r] = resolveAll(circuit, undefined, undefined, [KICAD_ONLY_SS54])
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '2', '2': '1' }) // the (wrong) regex belief — fixture is pre-fix
    }
    expect(r.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(false)
  })

  it('guard-rail fall-through: non-A/K pin names → regex tier, no note', () => {
    const circuit = makeCircuit([makePart('D7', 'SS54', 'Diode_SMD:D_SMC')])
    const [r] = resolveAll(circuit, d7SchData(['1', '2']), undefined, [KICAD_ONLY_SS54])
    if (r.model && 'pinMap' in r.model) {
      expect(r.model.pinMap).toEqual({ '1': '2', '2': '1' })
    }
    expect(r.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(false)
  })
})
```

NOTE for the implementer: this file's `makePart` builds `padNet: new Map([['1', 1], ['2', 2]])` — pads `1`/`2` exist, so the pad-presence guard passes. The tier-1 path only fires when `sim.Device` is set; these fixtures use `sim: {}` so resolution reaches tier 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/models/__tests__/resolve.test.ts`
Expected: the new describe FAILS (D7 replay gets `{'1':'2','2':'1'}` and no note — schematic pins are not threaded yet). All pre-existing tests still pass.

- [ ] **Step 3: Implement the threading**

In `src/core/models/resolve.ts`:

(a) Extend the libraryMatch import (line 29) from:

```ts
import { matchLibraryEntry, selectPinMap } from './libraryMatch'
```

to:

```ts
import {
  matchLibraryEntry,
  selectPinMap,
  pinMapFromSchematicPins,
  SCHEMATIC_PINMAP_NOTE,
  type SchematicPin,
} from './libraryMatch'
```

(b) Change `tryTier3`'s signature (line ~474):

```ts
function tryTier3(
  part: Part,
  library: LibraryEntry[],
  schematicPins?: SchematicPin[],
): Resolution | null {
```

(c) Replace the pin-map selection block (currently lines ~535-537):

```ts
  // Select pin map
  const { pinMap, warnings: pinWarnings } = selectPinMap(entry, part.libId)
  warnings.push(...pinWarnings)
```

with:

```ts
  // Select pin map. Footprint-name regexes encode BELIEFS about pad-numbering
  // conventions; attached-schematic pin names (A/K) are the design files' own
  // statement of pad semantics and win when unambiguous (spec 2026-07-15).
  // The user's Model Doctor override still beats both — the store applies it
  // post-resolution.
  const regexResult = selectPinMap(entry, part.libId)
  const schematicMap = pinMapFromSchematicPins(
    entry,
    schematicPins,
    new Set(part.padNet.keys()),
  )

  let pinMap: PinMap
  if (schematicMap) {
    pinMap = schematicMap
    const regexConfident = regexResult.warnings.length === 0
    if (regexConfident && !pinMapsEqual(schematicMap, regexResult.pinMap)) {
      // A "D7": the regex matched confidently but had the polarity reversed.
      warnings.push(SCHEMATIC_PINMAP_NOTE)
    }
    // Regex fallback warnings (pinmap-unverified) intentionally dropped:
    // the schematic just verified the map.
  } else {
    pinMap = regexResult.pinMap
    warnings.push(...regexResult.warnings)
  }
```

(d) Add the tiny comparator near `tryTier3` (module scope, above it):

```ts
/** Key/value equality for pin maps (2-entry objects — order-insensitive). */
function pinMapsEqual(a: PinMap, b: PinMap): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k])
}
```

(`PinMap` is already imported in resolve.ts line 27 — do not re-import.)

(e) Update the call site (line ~631, inside `resolvePart`, which receives `schematicSimData: SchematicSimData | undefined` as its third parameter — verified):

```ts
    const tier3 = tryTier3(part, _library, schematicSimData?.get(part.ref)?.pins)
    if (tier3) return tier3
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/models/__tests__/resolve.test.ts src/core/models/__tests__/libraryMatch.test.ts src/core/models/__tests__/library-content.test.ts src/core/models/__tests__/library-convention-guard.test.ts`
Expected: ALL PASS (the convention guard and content tests prove the regex tier is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/core/models/resolve.ts src/core/models/__tests__/resolve.test.ts
git commit -m "feat(models): schematic A/K pins override footprint pin-map beliefs (tier 3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: WarningsBar informational note row

**Files:**
- Modify: `src/renderer/src/panels/WarningsBar.tsx`
- Test: `src/renderer/src/panels/__tests__/WarningsBar.test.tsx` (append a describe)

**Interfaces:**
- Consumes: `SCHEMATIC_PINMAP_NOTE` (Task 1) — but the component filters on the string prefix `'schematic-pinmap:'` only (no import needed; keeps the renderer decoupled from core constants). `resolutions` is ALREADY subscribed in the component (line 53).
- Produces: rows with `data-testid="schematic-pinmap-note"` and `data-ref="<ref>"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/panels/__tests__/WarningsBar.test.tsx` (the file already defines `renderBar(resolutions)` and imports `Resolution`):

```tsx
// ─── Schematic pin-map correction notes (spec 2026-07-15) ────────────────────

const SCHEM_NOTE =
  'schematic-pinmap: pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale'

function schematicCorrected(ref: string): Resolution {
  return {
    ref,
    status: 'ok',
    tier: 3,
    warnings: [SCHEM_NOTE],
    model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'DSS54', pinMap: { '1': '1', '2': '2' } },
  }
}

describe('schematic pin-map notes — informational row per corrected ref', () => {
  it('a resolution carrying the schematic-pinmap warning → note row with ref + copy', () => {
    const html = renderBar([schematicCorrected('D7')])
    expect(html).toContain('data-testid="schematic-pinmap-note"')
    expect(html).toContain('data-ref="D7"')
    expect(html).toContain('D7')
    expect(html).toContain('pin map corrected from schematic (A/K)')
    expect(html).toContain('footprint convention was reversed')
    expect(html).toContain('Override in Model Doctor if the schematic is stale')
  })

  it('two corrected refs → two rows', () => {
    const html = renderBar([schematicCorrected('D7'), schematicCorrected('D8')])
    expect(html.match(/data-testid="schematic-pinmap-note"/g)).toHaveLength(2)
    expect(html).toContain('data-ref="D7"')
    expect(html).toContain('data-ref="D8"')
  })

  it('no schematic-pinmap warnings → no rows (and bar stays hidden when nothing else)', () => {
    const ok: Resolution = {
      ref: 'D1',
      status: 'ok',
      tier: 3,
      warnings: [],
      model: { kind: 'subckt', libFile: 'diodes.lib', subcktName: 'DSS54', pinMap: { '1': '2', '2': '1' } },
    }
    const html = renderBar([ok])
    expect(html).not.toContain('schematic-pinmap-note')
    expect(html).toBe('') // nothing else to show → component returns null
  })

  it('note is NOT counted by the fidelity banner/badge (accuracy upgrade, not approximation)', () => {
    const html = renderBar([schematicCorrected('D7')])
    expect(html).not.toContain('Results approximate')
    expect(html).not.toContain('approximate')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/panels/__tests__/WarningsBar.test.tsx`
Expected: the new describe FAILS (no `schematic-pinmap-note` markup; the "no rows" test may pass — that is fine). Pre-existing tests pass.

- [ ] **Step 3: Implement the row**

In `src/renderer/src/panels/WarningsBar.tsx`:

(a) Inside the component, after the `fidelityCollapsed` derivations (~line 64), add:

```tsx
  // Schematic pin-map corrections (spec 2026-07-15): the attached schematic's
  // A/K pin names contradicted a confident footprint-convention map and won.
  // Informational (grey-blue) — the model got MORE accurate, so this is
  // deliberately NOT part of the fidelity banner/badge counts.
  const schematicPinNotes = resolutions.filter(r =>
    r.warnings.some(w => w.startsWith('schematic-pinmap:')),
  )
```

(b) Extend the `anything` gate (~line 79) with one more disjunct:

```tsx
  const anything =
    (fidelity.length > 0 && !fidelityMinimized) ||
    convergenceCard ||
    benchToast ||
    crashNotice ||
    opCaveat ||
    railNotes.length > 0 ||
    schematicPinNotes.length > 0
```

(c) Render the rows next to the railNotes block (immediately after `{railNotes.map(...)}`):

```tsx
      {/* ── Schematic pin-map corrections (informational, spec 2026-07-15) ── */}
      {schematicPinNotes.map(r => (
        <div
          key={r.ref}
          style={schematicPinNoteStyle}
          data-testid="schematic-pinmap-note"
          data-ref={r.ref}
        >
          ⓘ <span style={refStyle}>{r.ref}</span>: pin map corrected from schematic
          (A/K) — footprint convention was reversed. Override in Model Doctor if the
          schematic is stale.
        </div>
      ))}
```

(`refStyle` already exists in this file — it is used by `RailNoteRow`.)

(d) Add the style constant next to `railNoteStyle` (~line 348):

```tsx
const schematicPinNoteStyle: React.CSSProperties = {
  ...baseRow,
  background: '#1c2733',
  color: '#bcd3e8',
  borderTop: '1px solid #2c4152',
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/panels/__tests__/WarningsBar.test.tsx`
Expected: ALL PASS (new + pre-existing, including the fidelity/badge suites).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/panels/WarningsBar.tsx src/renderer/src/panels/__tests__/WarningsBar.test.tsx
git commit -m "feat(warnings): informational row for schematic pin-map corrections

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Store precedence test, backlog supersession, full verification

**Files:**
- Test: `src/renderer/src/store/__tests__/appStore.test.ts` (extend the `appStore — pin-map override reaches the resolved model (M4)` describe)
- Modify: `docs/backlog.md`

**Interfaces:**
- Consumes: `storeWithLibrary()` + `d1PinMap(store)` helpers already defined inside that describe; store actions `setPinMap`, `reResolve`; `SymbolSimInfo` type from `../../../../core/kicad/schematic` (add the import if the file lacks it — use the existing relative-path style of the file's other core imports).
- Produces: nothing new — this task closes the precedence chain and the docs trail.

- [ ] **Step 1: Write the failing store test**

Append inside the existing `describe('appStore — pin-map override reaches the resolved model (M4)', ...)` block:

```tsx
  it('precedence: Model Doctor override > schematic A/K map > footprint regex', () => {
    const store = storeWithLibrary()
    const original = d1PinMap(store)
    expect(original).toEqual({ '1': '2', '2': '1' }) // KiCad-convention LED default

    // Attach schematic data for D1 with pin 1 = A (contradicts the regex map)
    // via direct state injection (house store-test idiom), then re-resolve.
    const info: SymbolSimInfo = {
      value: 'LED',
      sim: {},
      pins: [
        { number: '1', name: 'A', type: 'passive' },
        { number: '2', name: 'K', type: 'passive' },
      ],
      noConnects: [],
    }
    store.setState({ schematicSimData: new Map([['D1', info]]) })
    store.getState().reResolve()
    expect(d1PinMap(store)).toEqual({ '1': '1', '2': '2' }) // schematic tier won

    // The schematic-vs-regex contradiction is reported on the resolution.
    const d1 = store.getState().resolutions.find(r => r.ref === 'D1')
    expect(d1?.warnings.some(w => w.startsWith('schematic-pinmap:'))).toBe(true)

    // Now the user's Model Doctor override — highest precedence — wins.
    store.getState().setPinMap('D1', { '1': '2', '2': '1' })
    expect(d1PinMap(store)).toEqual({ '1': '2', '2': '1' })
  })
```

NOTE for the implementer: first-light's D1 is an LED that resolves through the bundled library with the KiCad-convention map `{'1':'2','2':'1'}` (asserted by the neighboring M4 test via `expect(override).not.toEqual(original)` with override `{'1':'1','2':'2'}`). If `SymbolSimInfo` is not yet imported in this test file, add `import type { SymbolSimInfo } from '../../../../core/kicad/schematic'` alongside the existing imports.

- [ ] **Step 2: Run it to verify current behavior**

Run: `npx vitest run src/renderer/src/store/__tests__/appStore.test.ts`
Expected: the new test PASSES if Tasks 1–2 are complete (this is a cross-layer integration pin, not new behavior). If it FAILS, that is a real integration bug between the store's `reResolve` and the new tier — fix before proceeding (the store passes `schematicSimData` to `resolveAll` at appStore.ts ~line 1059, so failure means the threading in Task 2 missed the resolveAll path the store uses).

- [ ] **Step 3: Update the backlog (supersession, spec §9)**

In `docs/backlog.md`, replace the entire `## Critic check: schematic polarity audit for diodes/LEDs` section's first paragraph (the `**What:**` paragraph) with:

```markdown
**Status: SUPERSEDED (2026-07-15)** by
`docs/superpowers/specs/2026-07-15-schematic-authoritative-pinmaps-design.md` —
implemented as an auto-correcting pin-map precedence tier (schematic A/K pin
names above footprint regexes, below Model Doctor overrides) plus a
WarningsBar note, NOT a Critic finding: a schematic-vs-footprint mismatch can
only ever be circsim-side (the netlist links schematic and PCB), so a
board-risk flag would be false by construction. The rationale below is kept
for the trail.

**What (original idea):** when a schematic is attached (the picker flow), audit every
two-terminal polarized part: compare the applied SPICE pin map against the
symbol's pin names (`A`/`K` for diodes/LEDs — ground truth in the design
files) and flag any part where the model's anode/cathode assignment
disagrees with the schematic.
```

(Keep the `**Why:**` and `**Scope sketch:**` paragraphs unchanged.)

- [ ] **Step 4: Full-suite verification**

Run: `npx vitest run`
Expected: ALL test files pass (~1554+ tests).

Run: `npm run typecheck`
Expected: exit 0. (NEVER use `tsc -p tsconfig.json` — solution-style no-op.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/__tests__/appStore.test.ts docs/backlog.md
git commit -m "test(store): pin-map precedence chain override>schematic>regex; docs: backlog supersession

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
