/**
 * parseBom — tolerant BOM CSV importer.
 *
 * Features:
 *  - Delimiter autodetect: comma, semicolon, tab
 *  - Header aliasing (case, spacing, "_", "-", "." and "#" are ignored):
 *      Reference(s)|Reference Designator(s)|Designator(s)|Ref|RefDes|Ref Des → ref;
 *      Value|Val → value (JLCPCB's "Comment" column is used when there is no Value column);
 *      Footprint|Package → footprint;
 *      MPN|Manufacturer Part Number|Mfr Part #|Mfg Part Number|Part Number → mpn
 *    LCSC / "JLCPCB Part #" codes are NOT MPNs and are never mapped to mpn.
 *  - Grouped-ref expansion: "R1, R2, R3" or "R1 R2 R3" in one row → individual entries
 *  - Range expansion: "R1-R4", "R1-4", "C10~C12" → one entry per ref
 *  - Quoted fields with embedded delimiters, embedded newlines, and doubled-quote escapes
 *  - No external CSV dependency
 */

export interface BomRow {
  value?: string
  mpn?: string
  footprint?: string
}

export interface BomParseResult {
  rows: Map<string, BomRow>
  columnGuess: Record<string, string>
  errors: string[]
}

// ── Header alias tables ───────────────────────────────────────────────────────

/** Leading UTF-8 byte-order mark (U+FEFF). */
const BOM_PATTERN = new RegExp('^' + String.fromCharCode(0xfeff))

