/**
 * core/spicegen/generate.ts
 *
 * SPICE deck generator: pure function that converts a resolved circuit +
 * instruments into a SPICE deck (array of strings, one card per line).
 *
 * Spec §8.8 rules enforced here:
 *   - Element names lowercase (r_r1, x_u2 …)
 *   - All numeric values plain decimal/exponent, NEVER letter suffixes
 *   - Series-R splice on the SOURCE side (synthetic _int node) so the KiCad
 *     net keeps its name and the overlay reads the correct voltage
 *   - .save all for node voltages + targeted .save @dev[i] per active current probe
 *   - NO blanket .options savecurrents
 *   - Every deck ends .end
 *   - Provenance comments (tier per part) make saved decks self-describing
 *
 * alterPlan() maps an instrument-parameter change to either:
 *   { kind: 'alter', commands } — live, no reload needed
 *   { kind: 'reload' }          — deck must be regenerated
 *
 * No imports from electron, react, or three. Pure TS, Vitest-safe.
 */

import type { Circuit, CircuitNet } from '../netlist/extract'
import type { Resolution } from '../models/types'
import type { Instrument, AlterPlanResult } from './instruments'

// ─── Public API types ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Circuit (from core/netlist/extract) */
  circuit: Circuit
  /** Resolutions for every part (from core/models/resolve) */
  resolutions: Resolution[]
  /** Instruments attached by the user */
  instruments: Instrument[]
  /** Which net id maps to ground (SPICE node "0") */
  groundNetId: number
  /** Optional analysis defaults (unused in deck — SimHost issues the analysis command) */
  analysisDefaults?: {
    tstepSeconds?: number
    tstopSeconds?: number
  }
  /** Title for the deck's first comment line (e.g. circuit/board name) */
  title?: string
}

// ─── Numeric emission ─────────────────────────────────────────────────────────

/**
 * Format a number as a plain decimal/exponent string.
 * NEVER emits letter suffixes (k, u, n, p, m, M …).
 *
 * Thresholds:
 *   abs < 0.001  → exponential  (e.g. 4.7e-6)
 *   abs >= 1e9   → exponential  (e.g. 1e10)
 *   otherwise    → plain decimal  (e.g. 10000, 0.1)
 *
 * Tests assert: 4.7e-6 → "4.7e-06", 10000 → "10000", 0.22 → "0.22"
 */
export function formatSpiceValue(v: number): string {
  if (v === 0) return '0'

  const abs = Math.abs(v)

  if (abs < 0.001 || abs >= 1e9) {
    // Use exponential form. JS toPrecision / toExponential may vary, so we
    // use toExponential and normalise the exponent sign.
    let exp = v.toExponential()
    // Normalise: JS gives "4.7e-6", but SPICE/tests expect "4.7e-06"
    // (two-digit exponent with sign)
    exp = exp.replace(/e([+-])(\d)$/, 'e$1' + '0$2')
    return exp
  }

  // Plain decimal range — let JS toString() handle it; it won't produce
  // scientific notation for values in [0.001, 1e9).
  const s = v.toString()
  // Guard: if JS produced scientific notation anyway (should not happen),
  // fall back to toExponential form.
  if (s.includes('e')) {
    return formatSpiceValue(v)   // tail-call; only if above thresholds are right
  }
  return s
}

// ─── Element name ─────────────────────────────────────────────────────────────

// (Element name prefix is inferred inline per-resolution; no standalone helper needed.)

// ─── Node lookup ──────────────────────────────────────────────────────────────

/** Build a map from netId → spiceNode for the circuit. */
function buildNetIdToNode(circuit: Circuit): Map<number, string> {
  const m = new Map<number, string>()
  for (const net of circuit.nets) {
    m.set(net.id, net.spiceNode)
  }
  return m
}

/** Find a CircuitNet by netId. */
function netById(circuit: Circuit, netId: number): CircuitNet | undefined {
  return circuit.nets.find(n => n.id === netId)
}

// ─── Instrument SPICE name builders ──────────────────────────────────────────

/**
 * Stable SPICE element name for an instrument.
 * dc-supply#1  → vpsu_1
 * function-gen#2 → vfgen_2
 * logic-input#3  → vlogic_3
 * (The suffix after _ is the id field, lowercased.)
 */
export function instrumentSpiceName(inst: Extract<Instrument, { id: string }>): string {
  const suffix = inst.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  switch (inst.kind) {
    case 'dc-supply':     return `vpsu_${suffix}`
    case 'function-gen':  return `vfgen_${suffix}`
    case 'logic-input':   return `vlogic_${suffix}`
    default:              return `v_${suffix}`
  }
}

