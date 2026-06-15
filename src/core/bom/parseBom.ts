/**
 * parseBom — tolerant BOM CSV importer.
 *
 * Features:
 *  - Delimiter autodetect: comma, semicolon, tab
 *  - Header aliasing: Reference|Designator|Ref → ref;
 *                     Value → value;
 *                     Footprint → footprint;
 *                     MPN|Manufacturer Part Number|Part Number → mpn
 *  - Grouped-ref expansion: "R1, R2, R3" or "R1 R2 R3" in one row → individual entries
 *  - Quoted fields with embedded delimiters and doubled-quote escapes
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

const REF_ALIASES = /^(reference|designator|ref|refdes)$/i
const VALUE_ALIASES = /^(value|val)$/i
const MPN_ALIASES = /^(mpn|manufacturer part number|part number|mfr part number|mfr# ?|mfg part number)$/i
const FOOTPRINT_ALIASES = /^(footprint|package)$/i

// ── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Parse a single CSV row respecting quoted fields with the given delimiter.
 * Handles doubled-quote escapes ("" inside a quoted field = one literal quote).
 */
function parseCsvRow(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) {
      // Trailing empty field or end of last field
      fields.push('')
      break
    }
    if (line[i] === '"') {
      // Quoted field
      i++ // skip opening quote
      let field = ''
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            // Escaped quote
            field += '"'
            i += 2
          } else {
            // Closing quote
            i++
            break
          }
        } else {
          field += line[i]
          i++
        }
      }
      fields.push(field)
      // Skip delimiter after closing quote
      if (i < line.length && line[i] === delimiter) i++
    } else {
      // Unquoted field — read until delimiter
      let field = ''
      while (i < line.length && line[i] !== delimiter) {
        field += line[i]
        i++
      }
      fields.push(field.trim())
      if (i < line.length) i++ // skip delimiter
    }
  }
  return fields
}

/**
 * Detect the most likely delimiter from the header line.
 * Strategy: count occurrences, pick the one with the most.
 */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t']
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    // Count occurrences outside quotes (simplified: just count all)
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

/**
 * Expand a reference string that may contain multiple refs.
 * Handles: "R1, R2, R3", "R1 R2 R3", "R1,R2,R3", "R1/R2" etc.
 * A "ref" must start with a letter and end with digits (e.g. R1, U12, C3).
 */
function expandRefs(refStr: string): string[] {
  // Split on common separators: comma, semicolon, slash, space
  const parts = refStr.split(/[,;\s/]+/).map(s => s.trim()).filter(Boolean)
  // Filter to things that look like refs (letter(s) + digits)
  const refPattern = /^[A-Za-z]+\d+[A-Za-z]?$/
  const refs = parts.filter(p => refPattern.test(p))
  if (refs.length > 0) return refs
  // If nothing matched the pattern, return original (caller may decide)
  return parts.length > 0 ? parts : [refStr.trim()]
}

// ── Main export ───────────────────────────────────────────────────────────────

export function parseBom(csvText: string): BomParseResult {
  const rows = new Map<string, BomRow>()
  const columnGuess: Record<string, string> = {}
  const errors: string[] = []

  // Normalize line endings
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // Find header line (first non-blank)
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { headerIdx = i; break }
  }
  if (headerIdx === -1) {
    errors.push('No header row found in BOM')
    return { rows, columnGuess, errors }
  }

  const headerLine = lines[headerIdx]
  const delimiter = detectDelimiter(headerLine)
  const headers = parseCsvRow(headerLine, delimiter)

  // Map header index to field name
  let refColIdx = -1
  let valueColIdx = -1
  let mpnColIdx = -1
  let footprintColIdx = -1

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim()
    if (REF_ALIASES.test(h)) {
      refColIdx = i
      columnGuess[h] = 'ref'
    } else if (VALUE_ALIASES.test(h)) {
      valueColIdx = i
      columnGuess[h] = 'value'
    } else if (MPN_ALIASES.test(h)) {
      mpnColIdx = i
      columnGuess[h] = 'mpn'
    } else if (FOOTPRINT_ALIASES.test(h)) {
      footprintColIdx = i
      columnGuess[h] = 'footprint'
    }
    // Other columns are not mapped but not errors
  }

  if (refColIdx === -1) {
    errors.push(
      `No ref column found. Expected a header matching: Reference, Designator, Ref, RefDes. ` +
      `Found headers: ${headers.map(h => `"${h}"`).join(', ')}`
    )
    return { rows, columnGuess, errors }
  }

  // Parse data rows
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue // skip blank lines

    const fields = parseCsvRow(line, delimiter)
    if (fields.length === 0) continue

    const rawRef = fields[refColIdx]?.trim() ?? ''
    if (!rawRef) continue

    const value = valueColIdx !== -1 ? (fields[valueColIdx]?.trim() || undefined) : undefined
    const mpn = mpnColIdx !== -1 ? (fields[mpnColIdx]?.trim() || undefined) : undefined
    const footprint = footprintColIdx !== -1 ? (fields[footprintColIdx]?.trim() || undefined) : undefined

    const refs = expandRefs(rawRef)
    for (const ref of refs) {
      rows.set(ref, { value, mpn, footprint })
    }
  }

  return { rows, columnGuess, errors }
}
