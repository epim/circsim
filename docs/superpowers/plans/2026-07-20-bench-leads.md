# Bench Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instruments become 2D front panels on a bench shelf below the 3D viewport, connected to the board by drawn sagging leads; the user wires an instrument by dragging a lead from a panel jack onto copper.

**Architecture:** A new `src/renderer/src/bench/` module holds a pure data layer (jack model + lead geometry math, headless-tested) and the React surface (shelf, per-kind front panels, one SVG LeadLayer overlay). The scene gains a generalized pixel-space hit-test and anchor projection; the instrument data model, spicegen, and alter planning are untouched. `InstrumentRack`/`InstrumentProps` retire.

**Tech Stack:** React 18 + zustand (existing store), THREE (projection math only), SVG overlay, vitest node-env (SSR via `renderToStaticMarkup`, no jsdom), Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-17-bench-leads-design.md`. One spec deviation is baked into this plan (Task 6 records it in the spec): the board-end clip renders as an **SVG glyph in the LeadLayer** (visible clip = hit target, one system). The spec assumed an in-scene probe-marker sprite could be restyled, but `addProbeMarker` has zero production callers — the marker data layer was never wired to any in-scene visual, so there is nothing to restyle.

## Global Constraints

- Typecheck gate is `npm run typecheck` — NEVER `tsc --noEmit -p tsconfig.json` (that is a silent no-op solution-style config).
- Inline `React.CSSProperties` only — this codebase has no CSS files.
- Tests are vitest node-env, NO jsdom. Panel tests use the `renderToStaticMarkup` + `getServerState` store pattern (copy the harness from `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx:32-48`).
- These testids MUST keep working (E2E depends on them): `supply-volts-input` (a NumericField accepting fill+Enter), `auto-supply-note`, `probe-net-btn`, `energize-btn`, `power-on-btn`, `op-annotation`.
- Unwired sentinel: `UNWIRED = -1` for net fields, `''` for `current-probe.ref` — the `Instrument` union itself is UNCHANGED.
- Lead sag formula (exact): `sag = clamp(0.15 * chordLen, 12, 80)` px; cubic bézier control points at 25% / 75% of the chord, each dropped `sag` px in +y.
- Jack/lead colors (exact): dc-supply `#e05545`, function-gen `#e8c33c`, logic-input `#a06ae0`, pot A `#e08a3c`, pot W `#4fae62`, pot Lo `#4a7fd6`, ground `#3a3a3a`, probes = the instrument's own `color` field.
- New bench testids (exact): `bench-shelf`, `add-instrument-btn`, `palette-<kind>` (e.g. `palette-voltage-probe`), `jack-<instId>-<terminal>` with `data-wired="true"|"false"`, `lead-layer`, `lead-path` with `data-inst`/`data-terminal`, `lead-clip` with `data-x`/`data-y` (container-relative px), `supply-volts-knob`.
- Knob/field ranges in the new panels are copied VERBATIM from the matching sections of `src/renderer/src/panels/InstrumentProps.tsx` (still present until Task 5 deletes it).
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TDd6RRgrLYSpZxheF5QZec`

---

### Task 1: Pure bench data layer — wiring model + lead geometry

**Files:**
- Modify: `src/core/spicegen/instruments.ts` (append after `potResistorNames`)
- Create: `src/renderer/src/bench/leads.ts`
- Create: `src/renderer/src/bench/leadGeometry.ts`
- Test: `src/core/spicegen/__tests__/wired.test.ts`
- Test: `src/renderer/src/bench/__tests__/leads.test.ts`
- Test: `src/renderer/src/bench/__tests__/leadGeometry.test.ts`

**Interfaces:**
- Consumes: `Instrument` union from `src/core/spicegen/instruments.ts` (unchanged).
- Produces (later tasks rely on these exact names):
  - core: `UNWIRED = -1`, `isFullyWired(inst: Instrument): boolean`, `wiredInstruments(list: Instrument[]): Instrument[]`
  - `bench/leads.ts`: `Terminal`, `AttachTarget`, `JackDef`, `JACK_COLORS`, `GROUND_INST_ID = 'ground'`, `jacksFor(inst, instId): JackDef[]`, `defaultBenchInstrument(kind, id, probeColor): Instrument`, `applyTerminal(inst, terminal, target): Instrument`, `clearTerminal(inst, terminal): Instrument`, `resolveDrop(hit, jack): AttachTarget | null`, `computeLeads(...): LeadRender[]`
  - `bench/leadGeometry.ts`: `Pt`, `projectAnchor(worldPos, camera, w, h): Pt`, `projectAnchorSet(nets, refs, camera, w, h)`, `leadPath(jack: Pt, clip: Pt): string`

- [ ] **Step 1: Write the failing core tests**

`src/core/spicegen/__tests__/wired.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isFullyWired, wiredInstruments, UNWIRED, type Instrument } from '../instruments'

const wiredSupply: Instrument = { kind: 'dc-supply', id: 's1', netId: 3, volts: 5, seriesOhms: 0.1 }
const unwiredSupply: Instrument = { kind: 'dc-supply', id: 's2', netId: UNWIRED, volts: 5, seriesOhms: 0.1 }

describe('isFullyWired', () => {
  it('single-net kinds: wired iff netId !== UNWIRED', () => {
    expect(isFullyWired(wiredSupply)).toBe(true)
    expect(isFullyWired(unwiredSupply)).toBe(false)
    expect(isFullyWired({ kind: 'ground-ref', netId: UNWIRED })).toBe(false)
    expect(isFullyWired({ kind: 'voltage-probe', id: 'p', netId: 7, color: '#6f6' })).toBe(true)
  })
  it('current-probe: wired iff ref non-empty', () => {
    expect(isFullyWired({ kind: 'current-probe', id: 'i', ref: 'D1', color: '#f6f' })).toBe(true)
    expect(isFullyWired({ kind: 'current-probe', id: 'i', ref: '', color: '#f6f' })).toBe(false)
  })
  it('pot rheostat needs A+W; divider needs Hi+W+Lo', () => {
    expect(isFullyWired({ kind: 'potentiometer', mode: 'rheostat', id: 'r', netA: 1, netW: 2, totalOhms: 10_000, wiperPct: 0.5 })).toBe(true)
    expect(isFullyWired({ kind: 'potentiometer', mode: 'rheostat', id: 'r', netA: 1, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })).toBe(false)
    expect(isFullyWired({ kind: 'potentiometer', mode: 'divider', id: 'd', netHi: 1, netW: 2, netLo: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })).toBe(false)
  })
  it('wiredInstruments filters', () => {
    expect(wiredInstruments([wiredSupply, unwiredSupply])).toEqual([wiredSupply])
  })
})
```

(If the pot record's exact field spellings differ from `instruments.ts:24-27`, match the source — the source is authoritative.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/spicegen/__tests__/wired.test.ts`
Expected: FAIL — `isFullyWired` is not exported.

- [ ] **Step 3: Implement the core additions**

Append to `src/core/spicegen/instruments.ts`:

```ts
// ── Bench-leads wiring state (2026-07-20 bench-leads spec §1) ────────────────
// An instrument added from the shelf palette starts UNWIRED: net fields hold
// UNWIRED (-1) and current-probe.ref holds ''. Everything that feeds SPICE
// (deck generation, source presence, probe vectors) must see only fully wired
// instruments — filter with wiredInstruments().

export const UNWIRED = -1

export function isFullyWired(inst: Instrument): boolean {
  switch (inst.kind) {
    case 'ground-ref':
    case 'dc-supply':
    case 'function-gen':
    case 'logic-input':
    case 'voltage-probe':
      return inst.netId !== UNWIRED
    case 'current-probe':
      return inst.ref !== ''
    case 'potentiometer':
      return inst.mode === 'rheostat'
        ? inst.netA !== UNWIRED && inst.netW !== UNWIRED
        : inst.netHi !== UNWIRED && inst.netW !== UNWIRED && inst.netLo !== UNWIRED
  }
}

export function wiredInstruments(list: Instrument[]): Instrument[] {
  return list.filter(isFullyWired)
}
```

- [ ] **Step 4: Run core tests to verify pass**

Run: `npx vitest run src/core/spicegen/__tests__/wired.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing leads tests**

`src/renderer/src/bench/__tests__/leads.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { UNWIRED, type Instrument } from '../../../../core/spicegen/instruments'
import {
  jacksFor, defaultBenchInstrument, applyTerminal, clearTerminal, resolveDrop,
  JACK_COLORS, GROUND_INST_ID, type JackDef,
} from '../leads'

describe('defaultBenchInstrument', () => {
  it('creates unwired records with the rack defaults', () => {
    expect(defaultBenchInstrument('dc-supply', 's1', '#6f6')).toEqual(
      { kind: 'dc-supply', id: 's1', netId: UNWIRED, volts: 5, seriesOhms: 0.1 })
    expect(defaultBenchInstrument('function-gen', 'f1', '#6f6')).toEqual(
      { kind: 'function-gen', id: 'f1', netId: UNWIRED, wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50 })
    expect(defaultBenchInstrument('logic-input', 'l1', '#6f6')).toEqual(
      { kind: 'logic-input', id: 'l1', netId: UNWIRED, level: 0, vHigh: 3.3 })
    expect(defaultBenchInstrument('voltage-probe', 'v1', '#6f6')).toEqual(
      { kind: 'voltage-probe', id: 'v1', netId: UNWIRED, color: '#6f6' })
    expect(defaultBenchInstrument('current-probe', 'c1', '#f6f')).toEqual(
      { kind: 'current-probe', id: 'c1', ref: '', color: '#f6f' })
    expect(defaultBenchInstrument('potentiometer', 'p1', '#6f6')).toEqual(
      { kind: 'potentiometer', mode: 'rheostat', id: 'p1', netA: UNWIRED, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 })
  })
})

