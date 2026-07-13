# UX Review — Gemini (2026-07-13)

External UI/UX review of circsim requested via agent-bridge (topic `circsim`).
Findings captured verbatim below, to be folded into the release **after** v0.2.5
(v0.2.5 is engine-only: LM339 quad, island-detection refinement, koffi #271 fix).

Status legend: ☐ open · ◐ in progress · ☑ done

---

## High severity

### ☐ 1. Model Doctor action overload
The Model Doctor cards display up to 6–7 action buttons simultaneously (Stub open,
Stub short, Interactive pins, Import .lib…, Ask your LLM, Pin map, Reset). This
creates a wall of buttons → choice paralysis and visual clutter.

**Suggestion:** Clear action hierarchy. Keep 2–3 primary actions visible
(e.g. "Import .lib…", "Pin map", "Stub open"); move secondary/advanced actions
("Ask your LLM", "Interactive pins", "Stub short") into a `⋮` / "More…" menu.

## Medium severity

### ☐ 2. Empty-state button hierarchy
First-run empty state shows three prominent buttons ("Open…", "Open First Light
demo", "Open sample project"), all toolbar-styled but with heavy distinct custom
backgrounds (brown, dark green). Muddy visual weight fails to guide the first click.

**Suggestion:** Establish primary / secondary / tertiary button styles. Make
"Open…" (or sample project) the primary solid CTA; style the others as ghost/outline.

### ☐ 3. "Probe this net" button contrast
The click-to-probe button uses dark green bg (`#1e2e1e`) with green text (`#6f6`)
and a thin green border. Thematic with the V-Probe chip, but low contrast against
the dark `#15151f` rack bg makes it look disabled / easily missed.

**Suggestion:** Increase contrast — brighter solid bg on hover, or a probe-tip icon
to signal it is actionable rather than a status label.

## Low severity / polish

### ☐ 4. Banner blindness for "Results approximate"
Persistent amber fidelity banner is useful, but ever-present on boards with known
unresolved stubs → banner blindness. (The M9 grey "open by design" informational
banner is called out as excellent.)

**Suggestion:** Let users collapse the amber warning into a small warning icon/badge
in the toolbar after acknowledgement — frees vertical space, preserves urgency for
new issues.

### ☐ 5. Net Voltages tab discoverability
The "Net Voltages" readout tab shares the bottom dock with "Sim log". New users may
not realize a tabular voltage list exists if focused on the 3D board annotations.

**Suggestion:** On the very first successful operating point, add a subtle pulse or
"unread" badge to the "Net voltages" tab to teach the feature.

---

## Positive notes (keep / don't regress)
- **Net voltages stale state:** dimming stale voltages (`opacity: 0.55`) during a new
  solve is "a fantastic micro-interaction that builds trust."
- **Ranked supply auto-select:** auto-selecting the supply on open so its properties
  appear immediately "reduces friction" — a smart interaction choice.