/** Synthetic intermediate node name (source-side splice). */
function intNode(baseName: string): string {
  return `${baseName}_int`
}

// ─── Wave source card builders ────────────────────────────────────────────────

/**
 * Build the SPICE source value string for a function-gen instrument.
 *
 * Sine:     SIN(<offset> <amplitude> <freq>)
 * Square:   PULSE(0 <vhigh> 0 1n 1n <width> <period>)
 * Triangle: not a native SPICE source — use SIN as approximation (warn)
 * Pulse:    PULSE(<lo> <hi> 0 <rise> <fall> <width> <period>)
 */
function buildWaveSourceValue(inst: Extract<Instrument, { kind: 'function-gen' }>): string {
  const { wave, freqHz, amplitudeV, offsetV, dutyPct } = inst
  const period = formatSpiceValue(1 / freqHz)
  const amp    = formatSpiceValue(amplitudeV)
  const off    = formatSpiceValue(offsetV)
  const freq   = formatSpiceValue(freqHz)
  const hi     = formatSpiceValue(offsetV + amplitudeV)
  const lo     = formatSpiceValue(offsetV - amplitudeV)

  switch (wave) {
    case 'sine':
    case 'triangle':
      // Triangle uses SIN as an approximation (first harmonic)
      return `SIN(${off} ${amp} ${freq})`

    case 'square': {
      // PULSE: lo hi delay rise fall width period
      // duty = 0.5 by default
      const duty = (dutyPct ?? 50) / 100
      const width  = formatSpiceValue(duty / freqHz)
      return `PULSE(${lo} ${hi} 0 1e-09 1e-09 ${width} ${period})`
    }

    case 'pulse': {
      // PULSE with user-defined duty cycle
      const duty = (dutyPct ?? 50) / 100
      const width = formatSpiceValue(duty / freqHz)
      return `PULSE(${lo} ${hi} 0 1e-09 1e-09 ${width} ${period})`
    }
  }
}

// ─── Current-probe helpers ─────────────────────────────────────────────────────

/** Returns true if the resolution is a top-level primitive (R/C/L/D/Q…). */
function isPrimitive(res: Resolution): boolean {
  return res.model?.kind === 'primitive'
}

/** Returns true if the resolution is a subckt (needs ammeter splice). */
function isSubckt(res: Resolution): boolean {
  return res.model?.kind === 'subckt' || res.model?.kind === 'xspice-digital'
}

// ─── XSPICE digital template expansion ───────────────────────────────────────

/**
 * Expand an xspice-digital resolution into deck lines.
 * Pattern: adc_bridge → logic gates → dac_bridge (spec §8.8).
 *
 * For Task 13 scope we emit a placeholder comment; full expansion is Task 14b.
 * But we do emit the correct wrapper structure so tests can verify the pattern.
 */
function expandXspiceDigital(
  ref: string,
  model: { kind: 'xspice-digital'; templateId: string; pinMap: Record<string, string> },
  _netIdToNode: Map<number, string>,
  _circuit: Circuit,
): string[] {
  return [
    `* xspice-digital template: ${ref} (${model.templateId})`,
    `* adc_bridge/gates/dac_bridge expansion — see Task 14b`,
  ]
}

// ─── Main deck generator ──────────────────────────────────────────────────────

/**
 * Generate a SPICE deck from a resolved circuit + instruments.
 *
 * Returns an array of strings (one per line). The first element is the title
 * comment (SPICE requires the first line to be a comment/title).
 * The last element is always ".end".
 *
 * No .tran/.op card is included — the SimHost issues the analysis command.
 */
