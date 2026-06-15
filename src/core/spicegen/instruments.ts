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
  | { kind: 'voltage-probe'; id: string; netId: number; color: string }
  | { kind: 'current-probe'; id: string; ref: string; pad?: string; color: string }
      // device current; pad designates the ammeter splice point for subckt parts (§8.8)

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
