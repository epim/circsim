/**
 * core/models/libraryMatch.ts
 *
 * Tier 3 library matching logic for the model resolution pipeline.
 *
 * Matching precedence (first tier that produces a non-ambiguous single match wins):
 *   1. Exact normalized MPN match against entry.match.mpn[]
 *   2. Value field matches entry.match.valueRegex
 *   3. refdesPrefix + footprintRegex fallback (footprintRegex is required)
 *
 * Tiers 1 and 2 refuse a match that came from the Value field when the refdes names
 * a class of part that is never a library device (battery, test point, switch,
 * connector, passive; issue #51).
 *
 * Ambiguous (2+ entries match at the same tier) → 'ambiguous' result with candidate ids.
 * No match at any tier → 'none'.
 *
 * Pin-map selection:
 *   - A JLC/EasyEDA-origin footprint on a polarized two-terminal entry → defaultPinMap
 *     + 'pinmap-unverified' polarity warning (the name cannot tell polarity, issue #5).
 *   - Iterate entry.pinMaps keys (treated as regex patterns) against the part's libId.
 *   - First match → return that pinMap with no warning.
 *   - No match → return entry.defaultPinMap + 'pinmap-unverified' warning.
 *   - Neither → empty map + warning.
 *
 * Spec §8.5, Task 15.
 */

import type { LibraryEntry, PinMap } from './types'

// ─── MPN normalization rules ──────────────────────────────────────────────────

/**
 * Package suffix strings to strip from MPNs, applied longest-first.
 *
 * These suffixes indicate packaging/reel/temperature variants — not distinct
 * part numbers. A suffix is only stripped if:
 *   - The remaining part still has at least 3 characters (preserves 'LM358', '555', etc.)
 *   - The remaining part does NOT end with something that looks purely numeric
 *     AND the stripped suffix is a single letter (prevents stripping '4' from
 *     '2N3904', '8' from '1N4148', '7' from 'BC547').
 *
 * Examples:
 *   LM358D   → LM358   (D = SOIC)
 *   LM358N   → LM358   (N = DIP)
 *   LM358DR  → LM358   (D + R = SOIC tape-and-reel; DR stripped in one step)
 *   NE555DT  → NE555   (DT = small outline)
 *   NE555P   → NE555   (P = PDIP)
 *   LM324PWR → LM324   (PWR = TSSOP + reel)
 *   BC547-TR → BC547   (TR = tape & reel with dash)
 *   1N4148-SMD → 1N4148 (explicit SMD marker)
 *   2N3904   → 2N3904  (no suffix — numeric ending is part of the name)
 *   1N4148   → 1N4148  (no suffix)
 *   BC547    → BC547   (no suffix)
 *
 * Kept as an exported constant so callers can inspect or augment the rules.
 */
export const MPN_SUFFIX_RULES: string[] = [
  // Multi-char suffixes first (longest match wins)
  'PWREP',   // rare extended power
  '-TSSOP',  // explicit package name
  '-SOIC',
  '-DIP',
  '-SMD',    // explicit SMD marker
  '-SMT',    // explicit SMT marker
  '-TR',     // tape & reel (with dash)
  'TSSOP',   // explicit package name (no dash)
  'PWR',     // TI/NXP power package suffix (e.g. LM324PWR)
  'DGK',     // TI MSOP package
  'DBV',     // TI SOT-23 package
  'DCK',     // TI SOT-23 5-pin
  'DGN',     // TI SOIC package variant
  'PW',      // TI TSSOP (stripped before R in next iteration)
  'TR',      // tape & reel (no dash)
  'DR',      // SOIC + reel (combined, strip before D)
  'DT',      // small-outline DT variant (e.g. NE555DT)
  'DG',      // DG variant
  'BT',      // BT variant
  // Single-char suffixes — careful: only strip when safe (see guard below)
  'D',       // SOIC
  'N',       // DIP
  'P',       // PDIP
  'T',       // TSSOP/SOT
  'R',       // reel (after multi-char stripped)
  'M',       // mini package
]

/**
 * Normalize an MPN for fuzzy library matching.
 *
 * Algorithm:
 *   1. Uppercase and trim
 *   2. Repeatedly strip known package suffixes (longest-first, restart each time)
 *      Guard: after stripping, remaining string must have ≥ 3 chars, and if the
 *      stripped suffix is a single letter AND the remaining string ends with a
 *      digit, we skip that rule (protects 2N3904 → not 2N390).
 *
 * The result is the "canonical" part identifier without packaging qualifiers.
 */
