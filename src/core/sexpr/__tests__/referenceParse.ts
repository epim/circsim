/**
 * Reference S-expression parser: the pre-#60 implementation, kept verbatim in
 * behavior (tokenise into an array, then build the tree) as the oracle for the
 * differential tests and as the "before" side of the allocation comparison.
 * Not used by production code.
 */

import { SexprError, type SExpr } from '../parse'

// --- tokeniser
const enum TKind {
  LParen = 0,
  RParen = 1,
  Atom   = 2, // bare token (number or string)
  Str    = 3, // quoted string (already unescaped)
  EOF    = 4,
}

interface Token {
  kind: TKind
  value: string
  line: number
  col: number
}

/** Convert a string atom to a number if it is a valid JS number, else keep it as string. */
function maybeNumber(raw: string): string | number {
  // Fast-path: reject tokens that definitely can't be numbers
  // A number must match [+-]?\d*\.?\d+([eE][+-]?\d+)?  - no letters other than e/E
  // We use Number() which is lenient but correctly rejects "1.0.5", "F.Cu", "smd" etc.
  if (raw === '' || raw === '.' || raw === '-' || raw === '+') return raw
  const n = Number(raw)
  // Number('') === 0 (false positive), Number('   ') === 0 (false positive)
  // All bare tokens we receive are trimmed and non-empty from the tokeniser, so
  // only check isNaN and that the string actually looks numeric.
  if (!Number.isNaN(n) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    return n
  }
  return raw
}

/**
 * Tokenise the entire input into a flat array of tokens.
 * We collect all tokens up front rather than streaming; this is fast enough for
 * KiCad files (tens of MB) and keeps the recursive descent simple.
 */
function tokenise(text: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  let line = 1
  let lineStart = 0

  const col = (): number => pos - lineStart + 1

  while (pos < text.length) {
    const ch = text[pos]

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pos++
      continue
    }
    if (ch === '\n') {
      line++
      lineStart = pos + 1
      pos++
      continue
    }

    // Line comment (KiCad sometimes has semicolon comments)
    if (ch === ';') {
      while (pos < text.length && text[pos] !== '\n') pos++
      continue
    }

    // Left paren
    if (ch === '(') {
      tokens.push({ kind: TKind.LParen, value: '(', line, col: col() })
      pos++
      continue
    }

    // Right paren
    if (ch === ')') {
      tokens.push({ kind: TKind.RParen, value: ')', line, col: col() })
      pos++
      continue
    }

    // Quoted string
    if (ch === '"') {
      const startLine = line
      const startCol = col()
      pos++ // skip opening quote
      let buf = ''
      while (pos < text.length) {
        const c = text[pos]
        if (c === '"') {
          pos++ // skip closing quote
          break
        }
        if (c === '\\') {
          pos++
          const esc = text[pos]
          if (esc === undefined) break
          switch (esc) {
            case '"':  buf += '"';  break
            case '\\': buf += '\\'; break
            case 'n':  buf += '\n'; break
            case 'r':  buf += '\r'; break
            case 't':  buf += '\t'; break
            default:   buf += esc;  break  // pass unknown escapes through
          }
          pos++
          if (esc === '\n') {
            line++
            lineStart = pos
          }
          continue
        }
        if (c === '\n') {
          buf += c
          line++
          lineStart = pos + 1
        } else {
          buf += c
        }
        pos++
      }
      tokens.push({ kind: TKind.Str, value: buf, line: startLine, col: startCol })
      continue
    }

    // Bare token (atom): everything up to whitespace, (, ), or "
    {
      const startLine = line
      const startCol = col()
      let buf = ''
      while (pos < text.length) {
        const c = text[pos]
        if (c === '(' || c === ')' || c === '"' || c === ' ' || c === '\t' || c === '\n' || c === '\r') break
        buf += c
        pos++
      }
      if (buf.length > 0) {
        tokens.push({ kind: TKind.Atom, value: buf, line: startLine, col: startCol })
      }
    }
  }

  tokens.push({ kind: TKind.EOF, value: '', line, col: col() })
  return tokens
}

// --- recursive descent parser
function parseTokens(tokens: Token[]): SExpr {
  let idx = 0

  function peek(): Token {
    return tokens[idx]
  }

  function consume(): Token {
    const t = tokens[idx]
    idx++
    return t
  }

  function parseList(): SExpr[] {
    const open = consume() // LParen - already verified by caller
    const items: SExpr[] = []

    for (;;) {
      const t = peek()
      if (t.kind === TKind.EOF) {
        throw new SexprError(
          `Unexpected end of input - unclosed '(' at line ${open.line}, col ${open.col}`,
          open.line,
          open.col
        )
      }
      if (t.kind === TKind.RParen) {
        consume() // closing paren
        return items
      }
      items.push(parseExpr())
    }
  }

  function parseExpr(): SExpr {
    const t = peek()
    if (t.kind === TKind.LParen) {
      return parseList()
    }
    if (t.kind === TKind.Str) {
      consume()
      return t.value
    }
    if (t.kind === TKind.Atom) {
      consume()
      return maybeNumber(t.value)
    }
    if (t.kind === TKind.RParen) {
      throw new SexprError(
        `Unexpected ')' at line ${t.line}, col ${t.col}`,
        t.line,
        t.col
      )
    }
    // EOF
    throw new SexprError(`Unexpected end of input`, t.line, t.col)
  }

  const result = parseExpr()

  // Continue scanning remaining tokens to catch structural errors (e.g. unclosed
  // parens in trailing content). Unknown extra atoms/lists after the root are
  // tolerated for future-compat, but mis-matched parens must still throw.
  while (peek().kind !== TKind.EOF) {
    const t = peek()
    if (t.kind === TKind.RParen) {
      throw new SexprError(
        `Unexpected ')' at line ${t.line}, col ${t.col}`,
        t.line,
        t.col
      )
    }
    // Parse and discard any additional top-level expressions; this lets structural
    // errors (unclosed parens) inside them surface correctly.
    parseExpr()
  }

  return result
}

// --- public API

export function parseSexprReference(text: string): SExpr {
  const tokens = tokenise(text)
  return parseTokens(tokens)
}
