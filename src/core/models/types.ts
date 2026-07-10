/**
 * core/models/types.ts
 *
 * Normative model-resolution types — copied verbatim from spec §8.5.
 * DO NOT modify shapes without updating the spec.
 *
 * These types encode the tier cascade result for every Part in a Circuit.
 * First tier hit wins; every resolution records its provenance.
 */

// ─── PinMap ──────────────────────────────────────────────────────────────────

/** Maps pad numbers (from the board file) to subckt node positions or names. */
export type PinMap = Record<string /* pad number */, string /* subckt node position or name */>;

// ─── ResolvedModel ────────────────────────────────────────────────────────────

export type ResolvedModel =
  | { kind: 'primitive'; card: string }                                  // e.g. "r_r1 n1 n2 10k"
  | { kind: 'subckt'; libFile: string; subcktName: string; pinMap: PinMap }
  | { kind: 'xspice-digital'; templateId: string; pinMap: PinMap }       // expands to adc_bridge+gates+dac_bridge
  | { kind: 'stub'; mode: 'open' | 'short' | 'interactive-pins' };

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface Resolution {
  ref: string;
  status: 'ok' | 'stubbed' | 'unresolved' | 'documented-open';
  model?: ResolvedModel;
  tier: 1 | 2 | 3 | 4 | 5 | 6;
  warnings: string[];
  /** Why the part is intentionally not modeled — documented-open only. */
  note?: string;
}

// ─── LibraryEntry ─────────────────────────────────────────────────────────────

export interface LibraryEntry {
  id: string;
  match: {
    mpn?: string[];
    valueRegex?: string;
    refdesPrefix?: string[];
    footprintRegex?: string;
  };
  model: {
    type: 'subckt' | 'model-card' | 'xspice-digital' | 'documented-open';
    file?: string;   // absent for documented-open (no model text by definition)
    name: string;
  };
  /** REQUIRED for documented-open entries: why the part is intentionally not modeled. */
  note?: string;
  pinMaps: Record<string /* footprint pattern, e.g. "SOT-23" */, PinMap>;  // REQUIRED — see pin-mapping note ({} for documented-open)
  defaultPinMap?: PinMap;
  provenance: string;   // who wrote it, from which datasheet — every entry must have this
}