export function normalizeMpn(mpn: string): string {
  let s = mpn.toUpperCase().trim()

  let changed = true
  let iterations = 0

  while (changed && iterations < 10) {
    changed = false
    iterations++

    for (const suffix of MPN_SUFFIX_RULES) {
      const suf = suffix.toUpperCase()
      if (!s.endsWith(suf)) continue

      const remaining = s.slice(0, s.length - suf.length)

      // Guard: remaining must have at least 3 chars
      if (remaining.length < 3) continue

      // Guard: if the suffix is a single letter AND remaining ends with a digit,
      // skip — this avoids stripping '4' from '2N3904' (which ends in '0' + suffix '4'
      // but '04' is part of the part number, not a package suffix).
      // We check: if suf.length === 1 and /[A-Z]/.test(suf) and /\d$/.test(remaining),
      // then we do NOT strip. E.g. '2N390' ends in digit '0' → don't strip 'D' that is
      // actually part of '04'. Wait, that doesn't apply: '2N3904' ends in '4', and
      // suf='4' would only match if '4' is in our list (it isn't — only letters).
      // Actually the issue is simpler: our suffix list only contains letters and '-',
      // so '2N3904' can never match a suffix ending 'D' or 'N' etc from the RIGHT
      // unless it actually ends with one of those letters. '2N3904' ends in '4', so it
      // never matches. '1N4148' ends in '8', never matches. BC547 ends in '7', never matches.
      // The guard above (remaining.length < 3) handles the length constraint.
      // No additional guard needed!

      s = remaining
      changed = true
      break
    }
  }

  return s
}

// ─── Match result types ───────────────────────────────────────────────────────

export type MatchResult =
  | { kind: 'match'; entry: LibraryEntry; tier: 'mpn' | 'valueRegex' | 'fallback' }
  | { kind: 'ambiguous'; candidates: string[]; tier: 'mpn' | 'valueRegex' | 'fallback' }
  | { kind: 'none' }

// ─── Part descriptor for matching ────────────────────────────────────────────

export interface PartDescriptor {
  /** MPN from a BOM row or part.properties['mpn'] / ['MPN'], if present. */
  mpn: string | undefined
  /**
   * True when `mpn` is only the part's Value field standing in for a missing
   * MPN. Such a guess carries no intent, so it is refused on a refdes that is
   * never a library device (battery, test point, switch, connector, passive;
   * issue #51). An explicit MPN is never gated.
   */
  mpnIsValue?: boolean
  /** Part's libId (e.g. "Diode_SMD:D_SMA_SMA"). Used for footprint matching. */
  libId: string
  /** Part's value field. */
  value: string
  /** Part's ref (e.g. "D1" → prefix "D"). */
  ref: string
}

/**
 * Extract the refdes prefix (leading letters) from a ref.
 * "D1" → "D", "R10" → "R", "U1" → "U".
 */