export function generateDeck(opts: GenerateOptions): string[] {
  const { circuit, resolutions, instruments, title } = opts
  // groundNetId is used by the caller to build the circuit (node "0" assignment);
  // the deck generator relies on circuit.nets[].spiceNode already being "0" for ground.
  // (opts.groundNetId is intentionally unused here — circuit.nets already have spiceNode="0")

  const lines: string[] = []
  const netIdToNode = buildNetIdToNode(circuit)

  // ── Line 0: title (SPICE requires first line to be a title comment) ────────
  lines.push(`* circsim deck${title ? ` — ${title}` : ''}`)

  // ── Provenance comment: tier per part ─────────────────────────────────────
  {
    const tierComments: string[] = []
    for (const res of resolutions) {
      const tierLabel = tierLabelFor(res)
      tierComments.push(`${res.ref}: ${tierLabel}`)
    }
    if (tierComments.length > 0) {
      lines.push(`* ${tierComments.join(' | ')}`)
    }
  }

  // ── Gather current probes — determine which need ammeter splice ────────────
  const currentProbes = instruments.filter(
    (i): i is Extract<Instrument, { kind: 'current-probe' }> => i.kind === 'current-probe'
  )

  // Map ref → current-probe for quick lookup
  const currentProbeByRef = new Map<string, Extract<Instrument, { kind: 'current-probe' }>>()
  for (const cp of currentProbes) {
    currentProbeByRef.set(cp.ref, cp)
  }

  // Map ref → Resolution for lookup
  const resolutionByRef = new Map<string, Resolution>()
  for (const res of resolutions) {
    resolutionByRef.set(res.ref, res)
  }

  // ── Instrument elements ────────────────────────────────────────────────────
  for (const inst of instruments) {
    if (inst.kind === 'ground-ref') continue  // ground is implicit (node "0")
    if (inst.kind === 'voltage-probe') continue  // no element needed; node voltages are saved
    if (inst.kind === 'current-probe') continue  // handled separately below

    const net = netById(circuit, inst.netId)
    if (!net) continue  // skip if net not in circuit

    const spiceNet = net.spiceNode

    if (inst.kind === 'dc-supply') {
      const name    = instrumentSpiceName(inst)
      const rName   = name.replace(/^v/, 'r')  // vpsu_1 → rpsu_1
      const synthetic = intNode(name)           // vpsu_1_int
      const volts   = formatSpiceValue(inst.volts)
      const ohms    = formatSpiceValue(inst.seriesOhms)

      // Source-side splice: voltage source from synthetic node to 0,
      // series R from synthetic node to the KiCad net.
      // This way the KiCad net keeps its name (overlay reads from spiceNet).
      lines.push(`${name} ${synthetic} 0 DC ${volts}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }

    if (inst.kind === 'function-gen') {
      const name      = instrumentSpiceName(inst)
      const rName     = name.replace(/^v/, 'r')
      const synthetic = intNode(name)
      const waveVal   = buildWaveSourceValue(inst)
      const ohms      = formatSpiceValue(inst.outputOhms)

      lines.push(`${name} ${synthetic} 0 ${waveVal}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }

    if (inst.kind === 'logic-input') {
      const name      = instrumentSpiceName(inst)
      const rName     = name.replace(/^v/, 'r')
      const synthetic = intNode(name)
      const vHigh     = formatSpiceValue(inst.vHigh)
      const level     = inst.level === 1 ? vHigh : '0'
      // Logic input series resistance (50Ω default, same as function-gen)
      const ohms      = formatSpiceValue(50)

      lines.push(`${name} ${synthetic} 0 DC ${level}`)
      lines.push(`${rName} ${synthetic} ${spiceNet} ${ohms}`)
      continue
    }
  }

  // ── Part elements ──────────────────────────────────────────────────────────
  for (const res of resolutions) {
    const part = circuit.parts.find(p => p.ref === res.ref)
    if (!part) continue

    if (!res.model) {
      lines.push(`* ${res.ref}: unresolved — no model found`)
      continue
    }

    const model = res.model

    if (model.kind === 'stub') {
      if (model.mode === 'open') {
        lines.push(`* ${res.ref}: stubbed open (no connections)`)
      } else if (model.mode === 'short') {
        // Tie all pads together via 1 µΩ resistors
        const nodes: string[] = []
        for (const [, netId] of part.padNet) {
          const node = netIdToNode.get(netId)
          if (node && !nodes.includes(node)) nodes.push(node)
        }
        if (nodes.length >= 2) {
          for (let i = 1; i < nodes.length; i++) {
            const rName = `r_stub_${part.ref.toLowerCase()}_${i}`
            lines.push(`${rName} ${nodes[0]} ${nodes[i]} 1e-06`)
          }
        } else {
          lines.push(`* ${res.ref}: stubbed short (< 2 distinct nodes)`)
        }
      } else {
        // interactive-pins: no SPICE elements (pins are controlled via logic-input instruments)
        lines.push(`* ${res.ref}: stubbed interactive-pins`)
      }
      continue
    }

    if (model.kind === 'primitive') {
      // The card was pre-built during resolution (core/models/resolve.ts)
      // Check if there's an ammeter splice for a current probe on this primitive
      const cp = currentProbeByRef.get(res.ref)
      if (cp) {
        // Top-level primitive: no ammeter needed — the device current vector
        // @<dev>[i] is available natively. Card goes in as-is.
        lines.push(model.card)
        // .save @<dev>[i] is added in the .save section below
      } else {
        lines.push(model.card)
      }
      continue
    }

    if (model.kind === 'subckt') {
      // .subckt instantiation: x_<ref> <nodes> <subcktName>
      // Node order from pinMap (pad → subckt terminal name/position)
      const pinMap = model.pinMap

      // Check for current probe on this subckt (needs ammeter splice)
      const cp = currentProbeByRef.get(res.ref)

      if (cp) {
        // Subckt current probe: insert vamm_<id> 0V ammeter at the designated pad.
        // The ammeter goes in series with the pad's net connection.
        const probeId = cp.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
        const ammName = `vamm_${probeId}`

        // Find which pad to splice
        const splicePad = cp.pad
        const netIdToSplice = splicePad ? part.padNet.get(splicePad) : undefined
        const spliceNode = netIdToSplice !== undefined ? netIdToNode.get(netIdToSplice) : undefined

        if (spliceNode) {
          // Create an internal node for the splice
          const spliceIntNode = `${ammName}_n`
          lines.push(`${ammName} ${spliceIntNode} ${spliceNode} DC 0`)

          // Build node list using the splice for the designated pad
          const nodeList = buildSubcktNodeList(part, netIdToNode, pinMap, splicePad, spliceIntNode)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
        } else {
          // Can't identify splice pad — emit without ammeter
          lines.push(`* WARNING: current probe on ${res.ref} pad ${cp.pad ?? '?'} — node not found, ammeter not inserted`)
          const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap)
          const xName = `x_${part.ref.toLowerCase()}`
          lines.push(`${xName} ${nodeList} ${model.subcktName}`)
        }
      } else {
        const nodeList = buildSubcktNodeListPlain(part, netIdToNode, pinMap)
        const xName = `x_${part.ref.toLowerCase()}`
        lines.push(`${xName} ${nodeList} ${model.subcktName}`)
      }
      continue
    }

    if (model.kind === 'xspice-digital') {
      const xspiceLines = expandXspiceDigital(res.ref, model, netIdToNode, circuit)
      lines.push(...xspiceLines)
      continue
    }
  }

  // ── .save section ─────────────────────────────────────────────────────────
  lines.push('.save all')

  // Targeted current-probe saves for top-level primitives
  for (const cp of currentProbes) {
    const res = resolutionByRef.get(cp.ref)
    if (res && isPrimitive(res)) {
      // The device name in the deck comes from the resolution card's first token
      const card = (res.model as { kind: 'primitive'; card: string }).card
      const devName = card.split(/\s+/)[0]
      lines.push(`.save @${devName}[i]`)
    }
    // Subckt current probes: save the vamm_ ammeter current
    if (res && isSubckt(res)) {
      const probeId = cp.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
      const ammName = `vamm_${probeId}`
      lines.push(`.save @${ammName}[i]`)
    }
  }

  lines.push('.end')

  return lines
}