describe('jacksFor', () => {
  it('single-net kinds expose one net jack with the kind color', () => {
    const jacks = jacksFor(defaultBenchInstrument('dc-supply', 's1', '#6f6'), 's1')
    expect(jacks).toHaveLength(1)
    expect(jacks[0]).toMatchObject({
      key: 's1:net', instId: 's1', terminal: 'net', accepts: 'net',
      color: JACK_COLORS['dc-supply'], target: null,
    })
  })
  it('a wired jack carries its target', () => {
    const inst: Instrument = { kind: 'voltage-probe', id: 'v1', netId: 9, color: '#6f6' }
    expect(jacksFor(inst, 'v1')[0].target).toEqual({ kind: 'net', netId: 9 })
    expect(jacksFor(inst, 'v1')[0].color).toBe('#6f6') // probes use their own color
  })
  it('pot rheostat: A+W; divider: A+W+Lo', () => {
    const rheo = defaultBenchInstrument('potentiometer', 'p1', '#6f6')
    expect(jacksFor(rheo, 'p1').map(j => j.terminal)).toEqual(['A', 'W'])
    const div: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: 1, netW: UNWIRED, netLo: 2, totalOhms: 10_000, wiperPct: 0.5 }
    const jacks = jacksFor(div, 'p1')
    expect(jacks.map(j => j.terminal)).toEqual(['A', 'W', 'Lo'])
    expect(jacks[0].target).toEqual({ kind: 'net', netId: 1 })   // A ↔ netHi in divider mode
    expect(jacks[1].target).toBeNull()
    expect(jacks[2].color).toBe(JACK_COLORS.potLo)
  })
  it('current-probe: one clamp jack accepting a component', () => {
    const jacks = jacksFor(defaultBenchInstrument('current-probe', 'c1', '#f6f'), 'c1')
    expect(jacks[0]).toMatchObject({ terminal: 'clamp', accepts: 'component', target: null })
  })
  it('ground-ref: one gnd jack under the ground singleton id', () => {
    const jacks = jacksFor({ kind: 'ground-ref', netId: 4 }, GROUND_INST_ID)
    expect(jacks[0]).toMatchObject({
      key: 'ground:gnd', terminal: 'gnd', accepts: 'net',
      color: JACK_COLORS.ground, target: { kind: 'net', netId: 4 },
    })
  })
})

describe('applyTerminal / clearTerminal', () => {
  const net7 = { kind: 'net', netId: 7 } as const
  it('net terminal → netId', () => {
    const next = applyTerminal(defaultBenchInstrument('dc-supply', 's1', '#6f6'), 'net', net7)
    expect(next).toMatchObject({ netId: 7, volts: 5 })
  })
  it('pot terminals map per mode (A→netA rheostat, A→netHi divider)', () => {
    const rheo = applyTerminal(defaultBenchInstrument('potentiometer', 'p1', '#6f6'), 'A', net7)
    expect(rheo).toMatchObject({ netA: 7 })
    const div: Instrument = { kind: 'potentiometer', mode: 'divider', id: 'p1', netHi: UNWIRED, netW: UNWIRED, netLo: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 }
    expect(applyTerminal(div, 'A', net7)).toMatchObject({ netHi: 7 })
    expect(applyTerminal(div, 'Lo', net7)).toMatchObject({ netLo: 7 })
  })
  it('clamp terminal → ref', () => {
    const next = applyTerminal(defaultBenchInstrument('current-probe', 'c1', '#f6f'), 'clamp', { kind: 'component', ref: 'D1' })
    expect(next).toMatchObject({ ref: 'D1' })
  })
  it('mismatched target kind returns the instrument unchanged', () => {
    const inst = defaultBenchInstrument('dc-supply', 's1', '#6f6')
    expect(applyTerminal(inst, 'net', { kind: 'component', ref: 'D1' })).toBe(inst)
    const clamp = defaultBenchInstrument('current-probe', 'c1', '#f6f')
    expect(applyTerminal(clamp, 'clamp', net7)).toBe(clamp)
  })
  it('clearTerminal rewires back to UNWIRED / empty ref', () => {
    const wired: Instrument = { kind: 'voltage-probe', id: 'v1', netId: 9, color: '#6f6' }
    expect(clearTerminal(wired, 'net')).toMatchObject({ netId: UNWIRED })
    const clamp: Instrument = { kind: 'current-probe', id: 'c1', ref: 'D1', color: '#f6f' }
    expect(clearTerminal(clamp, 'clamp')).toMatchObject({ ref: '' })
  })
})

describe('resolveDrop', () => {
  const netJack = { accepts: 'net' } as JackDef
  const clampJack = { accepts: 'component' } as JackDef
  it('net jack accepts a net hit, rejects a component hit', () => {
    expect(resolveDrop({ netId: 5 }, netJack)).toEqual({ kind: 'net', netId: 5 })
    expect(resolveDrop({ ref: 'D1' }, netJack)).toBeNull()
  })
  it('clamp jack accepts a component hit, rejects a net hit', () => {
    expect(resolveDrop({ ref: 'D1' }, clampJack)).toEqual({ kind: 'component', ref: 'D1' })
    expect(resolveDrop({ netId: 5 }, clampJack)).toBeNull()
  })
  it('null hit → null', () => {
    expect(resolveDrop(null, netJack)).toBeNull()
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/renderer/src/bench/__tests__/leads.test.ts`
Expected: FAIL — module `../leads` not found.

- [ ] **Step 7: Implement `src/renderer/src/bench/leads.ts`**

```ts
/**
 * bench/leads.ts — pure jack/wiring model for the Bench Leads feature.
 *
 * Spec: docs/superpowers/specs/2026-07-17-bench-leads-design.md §1–§3.
 * No React, no THREE, no store — table-driven-testable data layer.
 */

import {
  UNWIRED, isFullyWired, type Instrument,
} from '../../../core/spicegen/instruments'

export { UNWIRED, isFullyWired }

export type Terminal = 'net' | 'A' | 'W' | 'Lo' | 'clamp' | 'gnd'

export type AttachTarget =
  | { kind: 'net'; netId: number }
  | { kind: 'component'; ref: string }

export interface JackDef {
  /** `${instId}:${terminal}` — stable registry/testid key. */
  key: string
  instId: string
  terminal: Terminal
  label: string
  color: string
  accepts: 'net' | 'component'
  /** null = unwired (open jack). */
  target: AttachTarget | null
}

/** The ground-ref instrument has no id field; the shelf addresses it as 'ground'. */
export const GROUND_INST_ID = 'ground'

/** Spec Global Constraints — exact jack/lead colors. */
export const JACK_COLORS = {
  'dc-supply': '#e05545',
  'function-gen': '#e8c33c',
  'logic-input': '#a06ae0',
  potA: '#e08a3c',
  potW: '#4fae62',
  potLo: '#4a7fd6',
  ground: '#3a3a3a',
} as const

export type BenchKind =
  | 'dc-supply' | 'function-gen' | 'logic-input'
  | 'voltage-probe' | 'current-probe' | 'potentiometer'

/** Palette defaults — same values the retired rack used (InstrumentRack.tsx),
 *  but born UNWIRED. probeColor is used only by the probe kinds. */
export function defaultBenchInstrument(kind: BenchKind, id: string, probeColor: string): Instrument {
  switch (kind) {
    case 'dc-supply':
      return { kind, id, netId: UNWIRED, volts: 5, seriesOhms: 0.1 }
    case 'function-gen':
      return { kind, id, netId: UNWIRED, wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50 }
    case 'logic-input':
      return { kind, id, netId: UNWIRED, level: 0, vHigh: 3.3 }
    case 'voltage-probe':
      return { kind, id, netId: UNWIRED, color: probeColor }
    case 'current-probe':
      return { kind, id, ref: '', color: probeColor }
    case 'potentiometer':
      return { kind, mode: 'rheostat', id, netA: UNWIRED, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 }
  }
}

function netTarget(netId: number): AttachTarget | null {
  return netId === UNWIRED ? null : { kind: 'net', netId }
}

export function jacksFor(inst: Instrument, instId: string): JackDef[] {
  const jack = (terminal: Terminal, label: string, color: string,
    accepts: 'net' | 'component', target: AttachTarget | null): JackDef =>
    ({ key: `${instId}:${terminal}`, instId, terminal, label, color, accepts, target })

  switch (inst.kind) {
    case 'ground-ref':
      return [jack('gnd', 'GND', JACK_COLORS.ground, 'net', netTarget(inst.netId))]
    case 'dc-supply':
      return [jack('net', '+', JACK_COLORS['dc-supply'], 'net', netTarget(inst.netId))]
    case 'function-gen':
      return [jack('net', 'out', JACK_COLORS['function-gen'], 'net', netTarget(inst.netId))]
    case 'logic-input':
      return [jack('net', 'out', JACK_COLORS['logic-input'], 'net', netTarget(inst.netId))]
    case 'voltage-probe':
      return [jack('net', 'tip', inst.color, 'net', netTarget(inst.netId))]
    case 'current-probe':
      return [jack('clamp', 'clamp', inst.color, 'component',
        inst.ref === '' ? null : { kind: 'component', ref: inst.ref })]
    case 'potentiometer': {
      const a = inst.mode === 'rheostat' ? inst.netA : inst.netHi
      const jacks = [
        jack('A', 'A', JACK_COLORS.potA, 'net', netTarget(a)),
        jack('W', 'W', JACK_COLORS.potW, 'net', netTarget(inst.netW)),
      ]
      if (inst.mode === 'divider') {
        jacks.push(jack('Lo', 'Lo', JACK_COLORS.potLo, 'net', netTarget(inst.netLo)))
      }
      return jacks
    }
  }
}

/**
 * Pure terminal update: returns a NEW instrument with the terminal wired to
 * target, or the SAME instrument (referential no-op) when the terminal/target
 * combination is invalid for this kind. ground-ref is NOT handled here — the
 * store routes the 'gnd' terminal through setGround (spec §7).
 */
export function applyTerminal(inst: Instrument, terminal: Terminal, target: AttachTarget): Instrument {
  if (target.kind === 'net') {
    const netId = target.netId
    switch (inst.kind) {
      case 'dc-supply': case 'function-gen': case 'logic-input': case 'voltage-probe':
        return terminal === 'net' ? { ...inst, netId } : inst
      case 'potentiometer':
        if (terminal === 'A') {
          return inst.mode === 'rheostat' ? { ...inst, netA: netId } : { ...inst, netHi: netId }
        }
        if (terminal === 'W') return { ...inst, netW: netId }
        if (terminal === 'Lo' && inst.mode === 'divider') return { ...inst, netLo: netId }
        return inst
      default:
        return inst
    }
  }
  // component target
  if (inst.kind === 'current-probe' && terminal === 'clamp') {
    return { ...inst, ref: target.ref }
  }
  return inst
}

/** Pure detach: rewires the terminal back to UNWIRED / ''. Same no-op contract. */
export function clearTerminal(inst: Instrument, terminal: Terminal): Instrument {
  if (inst.kind === 'current-probe' && terminal === 'clamp') return { ...inst, ref: '' }
  return applyTerminal(inst, terminal, { kind: 'net', netId: UNWIRED })
}

/** Drop resolution: a raycast hit is valid only if the jack accepts its kind. */
export function resolveDrop(
  hit: { netId?: number; ref?: string } | null,
  jack: Pick<JackDef, 'accepts'>,
): AttachTarget | null {
  if (!hit) return null
  if (jack.accepts === 'net' && hit.netId !== undefined) return { kind: 'net', netId: hit.netId }
  if (jack.accepts === 'component' && hit.ref !== undefined) return { kind: 'component', ref: hit.ref }
  return null
}
```

Note: `applyTerminal(clearTerminal)` uses `{kind:'net', netId: UNWIRED}` — `netTarget` in `jacksFor` maps that back to `null`, so a cleared jack renders open.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/renderer/src/bench/__tests__/leads.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing geometry tests**

`src/renderer/src/bench/__tests__/leadGeometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { projectAnchor, projectAnchorSet, leadPath } from '../leadGeometry'

function orthoCam(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
  cam.position.set(0, 0, 100)
  cam.lookAt(0, 0, 0)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

describe('projectAnchor', () => {
  it('world origin lands at canvas center', () => {
    const p = projectAnchor(new THREE.Vector3(0, 0, 0), orthoCam(), 800, 600)
    expect(p.px).toBeCloseTo(400, 5)
    expect(p.py).toBeCloseTo(300, 5)
  })
  it('frustum edge lands at the canvas edge (+x → right, +y → up = smaller py)', () => {
    const cam = orthoCam()
    expect(projectAnchor(new THREE.Vector3(50, 0, 0), cam, 800, 600).px).toBeCloseTo(800, 5)
    expect(projectAnchor(new THREE.Vector3(0, 50, 0), cam, 800, 600).py).toBeCloseTo(0, 5)
  })
})

describe('projectAnchorSet', () => {
  it('projects both maps, preserving keys', () => {
    const cam = orthoCam()
    const out = projectAnchorSet(
      new Map([[7, new THREE.Vector3(0, 0, 0)]]),
      new Map([['D1', new THREE.Vector3(50, 0, 0)]]),
      cam, 800, 600,
    )
    expect(out.nets.get(7)!.px).toBeCloseTo(400, 5)
    expect(out.refs.get('D1')!.px).toBeCloseTo(800, 5)
  })
})

describe('leadPath (sag = clamp(0.15·chord, 12, 80), ctrl x at 25%/75%)', () => {
  it('exact path at chord 100 → sag 15', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 100, py: 0 }))
      .toBe('M 0 0 C 25 15, 75 15, 100 0')
  })
  it('short chord clamps sag to 12', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 40, py: 0 }))
      .toBe('M 0 0 C 10 12, 30 12, 40 0')
  })
  it('long chord clamps sag to 80', () => {
    expect(leadPath({ px: 0, py: 0 }, { px: 1000, py: 0 }))
      .toBe('M 0 0 C 250 80, 750 80, 1000 0')
  })
  it('sag is monotone in chord length between the clamps', () => {
    const sagOf = (d: number): number => {
      const m = leadPath({ px: 0, py: 0 }, { px: d, py: 0 }).match(/C [\d.-]+ ([\d.-]+),/)
      return Number(m![1])
    }
    expect(sagOf(200)).toBeGreaterThan(sagOf(100))
    expect(sagOf(400)).toBeGreaterThan(sagOf(200))
  })
  it('vertical component: control points drop below the chord (+y)', () => {
    const path = leadPath({ px: 0, py: 100 }, { px: 100, py: 100 })
    expect(path).toBe('M 0 100 C 25 115, 75 115, 100 100')
  })
})
```

- [ ] **Step 10: Run to verify failure**

Run: `npx vitest run src/renderer/src/bench/__tests__/leadGeometry.test.ts`
Expected: FAIL — module `../leadGeometry` not found.

- [ ] **Step 11: Implement `src/renderer/src/bench/leadGeometry.ts`**

```ts
/**
 * bench/leadGeometry.ts — pure projection + lead-path math.
 *
 * Spec §3: sag = clamp(0.15 · chordLen, 12, 80) px, cubic bézier control
 * points at 25% / 75% of the chord, each dropped `sag` px in +y (screen down).
 * Same world→screen projection as the annotation declutter (markers.ts).
 */