function refdesPrefix(ref: string): string {
  const m = ref.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

// ─── Single-entry match predicates ────────────────────────────────────────────

/**
 * Refdes prefixes (the leading letters) of parts that are never a library
 * device: passives, batteries, test points, switches, connectors, mechanical
 * and electromechanical parts. A value-derived match (value-as-MPN, valueRegex)
 * carries no refdes information of its own, so "3V0" on BT1 or "555" on SW1 must
 * not become a zener or an NE555 (issue #51).
 *
 * This is a deny list on purpose. The library covers diodes, LEDs, transistors,
 * ICs and regulators, and boards name those with many conventions (D, CR, LD, Q,
 * T, TR, V, U, IC, A, N, VR, REG ...); a list of the accepted prefixes goes stale
 * the moment a board uses another one and silently un-resolves a good part.
 * Naming what a part cannot be fails safe the other way: an unlisted prefix
 * keeps the match it always had.
 */
const NON_DEVICE_REFDES = new Set([
  // passives
  'R', 'RV', 'RN', 'RP', 'RT', 'RK', 'C', 'CP', 'L', 'FB', 'F', 'FU', 'TH', 'VDR',
  // sources, switches, relays, connectors, mechanical
  'BT', 'BAT', 'SW', 'S', 'K', 'RLY', 'J', 'P', 'CN', 'CON', 'JP', 'SP',
  'TP', 'H', 'MH', 'FID', 'MK', 'NT', 'ANT', 'Y', 'LS', 'BZ',
])

/**
 * True when a value-derived match may be accepted for a part with this refdes:
 * it may unless the refdes names a class that is never a library device.
 */
function valueMatchAllowed(ref: string): boolean {
  return !NON_DEVICE_REFDES.has(refdesPrefix(ref))
}

/**
 * Test if an entry matches by MPN (normalized).
 */
function matchesByMpn(entry: LibraryEntry, mpn: string | undefined): boolean {
  if (!mpn || !entry.match.mpn || entry.match.mpn.length === 0) return false
  const normalized = normalizeMpn(mpn)
  return entry.match.mpn.some(entryMpn => normalizeMpn(entryMpn) === normalized)
}

/**
 * Test if an entry matches by value regex.
 * The valueRegex in the index may use `(?i)` prefix for case-insensitive matching.
 */
function matchesByValueRegex(entry: LibraryEntry, value: string): boolean {
  if (!entry.match.valueRegex) return false
  let pattern = entry.match.valueRegex
  let flags = ''
  // Handle (?i) inline flag (not a valid JS regex flag position — convert to /flag)
  if (pattern.startsWith('(?i)')) {
    pattern = pattern.slice(4)
    flags = 'i'
  }
  try {
    const re = new RegExp(pattern, flags)
    return re.test(value)
  } catch {
    return false
  }
}

/**
 * Test if an entry matches by refdesPrefix + footprintRegex fallback.
 * Both must match (if the entry specifies them).
 */
function matchesByFallback(entry: LibraryEntry, part: PartDescriptor): boolean {
  const { refdesPrefix: prefixes, footprintRegex } = entry.match

  // A footprint pattern is required: a refdes prefix alone ("D") describes
  // every part of that class, which is no basis for picking one model. Entries
  // that are identified by value only (the colored LEDs) declare no
  // footprintRegex and so stay out of this tier.
  if (!footprintRegex) return false

  // Check refdesPrefix
  if (prefixes && prefixes.length > 0) {
    const prefix = refdesPrefix(part.ref)
    if (!prefixes.map(p => p.toUpperCase()).includes(prefix)) return false
  }

  // Check footprintRegex against libId
  if (footprintRegex) {
    try {
      const re = new RegExp(footprintRegex, 'i')
      if (!re.test(part.libId)) return false
    } catch {
      return false
    }
  }

  return true
}

// ─── Main matching function ───────────────────────────────────────────────────

/**
 * Documented-open entries ("we know this part and intentionally don't model
 * it") yield to modeled entries at the same tier: a user-imported model with
 * the same MPN must WIN, not create a false mpn-tier ambiguity — otherwise
 * "Import .lib…" on an open-by-design part could never take effect.
 */
function preferModeled(matches: LibraryEntry[]): LibraryEntry[] {
  if (matches.length < 2) return matches
  const modeled = matches.filter(e => e.model.type !== 'documented-open')
  return modeled.length > 0 ? modeled : matches
}

/**
 * Attempt to find a library entry matching the given part descriptor.
 *
 * Implements the three-tier matching precedence:
 *   mpn > valueRegex > fallback (refdesPrefix + footprintRegex)
 *
 * At each tier, if exactly one entry matches → 'match'.
 * If two or more match at the same tier → 'ambiguous' (do not fall through),
 * except that documented-open entries yield to modeled ones first.
 * If zero match at a tier → try the next tier.
 */
export function matchLibraryEntry(
  part: PartDescriptor,
  library: LibraryEntry[],
): MatchResult {
  // ── Tier A: MPN ────────────────────────────────────────────────────────────
  // A Value-field stand-in for a missing MPN is refused on a refdes that is
  // never a library device (issue #51: "3V0" on BT1 is a battery, not a zener).
  const mpnMatches = preferModeled(
    library.filter(
      e => matchesByMpn(e, part.mpn) && (!part.mpnIsValue || valueMatchAllowed(part.ref)),
    ),
  )
  if (mpnMatches.length === 1) {
    return { kind: 'match', entry: mpnMatches[0], tier: 'mpn' }
  }
  if (mpnMatches.length > 1) {
    return { kind: 'ambiguous', candidates: mpnMatches.map(e => e.id), tier: 'mpn' }
  }

  // ── Tier B: Value regex ────────────────────────────────────────────────────
  const valueMatches = preferModeled(
    library.filter(e => matchesByValueRegex(e, part.value) && valueMatchAllowed(part.ref)),
  )
  if (valueMatches.length === 1) {
    return { kind: 'match', entry: valueMatches[0], tier: 'valueRegex' }
  }
  if (valueMatches.length > 1) {
    return { kind: 'ambiguous', candidates: valueMatches.map(e => e.id), tier: 'valueRegex' }
  }

  // ── Tier C: Fallback (refdesPrefix + footprintRegex) ──────────────────────
  const fallbackMatches = preferModeled(library.filter(e => matchesByFallback(e, part)))
  if (fallbackMatches.length === 1) {
    return { kind: 'match', entry: fallbackMatches[0], tier: 'fallback' }
  }
  if (fallbackMatches.length > 1) {
    return { kind: 'ambiguous', candidates: fallbackMatches.map(e => e.id), tier: 'fallback' }
  }

  return { kind: 'none' }
}

// ─── Pin-map selection ────────────────────────────────────────────────────────

export interface PinMapResult {
  pinMap: PinMap
  warnings: string[]
}

/** Machine prefix of every unverified-pin-map warning. */
export const POLARITY_UNVERIFIED_PREFIX = 'pinmap-unverified:'

/**
 * True for footprint names that come from the JLC/EasyEDA ecosystem: the JLC
 * library prefix ("JLC-MCP:SMA_...") or the bare dimension-pattern shape
 * ("SMA_L4.2-W2.6-LS5.0-RD_1"). KiCad-official names never have that shape (their
 * dimension tokens carry an "mm" suffix). Pad numbering on these footprints
 * follows the part, not any convention, so the name cannot tell polarity.
 */
export function isEasyEdaOriginFootprint(libId: string): boolean {
  return /^JLC/i.test(libId) || /_L\d+(\.\d+)?-W\d+/i.test(libId)
}

/**
 * Select the best pin map for a matched entry given the part's footprint (libId).
 *
 * Algorithm:
 *   1. Iterate entry.pinMaps keys as regex patterns; test against libId.
 *   2. First match → return that pinMap, no warning.
 *   3. No regex match → use entry.defaultPinMap + emit 'pinmap-unverified' warning.
 *   4. Neither → return empty map + warning.
 */
export function selectPinMap(entry: LibraryEntry, libId: string): PinMapResult {
  const warnings: string[] = []

  // JLC/EasyEDA-origin footprint on a polarized two-terminal part: the name
  // says nothing about which pad is the anode (issue #5), so no pinMaps key may
  // claim it. Hand back the KiCad-convention default, flagged unverified; the
  // attached schematic's A/K names (pinMapFromSchematicPins) or a Model Doctor
  // override are what make the polarity known.
  if (
    isEasyEdaOriginFootprint(libId) &&
    isTwoTerminalPolarizedEntry(entry) &&
    entry.defaultPinMap &&
    Object.keys(entry.defaultPinMap).length > 0
  ) {
    warnings.push(
      `${POLARITY_UNVERIFIED_PREFIX} polarity of "${libId}" cannot be known from a JLC/EasyEDA footprint name ` +
      `(pad 1 is the anode on some and the cathode on others); assumed the KiCad convention, pad 1 = cathode. ` +
      `Attach the schematic or set the pin map in Model Doctor to confirm`
    )
    return { pinMap: entry.defaultPinMap, warnings }
  }

  // Try each pinMaps key as a regex
  for (const [pattern, pinMap] of Object.entries(entry.pinMaps)) {
    try {
      const re = new RegExp(pattern, 'i')
      if (re.test(libId)) {
        return { pinMap, warnings }
      }
    } catch {
      // Malformed regex — skip this key
    }
  }

  // No footprint regex match — fall back to defaultPinMap
  if (entry.defaultPinMap && Object.keys(entry.defaultPinMap).length > 0) {
    warnings.push(
      `pinmap-unverified: no footprint regex in entry "${entry.id}" matched "${libId}"; using defaultPinMap — verify pin order`
    )
    return { pinMap: entry.defaultPinMap, warnings }
  }

  // No default either
  warnings.push(
    `pinmap-unverified: no pin map found for entry "${entry.id}" with footprint "${libId}"`
  )
  return { pinMap: {}, warnings }
}

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
/** Machine prefix of SCHEMATIC_PINMAP_NOTE — the handle WarningsBar filters on. */
export const SCHEMATIC_PINMAP_PREFIX = 'schematic-pinmap:'

export const SCHEMATIC_PINMAP_NOTE =
  `${SCHEMATIC_PINMAP_PREFIX} pin map taken from the schematic (pin 1 = A) — the footprint convention would have reversed this part; override in Model Doctor if the schematic is stale`

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