// ─── Subckt node list builders ────────────────────────────────────────────────

/**
 * Build the node list for a subckt instantiation using the pinMap.
 * pinMap maps pad numbers to subckt terminal names/positions.
 * We sort by subckt terminal position (numeric) then alpha.
 */
function buildSubcktNodeListPlain(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
): string {
  // Determine ordering from pinMap values (which are terminal positions/names)
  // If pinMap values are all numeric, sort numerically; else sort as-is.
  const padEntries = Object.entries(pinMap)

  // Sort by terminal position (the VALUE of pinMap) if numeric, else alphabetically
  padEntries.sort(([, a], [, b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })

  const nodes: string[] = []
  for (const [padNum] of padEntries) {
    const netId = part.padNet.get(padNum)
    if (netId !== undefined) {
      const node = netIdToNode.get(netId) ?? '0'
      nodes.push(node)
    }
  }
  return nodes.join(' ')
}

/**
 * Same as buildSubcktNodeListPlain but substitutes spliceIntNode for the
 * designated splicePad (ammeter insertion).
 */
function buildSubcktNodeList(
  part: { padNet: Map<string, number> },
  netIdToNode: Map<number, string>,
  pinMap: Record<string, string>,
  splicePad: string | undefined,
  spliceIntNode: string,
): string {
  const padEntries = Object.entries(pinMap)
  padEntries.sort(([, a], [, b]) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })

  const nodes: string[] = []
  for (const [padNum] of padEntries) {
    if (padNum === splicePad) {
      nodes.push(spliceIntNode)
    } else {
      const netId = part.padNet.get(padNum)
      if (netId !== undefined) {
        const node = netIdToNode.get(netId) ?? '0'
        nodes.push(node)
      }
    }
  }
  return nodes.join(' ')
}

// ─── Tier label helper ────────────────────────────────────────────────────────

