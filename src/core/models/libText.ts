/**
 * core/models/libText.ts
 *
 * Pure text handling for a user's vendor `.lib` / `.sub` file (Tier 4 import,
 * issue #17). Nothing here touches the filesystem, so the renderer can use it.
 *
 * `bundleSubckt` is what Import .lib binds to a part: the chosen `.subckt` block,
 * every subckt it transitively instantiates, and the top-level `.model`,
 * `.param` and `.func` cards those blocks use (hoisted inside each block, because
 * the deck generator inlines `.subckt` blocks only and never reads files by path).
 * Comment lines are dropped, continuation lines are joined, and the result is
 * checked against the same gates it must pass later: the deck gate
 * (`sanitizeDeck`, run by SimHost on every load) and the sidecar model-text check
 * (so what is bound now is still there after a reopen). A file that cannot pass is
 * refused here, with the reason, instead of failing at load time.
 */

import { sanitizeDeck, formatDeckViolations } from '../spicegen/sanitize'

/** One `.subckt ... .ends` block of a lib text. */
export interface LibSubckt {
  /** Name as written in the file. */
  name: string
  /** Everything after the name on the header line: terminals plus any `params:` tail. */
  header: string
  /** The block, one entry per logical line (continuations joined, comments dropped). */
  lines: string[]
  /** True when the block declares another `.subckt` inside itself (not importable). */
  nested: boolean
  /** True when the block never reached its `.ends`. */
  unterminated: boolean
}

export interface ParsedLib {
  subckts: LibSubckt[]
  /** Logical lines outside any subckt, comments dropped. */
  topLevel: string[]
}

/** Names allowed for a bound subckt (the sidecar refuses any other). */
export const SUBCKT_NAME_RE = /^[A-Za-z0-9_.$-]{1,128}$/

/** Per-model text cap. */
export const MAX_MODEL_TEXT = 1024 * 1024

/**
 * Directives a model's text may contain when it is saved to or loaded from a
 * sidecar. `.control` / `.endc` blocks can run shell commands inside ngspice and
 * `.include` / `.lib` read arbitrary files, so anything outside this list is
 * refused.
 */
const ALLOWED_MODEL_DIRECTIVES = new Set([
  'subckt', 'ends', 'model', 'param', 'func', 'global',
  'options', 'option', 'temp', 'ic', 'nodeset', 'end',
])

const LINE_BREAK = /\r\n|\r|\n/

/** null when the model text is acceptable; otherwise the reason it is not. */
export function unsafeModelTextReason(text: string): string | null {
  if (text.length > MAX_MODEL_TEXT) return 'the model text is larger than 1 MB'
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim()
    if (!line.startsWith('.')) continue
    const directive = line.slice(1).split(/[\s(]/, 1)[0].toLowerCase()
    if (!ALLOWED_MODEL_DIRECTIVES.has(directive)) return `it uses the .${directive} directive`
  }
  return null
}

/** Split into logical lines: line endings normalised, continuations joined, comments and blanks dropped. */
function logicalLines(text: string): string[] {
  const out: string[] = []
  const raw = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(LINE_BREAK)
  for (const r of raw) {
    const t = r.trim()
    if (t === '') continue
    if (t.startsWith('*')) continue
    if (t.startsWith('+') && out.length > 0) {
      out[out.length - 1] += ' ' + t.slice(1).trim()
    } else {
      out.push(t)
    }
  }
  return out
}

/** Parse a lib text into its subckt blocks and the cards outside them. */
export function parseLib(text: string): ParsedLib {
  const subckts: LibSubckt[] = []
  const topLevel: string[] = []
  let current: LibSubckt | null = null
  let depth = 0
  for (const line of logicalLines(text)) {
    const start = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line)
    if (start) {
      if (current) {
        depth++
        current.nested = true
        current.lines.push(line)
      } else {
        depth = 1
        current = { name: start[1], header: start[2], lines: [line], nested: false, unterminated: true }
      }
      continue
    }
    if (!current) {
      topLevel.push(line)
      continue
    }
    current.lines.push(line)
    if (/^\.ends\b/i.test(line)) {
      depth--
      if (depth === 0) {
        current.unterminated = false
        subckts.push(current)
        current = null
      }
    }
  }
  if (current) subckts.push(current)
  return { subckts, topLevel }
}

