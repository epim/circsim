/**
 * core/sexpr/parse.ts
 *
 * S-expression parser for KiCad .kicad_pcb / .kicad_sch files.
 * Produces: type SExpr = string | number | SExpr[]
 *
 * Design rules (see spec §8.1):
 * - Handles quoted strings with backslash escapes (\", \\, \n, \t, \r)
 * - Bare tokens that parse as a valid JS number become numbers; otherwise strings
 * - Tolerant of unknown tokens: never throws on unrecognised atoms
 * - Throws SexprError { line, col, message } on structural errors (unbalanced parens)
 *
 * Allocation (issue #60): one pass over the text with an index cursor. There is
 * no token array and no per-character string building, so the only allocations
 * are the tree itself, and `skipHeads` lets a caller avoid building subtrees it
 * never reads.
 */

// --- public types ------------------------------------------------------------

export type SExpr = string | number | SExpr[]

/** Thrown when the file is structurally malformed (unbalanced parens, etc.). */
export class SexprError extends Error {
  constructor(
    public readonly message: string,
    public readonly line: number,
    public readonly col: number
  ) {
    super(message)
    this.name = 'SexprError'
  }
}

export interface ParseOptions {
  /**
   * Heads of lists to skip. A list whose first element is a bare atom equal to
   * one of these is not built: it comes back as a one-element list
   * holding only its head, in its original position, so `findAll(parent, head)`
   * still counts it. The skipped text is still scanned for balanced parens and
   * quotes, so a malformed file throws the same SexprError either way.
   *
   * Use it for subtrees the caller never reads, such as a zone's
   * `filled_polygon` point lists, which dominate pour-heavy boards.
   */
  skipHeads?: readonly string[]
}

// --- scanner constants -------------------------------------------------------

const TAB = 9
const LF = 10
const CR = 13
const SPACE = 32
const DQUOTE = 34
const LPAREN = 40
const RPAREN = 41
const SEMI = 59
const BSLASH = 92

/** Cap on distinct list heads kept for sharing, so hostile input cannot grow the table. */
const MAX_SHARED_HEADS = 1024

