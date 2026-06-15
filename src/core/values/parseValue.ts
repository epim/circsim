/**
 * parseValue — parse a component value string from the value-field domain into SI base units.
 *
 * Convention (value-field domain, NOT SPICE text):
 *   - Uppercase M, Meg, MEG = mega (1e6)
 *   - Lowercase m = milli (1e-3)
 *   - k/K = kilo (1e3)
 *   - u/µ = micro (1e-6)
 *   - n = nano (1e-9)
 *   - p = pico (1e-12)
 *   - f = femto (1e-15)
 *   - G = giga (1e9)
 *   - T = tera (1e12)
 *
 * Decks never see suffixes (spicegen emits plain numbers), so SPICE's own
 * M-means-milli rule never applies here.
 *
 * Supports:
 *   - Standard notation:  "10k", "4.7u", "100n"
 *   - European notation:  "4k7" → 4700, "0R22" → 0.22, "4R7" → 4.7
 *   - Trailing unit:      "10uF", "22uH", "10R" (unit letter stripped)
 *   - Meg/MEG:            "2.2Meg", "3.3MEG"
 *   - Plain numbers:      "470", "0.1"
 *   - Returns undefined:  "DNP", "N/A", "~", ""
 */
export function parseValue(text: string, _kind: 'R' | 'C' | 'L'): number | undefined {
  const trimmed = text.trim()

  // Empty, placeholder, or non-numeric strings → undefined
  if (!trimmed || trimmed === '~' || /^(DNP|N\/A|NA|TBD|--+|none)$/i.test(trimmed)) {
    return undefined
  }

  // Prefix multipliers. Note case sensitivity:
  //   M = mega (1e6), m = milli (1e-3), Meg/MEG = mega (1e6)
  const multipliers: Record<string, number> = {
    T: 1e12,
    G: 1e9,
    M: 1e6,   // uppercase M = mega
    k: 1e3,
    K: 1e3,
    // m handled separately below (lowercase m = milli)
    u: 1e-6,
    µ: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15,
  }

  // Unit suffix letters to strip after the multiplier
  const unitSuffixes = /^[FHROhmΩ]+$/i  // F, H, R, Ω, ohm etc.

  // ── European/EIA notation: digit(s) [prefix] digit(s) ──────────────────
  // Examples: 4k7 → 4.7e3, 0R22 → 0.22, 2k2 → 2200, 4R7 → 4.7
  // The separator letter acts as a decimal point.
  // Match: optional leading digits, a prefix letter, optional trailing digits
  // Pattern: (\d*\.?\d*)(k|K|M|m|u|µ|n|p|f|R|r)(\d+)
  const europeanMatch = trimmed.match(/^(\d*\.?\d*)(k|K|R|r|u|µ|n|p|f)(\d+)$/i)
  if (europeanMatch) {
    const [, before, sep, after] = europeanMatch
    const integer = before === '' ? '0' : before
    const decimal = after
    const base = parseFloat(`${integer}.${decimal}`)
    if (isNaN(base)) return undefined

    const sepUpper = sep.toUpperCase()
    if (sepUpper === 'R') {
      // R as decimal separator: 0R22 → 0.22, 4R7 → 4.7
      return base
    }
    const mult = multipliers[sep] ?? multipliers[sepUpper]
    if (mult !== undefined) return base * mult
  }

  // Uppercase M European notation: 4M7 etc (rare but possible)
  const europeanMMatch = trimmed.match(/^(\d*\.?\d*)M(\d+)$/i)
  if (europeanMMatch) {
    const [, before, after] = europeanMMatch
    const base = parseFloat(`${before === '' ? '0' : before}.${after}`)
    if (!isNaN(base)) {
      // Uppercase M = mega
      return base * 1e6
    }
  }

  // ── Meg/MEG suffix (must check before single-char M) ────────────────────
  const megMatch = trimmed.match(/^(\d+\.?\d*)[Mm][Ee][Gg]([A-Za-z]*)$/)
  if (megMatch) {
    const val = parseFloat(megMatch[1])
    if (!isNaN(val)) return val * 1e6
  }

  // ── Standard notation with optional trailing unit ────────────────────────
  // Examples: 10k, 4.7u, 100n, 1M, 1m, 10uF, 22uH, 470, 10R
  // Pattern: number, optional multiplier char, optional unit chars
  const standardMatch = trimmed.match(/^(\d+\.?\d*|\.\d+)([TGMmkKuµnpf]?)([A-Za-zΩ]*)$/)
  if (standardMatch) {
    const [, numStr, prefixChar, unitStr] = standardMatch
    const base = parseFloat(numStr)
    if (isNaN(base)) return undefined

    // If prefixChar is empty and unitStr is a single multiplier-eligible letter, handle it
    if (!prefixChar && unitStr) {
      // e.g. "10R" → 10 (R is a unit suffix, not a multiplier)
      if (unitSuffixes.test(unitStr)) return base
      // Unknown suffix → undefined
      return undefined
    }

    if (!prefixChar) {
      // Plain number
      return base
    }

    // Check if it's actually a unit suffix (R, Ω, H, F, ohm)
    if (prefixChar === 'R' || prefixChar === 'r') {
      // "10R" → 10 Ω — R as unit, no multiplication
      return base
    }

    // Lowercase m = milli (1e-3), uppercase M = mega (1e6)
    if (prefixChar === 'm') {
      return base * 1e-3
    }
    if (prefixChar === 'M') {
      return base * 1e6
    }

    const mult = multipliers[prefixChar]
    if (mult !== undefined) return base * mult

    return undefined
  }

  // ── Leading-zero European with explicit decimal: "0.22" etc ─────────────
  const plainDecimal = parseFloat(trimmed)
  if (!isNaN(plainDecimal) && /^-?\d*\.?\d+$/.test(trimmed)) {
    return plainDecimal
  }

  return undefined
}