/** Every `.subckt` name a lib text defines, in file order (case preserved). */
export function subcktNamesInText(text: string): string[] {
  return parseLib(text).subckts.map((s) => s.name)
}

/** True when `text` defines `.subckt <name>` (case-insensitive). */
export function definesSubckt(text: string, name: string): boolean {
  const want = name.toLowerCase()
  return subcktNamesInText(text).some((n) => n.toLowerCase() === want)
}

/**
 * The positional terminal names of `.subckt <name> ...` (the tokens before any
 * `params:` tail), or null when the text does not define it.
 */
export function subcktTerminals(text: string, name: string): string[] | null {
  const want = name.toLowerCase()
  const def = parseLib(text).subckts.find((s) => s.name.toLowerCase() === want)
  if (!def) return null
  const p = def.header.search(/\bparams:/i)
  const part = p >= 0 ? def.header.slice(0, p) : def.header
  return part.trim().split(/\s+/).filter(Boolean)
}

/**
 * A name token. Unlike a .param or .func name, a .model name may start with a
 * digit (1N4148, 2N3904, 2N7002 are the usual vendor spellings of discretes), so
 * the leading character class includes digits. Numbers match too (1k, 3); that
 * only over-collects names, which is harmless because a card is hoisted only when
 * it defines one of the collected names.
 */
const IDENT = /[A-Za-z0-9_][A-Za-z0-9_.$]*/g

/** Whitespace/punctuation-delimited tokens, which keep a hyphen (a .model named BAT54-7). */
const DELIMITED = /[^\s(),={}*/+^<>!&|?:;~]+/g

function identsOf(lines: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const line of lines) {
    for (const m of line.matchAll(IDENT)) set.add(m[0].toLowerCase())
    for (const m of line.matchAll(DELIMITED)) set.add(m[0].toLowerCase())
  }
  return set
}

/** The name a `.model` card declares: up to whitespace or the opening parenthesis of its parameters. */
function modelNameOf(rest: string): string | null {
  const m = /^([^\s(]+)/.exec(rest)
  return m ? m[1] : null
}

/** A hoistable top-level card and the names it defines. */
interface TopCard {
  line: string
  defines: string[]
}

function topCards(topLevel: readonly string[]): { cards: TopCard[]; ignored: string[] } {
  const cards: TopCard[] = []
  const ignored: string[] = []
  for (const line of topLevel) {
    const m = /^\.([a-z0-9_]+)\s*(.*)$/i.exec(line)
    if (!m) continue // element cards outside a subckt are not part of any model
    const dir = m[1].toLowerCase()
    const rest = m[2]
    if (dir === 'model') {
      const name = modelNameOf(rest)
      if (name) cards.push({ line, defines: [name.toLowerCase()] })
    } else if (dir === 'func') {
      const name = /^([A-Za-z_][A-Za-z0-9_.$]*)\s*\(/.exec(rest)
      if (name) cards.push({ line, defines: [name[1].toLowerCase()] })
    } else if (dir === 'param') {
      const names = [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_.$]*)\s*=/g)].map((x) => x[1].toLowerCase())
      cards.push({ line, defines: names })
    } else if (dir !== 'ends' && dir !== 'end' && dir !== 'title') {
      ignored.push(`.${dir}`)
    }
  }
  return { cards, ignored }
}

