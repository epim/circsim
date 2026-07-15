# UX Pass — Gemini Review Findings (Design)

**Date:** 2026-07-14
**Source:** `docs/ux-review-gemini-2026-07-13.md` (external UI/UX review, agent-bridge topic `circsim`)
**Scope:** renderer-only UI polish. No engine, store-pipeline, or deck-generation changes beyond one small piece of derived UI state in the app store (fidelity-banner collapse). No new dependencies.

Addresses all 5 findings: (1 HIGH) Model Doctor action overload, (2 MED) empty-state
button hierarchy, (3 MED) "Probe this net" contrast, (4 polish) amber-banner
blindness, (5 polish) Net Voltages tab discoverability.

**Decisions made with the user:**
- Empty-state primary CTA = **Open sample project**.
- Model Doctor split = **Gemini's split** (visible: Import .lib…, Pin map, Stub open; menu: Stub short, Interactive pins, Ask your LLM).
- Approach = **shared button-style module** (`ui/buttonStyles.ts`), adopted only by the surfaces this pass touches — not an app-wide restyle.

**Do-not-regress (from the review's positive notes):** stale-voltage dimming
(`opacity: 0.55`) in Net Voltages; ranked supply auto-select on open.

---

## 0. Shared foundation — `src/renderer/src/ui/buttonStyles.ts` (new)

The codebase styles exclusively with inline `React.CSSProperties` objects (there is
no stylesheet anywhere under `src/renderer`). The module follows that idiom: three
exported style objects, no component wrapper, no CSS file.

```ts
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

Consumers may spread-and-override (`{ ...btnSecondary, padding: '4px 8px' }`) —
the module fixes the *hierarchy language* (solid / outline / quiet), not exact
geometry. Only the surfaces below adopt it; `toolbarBtn`, Doctor `btnStyle`, etc.
elsewhere are untouched.

---

## 1. Model Doctor action hierarchy (HIGH)

**File:** `src/renderer/src/panels/ModelDoctor.tsx`

### Behavior

Each Doctor card's action row becomes:

```
[Import .lib…] [Pin map] [Stub open]  [⋮]   (+ ghost [Reset] when hasOverride, unchanged)
```

The `⋮` button toggles a small popover menu containing, in order:

```
Stub short
Interactive pins
Ask your LLM
```

- Selecting a menu item **closes the menu and fires the exact same handler the
  old inline button fired** (`stubPart(ref,'short')`, `stubPart(ref,'interactive-pins')`,
  `handleAskLlm`). The inline LlmAssist / LibImport panels, the
  force-pin-map-after-LLM-save flow, and Reset's `hasOverride` visibility rule are
  all unchanged.
- The menu closes on: item click, outside `mousedown`, `Escape`, and toggling `⋮`.
- One menu open at a time *per card* (state is per-card local `useState`; two cards
  can technically both be open — acceptable, matches per-card `pinEditorOpen`
  behavior today).

### Component

`DoctorMoreMenu` — a **local, exported** component in `ModelDoctor.tsx` (exported
for SSR tests; local because it has exactly one consumer — move it to `ui/` only
if a second consumer appears).

```ts
export interface DoctorMenuItem {
  label: string
  onSelect: () => void
}

export function DoctorMoreMenu({
  items,
  open,
  onToggle,   // ⋮ click
  onClose,    // Escape / outside click / item selected
}: {
  items: DoctorMenuItem[]
  open: boolean
  onToggle: () => void
  onClose: () => void
}): React.ReactElement
```

Rendering:
- Trigger: `<button data-testid="doctor-more" aria-haspopup="menu" aria-expanded={open}>⋮</button>`,
  styled like the existing `btnStyle` in the file.
- Menu: absolutely positioned `<div role="menu" data-testid="doctor-more-menu">`
  under the trigger (wrapper `position: relative`), `background: '#2a2038'`,
  `border: '1px solid #4a3a5a'`, `borderRadius: 4`, `zIndex: 10`,
  `boxShadow: '0 4px 12px rgba(0,0,0,0.5)'`.
- Items: full-width `<button role="menuitem">` rows, transparent background,
  `color: '#eee'`, `padding: '6px 12px'`, `textAlign: 'left'`, hover highlight
  `#3a2f4a` via local `onMouseEnter` state.
- Outside-close: `useEffect` adding a `document.addEventListener('mousedown', …)`
  while open, ignoring events inside the wrapper (ref containment check);
  `keydown` listener for `Escape`. Both defensively no-op when `document` is
  undefined (SSR).

### Removals

The three inline buttons "Stub short", "Interactive pins", "Ask your LLM" are
removed from the direct action row (their handlers stay).

---

## 2. Empty-state button hierarchy (MED)

**Files:** `src/renderer/src/panels/EmptyStates.tsx` + `src/renderer/src/App.tsx`

The first-run card **moves out of App.tsx** into `panels/EmptyStates.tsx` as an
exported `NoBoardState` (pure props: `onOpen`, `onOpenSample`, `onOpenFirstLight`)
— that file is the documented home for guided empty states, and the move is what
makes the card testable under the SSR panel-test idiom (App.tsx imports the GL
Viewport and can't be imported by node tests). App.tsx renders `<NoBoardState …>`.

- **Open sample project** → `btnPrimary`. Moves to **first** position.
- **Open First Light demo** → `btnSecondary`.
- **Open…** → `btnSecondary`.
- The ad-hoc `background: '#3a2e12'` / `'#1e3a2e'` overrides are deleted; no other
  copy or layout changes. All three `data-testid`s (`open-board-btn`,
  `open-first-light-btn`, `open-sample-btn`) are **unchanged** (E2E smoke +
  first-light depend on them).
- The explainer line beneath stays, but its First-Light-first phrasing is updated
  to match the new order:
  `"The sample project is a 555 blinker — the full simulation flow in one click. First Light is a one-LED dimmer if you want the smallest possible start."`
- The header `Open…` toolbar button (`open-board-header-btn`) is untouched.

---

## 3. "Probe this net" contrast (MED)

**File:** `src/renderer/src/panels/InstrumentRack.tsx` (`probeNetBtnStyle`, ~line 466)

Resting state — solid, clearly actionable, still V-Probe-green:

```ts
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

- Button text gains a probe-tip glyph prefix: `⌖ Probe this net` (plain text
  inside the existing button — no icon asset).
- Hover: brighten to `background: '#35854a'`, `border: '1px solid #55bf75'` via
  local `useState` + `onMouseEnter`/`onMouseLeave` (same JS-hover pattern as
  `NetDropTarget`). The button is extracted into a tiny local `ProbeNetButton`
  component so the hover state doesn't live in the rack's main body.
- `data-testid="probe-net-btn"`, the `onClick` (`attachProbeToNet`), and the
  `title` are unchanged.

---

## 4. Minimizable fidelity banner (polish)

**Files:** `src/renderer/src/store/appStore.ts`, `src/renderer/src/panels/WarningsBar.tsx`, `src/renderer/src/App.tsx`

### Honesty constraint

Spec §8.6 makes the fidelity banner *persistent + non-dismissable*. This feature
preserves that: the banner can be **minimized to a visible badge, never removed**.
There is no state in which fidelity problems have zero on-screen indication, and
any **change** in the problem set automatically re-expands the full banner.

### Store (`appStore.ts`)

Naming note: "collapse" is taken — `collapsedFidelitySummary` (M7 F9) already
means "summarize >3 refs into one line", and WarningsBar has a local
`fidelityCollapsed` holding its result. The new feature is therefore named
**minimize** throughout.

New state + action + pure helpers:

```ts
// state
fidelityMinimizedSig: string | null   // null = expanded (default)

// action
minimizeFidelityBanner(): void
// sets fidelityMinimizedSig = fidelitySignature(fidelityBannerItems(get().resolutions))

// pure, exported (unit-testable)
export function fidelitySignature(items: FidelityBannerItem[]): string
// sorted, stable: items.map(it => `${it.ref}:${it.mode}`).sort().join('|')

export function isFidelityMinimized(
  items: FidelityBannerItem[],
  minimizedSig: string | null,
): boolean
// minimizedSig !== null && fidelitySignature(items) === minimizedSig
```

Minimize is **purely derivational**: if resolutions change so the signature no
longer matches, `isFidelityMinimized` returns false — the banner re-expands with
no subscription or effect. Loading a new board resets the store, so the minimized
state is per-board, per-session, in-memory. `fidelityMinimizedSig` is **not**
cleared by `markDeckDirty` (stubbing a part changes the signature, which already
re-expands the banner — that's the desired behavior, not stale state).

Expanding via the badge sets `fidelityMinimizedSig: null` directly
(`store.setState`), matching how `crashNotice` is dismissed today.

### WarningsBar

- The fidelity banner div gains a minimize control in its top-right corner (same
  placement/styling as the existing `dismissBtn`, but a `»` glyph,
  `title="Minimize to a toolbar badge"`, `data-testid="fidelity-minimize"`),
  wired to `minimizeFidelityBanner()`.
- Render rule: the fidelity banner section renders only when
  `fidelity.length > 0 && !isFidelityMinimized(fidelity, fidelityMinimizedSig)`.
- Both variants (amber warning and grey-blue "open by design" info) get the same
  control — banner blindness applies to any persistent row.
- `opCaveat`, rail notes, convergence card, and toasts are **not** collapsible
  (per-run caveats / already dismissable) — unchanged.

### Header badge (`App.tsx`)

When minimized, the header row (after the parts summary) shows:

```
⚠ 3 approximate        (amber:  background '#3a2e12', color '#fde9b0', border '1px solid #5a4a22')
ⓘ 3 open by design     (grey-blue: background '#1c2733', color '#bcd3e8', border '1px solid #2c4152')
```

- `data-testid="fidelity-badge"`; count = `fidelity.length`; variant follows the
  same `onlyOpenByDesign` rule WarningsBar uses.
- `title` lists the refs (comma-joined) so hover reveals detail without expanding.
- Click → expand (`fidelityMinimizedSig: null`). Keyboard-activatable
  (`role="button"`, `tabIndex=0`, Enter/Space), matching the link pattern in
  WarningsBar.
- Badge visibility condition is identical to the banner's minimize condition, so
  exactly one of {banner, badge} is visible whenever `fidelity.length > 0`.

---

## 5. Net Voltages tab cue (polish)

**Files:** `src/renderer/src/ui/tabCues.ts` (new) + `src/renderer/src/App.tsx`

- New pure helper in `ui/tabCues.ts` (not App.tsx — App imports the GL Viewport
  and can't be imported by node tests):

```ts
export function showNetsTabCue(
  hasOpVoltages: boolean,
  netsTabSeen: boolean,
  bottomTab: 'log' | 'nets',
): boolean {
  return hasOpVoltages && !netsTabSeen && bottomTab !== 'nets'
}
```

- App-local state: `const [netsTabSeen, setNetsTabSeen] = useState(false)`; the
  Net voltages tab's `onClick` also calls `setNetsTabSeen(true)`.
- When `showNetsTabCue(opVoltages != null, netsTabSeen, bottomTab)` is true, the
  tab label renders as `Net voltages ●` — the dot is a `<span data-testid="nets-tab-cue">`
  with `color: '#f1c40f', marginLeft: 4`.
- Static dot only — there is no stylesheet in the renderer, and Gemini's
  suggestion accepts "pulse **or** unread badge". No keyframe/`<style>` injection.
- Per-session, in-memory. It disappears forever (that session) on first click of
  the tab; it never shows before the first successful op.

---

## Testing

Test idiom: panels are tested with `renderToStaticMarkup` against a real store
(node env, **no jsdom** — effects don't run, events can't fire), plus direct unit
tests of exported helpers/components. This pass follows that exactly:

1. **`buttonStyles`** — no dedicated tests (pure data); covered via consumers.
2. **ModelDoctor** (`panels/__tests__/ModelDoctor.test.tsx`):
   - closed-card SSR HTML contains `Import .lib`, `Pin map`, `Stub open`, and
     `data-testid="doctor-more"`, and does **not** contain `Stub short`,
     `Interactive pins`, or `Ask your LLM`;
   - `DoctorMoreMenu` rendered directly with `open: true` contains all three
     items with `role="menuitem"`; with `open: false` renders no menu;
   - existing selection-sync tests unchanged.
3. **EmptyStates** (`panels/__tests__/EmptyStates.test.tsx`, new): `NoBoardState`
   SSR — sample-project button carries the solid primary background exactly once;
   the other two are transparent outlines; all three testids present; DOM order.
4. **InstrumentRack** (`InstrumentRack.test.tsx`): existing "Probe this net"
   tests updated for the `⌖` prefix; button still `data-testid="probe-net-btn"`.
5. **Store** (`store/__tests__/…`): `fidelitySignature` stability (order-independent,
   mode-sensitive); `isFidelityMinimized` true on match, false on `null`, false
   when a new item changes the signature; `minimizeFidelityBanner` action sets the
   sig from live resolutions.
6. **WarningsBar** (`WarningsBar.test.tsx`): banner present + minimize control
   rendered when expanded; banner absent when store's `fidelityMinimizedSig`
   matches; banner re-present when resolutions change under a stale sig.
7. **App badge / tab cue**: `showNetsTabCue` truth table (4 cases, in
   `ui/__tests__/tabCues.test.ts`); SSR render of App is impractical
   (Viewport/GL) — the badge is an exported `FidelityBadge` component in
   WarningsBar.tsx, SSR-tested there; App wiring is covered by the E2E smoke run.
8. **E2E**: no selector churn — `open-sample-btn`, `open-first-light-btn`,
   `probe-net-btn`, `bottom-tab-nets` all keep their testids; no E2E currently
   clicks any action that moved into the ⋮ menu (verified by grep). Full suite
   must stay green.

## Completion

- Tick findings 1–5 (☐ → ☑) in `docs/ux-review-gemini-2026-07-13.md`.
- Do-not-regress checks: stale-voltage dimming and supply auto-select untouched.
