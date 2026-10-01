/**
 * core/spicegen/sanitize.ts
 *
 * The deck gate (issue #35). A SPICE deck handed to ngspice is code, not data:
 * ngspice collects `.control` / `.endc` cards from anywhere in a deck loaded
 * through the shared library (including inside a `.subckt` definition) and runs
 * them right after load, and the control language has `shell`, `write`,
 * `source`, `load` and friends. A user model pasted from a forum or an LLM is
 * therefore executable code with the user's privileges once it is bound to a
 * part and inlined into the deck.
 *
 * `sanitizeDeck` is the single pure check every deck must pass before it reaches
 * ngspice (SimHost applies it on every load). It is DEFAULT-DENY on dot cards:
 * only dot cards on SAFE_DOT_CARDS pass, so control-block cards, file includes
 * (`.include`, `.inc`, `.lib`), `.source`, `.csparam` and anything ngspice adds
 * later are refused without being enumerated. ngspice matches many card
 * keywords by PREFIX (`.incfoo` still includes), so the card name must match a
 * safe name exactly.
 *
 * What is refused, per card (one array entry is one card):
 *   - embedded-newline : a card containing a line break; ngspice splits it into
 *                        several cards, so one "card" could smuggle a `.control`.
 *   - control-card     : `.control`, `.endc`, `.exec`, `*#` and `*ng_script`
 *                        comments (ngspice runs these as commands / scripts).
 *   - file-include     : `.include`, `.inc`, `.lib`, `.source`, `.csparam`
 *                        (host file access or vector/shell-adjacent evaluation).
 *   - file-reference   : `input_file` / `state_file` model parameters (XSPICE
 *                        code models that read an arbitrary host path).
 *   - unknown-card     : any other dot card not on the safe list.
 *
 * Plain comments (`* ...`), continuation cards (`+ ...`), blank cards and element
 * cards pass. Cards are trimmed with JS `trim()` (a superset of the whitespace
 * ngspice skips) so a BOM or NBSP prefix cannot hide a keyword.
 *
 * Pure TypeScript, no Node / Electron / React imports (core stays portable).
 */

/** Dot cards a circsim deck or an imported model may legitimately contain. */
export const SAFE_DOT_CARDS: ReadonlySet<string> = new Set([
  // structure
  'subckt', 'ends', 'end', 'model', 'param', 'func', 'global', 'title',
  // conditional blocks
  'if', 'elseif', 'else', 'endif',
  // analyses and their settings
  'op', 'tran', 'ac', 'dc', 'noise', 'tf', 'sens', 'pz', 'disto', 'four',
  'temp', 'ic', 'nodeset', 'options', 'option', 'width',
  // output selection and measurement (no file output in a batch deck)
  'save', 'savecurrents', 'probe', 'print', 'plot', 'measure', 'meas'
])

export type DeckRule =
  | 'embedded-newline'
  | 'control-card'
  | 'file-include'
  | 'file-reference'
  | 'unknown-card'

export interface DeckViolation {
  /** 1-based index of the offending card in the array. */
  line: number
  rule: DeckRule
  /** The offending card, truncated for display. */
  card: string
  /** Human-readable reason, suitable for a Model Doctor error. */
  reason: string
}

export interface SanitizeResult {
  ok: boolean
  violations: DeckViolation[]
}

const CARD_DISPLAY_MAX = 80

const CONTROL_CARDS = new Set(['control', 'endc', 'exec'])
const INCLUDE_CARDS = new Set(['include', 'inc', 'lib', 'source', 'csparam'])

function show(card: string): string {
  const one = Array.from(card, (ch) => (ch.charCodeAt(0) < 0x20 || ch === '\x7f' ? ' ' : ch))
    .join('')
    .trim()
  return one.length > CARD_DISPLAY_MAX ? `${one.slice(0, CARD_DISPLAY_MAX)}...` : one
}

function check(card: string, index: number): DeckViolation | null {
  const line = index + 1
  const fail = (rule: DeckRule, reason: string): DeckViolation => ({
    line,
    rule,
    card: show(card),
    reason
  })

  const text = card.trim()
  if (/[\n\r\0]/.test(text)) {
    return fail(
      'embedded-newline',
      'card contains a line break or NUL byte; ngspice would split it into separate cards'
    )
  }
  if (text === '') return null

  const lower = text.toLowerCase()

  if (lower.startsWith('*')) {
    if (lower.startsWith('*#') || lower.startsWith('*ng_script')) {
      return fail('control-card', 'this comment form is executed by ngspice as a command script')
    }
    return null
  }

  if (lower.startsWith('.')) {
    const m = /^\.([a-z0-9_]*)/.exec(lower)
    const name = m ? m[1] : ''
    const after = lower.charAt(name.length + 1)
    if (CONTROL_CARDS.has(name)) {
      return fail(
        'control-card',
        `.${name} runs ngspice control commands (shell, write, source, load) on load`
      )
    }
    if (INCLUDE_CARDS.has(name)) {
      return fail(
        'file-include',
        `.${name} reads host files or evaluates commands; models must be inlined, never included`
      )
    }
    const nameEnds = after === '' || /[\s;$]/.test(after)
    if (!name || !nameEnds || !SAFE_DOT_CARDS.has(name)) {
      return fail('unknown-card', `.${name} is not an allowed deck card`)
    }
  }

  if (/\b(input_file|state_file)\b/.test(lower)) {
    return fail('file-reference', 'the card names a host file to read (input_file / state_file)')
  }
  return null
}

/** Check every card of a deck. Never throws; the caller decides what a failure means. */
export function sanitizeDeck(lines: readonly string[]): SanitizeResult {
  const violations: DeckViolation[] = []
  lines.forEach((card, i) => {
    const v = check(typeof card === 'string' ? card : String(card), i)
    if (v) violations.push(v)
  })
  return { ok: violations.length === 0, violations }
}

/** One readable message for a failed sanitize result (Model Doctor / log text). */
export function formatDeckViolations(violations: readonly DeckViolation[]): string {
  const shown = violations.slice(0, 3).map((v) => `card ${v.line} "${v.card}": ${v.reason}`)
  const more = violations.length > 3 ? `; and ${violations.length - 3} more` : ''
  return `deck rejected, it is not safe to load (${shown.join('; ')}${more}). Imported model files are treated as code and may not contain control blocks or file includes.`
}

/** Thrown by {@link assertSafeDeck}; carries the structured violations. */
export class DeckRejectedError extends Error {
  readonly violations: DeckViolation[]
  constructor(violations: DeckViolation[]) {
    super(formatDeckViolations(violations))
    this.name = 'DeckRejectedError'
    this.violations = violations
  }
}

/** Throw a {@link DeckRejectedError} unless the deck passes {@link sanitizeDeck}. */
export function assertSafeDeck(lines: readonly string[]): void {
  const result = sanitizeDeck(lines)
  if (!result.ok) throw new DeckRejectedError(result.violations)
}