import * as THREE from 'three'

export interface Pt {
  px: number
  py: number
}

export function projectAnchor(
  worldPos: THREE.Vector3, camera: THREE.Camera, w: number, h: number,
): Pt {
  const ndc = worldPos.clone().project(camera)
  return {
    px: (ndc.x + 1) * 0.5 * w,
    py: (1 - (ndc.y + 1) * 0.5) * h,
  }
}

export function projectAnchorSet(
  nets: Map<number, THREE.Vector3>,
  refs: Map<string, THREE.Vector3>,
  camera: THREE.Camera, w: number, h: number,
): { nets: Map<number, Pt>; refs: Map<string, Pt> } {
  const outNets = new Map<number, Pt>()
  for (const [netId, pos] of nets) outNets.set(netId, projectAnchor(pos, camera, w, h))
  const outRefs = new Map<string, Pt>()
  for (const [ref, pos] of refs) outRefs.set(ref, projectAnchor(pos, camera, w, h))
  return { nets: outNets, refs: outRefs }
}

/** Round to 0.1 px so path strings are stable for tests and cheap to diff. */
function r1(v: number): number {
  return Math.round(v * 10) / 10
}

export function leadPath(jack: Pt, clip: Pt): string {
  const dx = clip.px - jack.px
  const dy = clip.py - jack.py
  const chord = Math.hypot(dx, dy)
  const sag = Math.min(80, Math.max(12, 0.15 * chord))
  const c1x = jack.px + 0.25 * dx
  const c1y = jack.py + 0.25 * dy + sag
  const c2x = jack.px + 0.75 * dx
  const c2y = jack.py + 0.75 * dy + sag
  return `M ${r1(jack.px)} ${r1(jack.py)} C ${r1(c1x)} ${r1(c1y)}, ${r1(c2x)} ${r1(c2y)}, ${r1(clip.px)} ${r1(clip.py)}`
}
```

- [ ] **Step 12: Run to verify pass, then the full gate**

Run: `npx vitest run src/renderer/src/bench src/core/spicegen`
Expected: PASS (all new + existing spicegen tests).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add src/core/spicegen/instruments.ts src/core/spicegen/__tests__/wired.test.ts src/renderer/src/bench
git commit -m "feat(bench): pure lead data layer — wiring model + sag geometry"
```

---

### Task 2: Scene additions — attach-target hit-test, anchors, highlight

**Files:**
- Modify: `src/renderer/src/viewport/markers.ts` (export `projectToScreen`)
- Modify: `src/renderer/src/viewport/scene.ts`
- Test: `src/renderer/src/viewport/__tests__/picking.test.ts` (append)

**Interfaces:**
- Consumes: `projectAnchorSet` + `Pt` from `bench/leadGeometry.ts` (Task 1); the picker's `raycastFirst` (`picking.ts:292`); `netPositionsMap` (`scene.ts:257`); `setExternalHighlight` (`picking.ts:305`).
- Produces (Task 5 relies on these exact SceneManager members):
  - `pickAttachTargetAt(xPx: number, yPx: number, width: number, height: number): { netId: number } | { ref: string } | null`
  - `projectAnchors(netIds: number[], refs: string[]): { nets: Map<number, Pt>; refs: Map<string, Pt> }`
  - `highlightAttachTarget(target: { netId?: number; ref?: string } | null): void`
  - (`SceneCallbacks.onRender` already exists — `scene.ts:79`, fired at `scene.ts:328` — Task 5 uses it; nothing to add here.)

- [ ] **Step 1: Write the failing picking test (component-hit path)**