const NUMERIC =/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** Convert a bare atom to a number if it is a valid JS number, else keep it as string. */
function maybeNumber(raw: string): string | number {
  // A number starts with a digit, a sign or a dot. Anything else (F.Cu, smd,
  // Infinity, NaN) is a string, so skip Number() and the regex for it.
  const first = raw.charCodeAt(0)
  if (!((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46)) return raw
  const n = Number(raw)
  // The regex rejects what Number() is lenient about ("", "0x1", "Infinity").
  if (!Number.isNaN(n) && NUMERIC.test(raw)) return n
  return raw
}

// --- parser ------------------------------------------------------------------

/**
 * Parse a KiCad S-expression file.
 * Throws `SexprError` with `{ line, col, message }` on structural errors.
 */
export function parseSexpr(text: string, options?: ParseOptions): SExpr {
  const skip =
    options?.skipHeads !== undefined && options.skipHeads.length > 0 ? new Set(options.skipHeads) : null
  const n = text.length
  let pos = 0
  let line = 1
  let lineStart = 0

  /** Advance over whitespace and ';' line comments. */
  function skipTrivia(): void {
    while (pos < n) {
      const c = text.charCodeAt(pos)
      if (c === SPACE || c === TAB || c === CR) {
        pos++
      } else if (c === LF) {
        pos++
        line++
        lineStart = pos
      } else if (c === SEMI) {
        while (pos < n && text.charCodeAt(pos) !== LF) pos++
      } else {
        return
      }
    }
  }

  /** Read a bare token: everything up to whitespace, a paren, or a quote. */
  function readBare(): string {
    const start = pos
    while (pos < n) {
      const c = text.charCodeAt(pos)
      if (c === LPAREN || c === RPAREN || c === DQUOTE || c === SPACE || c === TAB || c === LF || c === CR) break
      pos++
    }
    return text.slice(start, pos)
  }

  /** Read a quoted string; `pos` is on the opening quote. Handles escapes and raw newlines. */
  function readQuoted(): string {
    pos++ // opening quote
    let start = pos
    let out: string | null = null // only built once an escape is seen
    while (pos < n) {
      const c = text.charCodeAt(pos)
      if (c === DQUOTE) {
        const v = out === null ? text.slice(start, pos) : out + text.slice(start, pos)
        pos++
        return v
      }
      if (c === BSLASH) {
        out = (out === null ? '' : out) + text.slice(start, pos)
        pos++
        if (pos >= n) return out // dangling backslash at end of input
        const esc = text.charCodeAt(pos)
        switch (esc) {
          case 110: out += '\n'; break // \n
          case 114: out += '\r'; break // \r
          case 116: out += '\t'; break // \t
          default: out += text[pos]; break // \" \\ and unknown escapes pass through
        }
        pos++
        if (esc === LF) {
          line++
          lineStart = pos
        }
        start = pos
        continue
      }
      if (c === LF) {
        line++
        lineStart = pos + 1
      }
      pos++
    }
    // Unterminated string: keep what was read.
    return out === null ? text.slice(start, pos) : out + text.slice(start, pos)
  }

  /**
   * Scan to the ')' that closes a list whose head has just been read, building
   * nothing. Returns false if the input ends first.
   */
  function skipRest(): boolean {
    let depth = 1
    while (pos < n) {
      const c = text.charCodeAt(pos)
      if (c === RPAREN) {
        pos++
        if (--depth === 0) return true
      } else if (c === LPAREN) {
        pos++
        depth++
      } else if (c === DQUOTE) {
        pos++
        while (pos < n) {
          const q = text.charCodeAt(pos)
          if (q === DQUOTE) {
            pos++
            break
          }
          if (q === BSLASH) {
            pos++
            if (pos < n && text.charCodeAt(pos) === LF) {
              line++
              lineStart = pos + 1
            }
            pos++
            continue
          }
          if (q === LF) {
            line++
            lineStart = pos + 1
          }
          pos++
        }
      } else if (c === LF) {
        pos++
        line++
        lineStart = pos
      } else if (c === SEMI) {
        // A comment only starts at a token boundary; inside a bare token ';' is text.
        const prev = text.charCodeAt(pos - 1)
        if (
          prev === SPACE || prev === TAB || prev === LF || prev === CR ||
          prev === LPAREN || prev === RPAREN || prev === DQUOTE
        ) {
          while (pos < n && text.charCodeAt(pos) !== LF) pos++
        } else {
          pos++
        }
      } else {
        pos++
      }
    }
    return false
  }

  /**
   * The skipped region ran off the end of the input. The innermost unclosed '('
   * is somewhere inside it, so let a full parse find and report it.
   */
  function failInsideSkip(): never {
    parseSexpr(text)
    throw new SexprError('Unexpected end of input', line, pos - lineStart + 1)
  }

  // Children of every open list accumulate here and are copied out at the
  // closing paren. Pushing straight into a fresh array per list would leave each
  // one with the spare capacity V8 gives a grown array (17 slots), which for a
  // segment's seven small lists is most of the retained tree.
  const stack: SExpr[] = []
  const heads = new Map<string, string>()

  function parseList(): SExpr[] {
    const openLine = line
    const openCol = pos - lineStart + 1
    const base = stack.length
    pos++ // '('

    for (;;) {
      skipTrivia()
      if (pos >= n) {
        throw new SexprError(
          `Unexpected end of input - unclosed '(' at line ${openLine}, col ${openCol}`,
          openLine,
          openCol
        )
      }
      const c = text.charCodeAt(pos)
      if (c === RPAREN) {
        pos++
        const items = stack.slice(base)
        stack.length = base
        return items
      }
      if (stack.length === base && c !== LPAREN && c !== DQUOTE) {
        // List head: a small vocabulary repeated for every node, so share one
        // string per distinct head instead of keeping a copy per list.
        let head = readBare()
        const shared = heads.get(head)
        if (shared !== undefined) head = shared
        else if (heads.size < MAX_SHARED_HEADS) heads.set(head, head)
        if (skip !== null && skip.has(head)) {
          if (!skipRest()) failInsideSkip()
          return [head]
        }
        stack.push(maybeNumber(head))
        continue
      }
      stack.push(parseExpr())
    }
  }

  function parseExpr(): SExpr {
    skipTrivia()
    if (pos >= n) throw new SexprError('Unexpected end of input', line, pos - lineStart + 1)
    const c = text.charCodeAt(pos)
    if (c === LPAREN) return parseList()
    if (c === RPAREN) {
      const col = pos - lineStart + 1
      throw new SexprError(`Unexpected ')' at line ${line}, col ${col}`, line, col)
    }
    if (c === DQUOTE) return readQuoted()
    return maybeNumber(readBare())
  }

  const result = parseExpr()

  // Keep scanning the trailing content so structural errors surface. Extra
  // top-level atoms and lists after the root are tolerated for future
  // compatibility and discarded; a stray ')' still throws.
  for (;;) {
    skipTrivia()
    if (pos >= n) break
    parseExpr()
  }

  return result
}

// --- tree helpers ------------------------------------------------------------

/**
 * Return the immediate child lists of `node` whose first element equals `head`.
 * Does NOT recurse into grandchildren.
 * Returns [] if node is not a list.
 */
export function findAll(node: SExpr, head: string): SExpr[] {
  if (!Array.isArray(node)) return []
  const results: SExpr[] = []
  for (const child of node) {
    if (Array.isArray(child) && child.length > 0 && child[0] === head) {
      results.push(child)
    }
  }
  return results
}

/**
 * Return the first immediate child list of `node` whose first element equals `head`,
 * or `undefined` if none exists.
 * Does NOT recurse into grandchildren.
 */
export function find(node: SExpr, head: string): SExpr | undefined {
  if (!Array.isArray(node)) return undefined
  for (const child of node) {
    if (Array.isArray(child) && child.length > 0 && child[0] === head) {
      return child
    }
  }
  return undefined
}

/**
 * Return the element at `index` in `node` if it is a string or number (an "atom"),
 * or `undefined` if out of bounds, if node is not a list, or if the element is itself a list.
 */
export function atom(node: SExpr, index: number): string | number | undefined {
  if (!Array.isArray(node)) return undefined
  const el = node[index]
  if (el === undefined) return undefined
  if (Array.isArray(el)) return undefined
  return el as string | number
}
