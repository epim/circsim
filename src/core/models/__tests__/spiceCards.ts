/**
 * Minimal SPICE .model card parser shared by the library fingerprint and
 * derivation tests. Not a test file (no .test suffix), so it is not collected.
 */

export interface ParsedCard {
  file: string
  name: string
  /** Normalised device type: npn, pnp, d. */
  type: string
  params: Record<string, number>
}

const SUFFIX: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15
}

/** Parse a SPICE number with an engineering suffix ("14.34f", "66.78m", "1e-19"). */
export function parseSpiceNumber(s: string): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?[a-z]*$/i.exec(s.trim())
  if (!m) return NaN
  const base = Number(m[1])
  const suf = m[2] ? SUFFIX[m[2].toLowerCase()] : 1
  return base * suf
}

/** Parse every `.model NAME TYPE(k=v ...)` card in a SPICE library text. */
export function parseModelCards(file: string, text: string): ParsedCard[] {
  const joined = text.replace(/\r?\n\+/g, ' ')
  const cards: ParsedCard[] = []
  for (const m of joined.matchAll(/^\s*\.model\s+(\S+)\s+(\w+)\s*\(([^)]*)\)/gim)) {
    const params: Record<string, number> = {}
    for (const p of m[3].matchAll(/([a-z][a-z0-9_]*)\s*=\s*(\S+)/gi)) {
      params[p[1].toLowerCase()] = parseSpiceNumber(p[2])
    }
    cards.push({ file, name: m[1], type: m[2].toLowerCase(), params })
  }
  return cards
}