Append to `src/renderer/src/viewport/__tests__/picking.test.ts` (reuse that file's existing helpers for creating meshes/cameras — read the file first and follow its local conventions):

```ts
describe('raycastFirst — component box path (bench lead clamp drops)', () => {
  it('returns { ref } when the first hit is a registered component box', () => {
    const picker = createPicker(() => {})
    const boxGeo = new THREE.BoxGeometry(10, 10, 2)
    const box = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial())
    box.position.set(0, 0, 0)
    box.updateMatrixWorld(true)
    picker.registerComponentBox(box, 'D1')

    const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000)
    cam.position.set(0, 0, 100)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)

    const hit = picker.raycastFirst({ x: 0, y: 0 }, cam)
    expect(hit).not.toBeNull()
    expect(hit!.ref).toBe('D1')
    expect(hit!.netId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/renderer/src/viewport/__tests__/picking.test.ts`
Expected: PASS already (raycastFirst exists) — this is a pinning test for the path the bench relies on. If it fails, STOP and report; do not modify picking.ts without flagging it.

- [ ] **Step 3: Export the projection from markers.ts**

In `src/renderer/src/viewport/markers.ts`, change the private `function projectToScreen(...)` (line ~156) to `export function projectToScreen(...)`. No body change. (It is not used by the bench directly — `leadGeometry.projectAnchor` duplicates the 6-line math with tests — but exporting documents the single source of the convention; add one line to its doc comment: `Exported: same convention as bench/leadGeometry.projectAnchor.`)

- [ ] **Step 4: Add the scene members**

In `src/renderer/src/viewport/scene.ts`:

(a) Import at top:

```ts
import { projectAnchorSet, type Pt } from '../bench/leadGeometry'
```

(b) Add to the `SceneManager` interface, after `pickNetAt` (line ~169):

```ts
  /**
   * Bench leads: generalized pixel-space hit-test. Copper hit → { netId },
   * component box hit → { ref }, miss → null. pickNetAt remains for callers
   * that only accept nets.
   */
  pickAttachTargetAt(xPx: number, yPx: number, width: number, height: number):
    { netId: number } | { ref: string } | null

  /**
   * Bench leads: project net + component anchor world positions to canvas px
   * using the active camera. Unknown ids/refs are silently skipped.
   */
  projectAnchors(netIds: number[], refs: string[]):
    { nets: Map<number, Pt>; refs: Map<string, Pt> }

  /**
   * Bench leads: highlight the candidate attach target during a lead drag via
   * the picker's external-highlight path (same as critic focus). null clears.
   */
  highlightAttachTarget(target: { netId?: number; ref?: string } | null): void
```

(c) Add module state next to `netPositionsMap` (line ~257):

```ts
  let componentAnchorByRef = new Map<string, THREE.Vector3>()
```

(d) In `loadBoard`, where component boxes are built (the `boxEntries` loop at line ~556): reset the map just before the loop —

```ts
      componentAnchorByRef = new Map<string, THREE.Vector3>()
```

— and inside the loop (after `picker.registerComponentBox(mesh, entry.ref)`):

```ts
        // World-space anchor for bench lead clamps: the box position plus the
        // group's board-centering offset (same convention as netPositionsMap).
        componentAnchorByRef.set(
          entry.ref,
          new THREE.Vector3(entry.worldX - cx, entry.worldY - cy, entry.worldZ),
        )
```

(e) Implement the three members in the returned object, after `pickNetAt` (line ~737):

```ts
    pickAttachTargetAt(xPx, yPx, width, height) {
      const cam = getActiveCamera()
      const ndcX = (xPx / width) * 2 - 1
      const ndcY = (yPx / height) * -2 + 1
      const hit = picker.raycastFirst({ x: ndcX, y: ndcY }, cam)
      if (!hit) return null
      if (hit.netId !== undefined) return { netId: hit.netId }
      if (hit.ref !== undefined) return { ref: hit.ref }
      return null
    },

    projectAnchors(netIds, refs) {
      const cam = getActiveCamera()
      const size = renderer ? renderer.getSize(new THREE.Vector2()) : new THREE.Vector2(800, 600)
      const nets = new Map<number, THREE.Vector3>()
      for (const id of netIds) {
        const pos = netPositionsMap.get(id)
        if (pos) nets.set(id, pos)
      }
      const refMap = new Map<string, THREE.Vector3>()
      for (const ref of refs) {
        const pos = componentAnchorByRef.get(ref)
        if (pos) refMap.set(ref, pos)
      }
      return projectAnchorSet(nets, refMap, cam, size.x, size.y)
    },

    highlightAttachTarget(target) {
      picker.setExternalHighlight(target?.netId ?? null, target?.ref ? [target.ref] : [])
      dirty = true
    },
```

- [ ] **Step 5: Gate**

Run: `npx vitest run src/renderer/src/viewport`
Expected: PASS (all existing viewport tests + the new pinning test).
Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/viewport/markers.ts src/renderer/src/viewport/scene.ts src/renderer/src/viewport/__tests__/picking.test.ts
git commit -m "feat(viewport): attach-target hit-test + anchor projection + drag highlight for bench leads"
```

---

### Task 3: Store — palette add, terminal assignment, wired-only sim

**Files:**
- Modify: `src/renderer/src/store/appStore.ts`
- Test: `src/renderer/src/store/__tests__/benchLeads.test.ts` (create)

**Interfaces:**
- Consumes: `defaultBenchInstrument`, `applyTerminal`, `clearTerminal`, `GROUND_INST_ID`, `type BenchKind`, `type Terminal`, `type AttachTarget` from `bench/leads.ts` (Task 1); `wiredInstruments` from `core/spicegen/instruments` (Task 1); existing `updateInstrument` / `addInstrument` / `setGround` / `nextProbeColor` / `selectInstrument`.
- Produces (Tasks 4–5 rely on):
  - `addBenchInstrument(kind: BenchKind): string` — creates an UNWIRED instrument, selects it, returns its id
  - `assignTerminal(instId: string, terminal: Terminal, target: AttachTarget): void` — routes `GROUND_INST_ID`+`'gnd'` to `setGround`; everything else through `applyTerminal` → `updateInstrument` (so alter/re-op semantics fire)
  - `detachTerminalWire(instId: string, terminal: Terminal): void`

- [ ] **Step 1: Write the failing store tests**

`src/renderer/src/store/__tests__/benchLeads.test.ts` (copy the `openedStore` harness from `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx:26-36`; it opens `fixture-rc.kicad_pcb` with a mock sim client):

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import { UNWIRED } from '../../../../core/spicegen/instruments'
import { GROUND_INST_ID } from '../../bench/leads'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
    'fixture-rc.kicad_pcb',
  )
  return store
}

describe('addBenchInstrument', () => {
  it('creates an unwired instrument, selects it, returns the id', () => {
    const store = openedStore()
    const id = store.getState().addBenchInstrument('potentiometer')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)
    expect(inst).toMatchObject({ kind: 'potentiometer', mode: 'rheostat', netA: UNWIRED, netW: UNWIRED })
    expect(store.getState().selectedInstrumentId).toBe(id)
  })
  it('voltage probes get a color from the shared allocator', () => {
    const store = openedStore()
    const id = store.getState().addBenchInstrument('voltage-probe')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)
    expect(inst).toMatchObject({ kind: 'voltage-probe', netId: UNWIRED })
    expect((inst as { color: string }).color).toMatch(/^#/)
  })
})

describe('assignTerminal', () => {
  it('wires a net terminal (table-driven per kind)', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const cases = [
      ['dc-supply', 'net', 'netId'],
      ['function-gen', 'net', 'netId'],
      ['logic-input', 'net', 'netId'],
      ['voltage-probe', 'net', 'netId'],
    ] as const
    for (const [kind, terminal, field] of cases) {
      const id = store.getState().addBenchInstrument(kind)
      store.getState().assignTerminal(id, terminal, { kind: 'net', netId: outId })
      const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
      expect((inst as Record<string, unknown>)[field]).toBe(outId)
    }
  })
  it('pot A/W wire netA/netW in rheostat mode', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('potentiometer')
    store.getState().assignTerminal(id, 'A', { kind: 'net', netId: outId })
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ netA: outId, netW: UNWIRED })
  })
  it('current-probe clamp wires the ref', () => {
    const store = openedStore()
    const id = store.getState().addBenchInstrument('current-probe')
    store.getState().assignTerminal(id, 'clamp', { kind: 'component', ref: 'R1' })
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ ref: 'R1' })
  })
  it('ground routes through setGround', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().assignTerminal(GROUND_INST_ID, 'gnd', { kind: 'net', netId: outId })
    expect(store.getState().groundNetId).toBe(outId)
  })
  it('detachTerminalWire unwires', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    const id = store.getState().addBenchInstrument('voltage-probe')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: outId })
    store.getState().detachTerminalWire(id, 'net')
    const inst = store.getState().instruments.find(i => 'id' in i && i.id === id)!
    expect(inst).toMatchObject({ netId: UNWIRED })
  })
})

describe('wired-only simulation', () => {
  it('powerOn refuses when the only source is unwired', async () => {
    const store = openedStore()
    // Drop the auto-attached supply, then add an UNWIRED one from the palette.
    for (const inst of [...store.getState().instruments]) {
      if (inst.kind === 'dc-supply' && 'id' in inst) store.getState().removeInstrument(inst.id)
    }
    store.getState().addBenchInstrument('dc-supply')
    const result = await store.getState().powerOn()
    expect(result).toBeNull()
    expect(store.getState().opVoltages).toBeNull()
  })
  it('wiring the supply then powering on solves', async () => {
    const store = openedStore()
    for (const inst of [...store.getState().instruments]) {
      if (inst.kind === 'dc-supply' && 'id' in inst) store.getState().removeInstrument(inst.id)
    }
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    const id = store.getState().addBenchInstrument('dc-supply')
    store.getState().assignTerminal(id, 'net', { kind: 'net', netId: vinId })
    const result = await store.getState().powerOn()
    expect(result).not.toBeNull()
  })
})
```

(Adjust the `powerOn` call shape to the store's actual signature — read the `powerOn` action in appStore.ts first; if it is not async or returns differently, assert via `opVoltages`/`simState` the way `appStore.test.ts` does. The INTENT is fixed: unwired source → no solve; wired source → solve.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/store/__tests__/benchLeads.test.ts`
Expected: FAIL — `addBenchInstrument` is not a function.

- [ ] **Step 3: Implement the store additions**

In `src/renderer/src/store/appStore.ts`:

(a) Imports:

```ts
import { wiredInstruments } from '../../../core/spicegen/instruments'
import {
  defaultBenchInstrument, applyTerminal, clearTerminal, GROUND_INST_ID,
  type BenchKind, type Terminal, type AttachTarget,
} from '../bench/leads'
```

(b) `AppState` interface — add next to the existing instrument actions (line ~582):

```ts
  /** Bench palette: create an UNWIRED instrument on the shelf; returns its id. */
  addBenchInstrument(kind: BenchKind): string
  /** Wire one terminal to a net/component (lead drop). Ground routes to setGround. */
  assignTerminal(instId: string, terminal: Terminal, target: AttachTarget): void
  /** Unwire one terminal (clip dragged off the board). */
  detachTerminalWire(instId: string, terminal: Terminal): void
```

(c) Implementation, next to `addInstrument` (line ~1225). Reuse the module-scope id counter pattern from InstrumentRack (`genId`) — add a module-scope helper near `nextProbeColor`:

```ts
let _benchIdCounter = 0
function benchId(kind: string): string {
  return `${kind.replace(/-/g, '_')}_bench_${++_benchIdCounter}`
}
```

```ts
    addBenchInstrument(kind) {
      const id = benchId(kind)
      const inst = defaultBenchInstrument(kind, id, nextProbeColor(get().instruments))
      get().addInstrument(inst)
      get().selectInstrument(id)
      return id
    },

    assignTerminal(instId, terminal, target) {
      // Ground is the setGround flow (spec §7) — the ground panel's black lead.
      if (instId === GROUND_INST_ID && terminal === 'gnd') {
        if (target.kind === 'net') get().setGround(target.netId)
        return
      }
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = applyTerminal(inst, terminal, target)
      // applyTerminal returns the SAME object for invalid combos — no-op then;
      // otherwise route through updateInstrument so alter/re-op semantics fire.
      if (next !== inst) get().updateInstrument(instId, next)
    },

    detachTerminalWire(instId, terminal) {
      const inst = get().instruments.find(i => 'id' in i && i.id === instId)
      if (!inst) return
      const next = clearTerminal(inst, terminal)
      if (next !== inst) get().updateInstrument(instId, next)
    },
```

(d) Wired-only sim — there are FOUR `generateDeck({...})` call sites (lines ~1372, ~1432, ~1565, ~1638). At each, change the `instruments,` property to:

```ts
        instruments: wiredInstruments(instruments),
```

(the local `instruments` variable name may differ per site — apply to whatever is passed).

(e) Every `hasSource`-style guard that decides whether a solve can run (the pattern at line ~1362: `instruments.some(i => i.kind === 'dc-supply' || ...)`) must count only wired sources:

```ts
      const hasSource = wiredInstruments(instruments).some(
        i => i.kind === 'dc-supply' || i.kind === 'function-gen' || i.kind === 'logic-input',
      )
```

Search for ALL occurrences of this source-presence pattern (grep `'function-gen'` in appStore.ts) and apply the same wrap where the result gates a solve. Do NOT touch UI-facing presence checks that merely display state.

(f) `syncRingBuffers` (line ~800): skip unwired probes:

```ts
      if (inst.kind === 'voltage-probe' && isFullyWired(inst)) {
```

(add `isFullyWired` to the core import).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/store`
Expected: PASS — the new file AND all existing store tests (the wired filter must not disturb them: every pre-existing test uses fully wired instruments, so `wiredInstruments` is a pass-through there).

- [ ] **Step 5: Gate + commit**

Run: `npm run typecheck` — clean.

```bash
git add src/renderer/src/store/appStore.ts src/renderer/src/store/__tests__/benchLeads.test.ts
git commit -m "feat(store): bench palette add + terminal wiring + wired-only deck generation"
```

---

### Task 4: Shelf UI — shared controls, front panels, BenchShelf

**Files:**
- Create: `src/renderer/src/bench/controls.tsx` (DragKnob + NumericField moved from InstrumentProps)
- Modify: `src/renderer/src/panels/InstrumentProps.tsx` (delete its local DragKnob/NumericField + styles; import from `../bench/controls`)
- Create: `src/renderer/src/bench/JackView.tsx`
- Create: `src/renderer/src/bench/panels.tsx` (all six front panels — they share small helpers and are each ~40 lines; one file keeps them cohesive)
- Create: `src/renderer/src/bench/BenchShelf.tsx`
- Test: `src/renderer/src/bench/__tests__/benchShelf.test.tsx`

**Interfaces:**
- Consumes: `jacksFor`, `GROUND_INST_ID`, `JACK_COLORS`, `type JackDef`, `type BenchKind` (Task 1); store actions `addBenchInstrument`, `updateInstrument`, `removeInstrument`, `attachProbeToNet`, `selectInstrument`; store state `instruments`, `groundNetId`, `selectedNetId`, `autoAttachedSupplyId`, `opVoltages`, `circuit`.
- Produces (Task 5 relies on):
  - `controls.tsx`: `export function DragKnob(props: DragKnobProps & { testId?: string })`, `export function NumericField(...)` — signatures identical to the InstrumentProps originals (`InstrumentProps.tsx:28-38, 111-119`) plus the optional `testId` on DragKnob (rendered as `data-testid` on the knob div).
  - `JackView.tsx`: `export interface JackHandlers { onJackPointerDown?: (jack: JackDef, e: React.PointerEvent) => void; registerJack?: (key: string, el: HTMLElement | null) => void }`, `export function JackView({ jack, handlers }: { jack: JackDef; handlers?: JackHandlers })` — renders testid `jack-${jack.instId}-${jack.terminal}`, `data-wired`.
  - `BenchShelf.tsx`: `export default function BenchShelf({ jackHandlers }: { jackHandlers?: JackHandlers })` — testid `bench-shelf`; palette button testid `add-instrument-btn`; palette items `palette-<kind>`.

**Steps:**

- [ ] **Step 1: Move the shared controls.** Create `src/renderer/src/bench/controls.tsx` containing `DragKnob`, `NumericField`, and their style constants moved VERBATIM from `InstrumentProps.tsx` (components at lines 26–165; find the style constants — `knobContainerStyle`, `knobStyle`, `knobTextStyle`, `knobUnitStyle`, `knobLabelStyle`, `fieldRowStyle`, `fieldLabelStyle`, `fieldInputWrapStyle`, and any others those two components reference — at the bottom of the file). Two changes only: `export` both components, and add `testId?: string` to `DragKnobProps`, rendered as `data-testid={testId}` on the knob div (the one with `role="slider"`). Then edit `InstrumentProps.tsx`: delete the moved code and add `import { DragKnob, NumericField } from '../bench/controls'`. Run: `npx vitest run src/renderer/src/panels && npm run typecheck` — all green (InstrumentRack tests still pass; behavior unchanged).

- [ ] **Step 2: Commit the move** (isolated so the panel diff stays readable):

```bash
git add src/renderer/src/bench/controls.tsx src/renderer/src/panels/InstrumentProps.tsx
git commit -m "refactor(bench): extract DragKnob + NumericField to bench/controls"
```

- [ ] **Step 3: Write the failing shelf tests**

`src/renderer/src/bench/__tests__/benchShelf.test.tsx` — same harness as `InstrumentRack.test.tsx:26-48` but rendering `<BenchShelf />`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import BenchShelf from '../BenchShelf'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, AUTO_SUPPLY_ID, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'), 'fixture-rc.kicad_pcb')
  return store
}
function renderShelf(store: ReturnType<typeof createAppStore>): string {
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}><BenchShelf /></AppStoreProvider>)
}

describe('BenchShelf — panels mirror the store', () => {
  it('renders the shelf with a panel for the auto supply and the ground', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="bench-shelf"')
    expect(html).toContain(`data-testid="jack-${AUTO_SUPPLY_ID}-net"`)
    expect(html).toContain('data-wired="true"')
    expect(html).toContain('data-testid="jack-ground-gnd"')
  })
  it('supply panel keeps the E2E contract: volts field + knob + auto note', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="supply-volts-input"')
    expect(html).toContain('data-testid="supply-volts-knob"')
    expect(html).toContain('data-testid="auto-supply-note"')
  })
  it('the auto note disappears after a user edit (parity with the rack)', () => {
    const store = openedStore()
    const vinId = store.getState().circuit!.nets.find(n => n.kicadName === 'VIN')!.id
    store.getState().updateInstrument(AUTO_SUPPLY_ID, {
      kind: 'dc-supply', id: AUTO_SUPPLY_ID, netId: vinId, volts: 9, seriesOhms: 0.1 })
    expect(renderShelf(store)).not.toContain('data-testid="auto-supply-note"')
  })
  it('palette lists all six kinds', () => {
    const html = renderShelf(openedStore())
    expect(html).toContain('data-testid="add-instrument-btn"')
    for (const kind of ['dc-supply', 'function-gen', 'logic-input', 'voltage-probe', 'current-probe', 'potentiometer']) {
      expect(html).toContain(`data-testid="palette-${kind}"`)
    }
  })
  it('a palette-added pot renders two open jacks (rheostat)', () => {
    const store = openedStore()
    const id = store.getState().addBenchInstrument('potentiometer')
    const html = renderShelf(store)
    expect(html).toContain(`data-testid="jack-${id}-A"`)
    expect(html).toContain(`data-testid="jack-${id}-W"`)
    expect(html).not.toContain(`data-testid="jack-${id}-Lo"`)
    expect(html).toContain('data-wired="false"')
  })
  it('probe-this-net button survives the rack retirement (M7 F6)', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().selectNet(outId)
    const html = renderShelf(store)
    expect(html).toContain('data-testid="probe-net-btn"')
    expect(html).toContain('⌖')
  })
  it('no probe-net button without a selected net', () => {
    expect(renderShelf(openedStore())).not.toContain('data-testid="probe-net-btn"')
  })
})
```

Note the palette items render in the static markup: implement the palette as always-in-DOM (`<div style={{display: open ? 'flex' : 'none'}}>` won't SSR both states — instead render the palette items ALWAYS, in a popover container whose visibility is controlled by state, defaulting OPEN=false but items present with `display:none`… SSR renders `display:none` fine and the testids remain findable). Simplest compliant approach: render palette items always; toggle only `display`.

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run src/renderer/src/bench/__tests__/benchShelf.test.tsx`
Expected: FAIL — `../BenchShelf` not found.

- [ ] **Step 5: Implement `JackView.tsx`**

```tsx
/**
 * bench/JackView.tsx — one jack circle on a front panel.
 * Registers its DOM node with the lead layer (Task 5) and forwards
 * pointerdown so a lead drag can start. Pure presentation otherwise.
 */

import React from 'react'
import type { JackDef } from './leads'

export interface JackHandlers {
  onJackPointerDown?: (jack: JackDef, e: React.PointerEvent) => void
  registerJack?: (key: string, el: HTMLElement | null) => void
}

export function JackView({ jack, handlers }: { jack: JackDef; handlers?: JackHandlers }): React.ReactElement {
  const wired = jack.target !== null
  return (
    <div style={jackColStyle}>
      <div
        data-testid={`jack-${jack.instId}-${jack.terminal}`}
        data-wired={wired ? 'true' : 'false'}
        ref={el => handlers?.registerJack?.(jack.key, el)}
        onPointerDown={e => handlers?.onJackPointerDown?.(jack, e)}
        title={wired ? `${jack.label} — drag the clip to re-attach` : `Drag a lead from ${jack.label} onto the board`}
        style={{
          width: 14, height: 14, borderRadius: '50%', cursor: 'grab',
          border: `2px solid ${jack.color}`,
          background: wired ? jack.color : 'transparent',
          boxSizing: 'border-box',
        }}
      />
      <span style={jackLabelStyle}>{jack.label}</span>
    </div>
  )
}

const jackColStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
}
const jackLabelStyle: React.CSSProperties = { fontSize: 9, color: '#889' }
```

- [ ] **Step 6: Implement `panels.tsx`**

One component per kind. All follow the same skeleton; the supply panel in full (write the others with the same structure — controls copied VERBATIM in ranges/steps/labels from the matching `InstrumentProps.tsx` section, which is still in the tree):

```tsx
/**
 * bench/panels.tsx — instrument front panels for the bench shelf.
 *
 * Each panel: jack row (top), controls (below). All edits route through
 * updateInstrument — the alter/re-op machinery is untouched (spec §3).
 * Control ranges are copied from the retired InstrumentProps sections.
 */

import React from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { DragKnob, NumericField } from './controls'
import { JackView, type JackHandlers } from './JackView'
import { jacksFor, GROUND_INST_ID } from './leads'
import type { Instrument } from '../../../core/spicegen/instruments'

interface PanelProps<K extends Instrument['kind']> {
  inst: Extract<Instrument, { kind: K }> & { id: string }
  handlers?: JackHandlers
}

export function SupplyPanel({ inst, handlers }: PanelProps<'dc-supply'>): React.ReactElement {
  const store = useAppStoreApi()
  const autoId = useApp(s => s.autoAttachedSupplyId)
  const update = (next: Instrument): void => store.getState().updateInstrument(inst.id, next)
  return (
    <div style={faceStyle}>
      <div style={jackRowStyle}>
        {jacksFor(inst, inst.id).map(j => <JackView key={j.key} jack={j} handlers={handlers} />)}
      </div>
      <DragKnob
        value={inst.volts} min={0} max={24} step={0.1} label="Volts" unit="V"
        testId="supply-volts-knob"
        onChange={v => update({ ...inst, volts: v })}
      />
      <NumericField
        label="V" value={inst.volts} unit="V" min={0} max={24}
        testId="supply-volts-input"
        onChange={v => update({ ...inst, volts: v })}
      />
      <NumericField
        label="Rs" value={inst.seriesOhms} unit="Ω" min={0}
        onChange={v => update({ ...inst, seriesOhms: v })}
      />
      {autoId === inst.id && (
        <div style={autoNoteStyle} data-testid="auto-supply-note">
          Auto-attached — 5 V default
        </div>
      )}
    </div>
  )
}
```

(If the current `InstrumentProps.tsx` supply section uses different knob min/max/step or an `auto-supply-note` copy string, MATCH THE SOURCE — the source is authoritative for ranges and note copy.)

Then, with the same skeleton:
- `FunctionGenPanel` — wave `<select>` (sine/square/triangle/pulse), freq `DragKnob` (log, range from source), amplitude `DragKnob`, offset `NumericField` — all from the InstrumentProps function-gen section.
- `LogicInputPanel` — Hi/Lo toggle button pair bound to `level`, `vHigh` NumericField.
- `PotPanel` — mode toggle (`rheostat`/`divider` buttons; switching calls `updateInstrument` with the OTHER record shape, carrying over `totalOhms`/`wiperPct` and initializing new net fields to `UNWIRED`), wiper `DragKnob` (0–100 %, mapped to `wiperPct` 0–1), `totalOhms` NumericField.
- `ProbePanel` — works for both probe kinds: color swatch (12×12 div in `inst.color`), for voltage probes a readout of the probed net's last op voltage (`useApp(s => s.opVoltages)?.get(inst.netId)`, formatted `x.toFixed(3) + ' V'`, em-dash when absent/unwired), for current probes the clamped `ref` or an em-dash.
- `GroundPanel` — takes `groundNetId` + net-name lookup instead of an inst prop; renders the single gnd jack via `jacksFor({ kind: 'ground-ref', netId: groundNetId ?? UNWIRED }, GROUND_INST_ID)` and the ground net's name.

Shared styles at the bottom of `panels.tsx`:

```tsx
export const faceStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  padding: '8px 10px', minWidth: 96,
}
const jackRowStyle: React.CSSProperties = { display: 'flex', gap: 10 }
const autoNoteStyle: React.CSSProperties = {
  fontSize: 9, color: '#c9a44a', maxWidth: 90, textAlign: 'center',
}
```

- [ ] **Step 7: Implement `BenchShelf.tsx`**

```tsx
/**
 * bench/BenchShelf.tsx — the horizontal instrument shelf below the viewport.
 * Spec §1: panels side by side, scrollable; ＋ Add instrument palette;
 * probe-this-net affordance carried over from the retired rack (M7 F6).
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import {
  SupplyPanel, FunctionGenPanel, LogicInputPanel, PotPanel, ProbePanel, GroundPanel,
} from './panels'
import type { JackHandlers } from './JackView'
import type { BenchKind } from './leads'
import type { Instrument } from '../../../core/spicegen/instruments'

const PALETTE: Array<{ kind: BenchKind; label: string }> = [
  { kind: 'dc-supply', label: 'DC Supply' },
  { kind: 'function-gen', label: 'Function Gen' },
  { kind: 'logic-input', label: 'Logic Input' },
  { kind: 'voltage-probe', label: 'V Probe' },
  { kind: 'current-probe', label: 'I Probe' },
  { kind: 'potentiometer', label: 'Potentiometer' },
]

export default function BenchShelf({ jackHandlers }: { jackHandlers?: JackHandlers }): React.ReactElement {
  const store = useAppStoreApi()
  const instruments = useApp(s => s.instruments)
  const groundNetId = useApp(s => s.groundNetId)
  const circuit = useApp(s => s.circuit)
  const selectedNetId = useApp(s => s.selectedNetId)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const selectedNet =
    selectedNetId !== null ? circuit?.nets.find(n => n.id === selectedNetId) : undefined

  const panelFor = (inst: Instrument, i: number): React.ReactElement | null => {
    if (!('id' in inst)) return null // ground-ref renders separately
    const key = inst.id
    switch (inst.kind) {
      case 'dc-supply':     return <ShelfSlot key={key} title="PSU" instId={inst.id}><SupplyPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'function-gen':  return <ShelfSlot key={key} title="FUNC GEN" instId={inst.id}><FunctionGenPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'logic-input':   return <ShelfSlot key={key} title="LOGIC" instId={inst.id}><LogicInputPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'potentiometer': return <ShelfSlot key={key} title="POT" instId={inst.id}><PotPanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      case 'voltage-probe':
      case 'current-probe': return <ShelfSlot key={key} title={inst.kind === 'voltage-probe' ? 'V PROBE' : 'I PROBE'} instId={inst.id}><ProbePanel inst={inst} handlers={jackHandlers} /></ShelfSlot>
      default: return null
    }
  }

  return (
    <div style={shelfStyle} data-testid="bench-shelf">
      <div style={shelfHeaderStyle}>
        <span style={{ fontWeight: 600 }}>Bench</span>
        {selectedNet && (
          <span style={probeRowStyle}>
            <span style={{ color: '#888' }}>Net:</span>
            <span style={{ fontFamily: 'monospace', color: '#9ab' }}>{selectedNet.kicadName}</span>
            <ProbeNetButton netId={selectedNet.id} netName={selectedNet.kicadName} />
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ position: 'relative' }}>
          <button
            data-testid="add-instrument-btn"
            style={addBtnStyle}
            onClick={() => setPaletteOpen(v => !v)}
          >
            ＋ Add instrument
          </button>
          <div style={{ ...paletteStyle, display: paletteOpen ? 'flex' : 'none' }}>
            {PALETTE.map(p => (
              <button
                key={p.kind}
                data-testid={`palette-${p.kind}`}
                style={paletteItemStyle}
                onClick={() => { store.getState().addBenchInstrument(p.kind); setPaletteOpen(false) }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </span>
      </div>
      <div style={panelsRowStyle}>
        {groundNetId !== null && (
          <ShelfSlot title="GND" instId={null}>
            <GroundPanel groundNetId={groundNetId} handlers={jackHandlers} />
          </ShelfSlot>
        )}
        {instruments.map(panelFor)}
      </div>
    </div>
  )
}
```

Include in the same file: `ShelfSlot` (title bar + optional ✕ calling `removeInstrument(instId)` when `instId !== null`, wrapping `children`), `ProbeNetButton` moved VERBATIM from `InstrumentRack.tsx:190-205` (keep `data-testid="probe-net-btn"`, the `⌖` glyph, and the `#2a6b3a` resting background — a pinned Gemini-finding regression), and the styles:

```tsx
const shelfStyle: React.CSSProperties = {
  borderTop: '1px solid #2a2a3a', background: '#12121c', color: '#ddd',
  display: 'flex', flexDirection: 'column', fontSize: 12,
}
const shelfHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px',
  borderBottom: '1px solid #22222f',
}
const probeRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }
const addBtnStyle: React.CSSProperties = {
  background: '#2a2a45', color: '#eee', border: '1px solid #3a3a55',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
}
const paletteStyle: React.CSSProperties = {
  position: 'absolute', right: 0, bottom: '110%', zIndex: 30,
  flexDirection: 'column', gap: 2, padding: 6,
  background: '#1e1e2e', border: '1px solid #3a3a55', borderRadius: 6,
}
const paletteItemStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#dde', padding: '5px 12px',
  cursor: 'pointer', textAlign: 'left', fontSize: 12, whiteSpace: 'nowrap',
}
const panelsRowStyle: React.CSSProperties = {
  display: 'flex', gap: 8, padding: '6px 10px', overflowX: 'auto', minHeight: 120,
}
```

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run src/renderer/src/bench src/renderer/src/panels`
Expected: PASS — shelf tests green AND all existing panel tests (rack still compiles: it is retired in Task 5).
Run: `npm run typecheck` — clean.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/bench
git commit -m "feat(bench): front panels + bench shelf with palette and jacks"
```

---

### Task 5: LeadLayer + drag interaction + App integration + rack retirement

**Files:**
- Create: `src/renderer/src/bench/BenchLeads.tsx` (provider: jack registry, anchors, drag state, LeadLayer)
- Modify: `src/renderer/src/viewport/Viewport.tsx` (add `onRender` prop; DELETE the HTML5 drag-drop path + `onNetDrop` prop)
- Modify: `src/renderer/src/App.tsx` (mount shelf + provider; retire rack; McuPinsPanel to right dock)
- Create: `src/renderer/src/panels/McuPinsPanel.tsx` (moved out of InstrumentProps)
- Delete: `src/renderer/src/panels/InstrumentProps.tsx`, `src/renderer/src/panels/InstrumentRack.tsx`, `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx`
- Test: `src/renderer/src/bench/__tests__/benchLeads.render.test.tsx`

**Interfaces:**
- Consumes: Task 2 SceneManager members (`pickAttachTargetAt`, `projectAnchors`, `highlightAttachTarget`), `SceneCallbacks.onRender` via the new Viewport `onRender` prop; Task 1 `jacksFor`/`resolveDrop`/`leadPath`/`GROUND_INST_ID`; Task 3 `assignTerminal`/`detachTerminalWire`; Task 4 `BenchShelf`/`JackHandlers`.
- Produces: `BenchLeads` component: `export interface BenchLeadsHandle { notifyFrame(): void }`; `const BenchLeads = forwardRef<BenchLeadsHandle, { scene: SceneManager | null; children: React.ReactNode }>(...)` — renders `children` inside a `position:relative` column, the `BenchShelf` (wired with jack handlers), and the SVG `LeadLayer` overlay on top.

**Structure of `BenchLeads.tsx`** (single file; the pure pieces already live in Task 1):

```tsx
/**
 * bench/BenchLeads.tsx — the lead overlay + drag controller.
 *
 * Owns: the jack element registry, the projected anchor cache, and the
 * drag-in-progress state. Children = the viewport region; the shelf and the
 * SVG LeadLayer are rendered by this component so all three share one
 * coordinate space (this component's relative container).
 *
 * Coordinates: everything in container-relative px. Jack anchors come from
 * getBoundingClientRect (cheap at <20 jacks); clip anchors come from
 * scene.projectAnchors + the canvas's offset within the container.
 * Recompute triggers: scene frame render (notifyFrame via ref), window
 * resize, shelf scroll (capture-phase), instruments/ground change.
 *
 * Drag: pointerdown on a jack or clip → setPointerCapture on that element →
 * window pointermove updates the dashed lead + throttled (50 ms) candidate
 * highlight via scene.highlightAttachTarget → pointerup resolves:
 *   over canvas + valid hit  → assignTerminal
 *   anywhere else            → wired jack: detachTerminalWire; unwired: cancel
 * Escape cancels. Highlight always cleared on end.
 */
```

- [ ] **Step 1: Write the failing render tests**

`src/renderer/src/bench/__tests__/benchLeads.render.test.tsx` — SSR the provider with a null scene (no drag, no anchors → leads render only once anchors exist, so the static assertions target structure, not paths):

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import BenchLeads from '../BenchLeads'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')
function openedStore(): ReturnType<typeof createAppStore> {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.getState().openBoardFromText(
    readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'), 'fixture-rc.kicad_pcb')
  return store
}

describe('BenchLeads composition', () => {
  it('renders children + shelf + the lead-layer SVG in one container', () => {
    const store = openedStore()
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () => store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <BenchLeads scene={null}>
          <div data-testid="fake-viewport" />
        </BenchLeads>
      </AppStoreProvider>,
    )
    expect(html).toContain('data-testid="fake-viewport"')
    expect(html).toContain('data-testid="bench-shelf"')
    expect(html).toContain('data-testid="lead-layer"')
    // No anchors yet (scene null, no layout) → no committed lead paths.
    expect(html).not.toContain('data-testid="lead-path"')
  })
})
```

Plus pure-logic tests for the lead assembly — add to `src/renderer/src/bench/__tests__/leads.test.ts`:

```ts
import { computeLeads } from '../leads'

describe('computeLeads', () => {
  const jackRects = new Map([['s1:net', { px: 10, py: 500 }], ['p1:A', { px: 60, py: 500 }]])
  const anchors = { nets: new Map([[7, { px: 200, py: 100 }]]), refs: new Map<string, { px: number; py: number }>() }
  it('wired jack with a live net + known anchors → one lead with a path', () => {
    const inst: Instrument = { kind: 'dc-supply', id: 's1', netId: 7, volts: 5, seriesOhms: 0.1 }
    const leads = computeLeads([{ inst, instId: 's1' }], jackRects, anchors, new Set([7]))
    expect(leads).toHaveLength(1)
    expect(leads[0]).toMatchObject({ jackKey: 's1:net', dangling: false, color: expect.stringMatching(/^#/) })
    expect(leads[0].path).toMatch(/^M 10 500 C /)
    expect(leads[0].clip).toEqual({ px: 200, py: 100 })
  })
  it('wired jack whose net no longer exists → dangling, no clip', () => {
    const inst: Instrument = { kind: 'dc-supply', id: 's1', netId: 7, volts: 5, seriesOhms: 0.1 }
    const leads = computeLeads([{ inst, instId: 's1' }], jackRects, anchors, new Set([99]))
    expect(leads[0]).toMatchObject({ dangling: true, clip: null, path: null })
  })
  it('unwired jacks and jacks without a measured rect produce no lead', () => {
    const unwired: Instrument = { kind: 'dc-supply', id: 's1', netId: UNWIRED, volts: 5, seriesOhms: 0.1 }
    expect(computeLeads([{ inst: unwired, instId: 's1' }], jackRects, anchors, new Set([7]))).toHaveLength(0)
    const wired: Instrument = { kind: 'voltage-probe', id: 'zz', netId: 7, color: '#6f6' }
    expect(computeLeads([{ inst: wired, instId: 'zz' }], jackRects, anchors, new Set([7]))).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/bench`
Expected: FAIL — `computeLeads` and `BenchLeads` missing.

- [ ] **Step 3: Add `computeLeads` to `bench/leads.ts`**

```ts
import { leadPath, type Pt } from './leadGeometry'

export interface LeadRender {
  jackKey: string
  instId: string
  terminal: Terminal
  color: string
  jack: Pt
  /** Projected clip anchor; null while dangling. */
  clip: Pt | null
  /** SVG path; null while dangling. */
  path: string | null
  /** Wired to a net that no longer exists on the (reloaded) board. */
  dangling: boolean
}

/**
 * Assemble the render model for every wired jack. A lead renders only when
 * its jack has a measured rect; it is dangling when its net target is absent
 * from the live circuit (spec §5). Component targets are never dangling here —
 * a vanished ref simply loses its anchor and the lead is skipped.
 */
export function computeLeads(
  instruments: Array<{ inst: Instrument; instId: string }>,
  jackRects: Map<string, Pt>,
  anchors: { nets: Map<number, Pt>; refs: Map<string, Pt> },
  liveNetIds: Set<number>,
): LeadRender[] {
  const out: LeadRender[] = []
  for (const { inst, instId } of instruments) {
    for (const jack of jacksFor(inst, instId)) {
      if (!jack.target) continue
      const jackPt = jackRects.get(jack.key)
      if (!jackPt) continue
      if (jack.target.kind === 'net') {
        if (!liveNetIds.has(jack.target.netId)) {
          out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
            jack: jackPt, clip: null, path: null, dangling: true })
          continue
        }
        const clip = anchors.nets.get(jack.target.netId)
        if (!clip) continue
        out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
          jack: jackPt, clip, path: leadPath(jackPt, clip), dangling: false })
      } else {
        const clip = anchors.refs.get(jack.target.ref)
        if (!clip) continue
        out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
          jack: jackPt, clip, path: leadPath(jackPt, clip), dangling: false })
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Implement `BenchLeads.tsx`**

Complete component (the doc-comment from the structure block above goes on top):

```tsx
import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import type { SceneManager } from '../viewport/scene'
import BenchShelf from './BenchShelf'
import type { JackHandlers } from './JackView'
import {
  computeLeads, jacksFor, resolveDrop, GROUND_INST_ID,
  type JackDef, type LeadRender,
} from './leads'
import { leadPath, type Pt } from './leadGeometry'

export interface BenchLeadsHandle { notifyFrame(): void }

interface DragState { jack: JackDef; cursor: Pt }

const BenchLeads = forwardRef<BenchLeadsHandle, {
  scene: SceneManager | null
  children: React.ReactNode
}>(function BenchLeads({ scene, children }, ref): React.ReactElement {
  const store = useAppStoreApi()
  const instruments = useApp(s => s.instruments)
  const groundNetId = useApp(s => s.groundNetId)
  const circuit = useApp(s => s.circuit)

  const containerRef = useRef<HTMLDivElement>(null)
  const jackEls = useRef(new Map<string, HTMLElement>())
  const [leads, setLeads] = useState<LeadRender[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const lastHighlightAt = useRef(0)

  // instruments + the ground singleton, in the shape computeLeads takes.
  const instRows = useCallback(() => {
    const rows: Array<{ inst: (typeof instruments)[number]; instId: string }> = []
    if (groundNetId !== null) {
      rows.push({ inst: { kind: 'ground-ref', netId: groundNetId }, instId: GROUND_INST_ID })
    }
    for (const inst of instruments) {
      if ('id' in inst) rows.push({ inst, instId: inst.id })
    }
    return rows
  }, [instruments, groundNetId])

  const recompute = useCallback(() => {
    const container = containerRef.current
    if (!container || !scene) { setLeads([]); return }
    const cRect = container.getBoundingClientRect()
    const canvas = container.querySelector('canvas')
    const canvasRect = canvas?.getBoundingClientRect()

    // Jack anchors: element centers, container-relative.
    const jackRects = new Map<string, Pt>()
    for (const [key, el] of jackEls.current) {
      const r = el.getBoundingClientRect()
      jackRects.set(key, { px: r.left + r.width / 2 - cRect.left, py: r.top + r.height / 2 - cRect.top })
    }

    // Clip anchors: canvas-px from the scene, shifted into container space.
    const rows = instRows()
    const netIds: number[] = []
    const refs: string[] = []
    for (const { inst, instId } of rows) {
      for (const j of jacksFor(inst, instId)) {
        if (j.target?.kind === 'net') netIds.push(j.target.netId)
        if (j.target?.kind === 'component') refs.push(j.target.ref)
      }
    }
    const raw = scene.projectAnchors(netIds, refs)
    const dx = (canvasRect?.left ?? cRect.left) - cRect.left
    const dy = (canvasRect?.top ?? cRect.top) - cRect.top
    const anchors = {
      nets: new Map([...raw.nets].map(([k, p]) => [k, { px: p.px + dx, py: p.py + dy }])),
      refs: new Map([...raw.refs].map(([k, p]) => [k, { px: p.px + dx, py: p.py + dy }])),
    }
    const liveNetIds = new Set((circuit?.nets ?? []).map(n => n.id))
    setLeads(computeLeads(rows, jackRects, anchors, liveNetIds))
  }, [scene, instRows, circuit])

  useImperativeHandle(ref, () => ({ notifyFrame: recompute }), [recompute])

  // Layout-change triggers beyond scene frames.
  useEffect(() => { recompute() }, [recompute])
  useEffect(() => {
    window.addEventListener('resize', recompute)
    const container = containerRef.current
    container?.addEventListener('scroll', recompute, true) // shelf scroll, capture
    return () => {
      window.removeEventListener('resize', recompute)
      container?.removeEventListener('scroll', recompute, true)
    }
  }, [recompute])

  // ── drag machinery ─────────────────────────────────────────────────────────

  const endDrag = useCallback(() => {
    dragRef.current = null
    setDrag(null)
    scene?.highlightAttachTarget(null)
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('keydown', onDragKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  const canvasHit = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current
    const canvas = container?.querySelector('canvas')
    if (!canvas || !scene) return null
    const r = canvas.getBoundingClientRect()
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null
    return scene.pickAttachTargetAt(clientX - r.left, clientY - r.top, r.width, r.height)
  }, [scene])

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const cRect = containerRef.current!.getBoundingClientRect()
    const next = { ...d, cursor: { px: e.clientX - cRect.left, py: e.clientY - cRect.top } }
    dragRef.current = next
    setDrag(next)
    const now = performance.now()
    if (now - lastHighlightAt.current > 50) {
      lastHighlightAt.current = now
      const hit = canvasHit(e.clientX, e.clientY)
      scene?.highlightAttachTarget(
        hit && 'netId' in hit && d.jack.accepts === 'net' ? { netId: hit.netId }
        : hit && 'ref' in hit && d.jack.accepts === 'component' ? { ref: hit.ref }
        : null)
    }
  }, [canvasHit, scene])

  const onDragUp = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    endDrag()
    if (!d) return
    const hit = canvasHit(e.clientX, e.clientY)
    const target = resolveDrop(hit ?? null, d.jack)
    const st = store.getState()
    if (target) {
      st.assignTerminal(d.jack.instId, d.jack.terminal, target)
    } else if (d.jack.target && !(d.jack.instId === GROUND_INST_ID)) {
      // A wired clip released off-board detaches (ground never detaches, spec §7).
      st.detachTerminalWire(d.jack.instId, d.jack.terminal)
    }
  }, [canvasHit, endDrag, store])

  const onDragKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') endDrag()
  }, [endDrag])

  const beginDrag = useCallback((jack: JackDef, e: React.PointerEvent) => {
    e.preventDefault()
    const cRect = containerRef.current!.getBoundingClientRect()
    const d = { jack, cursor: { px: e.clientX - cRect.left, py: e.clientY - cRect.top } }
    dragRef.current = d
    setDrag(d)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('keydown', onDragKey)
  }, [onDragMove, onDragUp, onDragKey])

  const jackHandlers: JackHandlers = {
    registerJack: (key, el) => {
      if (el) jackEls.current.set(key, el)
      else jackEls.current.delete(key)
    },
    onJackPointerDown: beginDrag,
  }

  // The dashed drag lead starts from the dragged jack's current anchor.
  const dragOrigin = drag ? (
    leads.find(l => l.jackKey === drag.jack.key)?.jack
      ?? (() => {
        const el = jackEls.current.get(drag.jack.key)
        const cRect = containerRef.current?.getBoundingClientRect()
        if (!el || !cRect) return null
        const r = el.getBoundingClientRect()
        return { px: r.left + r.width / 2 - cRect.left, py: r.top + r.height / 2 - cRect.top }
      })()
  ) : null

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {children}
      <BenchShelf jackHandlers={jackHandlers} />
      <svg
        data-testid="lead-layer"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 20, width: '100%', height: '100%' }}
      >
        {leads.map(l => (
          <g key={l.jackKey}>
            {l.path && (
              <path
                data-testid="lead-path"
                data-inst={l.instId}
                data-terminal={l.terminal}
                d={l.path}
                fill="none"
                stroke={l.color}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            )}
            {l.dangling && (
              <circle
                data-testid="lead-dangling"
                cx={l.jack.px} cy={l.jack.py + 10} r={4}
                fill="none" stroke={l.color} strokeDasharray="2 2"
              />
            )}
            {l.clip && (
              <g
                data-testid="lead-clip"
                data-x={l.clip.px}
                data-y={l.clip.py}
                style={{ pointerEvents: 'auto', cursor: 'grab' }}
                onPointerDown={e => {
                  const row = jacksFor(
                    l.instId === GROUND_INST_ID
                      ? { kind: 'ground-ref', netId: groundNetId ?? -1 }
                      : (instruments.find(i => 'id' in i && i.id === l.instId)!),
                    l.instId,
                  ).find(j => j.terminal === l.terminal)
                  if (row) beginDrag(row, e)
                }}
              >
                {/* invisible hit circle (spec §2) + visible alligator-clip glyph */}
                <circle cx={l.clip.px} cy={l.clip.py} r={10} fill="transparent" />
                <circle cx={l.clip.px} cy={l.clip.py} r={4.5} fill={l.color} stroke="#111" strokeWidth={1} />
                <line x1={l.clip.px - 4} y1={l.clip.py - 6} x2={l.clip.px + 4} y2={l.clip.py - 6}
                  stroke={l.color} strokeWidth={2} />
              </g>
            )}
          </g>
        ))}
        {drag && dragOrigin && (
          <path
            data-testid="lead-drag"
            d={leadPath(dragOrigin, drag.cursor)}
            fill="none"
            stroke={drag.jack.color}
            strokeWidth={2}
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  )
})

