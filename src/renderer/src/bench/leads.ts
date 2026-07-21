/**
 * bench/leads.ts — pure jack/wiring model for the Bench Leads feature.
 *
 * Spec: docs/superpowers/specs/2026-07-17-bench-leads-design.md §1–§3.
 * No React, no THREE, no store — table-driven-testable data layer.
 */

import {
  UNWIRED, isFullyWired, type Instrument,
} from '../../../core/spicegen/instruments'
import { leadPath, type Pt } from './leadGeometry'

export { UNWIRED, isFullyWired }

export type Terminal = 'net' | 'A' | 'W' | 'Lo' | 'clamp' | 'gnd'

export type AttachTarget =
  | { kind: 'net'; netId: number }
  | { kind: 'component'; ref: string }

export interface JackDef {
  /** `${instId}:${terminal}` — stable registry/testid key. */
  key: string
  instId: string
  terminal: Terminal
  label: string
  color: string
  accepts: 'net' | 'component'
  /** null = unwired (open jack). */
  target: AttachTarget | null
}

/** The ground-ref instrument has no id field; the shelf addresses it as 'ground'. */
export const GROUND_INST_ID = 'ground'

/** Spec Global Constraints — exact jack/lead colors. */
export const JACK_COLORS = {
  'dc-supply': '#e05545',
  'function-gen': '#e8c33c',
  'logic-input': '#a06ae0',
  potA: '#e08a3c',
  potW: '#4fae62',
  potLo: '#4a7fd6',
  ground: '#3a3a3a',
} as const

export type BenchKind =
  | 'dc-supply' | 'function-gen' | 'logic-input'
  | 'voltage-probe' | 'current-probe' | 'potentiometer'

/** Palette defaults — same values the retired rack used (InstrumentRack.tsx),
 *  but born UNWIRED. probeColor is used only by the probe kinds. */
export function defaultBenchInstrument(kind: BenchKind, id: string, probeColor: string): Instrument {
  switch (kind) {
    case 'dc-supply':
      return { kind, id, netId: UNWIRED, volts: 5, seriesOhms: 0.1 }
    case 'function-gen':
      return { kind, id, netId: UNWIRED, wave: 'sine', freqHz: 1000, amplitudeV: 1, offsetV: 0, outputOhms: 50 }
    case 'logic-input':
      return { kind, id, netId: UNWIRED, level: 0, vHigh: 3.3 }
    case 'voltage-probe':
      return { kind, id, netId: UNWIRED, color: probeColor }
    case 'current-probe':
      return { kind, id, ref: '', color: probeColor }
    case 'potentiometer':
      return { kind, mode: 'rheostat', id, netA: UNWIRED, netW: UNWIRED, totalOhms: 10_000, wiperPct: 0.5 }
  }
}

function netTarget(netId: number): AttachTarget | null {
  return netId === UNWIRED ? null : { kind: 'net', netId }
}

export function jacksFor(inst: Instrument, instId: string): JackDef[] {
  const jack = (terminal: Terminal, label: string, color: string,
    accepts: 'net' | 'component', target: AttachTarget | null): JackDef =>
    ({ key: `${instId}:${terminal}`, instId, terminal, label, color, accepts, target })

  switch (inst.kind) {
    case 'ground-ref':
      return [jack('gnd', 'GND', JACK_COLORS.ground, 'net', netTarget(inst.netId))]
    case 'dc-supply':
      return [jack('net', '+', JACK_COLORS['dc-supply'], 'net', netTarget(inst.netId))]
    case 'function-gen':
      return [jack('net', 'out', JACK_COLORS['function-gen'], 'net', netTarget(inst.netId))]
    case 'logic-input':
      return [jack('net', 'out', JACK_COLORS['logic-input'], 'net', netTarget(inst.netId))]
    case 'voltage-probe':
      return [jack('net', 'tip', inst.color, 'net', netTarget(inst.netId))]
    case 'current-probe':
      return [jack('clamp', 'clamp', inst.color, 'component',
        inst.ref === '' ? null : { kind: 'component', ref: inst.ref })]
    case 'potentiometer': {
      const a = inst.mode === 'rheostat' ? inst.netA : inst.netHi
      const jacks = [
        jack('A', 'A', JACK_COLORS.potA, 'net', netTarget(a)),
        jack('W', 'W', JACK_COLORS.potW, 'net', netTarget(inst.netW)),
      ]
      if (inst.mode === 'divider') {
        jacks.push(jack('Lo', 'Lo', JACK_COLORS.potLo, 'net', netTarget(inst.netLo)))
      }
      return jacks
    }
  }
}