/** Top-level cards a subckt block needs, in file order, closed over their own references. */
function neededTopCards(def: LibSubckt, cards: readonly TopCard[]): string[] {
  const own = new Set<string>()
  for (const line of def.lines) {
    const m = /^\.model\s+(.*)$/i.exec(line)
    const name = m ? modelNameOf(m[1]) : null
    if (name) own.add(name.toLowerCase())
  }
  // Header params are instance-overridable: a top-level .param of the same name must not shadow them.
  const headerParams = new Set<string>()
  const p = def.header.search(/\bparams:/i)
  if (p >= 0) {
    for (const m of def.header.slice(p).matchAll(/([A-Za-z_][A-Za-z0-9_.$]*)\s*=/g)) headerParams.add(m[1].toLowerCase())
  }
  const used = identsOf(def.lines)
  const picked = new Set<TopCard>()
  let grew = true
  while (grew) {
    grew = false
    for (const card of cards) {
      if (picked.has(card)) continue
      const names = card.defines.filter((n) => !own.has(n) && !headerParams.has(n))
      if (names.length === 0 || !names.some((n) => used.has(n))) continue
      picked.add(card)
      grew = true
      for (const id of identsOf([card.line])) used.add(id)
    }
  }
  return cards.filter((c) => picked.has(c)).map((c) => c.line)
}

/** Names of the lib's own subckts that an `x` card in `lines` instantiates. */
function subcktRefs(lines: readonly string[], known: ReadonlyMap<string, LibSubckt>): string[] {
  const refs: string[] = []
  for (const line of lines) {
    if (!/^x/i.test(line)) continue
    const toks = line.split(/\s+/).slice(1)
    for (const tok of toks) {
      if (known.has(tok.toLowerCase())) refs.push(tok.toLowerCase())
    }
  }
  return refs
}

export type BundleResult =
  | {
      ok: true
      /** The text to bind: only `.subckt` blocks, one logical line per line. */
      text: string
      /** Every subckt in the bundle, selected one first (case preserved). */
      subckts: string[]
      /** Things the person should know the bundle left out. */
      warnings: string[]
    }
  | { ok: false; error: string }

/**
 * Build the model text to bind for `subcktName` of the lib `text`.
 * Never throws; a file that cannot be used comes back as `{ ok: false, error }`.
 */
export function bundleSubckt(text: string, subcktName: string): BundleResult {
  if (!SUBCKT_NAME_RE.test(subcktName)) {
    return {
      ok: false,
      error: `The subckt name "${subcktName}" has characters circsim cannot save (letters, digits, _ . $ - only).`,
    }
  }
  const lib = parseLib(text)
  const byName = new Map<string, LibSubckt>()
  for (const s of lib.subckts) if (!byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s)

  const root = byName.get(subcktName.toLowerCase())
  if (!root) return { ok: false, error: `No .subckt named ${subcktName} was found in this file.` }

  const order: LibSubckt[] = []
  const seen = new Set<string>()
  const visit = (s: LibSubckt): void => {
    const key = s.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    order.push(s)
    for (const ref of subcktRefs(s.lines.slice(1), byName)) visit(byName.get(ref)!)
  }
  visit(root)

  for (const s of order) {
    if (s.unterminated) return { ok: false, error: `.subckt ${s.name} has no matching .ends; the file looks truncated.` }
    if (s.nested) {
      return { ok: false, error: `.subckt ${s.name} declares another .subckt inside itself, which circsim cannot import.` }
    }
  }

  const { cards, ignored } = topCards(lib.topLevel)
  const out: string[] = []
  for (const s of order) {
    const hoisted = neededTopCards(s, cards)
    out.push(s.lines[0], ...hoisted, ...s.lines.slice(1))
  }

  const warnings: string[] = []
  if (ignored.some((d) => d === '.include' || d === '.inc' || d === '.lib')) {
    warnings.push(
      'The file includes other files (.include or .lib), which circsim cannot follow. If the model needs them, import those files too or paste their text in.',
    )
  }

  const gate = sanitizeDeck(out)
  if (!gate.ok) return { ok: false, error: formatDeckViolations(gate.violations) }
  const bundled = out.join('\n')
  const unsafe = unsafeModelTextReason(bundled)
  if (unsafe) {
    return { ok: false, error: `This model cannot be bound: ${unsafe}, which circsim will not load from a saved file.` }
  }

  return { ok: true, text: bundled, subckts: order.map((s) => s.name), warnings }
}