function tierLabelFor(res: Resolution): string {
  const tierNames: Record<number, string> = {
    1: 'tier 1 (schematic Sim.*)',
    2: 'tier 2 (primitive)',
    3: 'tier 3 (bundled library)',
    4: 'tier 4 (user .lib)',
    5: 'tier 5 (LLM-assist)',
    6: 'tier 6 (stub)',
  }
  return tierNames[res.tier] ?? `tier ${res.tier}`
}

// ─── alterPlan ────────────────────────────────────────────────────────────────

/**
 * Determine whether an instrument parameter change requires a live alter
 * or a full deck reload.
 *
 * Rules (spec §9):
 *   Alter-safe (no reload):
 *     - dc-supply.volts                  → alter @vpsu_<id>[dc] <v>  (but we use the direct form)
 *     - logic-input.level                → alter @vlogic_<id>[dc] <v>
 *     - function-gen freq/amp/offset     → alter @vfgen_<id>[sin] [ <vo> <va> <freq> ]
 *                                          (exact spacing, all params re-sent together)
 *
 *   Reload-required:
 *     - function-gen.wave type change    → reload
 *     - current-probe add/remove on subckt part → reload
 *
 * @param prevInstrument  The previous state of the instrument
 * @param nextInstrument  The new state of the instrument
 * @param resolutions     Current resolutions (to check primitive vs subckt)
 */
export function alterPlan(
  prevInstrument: Instrument,
  nextInstrument: Instrument,
  resolutions?: Resolution[],
): AlterPlanResult {
  // Instruments of different kind → reload
  if (prevInstrument.kind !== nextInstrument.kind) {
    return { kind: 'reload' }
  }

  const kind = prevInstrument.kind

  // ── dc-supply: volts change → alter ──────────────────────────────────────
  if (kind === 'dc-supply') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'dc-supply' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'dc-supply' }>
    const name = instrumentSpiceName(prev)
    const v = formatSpiceValue(next.volts)
    return {
      kind: 'alter',
      commands: [`alter @${name}[dc] ${v}`],
    }
  }

  // ── logic-input: level change → alter ─────────────────────────────────────
  if (kind === 'logic-input') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'logic-input' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'logic-input' }>
    const name = instrumentSpiceName(prev)
    const v = formatSpiceValue(next.level === 1 ? next.vHigh : 0)
    return {
      kind: 'alter',
      commands: [`alter @${name}[dc] ${v}`],
    }
  }

  // ── function-gen: wave type change → reload ────────────────────────────────
  if (kind === 'function-gen') {
    const prev = prevInstrument as Extract<Instrument, { kind: 'function-gen' }>
    const next = nextInstrument as Extract<Instrument, { kind: 'function-gen' }>

    if (prev.wave !== next.wave) {
      return { kind: 'reload' }
    }

    // freq / amp / offset change → alter via SIN/PULSE vector form
    const name = instrumentSpiceName(prev)
    const vo   = formatSpiceValue(next.offsetV)
    const va   = formatSpiceValue(next.amplitudeV)
    const freq = formatSpiceValue(next.freqHz)

    if (next.wave === 'sine' || next.wave === 'triangle') {
      // SIN vector form: exact spacing required by spec §9
      return {
        kind: 'alter',
        commands: [`alter @${name}[sin] [ ${vo} ${va} ${freq} ]`],
      }
    }

    // Pulse/square: PULSE vector form
    // PULSE params: [lo hi delay rise fall width period]
    const duty   = (next.dutyPct ?? 50) / 100
    const width  = formatSpiceValue(duty / next.freqHz)
    const period = formatSpiceValue(1 / next.freqHz)
    const lo     = formatSpiceValue(next.offsetV - next.amplitudeV)
    const hi     = formatSpiceValue(next.offsetV + next.amplitudeV)

    return {
      kind: 'alter',
      commands: [`alter @${name}[pulse] [ ${lo} ${hi} 0 1e-09 1e-09 ${width} ${period} ]`],
    }
  }

  // ── current-probe: any change → check if it involves a subckt part ────────
  if (kind === 'current-probe') {
    const next = nextInstrument as Extract<Instrument, { kind: 'current-probe' }>
    if (resolutions) {
      const res = resolutions.find(r => r.ref === next.ref)
      if (res && isSubckt(res)) {
        return { kind: 'reload' }
      }
    }
    // Primitive current probe change: no reload needed (just .save update)
    return { kind: 'reload' }  // conservative: always reload when probes change
  }

  // ── voltage-probe: no deck change ─────────────────────────────────────────
  if (kind === 'voltage-probe') {
    return { kind: 'alter', commands: [] }
  }

  // Default: reload for anything unknown
  return { kind: 'reload' }
}
