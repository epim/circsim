/**
 * core/spicegen/instruments.ts
 *
 * Instrument types — copied verbatim from spec §9.
 * DO NOT modify shapes without updating the spec.
 *
 * Instruments are the "virtual bench" items the user attaches to nets/pads.
 * They become SPICE elements with stable names (vpsu_1, vfgen_2, vlogic_3)
 * so `alter` can target them by name.
 */

// ─── Instrument (spec §9) — normative, copied verbatim ───────────────────────

export type Instrument =
  | { kind: 'ground-ref'; netId: number }                                   // exactly one required
  | { kind: 'dc-supply'; id: string; netId: number; volts: number; seriesOhms: number /* default 0.1 */ }
  | { kind: 'function-gen'; id: string; netId: number; wave: 'sine' | 'square' | 'triangle' | 'pulse';
      freqHz: number; amplitudeV: number; offsetV: number; dutyPct?: number; outputOhms: number /* default 50 */ }
  | { kind: 'logic-input'; id: string; netId: number; level: 0 | 1; vHigh: number /* default = chosen rail */ }
  // Potentiometer — the "turn the pot" control. `wiperPct` ∈ [0,1] is the wiper
  // travel from the low/A end (0) to the high/B end (1).
  //   rheostat (2-terminal): one resistor netA–netW.
  //   divider  (3-terminal): two resistors netHi–netW (upper) + netW–netLo (lower).
  | { kind: 'potentiometer'; mode: 'rheostat'; id: string; netA: number; netW: number;
      totalOhms: number; wiperPct: number }
  | { kind: 'potentiometer'; mode: 'divider'; id: string; netHi: number; netW: number; netLo: number;
      totalOhms: number; wiperPct: number }
  | { kind: 'voltage-probe'; id: string; netId: number; color: string }
  | { kind: 'current-probe'; id: string; ref: string; pad?: string; color: string }
      // device current; pad designates the ammeter splice point for subckt parts (§8.8)

// ─── Potentiometer SPICE naming + clamp (single source of truth) ─────────────

/**
 * Minimum wiper-leg resistance (Ω). The wiper resistance must never reach 0:
 * a 0 Ω leg shorts a node and can wreck ngspice convergence. Every emitted pot
 * resistor value is clamped into [RMIN, totalOhms].
 */
export const POT_RMIN_OHMS = 1

/** Clamp a pot leg resistance into [RMIN, totalOhms]. */
export function clampPotOhms(ohms: number, totalOhms: number): number {
  const hi = Math.max(POT_RMIN_OHMS, totalOhms)
  return Math.max(POT_RMIN_OHMS, Math.min(ohms, hi))
}

/** Sanitize an instrument id into a SPICE-safe suffix (matches instrumentSpiceName). */
function potIdSuffix(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

/**
 * Stable SPICE resistor name(s) for a potentiometer — the SINGLE source of truth
 * shared by generate.ts (deck emission) and generate.ts:alterPlan (live alters)
 * so the names can never drift.
 *   rheostat → { single: 'rpot_<id>' }   (one resistor netA–netW)
 *   divider  → { upper:  'rpot_<id>_a',  (netHi–netW)
 *               lower:  'rpot_<id>_b' }  (netW–netLo)
 */
export function potResistorNames(inst: Extract<Instrument, { kind: 'potentiometer' }>):
  | { single: string }
  | { upper: string; lower: string } {
  const suffix = potIdSuffix(inst.id)
  if (inst.mode === 'rheostat') {
    return { single: `rpot_${suffix}` }
  }
  return { upper: `rpot_${suffix}_a`, lower: `rpot_${suffix}_b` }
}

// ─── AlterPlan result ─────────────────────────────────────────────────────────

/**
 * Result of alterPlan(): either a live-alter (no deck reload needed) or
 * a reload-required change.
 *
 * alter: commands is an array of `alter @<dev>[param] <value>` strings ready
 *        to send through SimHost.
 * reload: the deck must be regenerated and reloaded before the change takes effect.
 */
export type AlterPlanResult =
  | { kind: 'alter'; commands: string[] }
  | { kind: 'reload' }
