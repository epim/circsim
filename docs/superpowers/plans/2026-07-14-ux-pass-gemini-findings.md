# UX Pass — Gemini Review Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all 5 findings from Gemini's UX review (`docs/ux-review-gemini-2026-07-13.md`) per the approved spec `docs/superpowers/specs/2026-07-14-ux-pass-gemini-findings-design.md`.

**Architecture:** Renderer-only. A new shared inline-style module (`ui/buttonStyles.ts`) establishes primary/secondary/ghost button tiers; each finding is an isolated change to one panel plus its SSR tests. The only store change is a small derivational "minimize" state for the fidelity banner (signature-matched, auto re-expanding).

**Tech Stack:** React 18 + TypeScript, zustand store, inline `React.CSSProperties` styling (there is NO stylesheet anywhere in the renderer — do not add CSS files), vitest with `renderToStaticMarkup` in a **node env (no jsdom — effects never run, events can't fire; test interactive logic via exported helpers/components rendered in a chosen state)**.

## Global Constraints

- Renderer-only; no engine/spicegen/simhost changes; no new dependencies; no CSS files or `<style>` injection.
- All existing `data-testid`s keep their exact values: `open-sample-btn`, `open-first-light-btn`, `open-board-btn`, `probe-net-btn`, `bottom-tab-nets`, `bottom-tab-log`, `open-model-doctor` (E2E depends on the first two).
- The fidelity banner may be **minimized to a visible badge, never removed** (Spec §8.6 honesty). Exactly one of {banner, badge} is visible whenever problems exist.
- Naming: the feature is "minimize" (`fidelityMinimizedSig`, `minimizeFidelityBanner`, `isFidelityMinimized`) — "collapse" is already taken by `collapsedFidelitySummary` (>3-refs text summarization) and must not be reused.
- Do-not-regress: stale-voltage dimming (`opacity: 0.55`) in NetVoltages.tsx and the ranked supply auto-select in InstrumentRack.tsx — do not touch either.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run commands from the repo root `C:\Users\bear\circsim`.

---

### Task 1: Shared button styles + empty-state hierarchy (finding 2)

**Files:**
- Create: `src/renderer/src/ui/buttonStyles.ts`
- Modify: `src/renderer/src/panels/EmptyStates.tsx` (add `NoBoardState`)
- Modify: `src/renderer/src/App.tsx` (delete local `EmptyState` at ~lines 377–421 and `emptyStateStyle` at ~lines 528–536; render `NoBoardState`)
- Test: `src/renderer/src/panels/__tests__/EmptyStates.test.tsx` (new)

**Interfaces:**
- Produces: `btnPrimary`, `btnSecondary`, `btnGhost: React.CSSProperties` from `ui/buttonStyles.ts` (btnGhost is consumed by no one yet — it completes the tier language and is exported for future use; do not delete it). `NoBoardState({ onOpen, onOpenSample, onOpenFirstLight }: NoBoardStateProps)` from `panels/EmptyStates.tsx`.

Note: the first-run card moves out of App.tsx into `EmptyStates.tsx` — that file is the documented home for "guided empty-state cards" and the move is what makes the component testable under the SSR panel-test idiom (App.tsx imports the GL Viewport and can't be imported by node tests).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/panels/__tests__/EmptyStates.test.tsx`:

```tsx
/**
 * EmptyStates.test.tsx — Gemini finding 2 (button hierarchy).
 *
 * The first-run card must have exactly ONE solid primary CTA (Open sample
 * project); the other two are quiet outline buttons. Static SSR render —
 * pure props component, no store needed.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoBoardState } from '../EmptyStates'
import { btnPrimary, btnSecondary } from '../../ui/buttonStyles'

const noop = (): void => {}

function render(): string {
  return renderToStaticMarkup(
    <NoBoardState onOpen={noop} onOpenSample={noop} onOpenFirstLight={noop} />,
  )
}

describe('NoBoardState — first-run button hierarchy (Gemini finding 2)', () => {
  it('renders all three open buttons with their stable E2E testids', () => {
    const html = render()
    for (const id of ['open-sample-btn', 'open-first-light-btn', 'open-board-btn']) {
      expect(html).toContain(`data-testid="${id}"`)
    }
  })

  it('sample project is the single solid primary CTA', () => {
    const html = render()
    const solidBg = String(btnPrimary.background) // '#256b45'
    // the primary background appears exactly once in the whole card…
    expect(html.split(solidBg).length - 1).toBe(1)
    // …and it is on the sample-project button (style attr precedes the testid in the same tag)
    expect(html).toMatch(
      new RegExp(`<button style="[^"]*background:${solidBg}[^"]*"[^>]*data-testid="open-sample-btn"`),
    )
  })

  it('the other two are transparent outline buttons', () => {
    const html = render()
    expect(String(btnSecondary.background)).toBe('transparent')
    for (const id of ['open-first-light-btn', 'open-board-btn']) {
      expect(html).toMatch(
        new RegExp(`<button style="[^"]*background:transparent[^"]*"[^>]*data-testid="${id}"`),
      )
    }
  })

  it('sample project comes first in DOM order', () => {
    const html = render()
    expect(html.indexOf('open-sample-btn')).toBeLessThan(html.indexOf('open-first-light-btn'))
    expect(html.indexOf('open-first-light-btn')).toBeLessThan(html.indexOf('open-board-btn'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/panels/__tests__/EmptyStates.test.tsx`
Expected: FAIL — `buttonStyles` module not found / `NoBoardState` is not exported.

- [ ] **Step 3: Create `src/renderer/src/ui/buttonStyles.ts`**

```ts
/**
 * ui/buttonStyles.ts — shared button hierarchy (Gemini UX finding 2).
 *
 * Three tiers, plain inline-style objects (the renderer has no stylesheet):
 *   btnPrimary   — solid call-to-action. At most ONE per view.
 *   btnSecondary — outline; normal-weight actions.
 *   btnGhost     — quiet text-like; tertiary/utility actions.
 *
 * Consumers may spread-and-override geometry ({ ...btnSecondary, padding: … });
 * the module fixes the hierarchy LANGUAGE (solid / outline / quiet), not sizes.
 * Adopted only where a view needs an explicit hierarchy — not an app-wide theme.
 */

import type React from 'react'

/** Solid call-to-action — at most one per view. */
export const btnPrimary: React.CSSProperties = {
  background: '#256b45',
  color: '#e8ffee',
  border: '1px solid #2e8556',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}

/** Outline button — normal-weight actions. */
export const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#ccd',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  cursor: 'pointer',
}

/** Quiet text-like button — tertiary/utility actions. */
export const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid transparent',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  cursor: 'pointer',
}
```

- [ ] **Step 4: Add `NoBoardState` to `src/renderer/src/panels/EmptyStates.tsx`**

Append after the `NoSourceState` component (before the `── styles ──` section), and add the import at the top of the file (`import { btnPrimary, btnSecondary } from '../ui/buttonStyles'`):

```tsx
// ─── No-board first-run state ─────────────────────────────────────────────────

export interface NoBoardStateProps {
  /** Open the file picker. */
  onOpen: () => void
  /** Open the bundled 555-blinker sample project (primary CTA). */
  onOpenSample: () => void
  /** Open the one-LED First Light demo. */
  onOpenFirstLight: () => void
}

/**
 * First-run card (moved here from App.tsx — this file is the home for guided
 * empty states). One solid primary CTA (sample project) + two quiet outline
 * buttons (Gemini UX finding 2: three equally-heavy custom-colored buttons
 * failed to guide the first click).
 */
export function NoBoardState({
  onOpen,
  onOpenSample,
  onOpenFirstLight,
}: NoBoardStateProps): React.ReactElement {
  return (
    <div style={noBoardStyle}>
      <div style={{ fontSize: 18, marginBottom: 8 }}>No board loaded</div>
      <div style={{ color: '#888', marginBottom: 16 }}>
        Open a <code>.kicad_pcb</code> file, or drag one onto the window.
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button style={btnPrimary} onClick={onOpenSample} data-testid="open-sample-btn">
          Open sample project
        </button>
        <button style={btnSecondary} onClick={onOpenFirstLight} data-testid="open-first-light-btn">
          Open First Light demo
        </button>
        <button style={btnSecondary} onClick={onOpen} data-testid="open-board-btn">
          Open…
        </button>
      </div>
      <div style={{ color: '#555', marginTop: 10, fontSize: 12 }}>
        The sample project is a 555 blinker — the full simulation flow in one
        click. First Light is a one-LED dimmer if you want the smallest possible
        start.
      </div>
    </div>
  )
}
```

And in the styles section at the bottom of the file:

```tsx
const noBoardStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#ddd',
}
```

- [ ] **Step 5: Use it from `src/renderer/src/App.tsx`**

1. Delete the whole local `function EmptyState(...) {...}` (currently ~lines 377–421) and the `emptyStateStyle` const (~lines 528–536).
2. App.tsx does NOT currently import from `./panels/EmptyStates` — add `import { NoBoardState } from './panels/EmptyStates'` next to the other panel imports (~line 24).
3. Replace the `<EmptyState … />` usage inside the render with:

```tsx
<NoBoardState
  onOpen={handleOpen}
  onOpenSample={handleOpenSample}
  onOpenFirstLight={handleOpenFirstLight}
/>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/panels/__tests__/EmptyStates.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck + neighboring tests**

Run: `npm run typecheck && npx vitest run src/renderer/src/panels src/renderer/src/store`
Expected: clean typecheck; all panel/store tests PASS (nothing else referenced `EmptyState`).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/ui/buttonStyles.ts src/renderer/src/panels/EmptyStates.tsx src/renderer/src/App.tsx src/renderer/src/panels/__tests__/EmptyStates.test.tsx
git commit -m "feat(ui): button hierarchy — sample project is the primary first-run CTA

Gemini UX finding 2. New ui/buttonStyles.ts (primary/secondary/ghost inline
tiers); first-run card moves to panels/EmptyStates.tsx as NoBoardState with
one solid CTA + two outline buttons. E2E testids unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Model Doctor overflow menu (finding 1)

**Files:**
- Modify: `src/renderer/src/panels/ModelDoctor.tsx` (action row ~lines 243–273; add `DoctorMoreMenu`)
- Test: `src/renderer/src/panels/__tests__/ModelDoctor.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing from other tasks (uses the file's existing `btnStyle` — NOT `ui/buttonStyles`, the Doctor keeps its compact 12px buttons).
- Produces: `DoctorMoreMenu({ items, open, onToggle, onClose })` and `interface DoctorMenuItem { label: string; onSelect: () => void }`, both exported from `ModelDoctor.tsx` for tests.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/panels/__tests__/ModelDoctor.test.tsx` (it already imports `renderToStaticMarkup`, `ModelDoctor`, store helpers and defines `renderDoctor(selectedRef)`; add `DoctorMoreMenu` to the existing `../ModelDoctor` import):

```tsx
// ─── Gemini finding 1: action hierarchy — 3 primary + ⋮ overflow menu ─────────

describe('Doctor card action hierarchy (Gemini finding 1)', () => {
  it('card shows exactly the 3 primary actions + the ⋮ trigger; menu closed', () => {
    const html = renderDoctor(null)
    expect(html).toContain('Import .lib')
    expect(html).toContain('Pin map')
    expect(html).toContain('Stub open')
    expect(html).toContain('data-testid="doctor-more"')
    // secondary actions are NOT in the closed-state DOM
    expect(html).not.toContain('Stub short')
    expect(html).not.toContain('Interactive pins')
    expect(html).not.toContain('Ask your LLM')
    expect(html).not.toContain('data-testid="doctor-more-menu"')
  })

  it('DoctorMoreMenu open renders the three secondary actions as menuitems', () => {
    const items = [
      { label: 'Stub short', onSelect: () => {} },
      { label: 'Interactive pins', onSelect: () => {} },
      { label: 'Ask your LLM', onSelect: () => {} },
    ]
    const html = renderToStaticMarkup(
      <DoctorMoreMenu items={items} open={true} onToggle={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="doctor-more-menu"')
    expect(html).toContain('role="menu"')
    expect((html.match(/role="menuitem"/g) ?? []).length).toBe(3)
    for (const it_ of items) expect(html).toContain(it_.label)
    expect(html).toContain('aria-expanded="true"')
  })

  it('DoctorMoreMenu closed renders only the trigger', () => {
    const html = renderToStaticMarkup(
      <DoctorMoreMenu
        items={[{ label: 'Stub short', onSelect: () => {} }]}
        open={false}
        onToggle={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="doctor-more"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-testid="doctor-more-menu"')
    expect(html).not.toContain('Stub short')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/panels/__tests__/ModelDoctor.test.tsx`
Expected: FAIL — `DoctorMoreMenu` is not exported; closed-card assertions fail (secondary buttons still inline).

- [ ] **Step 3: Implement `DoctorMoreMenu` in `ModelDoctor.tsx`**

Add above `DoctorRow` (uses the file's existing `btnStyle`):

```tsx
export interface DoctorMenuItem {
  label: string
  onSelect: () => void
}

/**
 * ⋮ overflow menu for secondary Doctor actions (Gemini finding 1: 6–7 inline
 * buttons per card → choice paralysis). Controlled — the parent owns `open`,
 * so tests render either state directly. Closes on item select, outside
 * mousedown, and Escape. SSR-safe (listeners only attach when document exists).
 */
export function DoctorMoreMenu({
  items,
  open,
  onToggle,
  onClose,
}: {
  items: DoctorMenuItem[]
  open: boolean
  onToggle: () => void
  onClose: () => void
}): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div ref={wrapRef} style={moreWrapStyle}>
      <button
        style={btnStyle}
        data-testid="doctor-more"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={onToggle}
      >
        ⋮
      </button>
      {open && (
        <div role="menu" data-testid="doctor-more-menu" style={moreMenuStyle}>
          {items.map(item => (
            <MenuItemButton key={item.label} item={item} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One menu row; JS hover highlight (no stylesheet in the renderer). */
function MenuItemButton({
  item,
  onClose,
}: {
  item: DoctorMenuItem
  onClose: () => void
}): React.ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      role="menuitem"
      style={hover ? { ...menuItemStyle, background: '#3a2f4a' } : menuItemStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        item.onSelect()
        onClose()
      }}
    >
      {item.label}
    </button>
  )
}
```

And in the styles section at the bottom:

```tsx
const moreWrapStyle: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
}
const moreMenuStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 2,
  minWidth: 150,
  background: '#2a2038',
  border: '1px solid #4a3a5a',
  borderRadius: 4,
  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
  padding: 2,
}
const menuItemStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#eee',
  fontSize: 12,
  padding: '6px 12px',
  textAlign: 'left',
  cursor: 'pointer',
  borderRadius: 3,
}
```

- [ ] **Step 4: Rework the action row in `DoctorRow`**

Add `const [moreOpen, setMoreOpen] = useState(false)` next to the other useState hooks, then replace the whole `<div style={actionsStyle}>…</div>` block (currently ~lines 243–273) with:

```tsx
<div style={actionsStyle}>
  <button style={btnStyle} onClick={handleImportLib}>
    Import .lib…
  </button>
  <button
    style={{ ...btnStyle, background: (pinEditorOpen || forcePinMapOpen) ? '#2c4a2c' : undefined }}
    onClick={() => { setPinEditorOpen(o => !o); setForcePinMapOpen(false) }}
  >
    {pinEditorOpen ? 'Hide pin map' : 'Pin map'}
  </button>
  <button style={btnStyle} onClick={() => store.getState().stubPart(res.ref, 'open')}>
    Stub open
  </button>
  <DoctorMoreMenu
    open={moreOpen}
    onToggle={() => setMoreOpen(o => !o)}
    onClose={() => setMoreOpen(false)}
    items={[
      { label: 'Stub short', onSelect: () => store.getState().stubPart(res.ref, 'short') },
      { label: 'Interactive pins', onSelect: () => store.getState().stubPart(res.ref, 'interactive-pins') },
      { label: 'Ask your LLM', onSelect: handleAskLlm },
    ]}
  />
  {(isStubbed || res.tier === 6 || hasOverride) && (
    <button style={btnGhostStyle} onClick={() => store.getState().clearPartOverride(res.ref)}>
      Reset
    </button>
  )}
</div>
```

Nothing else in the file changes: `handleAskLlm`/`handleImportLib`, the inline LlmAssist/LibImport panels, the `forcePinMapOpen` flow, and Reset's `hasOverride` rule all stay exactly as they are.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/panels/__tests__/ModelDoctor.test.tsx`
Expected: PASS (new + all pre-existing selection-sync tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/panels/ModelDoctor.tsx src/renderer/src/panels/__tests__/ModelDoctor.test.tsx
git commit -m "feat(doctor): action hierarchy — 3 primary actions + overflow menu

Gemini UX finding 1 (HIGH): 6-7 inline buttons per card were a wall of
choices. Visible: Import .lib, Pin map, Stub open (+conditional Reset);
Stub short / Interactive pins / Ask your LLM move into an accessible
DoctorMoreMenu popover (Escape/outside-click close). Handlers unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: "Probe this net" contrast (finding 3)

**Files:**
- Modify: `src/renderer/src/panels/InstrumentRack.tsx` (button JSX ~lines 326–333; `probeNetBtnStyle` ~line 466)
- Test: `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx` (extend)

**Interfaces:**
- Consumes / Produces: nothing cross-task. `ProbeNetButton` stays private to the file.

- [ ] **Step 1: Write the failing test**

Append to `src/renderer/src/panels/__tests__/InstrumentRack.test.tsx` — the file already defines `openedStore()` (opens `fixture-rc.kicad_pcb` against a real store) and `renderRack(store)` (SSR render with the `getServerState` hack). Reuse them, exactly like the existing test `'a selected net shows its name + a "Probe this net" button'` (~line 68):

```tsx
// ─── Gemini finding 3: the probe button must read as actionable ───────────────

describe('Probe-this-net contrast (Gemini finding 3)', () => {
  it('is a solid high-contrast button with a probe-tip glyph', () => {
    const store = openedStore()
    const outId = store.getState().circuit!.nets.find(n => n.kicadName === 'OUT')!.id
    store.getState().selectNet(outId)
    const html = renderRack(store)
    expect(html).toContain('data-testid="probe-net-btn"')
    // probe-tip glyph signals actionability
    expect(html).toContain('⌖')
    // solid resting background — no longer the near-invisible #1e2e1e
    expect(html).toContain('background:#2a6b3a')
    expect(html).not.toContain('background:#1e2e1e')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/panels/__tests__/InstrumentRack.test.tsx`
Expected: FAIL — no `⌖`, background still `#1e2e1e`.

- [ ] **Step 3: Implement `ProbeNetButton`**

In `InstrumentRack.tsx`, add a private component (near the other small components in the file):

```tsx
/**
 * "⌖ Probe this net" (Gemini finding 3): the old dark-green-on-dark styling
 * read as disabled. Solid V-Probe-green resting state + JS hover brighten
 * (the NetDropTarget pattern — there is no stylesheet).
 */
function ProbeNetButton({ netId, netName }: { netId: number; netName: string }): React.ReactElement {
  const store = useAppStoreApi()
  const [hover, setHover] = useState(false)
  return (
    <button
      data-testid="probe-net-btn"
      style={hover ? { ...probeNetBtnStyle, background: '#35854a', borderColor: '#55bf75' } : probeNetBtnStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => store.getState().attachProbeToNet(netId)}
      title={`Attach a V-Probe to ${netName}`}
    >
      ⌖ Probe this net
    </button>
  )
}
```

Replace the inline `<button data-testid="probe-net-btn" …>Probe this net</button>` in the rack body (~lines 326–333) with:

```tsx
<ProbeNetButton netId={selectedNet.id} netName={selectedNet.kicadName} />
```

Replace `probeNetBtnStyle` (~line 466) with:

```tsx
const probeNetBtnStyle: React.CSSProperties = {
  background: '#2a6b3a',
  border: '1px solid #3f9f5f',
  borderRadius: 3,
  color: '#e6ffe9',
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 10px',
  cursor: 'pointer',
  flexShrink: 0,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/panels/__tests__/InstrumentRack.test.tsx src/renderer/src/panels/__tests__/Scope.test.tsx`
Expected: PASS — including the pre-existing "Probe this net" tests (the label is still a substring of `⌖ Probe this net`) and Scope's hint-text test (Scope.tsx is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/panels/InstrumentRack.tsx src/renderer/src/panels/__tests__/InstrumentRack.test.tsx
git commit -m "feat(rack): high-contrast Probe-this-net button with probe-tip glyph

Gemini UX finding 3: #1e2e1e/# 6f6 read as disabled against the rack. Solid
V-Probe-green resting state, hover brighten, ⌖ glyph. Same testid/handler.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Store — fidelity-banner minimize state (finding 4, part 1)

**Files:**
- Modify: `src/renderer/src/store/appStore.ts`
- Test: `src/renderer/src/store/__tests__/fidelityMinimize.test.ts` (new)

**Interfaces:**
- Consumes: existing `FidelityBannerItem` (`{ ref: string; mode: string }`, ~line 104) and `fidelityBannerItems(resolutions)` (~line 117).
- Produces (Task 5 relies on these exact names):
  - state `fidelityMinimizedSig: string | null`
  - action `minimizeFidelityBanner(): void`
  - `export function fidelitySignature(items: FidelityBannerItem[]): string`
  - `export function isFidelityMinimized(items: FidelityBannerItem[], minimizedSig: string | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/store/__tests__/fidelityMinimize.test.ts`:

```ts
/**
 * fidelityMinimize.test.ts — Gemini finding 4 (banner blindness).
 *
 * The fidelity banner can be MINIMIZED to a badge, never dismissed. Minimize
 * is purely derivational: the store keeps the signature of the problem set at
 * minimize time; any change to that set (new part, mode change, resolution)
 * changes the signature → isFidelityMinimized flips false → banner re-expands
 * with no subscription or effect.
 */

import { describe, it, expect } from 'vitest'
import {
  createAppStore,
  fidelityBannerItems,
  fidelitySignature,
  isFidelityMinimized,
} from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { Resolution } from '../../../../core/models/types'

function unresolved(ref: string): Resolution {
  return { ref, status: 'unresolved', tier: 6, warnings: [] }
}

describe('fidelitySignature', () => {
  it('is order-independent', () => {
    const a = [
      { ref: 'U1', mode: 'unresolved' },
      { ref: 'U2', mode: 'stubbed (open)' },
    ]
    const b = [a[1], a[0]]
    expect(fidelitySignature(a)).toBe(fidelitySignature(b))
  })

  it('is sensitive to mode changes on the same ref', () => {
    expect(fidelitySignature([{ ref: 'U1', mode: 'unresolved' }])).not.toBe(
      fidelitySignature([{ ref: 'U1', mode: 'stubbed (open)' }]),
    )
  })
})

describe('isFidelityMinimized', () => {
  const items = [{ ref: 'U1', mode: 'unresolved' }]

  it('false when never minimized (sig null)', () => {
    expect(isFidelityMinimized(items, null)).toBe(false)
  })

  it('true while the problem set matches the minimized signature', () => {
    expect(isFidelityMinimized(items, fidelitySignature(items))).toBe(true)
  })

  it('false when the problem set grows (auto re-expand)', () => {
    const sig = fidelitySignature(items)
    expect(isFidelityMinimized([...items, { ref: 'U2', mode: 'unresolved' }], sig)).toBe(false)
  })

  it('false when an item changes mode (auto re-expand)', () => {
    const sig = fidelitySignature(items)
    expect(isFidelityMinimized([{ ref: 'U1', mode: 'stubbed (open)' }], sig)).toBe(false)
  })
})

describe('minimizeFidelityBanner action', () => {
  it('defaults to expanded and stores the live signature on minimize', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    expect(store.getState().fidelityMinimizedSig).toBeNull()

    store.setState({ resolutions: [unresolved('U1'), unresolved('U2')] })
    store.getState().minimizeFidelityBanner()

    const items = fidelityBannerItems(store.getState().resolutions)
    expect(store.getState().fidelityMinimizedSig).toBe(fidelitySignature(items))
    expect(isFidelityMinimized(items, store.getState().fidelityMinimizedSig)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/store/__tests__/fidelityMinimize.test.ts`
Expected: FAIL — `fidelitySignature` / `isFidelityMinimized` not exported.

- [ ] **Step 3: Implement in `appStore.ts`**

(a) Pure helpers, directly after `collapsedFidelitySummary` (~line 190):

```ts
/**
 * Stable identity of the current fidelity problem set (Gemini finding 4).
 * Order-independent so a resolution re-order never spuriously re-expands the
 * minimized banner.
 */
export function fidelitySignature(items: FidelityBannerItem[]): string {
  return items
    .map(it => `${it.ref}:${it.mode}`)
    .sort()
    .join('|')
}

/**
 * Minimized iff the user minimized THIS exact problem set. Any change — new
 * part, mode change, item resolved — changes the signature → auto re-expand.
 * Honesty (Spec §8.6): the banner minimizes to a visible badge, never away.
 */
export function isFidelityMinimized(
  items: FidelityBannerItem[],
  minimizedSig: string | null,
): boolean {
  return minimizedSig !== null && fidelitySignature(items) === minimizedSig
}
```

(b) State field in `interface AppState`, directly after the `opCaveat` field (~line 479):

```ts
  /**
   * Fidelity-banner minimize (Gemini finding 4): when non-null, the banner is
   * minimized to the header badge for AS LONG AS the live fidelity signature
   * still matches. Per-board, per-session, in-memory.
   */
  fidelityMinimizedSig: string | null
```

(c) Action declaration in the actions section of the interface (near `markDeckDirty(): void`, ~line 625):

```ts
  /** Minimize the fidelity banner to the header badge (Gemini finding 4). */
  minimizeFidelityBanner(): void
```

(d) Initial value — add `fidelityMinimizedSig: null,` right after `opCaveat: null,` in the initial-state object (~line 830).

(e) Reset on new board — add `fidelityMinimizedSig: null,` right after `opCaveat: null,` inside the `openBoardFromText` reset `set({ … })` (~line 862).

(f) Action implementation, next to `dismissConvergenceCard()` (~line 1575):

```ts
    minimizeFidelityBanner() {
      set({ fidelityMinimizedSig: fidelitySignature(fidelityBannerItems(get().resolutions)) })
    },
```

Do NOT touch `markDeckDirty` — a deck-dirtying edit that changes the problem set already re-expands via the signature; one that doesn't change it shouldn't re-expand.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/store/__tests__/fidelityMinimize.test.ts && npm run typecheck`
Expected: PASS (7 tests); clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/appStore.ts src/renderer/src/store/__tests__/fidelityMinimize.test.ts
git commit -m "feat(store): fidelity-banner minimize state (signature-matched)

Gemini UX finding 4, store half. fidelityMinimizedSig + minimize action +
pure fidelitySignature/isFidelityMinimized helpers: minimized only while the
problem set is EXACTLY the one the user minimized — any change auto
re-expands derivationally. Named 'minimize' (collapse = M7 text summary).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: WarningsBar minimize control + header badge (finding 4, part 2)

**Files:**
- Modify: `src/renderer/src/panels/WarningsBar.tsx`
- Modify: `src/renderer/src/App.tsx` (header, ~line 265)
- Test: `src/renderer/src/panels/__tests__/WarningsBar.test.tsx` (extend)

**Interfaces:**
- Consumes (from Task 4): `fidelityMinimizedSig`, `minimizeFidelityBanner()`, `isFidelityMinimized(items, sig)`.
- Produces: `export function FidelityBadge(): React.ReactElement | null` from `WarningsBar.tsx` (App.tsx renders it in the header).

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/panels/__tests__/WarningsBar.test.tsx` (the file already has `renderBar(resolutions)`, `unresolved(ref)`, `documentedOpen(ref)` helpers and imports `createAppStore`, `AppStoreProvider`, `renderToStaticMarkup`; extend the WarningsBar import line with `FidelityBadge`):

```tsx
// ─── Gemini finding 4: minimizable fidelity banner + header badge ─────────────

/** renderBar variant that also seeds fidelityMinimizedSig and renders the badge too. */
function renderBarAndBadge(resolutions: Resolution[], minimize: boolean): string {
  const store = createAppStore({ simClient: createMockSimClient() })
  store.setState({ resolutions })
  if (minimize) store.getState().minimizeFidelityBanner()
  ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
    store.getState()
  return renderToStaticMarkup(
    <AppStoreProvider store={store}>
      <WarningsBar />
      <FidelityBadge />
    </AppStoreProvider>,
  )
}

describe('Gemini finding 4 — minimizable fidelity banner', () => {
  it('expanded: banner shows the minimize control, badge absent', () => {
    const html = renderBarAndBadge([unresolved('U1')], false)
    expect(html).toContain('Results approximate')
    expect(html).toContain('data-testid="fidelity-minimize"')
    expect(html).not.toContain('data-testid="fidelity-badge"')
  })

  it('minimized: banner hidden, amber badge with count shown', () => {
    const html = renderBarAndBadge([unresolved('U1'), unresolved('Q7')], true)
    expect(html).not.toContain('Results approximate')
    expect(html).toContain('data-testid="fidelity-badge"')
    expect(html).toContain('⚠ 2 approximate')
    expect(html).toContain('role="button"')
  })

  it('minimized + problem set changes → banner re-expands, badge gone', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.setState({ resolutions: [unresolved('U1')] })
    store.getState().minimizeFidelityBanner()
    // a NEW problem appears after the user minimized
    store.setState({ resolutions: [unresolved('U1'), unresolved('Q7')] })
    ;(store as unknown as { getServerState?: () => AppState }).getServerState = () =>
      store.getState()
    const html = renderToStaticMarkup(
      <AppStoreProvider store={store}>
        <WarningsBar />
        <FidelityBadge />
      </AppStoreProvider>,
    )
    expect(html).toContain('Results approximate')
    expect(html).not.toContain('data-testid="fidelity-badge"')
  })

  it('only documented opens minimized → grey-blue info badge wording', () => {
    const html = renderBarAndBadge([documentedOpen('J1'), documentedOpen('J2')], true)
    expect(html).toContain('data-testid="fidelity-badge"')
    expect(html).toContain('ⓘ 2 open by design')
    expect(html).not.toContain('⚠')
  })

  it('badge title lists the refs so hover reveals detail without expanding', () => {
    const html = renderBarAndBadge([unresolved('U1'), unresolved('Q7')], true)
    expect(html).toMatch(/title="[^"]*U1[^"]*Q7[^"]*"/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/panels/__tests__/WarningsBar.test.tsx`
Expected: FAIL — `FidelityBadge` not exported; no minimize control.

- [ ] **Step 3: Implement in `WarningsBar.tsx`**

(a) Extend the appStore import with `fidelitySignature` is NOT needed — only add `isFidelityMinimized` to the existing `import { fidelityBannerItems, collapsedFidelitySummary, opCaveatMessage, … } from '../store/appStore'`.

(b) In `WarningsBar()`, read the sig and compute minimized:

```tsx
const fidelityMinimizedSig = useApp(s => s.fidelityMinimizedSig)
// …after `const fidelity = fidelityBannerItems(resolutions)`:
const fidelityMinimized = isFidelityMinimized(fidelity, fidelityMinimizedSig)
```

(c) Update the `anything` gate: replace `fidelity.length > 0 ||` with `(fidelity.length > 0 && !fidelityMinimized) ||`.

(d) Gate the banner: change `{fidelity.length > 0 && (` to `{fidelity.length > 0 && !fidelityMinimized && (`.

(e) Add the minimize control as the FIRST child inside the banner div (it is absolutely positioned like `dismissBtn`):

```tsx
<button
  style={dismissBtn}
  title="Minimize to a toolbar badge"
  data-testid="fidelity-minimize"
  onClick={() => store.getState().minimizeFidelityBanner()}
>
  »
</button>
```

(f) Add the exported badge component after `RailNoteRow` (before the styles section):

```tsx
/**
 * Compact header badge shown while the fidelity banner is minimized (Gemini
 * finding 4). Exactly one of {banner, badge} is visible whenever problems
 * exist — there is NO state with zero indication (Spec §8.6 honesty).
 * Click / Enter / Space re-expands.
 */
export function FidelityBadge(): React.ReactElement | null {
  const store = useAppStoreApi()
  const resolutions = useApp(s => s.resolutions)
  const minimizedSig = useApp(s => s.fidelityMinimizedSig)
  const fidelity = fidelityBannerItems(resolutions)
  if (fidelity.length === 0 || !isFidelityMinimized(fidelity, minimizedSig)) return null

  const onlyOpenByDesign = fidelity.every(it => it.mode === 'open by design')
  const expand = (): void => store.setState({ fidelityMinimizedSig: null })
  return (
    <span
      style={onlyOpenByDesign ? badgeInfoStyle : badgeWarnStyle}
      data-testid="fidelity-badge"
      role="button"
      tabIndex={0}
      title={`${fidelity.map(it => it.ref).join(', ')} — click to expand`}
      onClick={expand}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') expand()
      }}
    >
      {onlyOpenByDesign ? `ⓘ ${fidelity.length} open by design` : `⚠ ${fidelity.length} approximate`}
    </span>
  )
}
```

(g) Badge styles in the styles section:

```tsx
const badgeBase: React.CSSProperties = {
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
}
const badgeWarnStyle: React.CSSProperties = {
  ...badgeBase,
  background: '#3a2e12',
  color: '#fde9b0',
  border: '1px solid #5a4a22',
}
const badgeInfoStyle: React.CSSProperties = {
  ...badgeBase,
  background: '#1c2733',
  color: '#bcd3e8',
  border: '1px solid #2c4152',
}
```

- [ ] **Step 4: Mount the badge in the App header**

In `src/renderer/src/App.tsx`: change the WarningsBar import to `import WarningsBar, { FidelityBadge } from './panels/WarningsBar'` and add `<FidelityBadge />` in the header, directly after the parts-summary `</span>` (after ~line 265, before the `viewerOnly` badge):

```tsx
<FidelityBadge />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/panels/__tests__/WarningsBar.test.tsx && npm run typecheck`
Expected: PASS (new + all pre-existing M7/M9/rail-note tests — the expanded default keeps them green); clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/panels/WarningsBar.tsx src/renderer/src/App.tsx src/renderer/src/panels/__tests__/WarningsBar.test.tsx
git commit -m "feat(warnings): minimizable fidelity banner with header badge

Gemini UX finding 4, UI half. » control minimizes the banner to a compact
header badge (amber count / grey-blue info variant); badge click or any
change in the problem set re-expands. Never dismissable to nothing.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Net Voltages tab cue + review-doc closeout (finding 5)

**Files:**
- Create: `src/renderer/src/ui/tabCues.ts`
- Modify: `src/renderer/src/App.tsx` (bottom tab strip, ~lines 343–358)
- Modify: `docs/ux-review-gemini-2026-07-13.md` (tick ☐ → ☑ on findings 1–5)
- Test: `src/renderer/src/ui/__tests__/tabCues.test.ts` (new)

**Interfaces:**
- Produces: `showNetsTabCue(hasOpVoltages: boolean, netsTabSeen: boolean, bottomTab: 'log' | 'nets'): boolean` from `ui/tabCues.ts`. (Lives in `ui/`, not App.tsx — App.tsx imports the GL Viewport and can't be imported by node tests.)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/ui/__tests__/tabCues.test.ts`:

```ts
/**
 * tabCues.test.ts — Gemini finding 5 (Net Voltages tab discoverability).
 * The unread dot shows after the first successful op, until the user first
 * opens the tab; it never shows while the tab is already active.
 */

import { describe, it, expect } from 'vitest'
import { showNetsTabCue } from '../tabCues'

describe('showNetsTabCue', () => {
  it('no op result yet → no cue', () => {
    expect(showNetsTabCue(false, false, 'log')).toBe(false)
  })
  it('first op landed, tab never seen, log tab active → cue', () => {
    expect(showNetsTabCue(true, false, 'log')).toBe(true)
  })
  it('tab already seen → no cue', () => {
    expect(showNetsTabCue(true, true, 'log')).toBe(false)
  })
  it('nets tab currently active → no cue', () => {
    expect(showNetsTabCue(true, false, 'nets')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/ui/__tests__/tabCues.test.ts`
Expected: FAIL — module `../tabCues` not found.

- [ ] **Step 3: Create `src/renderer/src/ui/tabCues.ts`**

```ts
/**
 * ui/tabCues.ts — Gemini finding 5: Net Voltages tab discoverability.
 *
 * New users focused on the 3D annotations may never notice the tabular
 * voltage readout in the bottom dock. After the FIRST successful operating
 * point of the session, the "Net voltages" tab shows a small unread dot
 * until the user first opens it. Per-session, in-memory (App-local state).
 */

export function showNetsTabCue(
  hasOpVoltages: boolean,
  netsTabSeen: boolean,
  bottomTab: 'log' | 'nets',
): boolean {
  return hasOpVoltages && !netsTabSeen && bottomTab !== 'nets'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/ui/__tests__/tabCues.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into `App.tsx`**

1. Add the import: `import { showNetsTabCue } from './ui/tabCues'`.
2. Next to the existing `bottomTab` useState, add: `const [netsTabSeen, setNetsTabSeen] = useState(false)`.
3. Replace the Net-voltages tab button (~lines 351–357) with:

```tsx
<button
  style={bottomTab === 'nets' ? bottomTabActive : bottomTabBtn}
  onClick={() => {
    setBottomTab('nets')
    setNetsTabSeen(true)
  }}
  data-testid="bottom-tab-nets"
>
  Net voltages
  {showNetsTabCue(opVoltages != null, netsTabSeen, bottomTab) && (
    <span data-testid="nets-tab-cue" style={{ color: '#f1c40f', marginLeft: 4 }}>
      ●
    </span>
  )}
</button>
```

(`opVoltages` is already in scope in App — it's passed to `<Viewport netVoltages={opVoltages ?? undefined} …>`.)

- [ ] **Step 6: Tick the review doc**

In `docs/ux-review-gemini-2026-07-13.md`, change each finding heading's `☐` to `☑` (findings 1–5, e.g. `### ☑ 1. Model Doctor action overload`).

- [ ] **Step 7: Full validation**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; full vitest suite green (~1500 tests; the real-ngspice integration tests run as part of `npm test` and need the fetched ngspice — they were green before this pass and nothing engine-side changed).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/ui/tabCues.ts src/renderer/src/ui/__tests__/tabCues.test.ts src/renderer/src/App.tsx docs/ux-review-gemini-2026-07-13.md
git commit -m "feat(app): Net Voltages tab unread cue; close out Gemini UX review

Gemini UX finding 5: amber unread dot on the Net voltages tab after the
session's first successful op, until first opened. Ticks findings 1-5 in
docs/ux-review-gemini-2026-07-13.md — review fully addressed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck && npm test` — full suite green.
- [ ] `npm run test:e2e` — Playwright E2E green (smoke clicks `open-sample-btn`, first-light clicks `open-first-light-btn`; both testids unchanged. Windows `crashpad_client_win.cc(868) not connected` log spam is benign noise).
- [ ] Do-not-regress spot-check: `NetVoltages.tsx` still dims stale voltages (`opacity: 0.55`); `InstrumentRack.tsx` still auto-selects the auto-attached supply.
