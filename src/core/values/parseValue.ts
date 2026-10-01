/**
 * parseValue — parse a component value string from the value-field domain into SI base units.
 *
 * Convention (value-field domain, NOT SPICE text):
 *   - Uppercase M, Meg, MEG = mega (1e6)
 *   - Lowercase m = milli (1e-3)
 *   - k/K = kilo (1e3)
 *   - u/U/micro sign/Greek mu = micro (1e-6)
 *   - n/N = nano (1e-9)
 *   - p/P = pico (1e-12)
 *   - f = femto (1e-15); uppercase F is the farad unit
 *   - G = giga (1e9)
 *   - T = tera (1e12)
 *
 * Decks never see suffixes (spicegen emits plain numbers), so SPICE's own
 * M-means-milli rule never applies here.
 *
 * Supports:
 *   - Standard notation:  "10k", "4.7u", "100n"
 *   - European notation:  "4k7" → 4700, "0R22" → 0.22, "4R7" → 4.7,
 *                         "4N7" → 4.7e-9, "2m2" → 2.2e-3, "2M2" → 2.2e6
 *   - Decimal comma:      "4,7k" → 4700, "0,22" → 0.22 ("1,000" is ambiguous
 *                         and returns undefined)
 *   - Trailing unit:      "10uF", "22uH", "10R", "10kOhm", "10 kΩ" (unit stripped)
 *   - Uppercase:          "10UF", "100NF", "22PF"
 *   - Greek mu:           "4.7μF" (U+03BC) and "4.7µF" (U+00B5)
 *   - Whitespace:         "10 k", "100 nF", "4.7 µF", "4.7 k Ohm"
 *   - Exponent notation:  "1e-9", "4.7E-6", "1e+10"
 *   - Meg/MEG:            "2.2Meg", "3.3MEG"
 *   - Plain numbers:      "470", "0.1"
 *   - Rating/tolerance:   "100nF/50V" → 100nF, "2.0k/0.5%" → 2.0k,
 *                         "100nF 50V", "10uF,25V" (suffix segment stripped)
 *   - Returns undefined:  "DNP", "N/A", "~", ""
 */

/**
 * Strip trailing voltage-rating / tolerance segments from a value field.
 * Real-board value fields often append a rating after the value:
 * "100nF/50V", "10uF,25V", "2.0k/0.5%", "100nF 50V". Take the leading value
 * token and drop trailing /-, comma- or space-delimited segments that are
 * just a voltage rating (\d+(\.\d+)?V) or tolerance (\d+(\.\d+)?%).
 * A bare "5V" (no delimiter) is untouched — a lone rating is not a value.
 */
function stripRatingSuffix(trimmed: string): string {
  const segments = trimmed.split(/[\s/,]+/).filter(s => s.length > 0)
  if (segments.length < 2) return trimmed

  const ratingOrTolerance = /^\d+(\.\d+)?(V|%)$/i
  while (segments.length > 1 && ratingOrTolerance.test(segments[segments.length - 1])) {
    segments.pop()
  }
  // Only apply when the leading value token is all that remains — anything
  // else (e.g. "100nF X7R") is not a recognized value+rating form.
  return segments.length === 1 ? segments[0] : trimmed
}

/**
 * Prefix letter to multiplier. Case matters only for M (mega) versus m (milli);
 * u/U, n/N and p/P are the same prefix in either case, because uppercase unit
 * strings ("10UF", "100NF", "22PF", "4N7") are what BOM exports and CAD tools
 * produce. Femto is lowercase f only: uppercase F is the farad unit.
 */
const PREFIX_MULT: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  M: 1e6,
  k: 1e3,
  K: 1e3,
  m: 1e-3,
  u: 1e-6,
  U: 1e-6,
  n: 1e-9,
  N: 1e-9,
  p: 1e-12,
  P: 1e-12,
  f: 1e-15,
}

/** One unit after the prefix: F, H, R, Ohm, Ohms or the omega sign. */
const UNIT_TAIL = /^(?:[FHR]|ohms?|Ω)$/i

/** Leading number: digits with optional point, or a bare fraction. */
const NUM = '(\\d+\\.?\\d*|\\.\\d+)'

/**
 * Normalise spellings that are the same value written differently:
 *   - micro sign (U+00B5) and Greek small mu (U+03BC) become u
 *   - ohm sign (U+2126) and Greek small omega (U+03C9) become capital omega
 *   - a European decimal comma between digits ("4,7k", "0,22") becomes a point
 *   - whitespace between number and prefix or unit ("10 k", "100 nF", "10 kΩ",
 *     "4.7 k Ohm") is dropped
 * Returns undefined for the one ambiguous spelling, a thousands-shaped comma
 * group ("1,000"), which is a decimal comma in Europe and a thousands
 * separator elsewhere: a silent factor of 1000 is worse than no value.
 */
