# Read the warnings & fidelity banner

circsim surfaces a lot of honesty. That's on purpose — [a validator you can't trust is worse than none](../concepts/fidelity), so circsim would rather tell you about a gap than hide it. This guide decodes every warning surface so none of them are mysterious.

They stack near the top of the window, most-urgent first.

## The fidelity banner

The one you'll see most. It appears whenever the simulation is running with incomplete information.

- **"Results approximate: …"** *(amber)* — one or more parts are **unresolved** or **stubbed**. The voltages and waveforms are correct for the *modeled* part of the circuit, but the real board may differ wherever an unmodeled part matters.
- **"Open by design: …"** *(grey-blue)* — the only affected parts are documented opens (a part with no meaningful SPICE model). Lower-key, because this is expected, not a problem.

The banner lists the affected parts and links to **open Model Doctor** (jumps to the first one) and **What can circsim tell you?** ([the fidelity page](../concepts/fidelity)). If many parts are affected it collapses to a count.

You can **minimize** it (the **»** button) to a compact header badge — **⚠ N approximate** or **ⓘ N open by design** — and click the badge to bring it back. You can't fully dismiss it, and it re-expands on its own if the set of affected parts changes: hiding it entirely would misrepresent the simulation. To make it go away for real, [resolve or stub the parts](./model-doctor).

## "Check these voltages" — the operating-point caveat

*(persistent, appears after a fallback solve)* The [operating point](./energize) converged, but only through a numerical fallback (gmin-stepping, source-stepping, or a transient assist) rather than a clean direct solve. A fallback op can report a misleading `0.000 V` on nets it couldn't resolve, so treat the voltages as suspect and look for the underlying cause (a floating node, a missing ground path). A clean solve shows no caveat.

## "The simulator couldn't find a stable solution"

*(dismissable card)* The solve failed outright. This is usually a **numerical** problem, not a broken circuit. circsim names the likely culprit in plain language and often points at the specific net or part. Common fixes: designate the [correct ground](./ground-and-supply), stub an [unresolved part](./model-doctor), or check for a floating node. Expand **Show raw ngspice log** if you want the engine's own output.

## "Check this rail" — a gated-off rail

*(amber)* A digital chip's VDD net measured near 0 V at the operating point, so circsim used the family-default logic swing instead — which means logic thresholds may be wrong if that rail is actually powered during a transient. Type the real rail voltage into the inline field and click **Set rail voltage** to fix it. See [rail sensing](../reference/architecture#rail-sensing).

## "Pin map corrected from schematic"

*(grey, informational)* circsim found a diode/LED whose schematic pin names (A/K) disagreed with its footprint's pad convention, and trusted the schematic — catching a would-be-reversed part. If your *schematic* is the stale one, override in the [Model Doctor](./model-doctor#pin-map). This is the system working; no action needed unless the schematic is wrong. See [the diode-polarity trap](../reference/pin-maps#diode-polarity).

## 💡 Coach notes (dark LEDs)

*(bottom-left overlay)* After a solve, any LED that *should* be lit but isn't gets a plain-language card explaining why — a reversed diode, no current-limit path, too little voltage. A silent dark LED is a beginner's worst moment, so circsim turns it into a lesson. It disappears once every LED is lit.

## Simulator restarted / Bench restarted

*(dismissable toasts)*

- **Simulator restarted** — the isolated SPICE engine crashed and recovered automatically. Your work is intact; just re-run. (If it says it *couldn't* restart, restart circsim.)
- **Bench restarted** — a long continuous transient hit its memory/time window and restarted to stay bounded. Scope history is kept. Note that sequential-logic state (flip-flops, counters) resets on a bench restart.

## The Sim Log

*(bottom dock, "Sim log" tab)* The raw engine output, filterable by **All / Warn+ / Errors**. Most of the time the friendly surfaces above are enough — reach for the Sim Log when you want to see exactly what ngspice said.

## The through-line

Every one of these exists so you're never trusting a number circsim doesn't trust. When in doubt, read [what circsim can and can't tell you](../concepts/fidelity) — it's the philosophy all of these surfaces come from.