/**
 * Pure terminal update: returns a NEW instrument with the terminal wired to
 * target, or the SAME instrument (referential no-op) when the terminal/target
 * combination is invalid for this kind. ground-ref is NOT handled here — the
 * store routes the 'gnd' terminal through setGround (spec §7).
 */
export function applyTerminal(inst: Instrument, terminal: Terminal, target: AttachTarget): Instrument {
  if (target.kind === 'net') {
    const netId = target.netId
    switch (inst.kind) {
      case 'dc-supply': case 'function-gen': case 'logic-input': case 'voltage-probe':
        return terminal === 'net' ? { ...inst, netId } : inst
      case 'potentiometer':
        if (terminal === 'A') {
          return inst.mode === 'rheostat' ? { ...inst, netA: netId } : { ...inst, netHi: netId }
        }
        if (terminal === 'W') return { ...inst, netW: netId }
        if (terminal === 'Lo' && inst.mode === 'divider') return { ...inst, netLo: netId }
        return inst
      default:
        return inst
    }
  }
  // component target
  if (inst.kind === 'current-probe' && terminal === 'clamp') {
    return { ...inst, ref: target.ref }
  }
  return inst
}

/** Pure detach: rewires the terminal back to UNWIRED / ''. Same no-op contract. */
export function clearTerminal(inst: Instrument, terminal: Terminal): Instrument {
  if (inst.kind === 'current-probe' && terminal === 'clamp') return { ...inst, ref: '' }
  return applyTerminal(inst, terminal, { kind: 'net', netId: UNWIRED })
}

/**
 * Pot mode toggle (spec §5): the A/Hi and W wires survive the switch — A and
 * Hi are the same physical jack (see jacksFor) — and only Lo is added
 * (unwired) or discarded.
 */
export function potModeSwitch(
  inst: Extract<Instrument, { kind: 'potentiometer' }>,
): Instrument {
  return inst.mode === 'rheostat'
    ? { kind: 'potentiometer', mode: 'divider', id: inst.id,
        netHi: inst.netA, netW: inst.netW, netLo: UNWIRED,
        totalOhms: inst.totalOhms, wiperPct: inst.wiperPct }
    : { kind: 'potentiometer', mode: 'rheostat', id: inst.id,
        netA: inst.netHi, netW: inst.netW,
        totalOhms: inst.totalOhms, wiperPct: inst.wiperPct }
}

/** Drop resolution: a raycast hit is valid only if the jack accepts its kind. */
export function resolveDrop(
  hit: { netId?: number; ref?: string } | null,
  jack: Pick<JackDef, 'accepts'>,
): AttachTarget | null {
  if (!hit) return null
  if (jack.accepts === 'net' && hit.netId !== undefined) return { kind: 'net', netId: hit.netId }
  if (jack.accepts === 'component' && hit.ref !== undefined) return { kind: 'component', ref: hit.ref }
  return null
}

export interface LeadRender {
  jackKey: string
  instId: string
  terminal: Terminal
  color: string
  jack: Pt
  /** Projected clip anchor; null while dangling. */
  clip: Pt | null
  /** SVG path; null while dangling. */
  path: string | null
  /** Wired to a net that no longer exists on the (reloaded) board. */
  dangling: boolean
}

/**
 * Assemble the render model for every wired jack. A lead renders only when
 * its jack has a measured rect; it is dangling when its net target is absent
 * from the live circuit (spec §5). Component targets are never dangling here —
 * a vanished ref simply loses its anchor and the lead is skipped.
 */
export function computeLeads(
  instruments: Array<{ inst: Instrument; instId: string }>,
  jackRects: Map<string, Pt>,
  anchors: { nets: Map<number, Pt>; refs: Map<string, Pt> },
  liveNetIds: Set<number>,
): LeadRender[] {
  const out: LeadRender[] = []
  for (const { inst, instId } of instruments) {
    for (const jack of jacksFor(inst, instId)) {
      if (!jack.target) continue
      const jackPt = jackRects.get(jack.key)
      if (!jackPt) continue
      if (jack.target.kind === 'net') {
        if (!liveNetIds.has(jack.target.netId)) {
          out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
            jack: jackPt, clip: null, path: null, dangling: true })
          continue
        }
        const clip = anchors.nets.get(jack.target.netId)
        if (!clip) continue
        out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
          jack: jackPt, clip, path: leadPath(jackPt, clip), dangling: false })
      } else {
        const clip = anchors.refs.get(jack.target.ref)
        if (!clip) continue
        out.push({ jackKey: jack.key, instId, terminal: jack.terminal, color: jack.color,
          jack: jackPt, clip, path: leadPath(jackPt, clip), dangling: false })
      }
    }
  }
  return out
}