function normalise(raw: string): string | undefined {
  let s = raw.replace(/[µμ]/g, 'u').replace(/[Ωω]/g, 'Ω')

  // A comma followed by digits then V or % ("100,25V", "1,100V") is a rating
  // delimiter, never a decimal comma or a thousands separator.
  if (/^[1-9]\d{0,2},\d{3}(?![\dV%])/.test(s)) return undefined
  s = s.replace(/^(\d+),(\d+)(?![\dV%])/, '$1.$2')

  // Number, whitespace, then a letter: "10 k", "100 nF", "10 kΩ".
  s = s.replace(new RegExp(`^${NUM}\\s+(?=[A-Za-z\\u03A9])`), '$1')
  // Prefix, whitespace, then a bare unit word: "10k Ω", "4.7k Ohm".
  s = s.replace(
    new RegExp(`^${NUM}([TGMmkKuUnNpPf]?)\\s+(?=(?:[Oo][Hh][Mm][Ss]?|\\u03A9|[RFH])(?:[\\s/,]|$))`),
    '$1$2'
  )
  return s
}

/** Result guard: a value that overflows to Infinity is not a value. */
const finite = (n: number): number | undefined => (Number.isFinite(n) ? n : undefined)

export function parseValue(text: string, _kind: 'R' | 'C' | 'L'): number | undefined {
  const raw = text.trim()

  // Empty, placeholder, or non-numeric strings → undefined
  if (!raw || raw === '~' || /^(DNP|N\/A|NA|TBD|--+|none)$/i.test(raw)) {
    return undefined
  }

  const normalised = normalise(raw)
  if (normalised === undefined) return undefined

  // Drop a trailing voltage-rating / tolerance segment ("100nF/50V" → "100nF")
  const trimmed = stripRatingSuffix(normalised)

  // ── European/EIA notation: digit(s) [prefix] digit(s) ──────────────────
  // Examples: 4k7 → 4.7e3, 0R22 → 0.22, 2k2 → 2200, 4R7 → 4.7, 4N7 → 4.7e-9
  // The separator letter acts as a decimal point. Case-sensitive: m is milli
  // and M is mega ("2m2" = 2.2 milli, "2M2" = 2.2 mega); both need a leading
  // digit, so a bare "M3" (a screw size) is not a value.
  const europeanMatch = trimmed.match(/^(\d*\.?\d*)(k|K|R|r|u|U|n|N|p|P|f|M|m)(\d+)$/)
  if (europeanMatch) {
    const [, before, sep, after] = europeanMatch
    const isMega = sep === 'M' || sep === 'm'
    if (!(isMega && before === '')) {
      const base = parseFloat(`${before === '' ? '0' : before}.${after}`)
      if (isNaN(base)) return undefined
      if (sep === 'R' || sep === 'r') {
        // R as decimal separator: 0R22 → 0.22, 4R7 → 4.7
        return base
      }
      return finite(base * PREFIX_MULT[sep])
    }
  }

  // ── Meg/MEG suffix (must check before single-char M) ────────────────────
  const megMatch = trimmed.match(/^(\d+\.?\d*)[Mm][Ee][Gg]([A-Za-z]*)$/)
  if (megMatch) {
    const val = parseFloat(megMatch[1])
    if (!isNaN(val)) return finite(val * 1e6)
  }

  // ── Exponent notation: 1e-9, 4.7E-6, 1e+10, optionally with a unit ──────
  const expMatch = trimmed.match(/^(\d+\.?\d*|\.\d+)[eE]([+-]?\d+)([A-Za-zΩ]*)$/)
  if (expMatch) {
    const [, numStr, expStr, unitStr] = expMatch
    if (unitStr && !UNIT_TAIL.test(unitStr)) return undefined
    return finite(parseFloat(`${numStr}e${expStr}`))
  }

  // ── Standard notation with optional trailing unit ────────────────────────
  // Examples: 10k, 4.7u, 100n, 1M, 1m, 10uF, 22uH, 470, 10R, 10UF, 10kOhm
  // Pattern: number, optional multiplier char, optional unit chars
  const standardMatch = trimmed.match(/^(\d+\.?\d*|\.\d+)([TGMmkKuUnNpPf]?)([A-Za-zΩ]*)$/)
  if (standardMatch) {
    const [, numStr, prefixChar, unitStr] = standardMatch
    const base = parseFloat(numStr)
    if (isNaN(base)) return undefined

    // A unit tail (R, F, H, Ohm, Ω) is accepted with or without a prefix;
    // any other trailing text ("10kV", "100nFX") is not a value.
    if (unitStr && !UNIT_TAIL.test(unitStr)) return undefined

    if (!prefixChar) return finite(base)
    return finite(base * PREFIX_MULT[prefixChar])
  }

  // Signed plain number ("-5"): not matched above, kept from the original parser.
  if (/^-?\d*\.?\d+$/.test(trimmed)) return finite(parseFloat(trimmed))

  return undefined
}
