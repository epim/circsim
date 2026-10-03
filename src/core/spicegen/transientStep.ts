import { parseValue } from '../values/parseValue'

/** SPICE suffixes are case insensitive: M is milli, while MEG is mega. */
function spiceValue(token: string): number | undefined {
  const normalized = token.toLowerCase().replace(/[gt](?=[a-z]*$)/g, suffix => suffix.toUpperCase())
  return parseValue(normalized, 'R')
}

/**
 * Bound quiet-region work by source periods and explicit capacitor dynamics.
 * For each identified timing/feedback capacitor terminal, attached conductances
 * give an RC estimate; use 10 steps per time constant, calibrated against a
 * 1 us reference for timer period and feedback-loop settling. Copper is
 * grouped as wire for this estimate, not used as a tiny timing resistor. Ideal
 * voltage-source terminals are grouped too. Model power pins and generated
 * digital ICC rails identify bypasses, which remain under native LTE control.
 * Pure passive RC decks use all their unforced capacitors. This is not model
 * pole extraction: unknown port roles, model-local capacitors and parameter
 * expressions cannot supply a bound, and need an explicitly finer request.
 * ngspice still inserts breakpoints and refines below the resulting ceiling.
 */
export function transientMaxStep(requested: number, deck: readonly string[]): number {
  let step = requested
  const ports = new Map<string, string[]>()
  const adcModels = new Set<string>()
  for (const card of deck) {
    const subcircuit = card.trim().match(/^\.subckt\s+(\S+)\s+(.+)/i)
    if (subcircuit) ports.set(subcircuit[1].toLowerCase(), subcircuit[2].toLowerCase().split(/\s+/))
    const adc = card.trim().match(/^\.model\s+(\S+)\s+adc_bridge\b/i)
    if (adc) adcModels.add(adc[1].toLowerCase())
  }
  const powerNodes = new Set<string>(['0'])
  const signalNodes = new Set<string>()
  let activeCircuit = false
  const parent = new Map<string, string>()
  const root = (name: string): string => {
    const path: string[] = []
    let node = name
    while (parent.has(node) && parent.get(node) !== node) {
      path.push(node)
      node = parent.get(node)!
    }
    parent.set(node, node)
    for (const member of path) parent.set(member, node)
    return node
  }
  const join = (a: string, b: string): void => { parent.set(root(a), root(b)) }
  const resistors: { a: string; b: string; value: number }[] = []
  const capacitors: { a: string; b: string; value: number }[] = []
  let subcircuitDepth = 0
  for (const card of deck) {
    const line = card.trim()
    if (/^[vi]\S*\s+\S+\s+\S+\s+/i.test(line)) {
      const wave = line.match(/\b(SIN|PULSE)\s*\(([^)]*)\)/i)
      if (wave) {
        const params = wave[2].trim().split(/[\s,]+/).map(spiceValue)
        const period = wave[1].toUpperCase() === 'SIN' ? 1 / (params[2] ?? NaN) : params[6]
        if (period !== undefined && Number.isFinite(period) && period > 0) step = Math.min(step, period / 200)
      }
    }
    if (/^\.subckt\b/i.test(line)) { subcircuitDepth++; continue }
    if (/^\.ends\b/i.test(line)) { subcircuitDepth--; continue }
    if (subcircuitDepth !== 0) continue
    const tokens = line.toLowerCase().split(/\s+/)
    if (/^[abdegjmqszx]\S*\s+/i.test(line)) activeCircuit = true
    if (/^x\S*\s+/i.test(line)) {
      const modelPorts = ports.get(tokens.at(-1)!)
      modelPorts?.forEach((port, i) => {
        const node = tokens[i + 1]
        if (!node) return
        if (/^(?:vcc|vdd|vss|vee|gnd|ground|vin|vout|bat|intvcc)$/.test(port)) powerNodes.add(node)
        if (/^(?:trig|thres|ref|in(?:[ab]?[pn]|\d+[pn]))$/.test(port)) signalNodes.add(node)
      })
    }
    // The generated digital expansion names its actual supply draw *_icc.
    if (/^b_\S+_icc\s+\S+\s+\S+\s+i\s*=/i.test(line)) {
      powerNodes.add(tokens[1]); powerNodes.add(tokens[2])
    }
    if (/^b\S*\s+\S+\s+\S+\s+v\s*=/i.test(line)) {
      for (const voltage of line.matchAll(/\bv\s*\(([^)]*)\)/gi)) {
        for (const node of voltage[1].toLowerCase().split(/[\s,]+/)) signalNodes.add(node)
      }
    }
    const adcInput = line.match(/^a\S*\s+\[([^\]]*)\].*\s(\S+)$/i)
    if (adcInput && adcModels.has(adcInput[2].toLowerCase())) {
      for (const node of adcInput[1].toLowerCase().trim().split(/\s+/)) signalNodes.add(node)
    }
    if (/^[eg]\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+/i.test(line)) {
      signalNodes.add(tokens[3]); signalNodes.add(tokens[4])
    }
    const part = line.match(/^([rcv]\S*)\s+(\S+)\s+(\S+)\s+(\S+)/i)
    if (!part) continue
    const [, name, nodeA, nodeB, token] = part
    const a = nodeA.toLowerCase()
    const b = nodeB.toLowerCase()
    const kind = name[0].toLowerCase()
    // Bench supplies expose their actual rail through the generated series R.
    if (/^rpsu_/i.test(name)) { powerNodes.add(a); powerNodes.add(b) }
    if (kind === 'v' || /^r_copper_/i.test(name)) { join(a, b); continue }
    const value = spiceValue(token)
    if (value === undefined || !(value > 0)) continue
    if (kind === 'r') resistors.push({ a, b, value })
    if (kind === 'c') capacitors.push({ a, b, value })
  }
  const conductance = new Map<string, number>()
  for (const { a, b, value } of resistors) {
    const aa = root(a)
    const bb = root(b)
    if (aa === bb) continue
    conductance.set(aa, (conductance.get(aa) ?? 0) + 1 / value)
    conductance.set(bb, (conductance.get(bb) ?? 0) + 1 / value)
  }
  const ground = root('0')
  const power = new Set([...powerNodes].map(root))
  const signals = new Set([...signalNodes].map(root))
  for (const { a, b, value } of capacitors) {
    const aa = root(a)
    const bb = root(b)
    if (aa === bb) continue
    if (power.has(aa) && power.has(bb)) continue
    if (activeCircuit && ![aa, bb].some(node => signals.has(node) && !power.has(node))) continue
    const g = (aa === ground ? 0 : conductance.get(aa) ?? 0) + (bb === ground ? 0 : conductance.get(bb) ?? 0)
    if (g > 0) step = Math.min(step, value / g / 10)
  }
  return step
}