export default BenchLeads
```

Listener-cleanup note for the reviewer: `beginDrag`/`endDrag` add/remove the same three window listeners; `endDrag` runs on every pointerup and on Escape, and the callbacks are stable per drag because `dragRef` carries the state (the `useCallback` deps intentionally exclude `drag`).

- [ ] **Step 5: Extract McuPinsPanel, retire the rack**

1. Create `src/renderer/src/panels/McuPinsPanel.tsx`: move the `McuPinsPanel` component (`InstrumentProps.tsx:440+`), the `McuPinRow` helper (line 168+), and every style constant they reference, VERBATIM, as the new file's default export. Update its imports (`useApp`/`useAppStoreApi`, `Instrument`).
2. Delete `src/renderer/src/panels/InstrumentProps.tsx` and `src/renderer/src/panels/InstrumentRack.tsx` and `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx` (its store-behavior assertions were ported to `benchShelf.test.tsx` in Task 4).
3. `App.tsx`:
   - Remove the `InstrumentRack` import + `<InstrumentRack />`; add `import McuPinsPanel from './panels/McuPinsPanel'` and render it in the right dock where the rack was, gated exactly as the rack gated it (`InstrumentRack.tsx:322-328`): when the selected part resolves to an `interactive-pins` stub —
     ```tsx
     {isMcuSelected && selectedMcuRef && <McuPinsPanel ref_={selectedMcuRef} />}
     ```
     (lift the `selectedMcuRef` / `isMcuSelected` derivation from `InstrumentRack.tsx:323-328` into App).
   - Remove `handleNetDrop` (line 167-200) and the `onNetDrop={handleNetDrop}` prop.
   - Add scene state + provider composition:
     ```tsx
     const [sceneMgr, setSceneMgr] = useState<SceneManager | null>(null)
     const benchRef = useRef<BenchLeadsHandle>(null)
     ```
     — in the existing `handleSceneReady`, additionally call `setSceneMgr(scene)`. Replace the center-column contents (line ~313-376) with:
     ```tsx
     <div style={centerColStyle}>
       <BenchLeads ref={benchRef} scene={sceneMgr}>
         <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
           {board ? (
             <Viewport
               board={board}
               onPick={handlePick}
               onSceneReady={handleSceneReady}
               onRender={() => benchRef.current?.notifyFrame()}
               netVoltages={opVoltages ?? undefined}
               voltageRange={voltageRange}
               overlay={overlay}
             />
           ) : ( /* NoBoardState block unchanged */ )}
           {/* CoachNotes + selection badge unchanged */}
         </div>
       </BenchLeads>
       {/* bottomDock (Scope + log tabs) unchanged, still below the provider */}
     </div>
     ```
     The shelf therefore sits between the viewport and the bottom dock (spec §1: shelf above the Scope region).
4. `Viewport.tsx`: add `onRender?: () => void` to props; thread it into `manager.mount(canvas, { onPickEvent: ..., onRender: () => onRenderRef.current?.() })` via the same ref pattern as `onPick` (line 70-75). DELETE `handleDragOver`, `handleDrop`, the `onDragOver`/`onDrop` props on the wrapper div, and the `onNetDrop` prop + its ref (the HTML5 drag gesture is replaced by lead drags, spec §2).

- [ ] **Step 6: Full gate**

Run: `npx vitest run`
Expected: ALL tests pass (the deleted rack test is gone; no other suite imports the deleted files — verify with `grep -rn "InstrumentRack\|InstrumentProps" src/ e2e/` → only `McuPinsPanel`-related and historical comments may remain; fix any live importer found).
Run: `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add -A src/renderer/src
git commit -m "feat(bench): lead layer + jack drag wiring; retire InstrumentRack/InstrumentProps"
```

---

### Task 6: E2E — the tactile path, plus spec bookkeeping

**Files:**
- Modify: `e2e/first-light.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-17-bench-leads-design.md` (record the clip-rendering deviation)

**Interfaces:**
- Consumes: testids from Tasks 4–5 (`lead-path`, `lead-clip` with `data-x`/`data-y`, `lead-layer`, `add-instrument-btn`, `palette-voltage-probe`, `jack-*` with `data-wired`, `supply-volts-knob`); DragKnob semantics: value change = `(startY − clientY)/100 × (max − min)`, so +20 px downward ≈ −4.8 V on the 0–24 V supply knob.

- [ ] **Step 1: Extend the First Light E2E**

In `e2e/first-light.spec.ts`, after the glow-at-5V assertions (the block ending near line 125) and REPLACING the `supply-volts-input` fill step (lines ~127-133):

```ts
    // 4. Bench leads: the auto-attached supply + ground render as drawn leads.
    const leadPaths = page.locator('[data-testid="lead-path"]')
    await expect(leadPaths.first()).toBeVisible({ timeout: 10_000 })
    const leadCountBefore = await leadPaths.count()
    expect(leadCountBefore).toBeGreaterThanOrEqual(2) // supply + ground

    // 5. Run a lead: add a V-probe from the palette, drag its open jack onto
    //    the board. Drop target: the supply clip's anchor (data-x/data-y are
    //    container-relative px) — that pixel is ON the supply net's copper, so
    //    the raycast attaches the probe to a real net deterministically.
    await page.locator('[data-testid="add-instrument-btn"]').click()
    await page.locator('[data-testid="palette-voltage-probe"]').click()
    const openJack = page.locator('[data-testid^="jack-voltage_probe"][data-wired="false"]')
    await expect(openJack).toBeVisible()
    const clip = page.locator('[data-testid="lead-clip"]').first()
    const clipX = Number(await clip.getAttribute('data-x'))
    const clipY = Number(await clip.getAttribute('data-y'))
    const layerBox = (await page.locator('[data-testid="lead-layer"]').boundingBox())!
    const jackBox = (await openJack.boundingBox())!
    await page.mouse.move(jackBox.x + jackBox.width / 2, jackBox.y + jackBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(layerBox.x + clipX, layerBox.y + clipY, { steps: 10 })
    await page.mouse.up()
    await expect(leadPaths).toHaveCount(leadCountBefore + 1, { timeout: 10_000 })
    await expect(openJack).toHaveCount(0) // the jack is now wired

    // 6. Turn the supply knob DOWN (the tactile path — spec §6 replaces the
    //    typed set-value step). +20 px downward drag ≈ −4.8 V on the 0–24 V
    //    knob → ~0.2 V → the LED dims sharply.
    const knob = page.locator('[data-testid="supply-volts-knob"]')
    const knobBox = (await knob.boundingBox())!
    const kx = knobBox.x + knobBox.width / 2
    const ky = knobBox.y + knobBox.height / 2
    await page.mouse.move(kx, ky)
    await page.mouse.down()
    await page.mouse.move(kx, ky + 20, { steps: 5 })
    await page.mouse.up()
```

Keep the existing glow-dimming `waitForFunction` + assertions that followed the old fill step unchanged — they now verify the knob path. (DragKnob listens to `mousemove`/`mouseup` on `window` — Playwright's `page.mouse` drives real window events, so this works without element-level dispatch.)

- [ ] **Step 2: Run the E2E suite**

Run: `npm run build && npx playwright test e2e/first-light.spec.ts`
Expected: PASS. Then the full suite: `npx playwright test` — all 6 scenarios green (`smoke.spec.ts` still uses `supply-volts-input`, which the SupplyPanel kept). Known flake: `transient.integration.test.ts` RC-curve zero-rows on Windows — rerun once before investigating.

- [ ] **Step 3: Record the deviation in the spec**

In `docs/superpowers/specs/2026-07-17-bench-leads-design.md` §1, replace the final bullet ("The **board-end clip** is the existing probe-marker sprite …") with:

```markdown
- The **board-end clip** renders as an SVG glyph in the LeadLayer at the
  projected anchor (`data-x`/`data-y` in container px), doubling as the
  re-attach hit target. **[2026-07-20 implementation note]** The spec
  originally reused "the existing probe-marker sprite", but `addProbeMarker`
  turned out to have zero production callers — the Task-20 marker layer was
  never wired to any in-scene visual, so there was nothing to restyle; the
  anchor world positions (`netPositionsMap`) are reused as specced.
```

- [ ] **Step 4: Final full gate + commit**

Run: `npx vitest run && npm run typecheck`
Expected: everything green.

```bash
git add e2e/first-light.spec.ts docs/superpowers/specs/2026-07-17-bench-leads-design.md
git commit -m "test(e2e): first-light drives the bench — run a lead, turn the knob; spec deviation note"
```

---

## Plan Self-Review (performed at authoring time)

- **Spec coverage:** §1 shelf/panels/palette → Task 4; §1 lead styling + §5 dangling → Tasks 1/5; §2 gestures (attach/re-attach/detach/highlight/no-orbit) → Task 5 (jack + clip pointer targets are DOM/SVG, so pointerdown never reaches the canvas); §3 architecture (leadGeometry, LeadLayer, shelf, DragKnob move, scene members, App retirement, unchanged data model) → Tasks 1–5; §4 data flow (onRender-driven reprojection, alterPlan untouched) → Tasks 2/5; §6 testing → each task + Task 6 E2E; §7 non-goals respected (GroundSetup untouched; ground panel mirrors + re-attaches only; no persistence — shelf order is instrument insertion order).
- **Known deviation** (recorded in Task 6): clip = SVG glyph, not a restyled marker sprite (no such sprite exists).
- **Deliberate scope note:** unwired instruments do not persist across board reloads (instruments reset on open — existing store semantics, spec §5 "the shelf renders whatever the store holds").
- **Type consistency:** `Pt`/`JackDef`/`AttachTarget`/`Terminal`/`LeadRender` defined once (Task 1) and imported everywhere; SceneManager members named identically in Task 2 (definition) and Task 5 (consumption); store actions named identically in Task 3 (definition) and Tasks 4–5 (consumption).