/** Lowercase; "_", "-", "." and ":" become spaces; "#" becomes " number"; collapse spaces. */
function normalizeHeader(h: string): string {
  return h
    .replace(BOM_PATTERN, '')
    .toLowerCase()
    .replace(/#/g, ' number')
    .replace(/[_\-.:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const REF_ALIASES = new Set([
  'reference', 'references', 'reference designator', 'reference designators',
  'designator', 'designators', 'ref', 'refs', 'refdes', 'ref des',
  'ref designator', 'ref designators', 'part reference', 'part references',
])
const VALUE_ALIASES = new Set(['value', 'val'])
/** JLCPCB / EasyEDA exports put the value in "Comment". Used only when there is no Value column. */
const COMMENT_ALIASES = new Set(['comment'])
const MPN_ALIASES = new Set([
  'mpn',
  'manufacturer part number', 'manufacturer part no', 'manufacturer part', 'manufacturer pn',
  'mfr part number', 'mfr part no', 'mfr part', 'mfr pn', 'mfr number',
  'mfg part number', 'mfg part no', 'mfg part', 'mfg pn',
  'part number', 'part no',
])
const FOOTPRINT_ALIASES = new Set(['footprint', 'package'])

// ── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Parse CSV text into records of fields. Quoted fields may contain the
 * delimiter, newlines, and doubled quotes ("" = one literal quote). Unquoted
 * fields are trimmed; quoted fields are returned as written (callers trim).
 * Line endings must already be normalized to "\n".
 */
function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let fields: string[] = []
  let i = 0
  const n = text.length

  while (i <= n) {
    // ── one field ──
    let j = i
    while (j < n && text[j] === ' ') j++
    if (j < n && text[j] === '"') {
      // Quoted field
      i = j + 1
      let field = ''
      while (i < n) {
        if (text[i] === '"') {
          if (i + 1 < n && text[i + 1] === '"') {
            field += '"'
            i += 2
          } else {
            i++ // closing quote
            break
          }
        } else {
          field += text[i]
          i++
        }
      }
      // Ignore anything between the closing quote and the next delimiter/newline.
      while (i < n && text[i] !== delimiter && text[i] !== '\n') i++
      fields.push(field)
    } else {
      let field = ''
      while (i < n && text[i] !== delimiter && text[i] !== '\n') {
        field += text[i]
        i++
      }
      fields.push(field.trim())
    }

    // ── what ended the field ──
    if (i >= n) {
      records.push(fields)
      break
    }
    if (text[i] === delimiter) {
      i++
      continue
    }
    // newline: end of record
    records.push(fields)
    fields = []
    i++
    if (i >= n) break
  }
  return records
}

/**
 * Detect the most likely delimiter from the header line.
 * Strategy: count occurrences outside quotes, pick the one with the most.
 */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    let count = 0
    let inQuote = false
    for (const ch of headerLine) {
      if (ch === '"') inQuote = !inQuote
      else if (!inQuote && ch === d) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

// ── Ref expansion ─────────────────────────────────────────────────────────────

/** A range may not expand past this many refs (guards "R1-R99999"). */
const MAX_RANGE = 1000

const REF_PATTERN = /^[A-Za-z]+\d+[A-Za-z]?$/
/** R1-R4, R1-4, C10~C12 (hyphen, en dash, tilde). */
const RANGE_PATTERN = /^([A-Za-z]+)(\d+)[-\u2013~]([A-Za-z]*)(\d+)$/

/**
 * Expand a reference cell that may contain multiple refs and ranges.
 * Handles: "R1, R2, R3", "R1 R2 R3", "R1,R2,R3", "R1/R2", "R1-R4", "R1-4".
 * A "ref" must start with a letter and end with digits (e.g. R1, U12, C3).
 * Ranges that cannot be expanded faithfully (descending, mixed prefix, too
 * wide) produce an error and no refs: circsim never invents refs.
 */
function expandRefs(refStr: string): { refs: string[]; errors: string[] } {
  const normalized = refStr.replace(/\s*([-\u2013~])\s*/g, '$1')
  const tokens = normalized.split(/[,;\s/]+/).map(s => s.trim()).filter(Boolean)
  const refs: string[] = []
  const errors: string[] = []
  const others: string[] = []

  for (const token of tokens) {
    const range = RANGE_PATTERN.exec(token)
    if (range) {
      const [, prefix, startDigits, endPrefix, endDigits] = range
      const start = parseInt(startDigits, 10)
      const end = parseInt(endDigits, 10)
      if (endPrefix !== '' && endPrefix.toUpperCase() !== prefix.toUpperCase()) {
        errors.push(`BOM range "${token}" mixes reference prefixes and was skipped`)
      } else if (end < start) {
        errors.push(`BOM range "${token}" runs backwards and was skipped`)
      } else if (end - start + 1 > MAX_RANGE) {
        errors.push(`BOM range "${token}" spans more than ${MAX_RANGE} references and was skipped`)
      } else {
        for (let k = start; k <= end; k++) refs.push(`${prefix}${k}`)
      }
    } else if (REF_PATTERN.test(token)) {
      refs.push(token)
    } else {
      others.push(token)
    }
  }

  if (refs.length > 0 || errors.length > 0) return { refs, errors }
  // Nothing looked like a ref: hand back the original tokens (caller decides).
  return { refs: others.length > 0 ? others : [refStr.trim()], errors }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parseBom(csvText: string): BomParseResult {
  const rows = new Map<string, BomRow>()
  const columnGuess: Record<string, string> = {}
  const errors: string[] = []

  // Normalize line endings and drop a leading byte-order mark.
  const text = csvText.replace(BOM_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Delimiter comes from the first non-blank physical line.
  const firstLine = text.split('\n').find(l => l.trim() !== '')
  if (firstLine === undefined) {
    errors.push('No header row found in BOM')
    return { rows, columnGuess, errors }
  }
  const delimiter = detectDelimiter(firstLine)

  const isBlank = (rec: string[]): boolean => rec.every(f => f.trim() === '')
  const records = parseCsv(text, delimiter).filter(rec => !isBlank(rec))
  if (records.length === 0) {
    errors.push('No header row found in BOM')
    return { rows, columnGuess, errors }
  }

  const headers = records[0]

  // Map header index to field name
  let refColIdx = -1
  let valueColIdx = -1
  let commentColIdx = -1
  let mpnColIdx = -1
  let footprintColIdx = -1
  let commentHeader = ''

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim()
    const key = normalizeHeader(h)
    if (REF_ALIASES.has(key)) {
      if (refColIdx === -1) {
        refColIdx = i
        columnGuess[h] = 'ref'
      }
    } else if (VALUE_ALIASES.has(key)) {
      if (valueColIdx === -1) {
        valueColIdx = i
        columnGuess[h] = 'value'
      }
    } else if (COMMENT_ALIASES.has(key)) {
      if (commentColIdx === -1) {
        commentColIdx = i
        commentHeader = h
      }
    } else if (MPN_ALIASES.has(key)) {
      if (mpnColIdx === -1) {
        mpnColIdx = i
        columnGuess[h] = 'mpn'
      }
    } else if (FOOTPRINT_ALIASES.has(key)) {
      if (footprintColIdx === -1) {
        footprintColIdx = i
        columnGuess[h] = 'footprint'
      }
    }
    // Other columns are not mapped but not errors
  }

  // A Comment column stands in for Value only when there is no Value column.
  if (valueColIdx === -1 && commentColIdx !== -1) {
    valueColIdx = commentColIdx
    columnGuess[commentHeader] = 'value'
  }

  if (refColIdx === -1) {
    errors.push(
      `No ref column found. Expected a header matching: Reference, References, Reference Designator, Designator, Ref, RefDes. ` +
      `Found headers: ${headers.map(h => `"${h}"`).join(', ')}`
    )
    return { rows, columnGuess, errors }
  }

  // Parse data rows
  for (let r = 1; r < records.length; r++) {
    const fields = records[r]
    const rawRef = fields[refColIdx]?.trim() ?? ''
    if (!rawRef) continue

    const value = valueColIdx !== -1 ? (fields[valueColIdx]?.trim() || undefined) : undefined
    const mpn = mpnColIdx !== -1 ? (fields[mpnColIdx]?.trim() || undefined) : undefined
    const footprint = footprintColIdx !== -1 ? (fields[footprintColIdx]?.trim() || undefined) : undefined

    const expanded = expandRefs(rawRef)
    errors.push(...expanded.errors)
    for (const ref of expanded.refs) {
      rows.set(ref, { value, mpn, footprint })
    }
  }

  return { rows, columnGuess, errors }
}

// ── Import report ─────────────────────────────────────────────────────────────

/**
 * Plain-language notes about a finished BOM import, for the sim log: every
 * parser error, an empty result, a BOM that cannot influence identification
 * (no MPN or Value column), and the count of rows whose ref is not on the board.
 * Returns [] when the import is clean.
 */
export function describeBomImport(parsed: BomParseResult, boardRefs: Iterable<string>): string[] {
  const notes: string[] = parsed.errors.map(e => `BOM: ${e}`)

  if (parsed.errors.length === 0 && parsed.rows.size === 0) {
    notes.push('BOM: no rows with a reference were found, so it changes nothing')
    return notes
  }
  if (parsed.rows.size === 0) return notes

  const fields = new Set(Object.values(parsed.columnGuess))
  if (!fields.has('mpn') && !fields.has('value')) {
    notes.push('BOM: no MPN, Value or Comment column was recognized, so it cannot change how parts are identified')
  }

  const onBoard = new Set<string>()
  for (const ref of boardRefs) onBoard.add(ref.toUpperCase())
  const unmatched = [...parsed.rows.keys()].filter(ref => !onBoard.has(ref.toUpperCase()))
  if (unmatched.length > 0) {
    const shown = unmatched.slice(0, 8).join(', ')
    const more = unmatched.length > 8 ? `, and ${unmatched.length - 8} more` : ''
    notes.push(
      `BOM: ${unmatched.length} of ${parsed.rows.size} rows name refs that are not on the board (${shown}${more})`,
    )
  }
  return notes
}
