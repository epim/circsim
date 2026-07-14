# Op-Informed Rail Sensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive a digital chip's supply-rail voltage (`vHigh`) from a first-pass operating-point solve when its VDD sits on a switched/derived rail with no directly-attached bench supply, with a manual override escape hatch and a gated-off warning.

**Architecture:** A 4-tier rail precedence (direct DC supply › manual override › measured-op rail › family default) selected in `expandXspiceDigital`. Tiers 1/2/4 are known at deck-gen; tier 3 needs a conditional second op pass orchestrated in `appStore.powerOn` (sense the DC voltage on unresolved chips' VDD nets, regenerate + re-run once if anything changed). A gated-off rail (measured < floor) keeps the family default and surfaces a warning that offers a one-click manual override.

**Tech Stack:** TypeScript, ngspice-46 via koffi FFI, vitest, zustand store, React (renderer).

## Global Constraints

- Full `npx vitest run` + `npm run typecheck` MUST pass before every commit (copy verbatim: the suite is currently 1463 passing / 74 files).
- Real-ngspice integration tests live behind `describe.skipIf(!haveNgspice)` and run under `npx vitest run` on this Windows x64 machine (koffi #271 patched binary installed).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Non-Schmitt/non-digital deck generation and the no-`modelTexts` golden path must remain byte-identical (there are golden tests).
- Floor = `2` V; sanity cap = `30` V; change epsilon = `0.1` V. Family defaults: CD4000 = 12 V, 74HC = 5 V.
- Rail-override keys are net `kicadName` strings (e.g. `/VGATED`); `generateDeck` consumes a resolved `Map<number /*netId*/, number /*volts*/>`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/core/spicegen/generate.ts` | Deck generation, rail precedence, `digitalVddNet`, `deriveMeasuredRailVHigh` | modify |
| `src/core/spicegen/__tests__/generate.test.ts` | Unit tests for precedence + helpers | modify |
| `src/core/spicegen/__tests__/deriveMeasuredRailVHigh.test.ts` | Unit tests for the sensing function | create |
| `src/renderer/src/store/appStore.ts` | `railOverrides` state, setters, two-pass orchestration, `railNotes` | modify |
| `src/renderer/src/store/__tests__/railSensing.test.ts` | Store-level two-pass + override + warning tests | create |
| `src/renderer/src/components/…` (net readout / override control) | UI to set/clear a per-net rail override + render the gated-off note | modify (identified in Task 7) |
| `src/simhost/__tests__/rail-sensing.integration.test.ts` | Real-ngspice two-pass / gated-off / override proof | create |

---

## Task 1: `digitalVddNet` shared helper (refactor `deriveSupplyVHigh`)

**Files:**
- Modify: `src/core/spicegen/generate.ts` (the existing `deriveSupplyVHigh`, ~lines 900–960)
- Test: `src/core/spicegen/__tests__/generate.test.ts`

**Interfaces:**
- Produces: `function digitalVddNet(tpl: Logic74Template, pinMap: Record<string, string>, part: { padNet: Map<string, number> }, netIdToNode: Map<number, string>): { vddNetId?: number; vssGrounded: boolean }` — exported.
- `deriveSupplyVHigh` keeps its existing signature and return type (`number | undefined`); it now calls `digitalVddNet` internally.

- [ ] **Step 1: Write the failing test**

Add to `generate.test.ts` (near the existing M10 digital tests, reuse `makeDigitalCircuit`):

```ts
import { digitalVddNet } from '../generate'

test('digitalVddNet resolves the VDD net and VSS-grounded flag', () => {
  const tpl = { power: { vcc: 'VCC', gnd: 'GND' } } as any
  const pinMap = { '14': 'VCC', '7': 'GND', '1': '1A' }
  const part = { padNet: new Map([['14', 4], ['7', 5], ['1', 1]]) }
  const netIdToNode = new Map([[4, 'vcc'], [5, '0'], [1, 'a']])
  const r = digitalVddNet(tpl, pinMap, part, netIdToNode)
  expect(r.vddNetId).toBe(4)
  expect(r.vssGrounded).toBe(true)
})

test('digitalVddNet reports vssGrounded=false when VSS pad is not on node 0', () => {
  const tpl = { power: { vcc: 'VCC', gnd: 'GND' } } as any
  const pinMap = { '14': 'VCC', '7': 'GND' }
  const part = { padNet: new Map([['14', 4], ['7', 6]]) }
  const netIdToNode = new Map([[4, 'vcc'], [6, 'notground']])
  const r = digitalVddNet(tpl, pinMap, part, netIdToNode)
  expect(r.vddNetId).toBe(4)
  expect(r.vssGrounded).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spicegen/__tests__/generate.test.ts -t digitalVddNet`
Expected: FAIL — `digitalVddNet` is not exported.

- [ ] **Step 3: Extract the helper**

In `generate.ts`, add above `deriveSupplyVHigh` (use the SAME `Logic74Template` type `deriveSupplyVHigh` already references for `tpl`):

```ts
/**
 * Resolve a digital chip's VDD board net and whether its VSS pad is grounded.
 * Steps 1–2 of the M10 supply rule, shared by deriveSupplyVHigh and
 * deriveMeasuredRailVHigh. Returns vddNetId=undefined if the VDD pads don't all
 * land on one net (or there's no VDD/VSS signal in the template power block).
 */
export function digitalVddNet(
  tpl: Logic74Template,
  pinMap: Record<string, string>,
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
): { vddNetId?: number; vssGrounded: boolean } {
  const vccSig = tpl.power?.vcc?.toUpperCase()
  const gndSig = tpl.power?.gnd?.toUpperCase()
  if (!vccSig || !gndSig) return { vddNetId: undefined, vssGrounded: false }

  let vddNetId: number | undefined
  for (const [pad, sig] of Object.entries(pinMap)) {
    if (sig.toUpperCase() !== vccSig) continue
    const netId = part.padNet.get(pad)
    if (netId === undefined) continue
    if (vddNetId !== undefined && vddNetId !== netId) return { vddNetId: undefined, vssGrounded: false }
    vddNetId = netId
  }

  let vssGrounded = false
  for (const [pad, sig] of Object.entries(pinMap)) {
    if (sig.toUpperCase() !== gndSig) continue
    const netId = part.padNet.get(pad)
    if (netId === undefined) continue
    if (netIdToNode.get(netId) === '0') vssGrounded = true
  }
  return { vddNetId, vssGrounded }
}
```

Then rewrite `deriveSupplyVHigh` to consume it (replace its steps 1–2 loops):

```ts
function deriveSupplyVHigh(
  tpl: Logic74Template,
  pinMap: Record<string, string>,
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  instruments: Instrument[],
): number | undefined {
  const { vddNetId, vssGrounded } = digitalVddNet(tpl, pinMap, part, netIdToNode)
  if (vddNetId === undefined || !vssGrounded) return undefined

  const supplies = instruments.filter(
    (i): i is Extract<Instrument, { kind: 'dc-supply' }> =>
      i.kind === 'dc-supply' && i.netId === vddNetId,
  )
  if (supplies.length !== 1) return undefined
  const volts = supplies[0].volts
  if (!Number.isFinite(volts) || volts <= 0) return undefined
  return volts
}
```

> NOTE the behavior-preserving subtlety: the OLD `deriveSupplyVHigh` returned `undefined` the moment ANY VSS pad was on a non-ground net. The new `digitalVddNet` sets `vssGrounded=true` if ANY VSS pad is grounded. For every current fixture each chip has exactly one VSS pad, so behavior is identical. Keep the `!vssGrounded` guard so a chip with no grounded VSS still yields `undefined`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spicegen/__tests__/generate.test.ts`
Expected: PASS (new `digitalVddNet` tests + all existing M10/digital tests still green).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/spicegen/generate.ts src/core/spicegen/__tests__/generate.test.ts
git commit -m "refactor(spicegen): extract digitalVddNet from deriveSupplyVHigh

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 4-tier rail precedence in `generateDeck`

**Files:**
- Modify: `src/core/spicegen/generate.ts` (`GenerateOptions`, `generateDeck`, `expandXspiceDigital`)
- Test: `src/core/spicegen/__tests__/generate.test.ts`

**Interfaces:**
- Consumes: `deriveSupplyVHigh` (tier 1), the family default (tier 4) — existing.
- Produces: `GenerateOptions` gains `railOverrides?: Map<number, number>` and `measuredRailVHigh?: Map<number, number>` (both netId→volts). `expandXspiceDigital` selects `vHigh` in tier order and names the provenance source.

- [ ] **Step 1: Write the failing test**

Add to `generate.test.ts` (reuse `makeDigitalCircuit` + `LOGIC4000_JSON` fixture; CD40106 VDD pad 14 → net id 4):

```ts
test('rail precedence: manual override beats measured rail beats family default', () => {
  const circuit = makeDigitalCircuit()
  circuit.parts[0].value = 'CD40106'
  const resolutions: Resolution[] = [{
    ref: 'U1', status: 'ok', tier: 3, warnings: [],
    model: { kind: 'xspice-digital', templateId: 'CD40106',
      pinMap: { '1': '1A', '2': '1Y', '7': 'GND', '14': 'VCC' } },
  }]
  const base = {
    circuit, resolutions,
    instruments: [{ kind: 'ground-ref', netId: 5 } as any],
    groundNetId: 5,
    modelTexts: { 'logic4000.json': LOGIC4000_JSON },
  }
  // Family default (12 V): mid 6.0000, V_T+ 7.2000.
  expect(generateDeck(base).join('\n')).toContain('6.0000 ? 7.2000 : 4.8000)) ? 0 : 12.0000')
  // Measured rail 5 V (netId 4 = VDD): mid 2.5, V_T+ 3.0.
  expect(generateDeck({ ...base, measuredRailVHigh: new Map([[4, 5]]) }).join('\n'))
    .toContain('2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000')
  // Manual override 3.3 V beats the measured 5 V.
  expect(generateDeck({ ...base, measuredRailVHigh: new Map([[4, 5]]), railOverrides: new Map([[4, 3.3]]) }).join('\n'))
    .toContain('1.6500 ? 1.9800 : 1.3200)) ? 0 : 3.3000')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spicegen/__tests__/generate.test.ts -t "rail precedence"`
Expected: FAIL — `generateDeck` ignores the new options; the override/measured decks still show 12 V.

- [ ] **Step 3: Implement**

3a. Add to `GenerateOptions` (after `modelTexts`):

```ts
  /** OPTIONAL manual per-net rail voltage overrides (netId → volts). Tier 2. */
  railOverrides?: Map<number, number>
  /** OPTIONAL op-measured per-net rail voltages (netId → volts). Tier 3. */
  measuredRailVHigh?: Map<number, number>
```

3b. In `generateDeck`, thread both into the `expandXspiceDigital` call (find the call ~line 1414):

```ts
      const xspice = expandXspiceDigital(
        res.ref, model, part, netIdToNode, modelIndex, templateFile, instruments,
        opts.railOverrides, opts.measuredRailVHigh,
      )
```

3c. Extend `expandXspiceDigital`'s signature and the vHigh selection. Add params:

```ts
  railOverrides: Map<number, number> | undefined,
  measuredRailVHigh: Map<number, number> | undefined,
```

Replace the current `const supplyVHigh = deriveSupplyVHigh(...)` / `const vHigh = supplyVHigh ?? logic.family.vHighDefault` block with a tiered selection that also resolves the VDD net for the override/measured lookups:

```ts
  const { vddNetId } = digitalVddNet(tpl, model.pinMap, part, netIdToNode)
  const directVHigh = deriveSupplyVHigh(tpl, model.pinMap, part, netIdToNode, instruments) // tier 1
  const overrideVHigh = vddNetId !== undefined ? railOverrides?.get(vddNetId) : undefined   // tier 2
  const measuredVHigh = vddNetId !== undefined ? measuredRailVHigh?.get(vddNetId) : undefined // tier 3
  const sane = (v: number | undefined): number | undefined =>
    v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined
  const railSource =
    sane(directVHigh) !== undefined ? 'dc-supply on VDD net'
    : sane(overrideVHigh) !== undefined ? 'user rail override'
    : sane(measuredVHigh) !== undefined ? 'op-measured rail'
    : null
  const vHigh = sane(directVHigh) ?? sane(overrideVHigh) ?? sane(measuredVHigh) ?? logic.family.vHighDefault
```

Update the provenance comment (the existing `if (supplyVHigh !== undefined)` block) to fire whenever `railSource` is non-null and name the source:

```ts
  if (railSource) {
    lines.push(
      `* ${ref} vhigh: ${formatSpiceValue(vHigh)} (${railSource}; ` +
        `family default ${formatSpiceValue(logic.family.vHighDefault)})`,
    )
  }
```

> Keep the existing lantern integration assertion `* U1 vhigh: 5 (dc-supply on VDD net; family default 12)` working — tier 1 still produces that exact string.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spicegen/__tests__/generate.test.ts`
Expected: PASS (new precedence test + all existing digital/M10 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/spicegen/generate.ts src/core/spicegen/__tests__/generate.test.ts
git commit -m "feat(spicegen): 4-tier digital rail precedence (override + measured rail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `deriveMeasuredRailVHigh` sensing function

**Files:**
- Modify: `src/core/spicegen/generate.ts`
- Test: `src/core/spicegen/__tests__/deriveMeasuredRailVHigh.test.ts` (create)

**Interfaces:**
- Consumes: `digitalVddNet` (Task 1); `findDigitalTemplateFile` + `parseLogic74` + `ModelTextIndex` (existing in `generate.ts`); `deriveSupplyVHigh` (tier 1 skip).
- Produces:
  ```ts
  export function deriveMeasuredRailVHigh(opts: {
    opValues: Record<string, number>       // bare lowercase spice node → volts
    circuit: Circuit
    resolutions: Resolution[]
    instruments: Instrument[]
    groundNetId: number
    railOverrides?: Map<number, number>    // netId → volts (tier-2 skip)
    modelTexts?: Record<string, string>
  }): { rails: Map<number, number>; gatedOff: Array<{ ref: string; netId: number; kicadName: string }> }
  ```
  Constants: `RAIL_FLOOR_V = 2`, `RAIL_SANITY_MAX_V = 30` (module-level, exported for tests).

- [ ] **Step 1: Write the failing test**

Create `deriveMeasuredRailVHigh.test.ts`. Build a minimal `circuit` + resolutions matching `makeDigitalCircuit` conventions (net id 4 = VDD net `vgated`, id 5 = GND node `0`). Use the existing `LOGIC4000_JSON` shape (copy the fixture the generate tests use, or import if exported).

```ts
import { describe, expect, test } from 'vitest'
import { deriveMeasuredRailVHigh, RAIL_FLOOR_V } from '../generate'
import type { Circuit } from '../../netlist/types'
import type { Resolution } from '../../models/resolve'

const LOGIC4000_JSON = JSON.stringify({
  family: { vHighDefault: 12.0, adc: { inLowFrac: 0.3, inHighFrac: 0.7 }, schmittAdc: { inLowFrac: 0.4, inHighFrac: 0.6 } },
  templates: { CD40106: { schmitt: true, gates: [{ prim: 'd_inverter', in: ['1A'], out: '1Y' }],
    inputs: ['1A'], outputs: ['1Y'], power: { vcc: 'VCC', gnd: 'GND' }, delaysNs: 80 } },
})

function digitalCircuit(vddNode: string): Circuit {
  return {
    nets: [
      { id: 1, kicadName: 'IN', spiceNode: 'a', padRefs: [] },
      { id: 2, kicadName: 'OUT', spiceNode: 'b', padRefs: [] },
      { id: 4, kicadName: '/VGATED', spiceNode: vddNode, padRefs: [] },
      { id: 5, kicadName: 'GND', spiceNode: '0', padRefs: [] },
    ],
    parts: [{ ref: 'U1', value: 'CD40106', libId: 'Logic:CD40106', layer: 'F',
      padNet: new Map([['1', 1], ['2', 2], ['14', 4], ['7', 5]]), properties: {} }],
    warnings: [],
  }
}
const RES: Resolution[] = [{ ref: 'U1', status: 'ok', tier: 3, warnings: [],
  model: { kind: 'xspice-digital', templateId: 'CD40106',
    pinMap: { '1': '1A', '2': '1Y', '14': 'VCC', '7': 'GND' } } }]
const base = (opValues: Record<string, number>, extra = {}) => deriveMeasuredRailVHigh({
  opValues, circuit: digitalCircuit('vgated'), resolutions: RES,
  instruments: [{ kind: 'ground-ref', netId: 5 } as any], groundNetId: 5,
  modelTexts: { 'logic4000.json': LOGIC4000_JSON }, ...extra,
})

test('FET-fed VDD measuring 12.6 V → rails has netId 4 = 12.6', () => {
  const r = base({ vgated: 12.6 })
  expect(r.rails.get(4)).toBeCloseTo(12.6)
  expect(r.gatedOff).toEqual([])
})

test('gated-off VDD (~0 V) → not in rails, present in gatedOff', () => {
  const r = base({ vgated: 0.01 })
  expect(r.rails.has(4)).toBe(false)
  expect(r.gatedOff).toEqual([{ ref: 'U1', netId: 4, kicadName: '/VGATED' }])
})

test('chip with a direct dc-supply on VDD is skipped (tier 1 owns it)', () => {
  const r = deriveMeasuredRailVHigh({
    opValues: { vgated: 12.6 }, circuit: digitalCircuit('vgated'), resolutions: RES,
    instruments: [{ kind: 'dc-supply', netId: 4, volts: 12 } as any, { kind: 'ground-ref', netId: 5 } as any],
    groundNetId: 5, modelTexts: { 'logic4000.json': LOGIC4000_JSON },
  })
  expect(r.rails.has(4)).toBe(false)
  expect(r.gatedOff).toEqual([])
})

test('chip with a manual override is skipped', () => {
  const r = base({ vgated: 12.6 }, { railOverrides: new Map([[4, 3.3]]) })
  expect(r.rails.has(4)).toBe(false)
})

test('floor constant is 2 V', () => { expect(RAIL_FLOOR_V).toBe(2) })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/spicegen/__tests__/deriveMeasuredRailVHigh.test.ts`
Expected: FAIL — `deriveMeasuredRailVHigh` / `RAIL_FLOOR_V` not exported.

- [ ] **Step 3: Implement**

Add to `generate.ts`:

```ts
export const RAIL_FLOOR_V = 2
export const RAIL_SANITY_MAX_V = 30

export function deriveMeasuredRailVHigh(opts: {
  opValues: Record<string, number>
  circuit: Circuit
  resolutions: Resolution[]
  instruments: Instrument[]
  groundNetId: number
  railOverrides?: Map<number, number>
  modelTexts?: Record<string, string>
}): { rails: Map<number, number>; gatedOff: Array<{ ref: string; netId: number; kicadName: string }> } {
  const { opValues, circuit, resolutions, instruments, railOverrides, modelTexts } = opts
  const rails = new Map<number, number>()
  const gatedOff: Array<{ ref: string; netId: number; kicadName: string }> = []
  const haveModelTexts = modelTexts !== undefined && Object.keys(modelTexts).length > 0
  if (!haveModelTexts) return { rails, gatedOff }
  const idx = buildModelTextIndex(modelTexts!)  // same index builder generateDeck uses

  // netId → spiceNode (mirror generateDeck's map)
  const netIdToNode = new Map<number, string>()
  for (const net of circuit.nets) netIdToNode.set(net.id, net.spiceNode)
  const netById = new Map(circuit.nets.map((n) => [n.id, n]))
  const partByRef = new Map(circuit.parts.map((p) => [p.ref, p]))

  for (const res of resolutions) {
    const model = res.model
    if (!model || model.kind !== 'xspice-digital') continue
    const part = partByRef.get(res.ref)
    if (!part) continue
    const templateFile = findDigitalTemplateFile(idx, model.templateId)
    const logic = templateFile ? parseLogic74(idx, templateFile) : null
    const tpl = logic?.templates?.[model.templateId]
    if (!logic || !tpl) continue

    const { vddNetId, vssGrounded } = digitalVddNet(tpl, model.pinMap, part, netIdToNode)
    if (vddNetId === undefined || !vssGrounded) continue
    // tier 1 / tier 2 own this chip → don't sense.
    if (deriveSupplyVHigh(tpl, model.pinMap, part, netIdToNode, instruments) !== undefined) continue
    if (railOverrides?.get(vddNetId) !== undefined) continue

    const node = netIdToNode.get(vddNetId)
    const v = node !== undefined ? opValues[node] : undefined
    if (v === undefined || !Number.isFinite(v)) continue
    const kicadName = netById.get(vddNetId)?.kicadName ?? String(vddNetId)
    if (v < RAIL_FLOOR_V) { gatedOff.push({ ref: res.ref, netId: vddNetId, kicadName }); continue }
    if (v > RAIL_SANITY_MAX_V) continue
    rails.set(vddNetId, v)
  }
  return { rails, gatedOff }
}
```

> If `buildModelTextIndex` is named differently in `generate.ts`, use the exact existing builder that `generateDeck` calls to construct its `ModelTextIndex` (grep for `ModelTextIndex` construction near `generateDeck`). Reuse it — do not re-implement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/spicegen/__tests__/deriveMeasuredRailVHigh.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/spicegen/generate.ts src/core/spicegen/__tests__/deriveMeasuredRailVHigh.test.ts
git commit -m "feat(spicegen): deriveMeasuredRailVHigh (op-measured digital rails + gated-off)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `railOverrides` store state + threading into deck gen

**Files:**
- Modify: `src/renderer/src/store/appStore.ts`
- Test: `src/renderer/src/store/__tests__/railSensing.test.ts` (create)

**Interfaces:**
- Consumes: `generateDeck` (`railOverrides?: Map<number, number>`, Task 2).
- Produces store additions: `railOverrides: Map<string, number>` (kicadName→volts); actions `setRailOverride(kicadName: string, volts: number): void` and `clearRailOverride(kicadName: string): void`; a private helper `railOverrideNetMap(): Map<number, number>` resolving kicadName→netId via the current circuit's nets.

- [ ] **Step 1: Write the failing test**

Create `railSensing.test.ts`. Mirror any existing appStore test's setup (grep the store test dir for how the store is instantiated + how `circuit` is seeded). Assert:

```ts
test('setRailOverride stores by kicadName and resolves to a netId map', () => {
  const store = makeTestStore() // per existing store-test harness
  seedCircuitWithNet(store, { id: 4, kicadName: '/VGATED' })
  store.getState().setRailOverride('/VGATED', 3.3)
  expect(store.getState().railOverrides.get('/VGATED')).toBe(3.3)
  expect((store.getState() as any).railOverrideNetMap().get(4)).toBe(3.3)
})

test('clearRailOverride removes the entry', () => {
  const store = makeTestStore()
  seedCircuitWithNet(store, { id: 4, kicadName: '/VGATED' })
  store.getState().setRailOverride('/VGATED', 3.3)
  store.getState().clearRailOverride('/VGATED')
  expect(store.getState().railOverrides.has('/VGATED')).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/railSensing.test.ts`
Expected: FAIL — `setRailOverride` undefined.

- [ ] **Step 3: Implement (mirror the `pinMapOverrides` pattern)**

3a. State field (near `pinMapOverrides: Map<string, PinMap>`, ~line 303) and its two initializers (~lines 741, 790):

```ts
  railOverrides: Map<string, number>
```
```ts
    railOverrides: new Map(),
```

3b. Actions (mirror `setPinMap`, ~line 1035):

```ts
    setRailOverride(kicadName, volts) {
      if (!Number.isFinite(volts) || volts <= 0) return
      const next = new Map(get().railOverrides)
      next.set(kicadName, volts)
      set({ railOverrides: next })
      get().markDeckDirty()
    },
    clearRailOverride(kicadName) {
      const next = new Map(get().railOverrides)
      next.delete(kicadName)
      set({ railOverrides: next })
      get().markDeckDirty()
    },
    railOverrideNetMap() {
      const { circuit, railOverrides } = get()
      const map = new Map<number, number>()
      if (!circuit) return map
      for (const net of circuit.nets) {
        const v = railOverrides.get(net.kicadName)
        if (v !== undefined) map.set(net.id, v)
      }
      return map
    },
```

3c. Thread `railOverrides: get().railOverrideNetMap()` into EVERY `generateDeck({ … })` call site (powerOn ~1243, energize ~1368, transient ~1432). Add the property to each options object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/railSensing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/renderer/src/store/appStore.ts src/renderer/src/store/__tests__/railSensing.test.ts
git commit -m "feat(store): railOverrides state + thread into deck generation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Two-pass op orchestration in `powerOn`

**Files:**
- Modify: `src/renderer/src/store/appStore.ts` (`powerOn`, ~lines 1231–1307)
- Test: `src/renderer/src/store/__tests__/railSensing.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveMeasuredRailVHigh` (Task 3), `railOverrideNetMap` (Task 4), `generateDeck` `measuredRailVHigh` (Task 2), the existing `simClient` (`send`, `waitFor`).
- Produces: `powerOn` runs a conditional second op pass; caches `measuredRails: Map<number, number>` in store state for transient reuse; sets `railNotes` (Task 6) from `gatedOff`.

- [ ] **Step 1: Write the failing test (mocked sim)**

Extend `railSensing.test.ts`. Mock `simClient` so `runOp` resolves with a scripted `opResult`. Two cases:

```ts
test('powerOn runs a second op pass when a measured rail changes vHigh', async () => {
  const store = makeTestStore()
  seedSwitchedRailBoard(store) // CD40106 on /VGATED (net 4), no supply on it; battery elsewhere
  const opCalls: string[][] = []
  mockSim(store, {
    onLoad: (deck) => opCalls.push(deck),
    // /VGATED measures 12.6 V in BOTH passes (rail set by upstream power)
    opResult: () => ({ type: 'opResult', values: { vgated: 12.6, /* … */ } }),
  })
  await store.getState().powerOn()
  expect(opCalls.length).toBe(2)                       // pass 1 + pass 2
  // pass-2 deck uses the measured 12.6 V swing, not the 12 V default
  expect(opCalls[1].join('\n')).toContain('12.6000')
})

test('powerOn does NOT re-run when nothing changes (measured == family default)', async () => {
  const store = makeTestStore()
  seedSwitchedRailBoard(store)
  const opCalls: string[][] = []
  mockSim(store, { onLoad: (deck) => opCalls.push(deck), opResult: () => ({ type: 'opResult', values: { vgated: 12.0 } }) })
  await store.getState().powerOn()
  expect(opCalls.length).toBe(1)                       // 12.0 == family default (within epsilon) → no pass 2
})

test('powerOn surfaces a gated-off warning and keeps family default', async () => {
  const store = makeTestStore()
  seedSwitchedRailBoard(store)
  mockSim(store, { opResult: () => ({ type: 'opResult', values: { vgated: 0.0 } }) })
  await store.getState().powerOn()
  expect(store.getState().railNotes.map((n) => n.kicadName)).toContain('/VGATED')
})
```

> If the existing store tests don't have a sim mock harness, add a minimal one in this test file: replace `simClient.send`/`waitFor` with a controllable stub (grep `simClient` import in appStore to see the seam; inject via the same mechanism other store tests use, or `vi.mock('../../ipc/simClient')`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/railSensing.test.ts -t powerOn`
Expected: FAIL — only one op pass; no `railNotes`.

- [ ] **Step 3: Implement**

In `powerOn`, after `result = await simClient.waitFor('opResult', 30_000)` succeeds and BEFORE `mapOpResultToNetVoltages` (~line 1274), insert:

```ts
      // ── Op-informed rail sensing (tier 3): sense switched rails, re-solve once ──
      const { rails, gatedOff } = deriveMeasuredRailVHigh({
        opValues: result.values, circuit, resolutions, instruments, groundNetId,
        railOverrides: get().railOverrideNetMap(),
        modelTexts: buildDeckModelTexts(get()),
      })
      // Did any measured rail change a chip's vHigh vs pass 1 (family default)?
      const familyChanged = [...rails.entries()].some(([netId, v]) => {
        const prev = get().measuredRails?.get(netId)
        return prev === undefined || Math.abs(prev - v) > 0.1
      })
      if (rails.size > 0 && familyChanged) {
        const deck2 = generateDeck({
          circuit, resolutions, instruments, groundNetId,
          title: get().project.boardFileName ?? undefined,
          modelTexts: buildDeckModelTexts(get()),
          railOverrides: get().railOverrideNetMap(),
          measuredRailVHigh: rails,
        })
        simClient.send({ type: 'loadCircuit', deckLines: deck2 })
        simClient.send({ type: 'runOp' })
        try {
          result = await simClient.waitFor('opResult', 30_000)   // pass 2 (single re-run)
        } catch {
          // Pass-2 failure: keep the pass-1 result already in `result`.
        }
      }
      set({ measuredRails: rails })
      const railNotes = gatedOff.map((g) => ({ ref: g.ref, kicadName: g.kicadName }))
```

Then extend the existing `set({ … })` state commit (~line 1290) to include `railNotes`. Add `measuredRails: Map<number, number> | null` and `railNotes: RailNote[]` to the store state + initializers (default `null` / `[]`). `result` is already `let` — confirm it is (it is: `let result` at ~1264). The pass-2 result flows into the existing `mapOpResultToNetVoltages(result.values, …)` unchanged.

> Guard: exactly one re-run — the code above re-runs at most once (no loop). Pass 2 uses `measuredRailVHigh: rails`, so re-sensing pass 2 would measure ~the same rails → `familyChanged` false → the guard is structural (there is no second sense call anyway).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/railSensing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite + commit**

```bash
npm run typecheck && npx vitest run
git add src/renderer/src/store/appStore.ts src/renderer/src/store/__tests__/railSensing.test.ts
git commit -m "feat(store): two-pass op-informed rail sensing in powerOn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Gated-off warning channel + rendering

**Files:**
- Modify: `src/renderer/src/store/appStore.ts` (`railNotes` state — types + init, done alongside Task 5)
- Modify: the readout component that renders caveats (identify by grepping the renderer for `coachNotes` / the fidelity banner render; likely `src/renderer/src/components/…` — the same component that shows "open by design")
- Test: extend `railSensing.test.ts` (state) + a component test if the readout component has one

**Interfaces:**
- Consumes: `railNotes: Array<{ ref: string; kicadName: string }>` (set in Task 5).
- Produces: a rendered fidelity note per gated-off rail with copy: *"VDD ({kicadName}) is ~0 V at the operating point — using the default swing. If this rail is powered during a transient, logic thresholds may be inaccurate."* and a "Set rail voltage…" affordance calling `setRailOverride(kicadName, …)`.

- [ ] **Step 1: Write the failing test**

Add a `RailNote` type export and a state test (already partly in Task 5). For the component, add a render test in the readout component's existing test file (grep for the component that renders `coachNotes`):

```ts
test('gated-off rail note renders with a set-rail-voltage action', () => {
  render(<Readout /* props with railNotes=[{ref:'U7', kicadName:'/VGATED'}] */ />)
  expect(screen.getByText(/VGATED.*0 V at the operating point/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /set rail voltage/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <readout component test path>`
Expected: FAIL — no rail-note rendering.

- [ ] **Step 3: Implement**

3a. In `appStore.ts` add near the coachNotes type:

```ts
export interface RailNote { ref: string; kicadName: string }
```
State: `railNotes: RailNote[]` (init `[]` in both initializers; reset to `[]` where `coachNotes` is reset).

3b. In the readout component, after the `coachNotes` block, map `railNotes` to a caveat row using the copy above; the action button calls the store's `setRailOverride` (open the existing numeric-entry affordance used elsewhere, or a minimal prompt — match how the component collects a number; if none exists, a small inline `<input type="number">` + Apply that calls `setRailOverride(kicadName, value)` then `powerOn()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <readout component test path> src/renderer/src/store/__tests__/railSensing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add -A src/renderer/src
git commit -m "feat(ui): gated-off rail warning with set-rail-voltage action

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Per-net rail-override control (net context)

**Files:**
- Modify: the net-voltages readout row and/or the selected-net panel (grep the renderer for where a net is selected / the Net Voltages tab renders rows — likely `src/renderer/src/components/…`)
- Test: that component's test file

**Interfaces:**
- Consumes: `railOverrides` state + `setRailOverride` / `clearRailOverride` (Task 4); the current net selection.
- Produces: a "Rail voltage: [___] V (Clear)" control on a net's context; setting it calls `setRailOverride(kicadName, volts)` then re-runs (`powerOn`); shows the active override value when present.

- [ ] **Step 1: Write the failing test**

```ts
test('setting a net rail override calls setRailOverride and re-runs', async () => {
  const setRailOverride = vi.fn()
  const powerOn = vi.fn()
  render(<NetPanel net={{ id: 4, kicadName: '/VGATED' }} setRailOverride={setRailOverride} powerOn={powerOn} />)
  fireEvent.change(screen.getByLabelText(/rail voltage/i), { target: { value: '3.3' } })
  fireEvent.click(screen.getByRole('button', { name: /apply|set/i }))
  expect(setRailOverride).toHaveBeenCalledWith('/VGATED', 3.3)
  expect(powerOn).toHaveBeenCalled()
})

test('an active override shows its value and a Clear control', () => {
  render(<NetPanel net={{ id: 4, kicadName: '/VGATED' }} railOverrides={new Map([['/VGATED', 3.3]])} />)
  expect(screen.getByDisplayValue('3.3')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run <net panel test path>`
Expected: FAIL — no rail-voltage control.

- [ ] **Step 3: Implement**

Add the rail-voltage control to the net panel/row: a numeric input bound to `railOverrides.get(net.kicadName)`, an Apply that calls `setRailOverride(net.kicadName, Number(value))` then `powerOn()`, and a Clear that calls `clearRailOverride(net.kicadName)` then `powerOn()`. Wire the store selectors/actions through the component's existing props/store hook (match how the component already reads store state — grep for `useAppStore` usage in that file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <net panel test path>`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add -A src/renderer/src
git commit -m "feat(ui): per-net rail-voltage override control

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Real-ngspice integration proof

**Files:**
- Create: `src/simhost/__tests__/rail-sensing.integration.test.ts`

**Interfaces:**
- Consumes: the real ngspice harness pattern from `src/simhost/__tests__/library-ic.integration.test.ts` (the `runTran` / op helpers + `haveNgspice` guard) and `generateDeck` + `deriveMeasuredRailVHigh`.

- [ ] **Step 1: Write the test (this IS the proof — no separate red step beyond it failing until Tasks 2–3 exist)**

Build a hand-written deck OR a generateDeck deck for a CD4000 chip whose VDD net is fed by a high-side FET from a non-12 V rail (e.g. a resistor divider or a VDMOS gated ON producing ~5 V on `/VGATED`). Three cases:

```ts
describe.skipIf(!haveNgspice)('op-informed rail sensing (real ngspice)', () => {
  it('two-pass derives the measured swing where a single pass used 12 V', async () => {
    // 1) generate pass-1 deck (family default 12 V on /VGATED chip), run op
    // 2) deriveMeasuredRailVHigh(op.values, …) → expect rails.get(vgatedNetId) ≈ 5
    // 3) regenerate with measuredRailVHigh, assert the CD40106 B-source shows the 5 V swing
    //    (e.g. '2.5000 ? 3.0000 : 2.0000)) ? 0 : 5.0000') and NOT '12.0000'
  })
  it('gated-off rail (FET off, ~0 V) keeps the family default and reports gatedOff', async () => {
    // FET gate held low → /VGATED ≈ 0; expect rails empty, gatedOff names the chip,
    // and the pass-1 deck (12 V default) is what runs.
  })
  it('a manual override pins the voltage regardless of the measured op', async () => {
    // railOverrides netId→3.3; assert generateDeck uses 3.3 V even though op measures 5.
  })
})
```

Fill in the deck construction concretely using the `library-ic.integration.test.ts` helpers (copy the codemodel/harness setup). Compute `vgatedNetId` from the circuit you build.

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run src/simhost/__tests__/rail-sensing.integration.test.ts`
Expected: PASS (all three) against real ngspice. If skipped (no ngspice), state that explicitly and force with the integration reporter.

- [ ] **Step 3: Full suite + typecheck + commit**

```bash
npm run typecheck && npx vitest run
git add src/simhost/__tests__/rail-sensing.integration.test.ts
git commit -m "test(rail-sensing): real-ngspice two-pass / gated-off / override proof

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review (completed by planner)

**Spec coverage:** Tier 1 (existing) ✓; tier 2 override → Tasks 2,4,7; tier 3 measured → Tasks 2,3,5; tier 4 default (existing) ✓; two-pass conditional re-run → Task 5; gated-off warning → Tasks 3,5,6; transient reuse → Task 4 (threading) + Task 5 (`measuredRails` cache; note: wiring the cache into the transient/energize deck calls is covered by Task 4's "every generateDeck call site" for `railOverrides` — extend the same call sites to pass `measuredRailVHigh: get().measuredRails ?? undefined` when present); precedence tests → Task 2; error handling (pass-2 fallback) → Task 5.

**Gap fixed inline:** transient reuse of the measured-rail cache — Task 4 threads `railOverrides` into all call sites; ALSO thread `measuredRailVHigh: get().measuredRails ?? undefined` into the energize (~1368) and transient (~1432) `generateDeck` calls in Task 4 Step 3c so a transient after an op reuses the sensed rails.

**Placeholder scan:** UI Tasks 6–7 reference "grep the renderer for the component" rather than an exact path — this is deliberate (the exact readout/net component must be located at execution time); every logic/store task has concrete code. Executors MUST identify the component first, then follow the shown test/impl shapes.

**Type consistency:** `railOverrides` is `Map<string, number>` in the store (kicadName) and `Map<number, number>` into `generateDeck` (netId), bridged by `railOverrideNetMap()` — consistent across Tasks 2/4/5. `deriveMeasuredRailVHigh` returns `{ rails, gatedOff }` used identically in Task 5. `RailNote` shape consistent Tasks 5/6.
