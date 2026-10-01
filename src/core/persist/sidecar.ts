/**
 * core/persist/sidecar.ts
 *
 * The per-board sidecar: `<board>.circsim.json`, written beside a `.kicad_pcb`
 * and holding everything a user sets up by hand so a reopen (for example after
 * fixing the board in KiCad) or an app restart does not throw it away:
 *
 *   - the designated ground net (and where its lead was clipped)
 *   - bench instruments with their leads, each lead with its copper position
 *   - stub overrides and pin-map overrides from the Model Doctor
 *   - manual rail-voltage overrides
 *   - user models (imported or LLM-generated subckts)
 *
 * Design rules:
 *   - Nets are stored BY NAME, never by numeric id. Net ids are assigned at parse
 *     time and shift when a board is edited; names survive an edit.
 *   - Loading NEVER throws and never blocks an open. A file with no version (v0),
 *     a file from a newer circsim, a truncated file and outright garbage each
 *     yield a LoadOutcome: what could be restored plus plain-language notes on
 *     what could not. Every entry is validated on its own, so one bad entry
 *     loses only itself.
 *   - A sidecar may come from a cloned repository, so it is treated as untrusted
 *     input: every value is type-checked, instruments are rebuilt field by field
 *     (never spread from the file), and user-model text is checked against a
 *     directive allowlist before it can reach ngspice (a `.control` block can run
 *     shell commands).
 *   - The sidecar never contains board geometry or anything derived from running
 *     the simulator; results are not persisted, only the setup that produces them.
 *
 * Format versions:
 *   v0  no `version` field (a draft layout). Same sections as v1; `ground` may be
 *       a bare net-name string and an instrument may be a flat object whose net
 *       fields hold net names. Loaded, and rewritten as v1 on the next save.
 *   v1  the current layout (SIDECAR_VERSION).
 *   >1  written by a newer circsim. The sections this build understands are
 *       loaded; the file is never overwritten by this build.
 *
 * No imports from electron, react, or three.
 */

import type { CircuitNet } from '../netlist/extract'
import type { PinMap } from '../models/types'
import type { UserStubOverride } from '../models/resolve'
import { UNWIRED, type Instrument } from '../spicegen/instruments'

// --- constants -------------------------------------------------------------

export const SIDECAR_FORMAT = 'circsim-sidecar'
export const SIDECAR_VERSION = 1
/** Files larger than this are refused (a sidecar holds settings, not data). */
export const MAX_SIDECAR_BYTES = 8 * 1024 * 1024
/** Per-model text cap. */
export const MAX_MODEL_TEXT = 1024 * 1024

// --- types -----------------------------------------------------------------

/**
 * Where a lead was clipped on the board: KiCad board coordinates in millimetres
 * (same frame as a critic Finding.location). The critic lane reads this to find
 * the pad or copper a supply actually enters through.
 */
export interface LeadPosition {
  x: number
  y: number
}

/** The store key of a lead position: `${instrumentId}:${terminal}` (the bench JackDef key). */
export function leadKey(instId: string, terminal: string): string {
  return `${instId}:${terminal}`
}

/** Key of the ground lead (the virtual `ground` instrument's `gnd` terminal). */
export const GROUND_LEAD_KEY = 'ground:gnd'

export type StubMode = UserStubOverride['mode']

export interface UserModelRecord {
  mpn: string
  subcktText: string
  subcktName: string
  pinMap: PinMap
  provenance: 'llm-generated' | 'user-import'
}

/** One persisted instrument: every net field is stripped and stored by name in `nets`. */
export interface SidecarInstrument {
  instrument: Record<string, unknown>
  /** Instrument field name (netId, netA, netW, netHi, netLo) to net name. */
  nets: Record<string, string>
  /** Terminal (net, A, W, Lo, clamp) to clip position. */
  leads: Record<string, LeadPosition>
}

export interface Sidecar {
  format: typeof SIDECAR_FORMAT
  version: number
  savedBy?: string
  board?: { fileName?: string; sha256?: string }
  ground?: { net: string | null; lead?: LeadPosition }
  instruments?: SidecarInstrument[]
  stubs?: Record<string, StubMode>
  pinMaps?: Record<string, PinMap>
  railOverrides?: Record<string, number>
  userModels?: Record<string, UserModelRecord>
}

/**
 * How a sidecar file read:
 *   ok         current version, whole file
 *   legacy     no version field (v0) or a non-numeric one
 *   salvaged   the file was truncated or damaged and part of it was recovered
 *   newer      written by a newer circsim; read, but must not be overwritten
 *   unreadable nothing usable
 */
export type SidecarStatus = 'ok' | 'legacy' | 'salvaged' | 'newer' | 'unreadable'

export interface SidecarParse {
  status: SidecarStatus
  sidecar: Sidecar | null
  notes: string[]
}

/** Everything the store applies on open. A section is absent when the file did not speak about it. */
export interface RestorePlan {
  /** Present when the sidecar named a ground (or explicitly none) that resolved on this board. */
  ground?: { netId: number | null }
  /** Present when the sidecar had an instruments section: replaces the auto-attached bench. */
  instruments?: Instrument[]
  leadPositions: Map<string, LeadPosition>
  stubOverrides: Map<string, UserStubOverride>
  pinMapOverrides: Map<string, PinMap>
  /** kicadName to volts. */
  railOverrides: Map<string, number>
  userModels: Map<string, UserModelRecord>
}

export interface LoadOutcome {
  status: SidecarStatus
  plan: RestorePlan | null
  /** Number of individual settings applied (ground, each instrument, override, model). */
  restored: number
  /** Plain-language notes: what was skipped and why. */
  notes: string[]
}

export interface RestoreContext {
  nets: CircuitNet[]
  /** Refs of the parts on the board (overrides for unknown refs are dropped). */
  partRefs: Set<string>
}

// --- small validators ------------------------------------------------------

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function entriesOf(v: unknown): [string, unknown][] {
  if (!isObj(v)) return []
  return Object.entries(v).filter(([k]) => !DANGEROUS_KEYS.has(k))
}

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
const SUBCKT_NAME_RE = /^[A-Za-z0-9_.$-]{1,128}$/
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/
const TERMINALS = new Set(['net', 'A', 'W', 'Lo', 'clamp', 'gnd'])
const STUB_MODES = new Set<string>(['open', 'short', 'interactive-pins'])
const MAX_COORD_MM = 1e5

function parseLeadPosition(v: unknown): LeadPosition | null {
  if (!isObj(v)) return null
  const { x, y } = v
  if (!isFiniteNum(x) || !isFiniteNum(y)) return null
  if (Math.abs(x) > MAX_COORD_MM || Math.abs(y) > MAX_COORD_MM) return null
  return { x, y }
}

function parsePinMap(v: unknown): PinMap | null {
  if (!isObj(v)) return null
  const out: PinMap = {}
  for (const [k, val] of entriesOf(v)) {
    if (typeof val !== 'string' || k.length > 64 || val.length > 64) return null
    out[k] = val
  }
  return out
}

/**
 * Directives a model's text may contain. `.control` / `.endc` blocks can run
 * shell commands inside ngspice and `.include` / `.lib` read arbitrary files, so
 * anything outside this list is refused when model text comes from a sidecar.
 */
const ALLOWED_MODEL_DIRECTIVES = new Set([
  'subckt', 'ends', 'model', 'param', 'func', 'global',
  'options', 'option', 'temp', 'ic', 'nodeset', 'end',
])

/** null when the model text is acceptable; otherwise the reason it is not. */
export function unsafeModelTextReason(text: string): string | null {
  if (text.length > MAX_MODEL_TEXT) return 'the model text is larger than 1 MB'
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line.startsWith('.')) continue
    const directive = line.slice(1).split(/[\s(]/, 1)[0].toLowerCase()
    if (!ALLOWED_MODEL_DIRECTIVES.has(directive)) return `it uses the .${directive} directive`
  }
  return null
}

function parseUserModel(v: unknown): UserModelRecord | string {
  if (!isObj(v)) return 'it is not an object'
  const { mpn, subcktText, subcktName, pinMap, provenance } = v
  if (typeof mpn !== 'string' || mpn.length === 0 || mpn.length > 128) return 'it has no valid MPN'
  if (typeof subcktText !== 'string' || subcktText.trim() === '') return 'it has no model text'
  if (typeof subcktName !== 'string' || !SUBCKT_NAME_RE.test(subcktName)) return 'its subckt name is not valid'
  const pins = parsePinMap(pinMap)
  if (!pins) return 'its pin map is not valid'
  if (provenance !== 'llm-generated' && provenance !== 'user-import') return 'its provenance is not valid'
  const unsafe = unsafeModelTextReason(subcktText)
  if (unsafe) return `${unsafe}, which circsim will not load from a saved file`
  return { mpn, subcktText, subcktName, pinMap: pins, provenance }
}

// --- truncated-JSON salvage -------------------------------------------------

/**
 * Recover the longest valid prefix of a truncated JSON document: cut at a comma
 * (always a boundary between complete entries) and close the open brackets. Tries
 * the latest cut first; nearly always the first attempt succeeds.
 */
function salvageJson(text: string): unknown | undefined {
  const cuts: { idx: number; closers: string }[] = []
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') cuts.push({ idx: i, closers: [...stack].reverse().join('') })
  }
  // The text may also end right after a complete value.
  const candidates = inStr ? cuts : [...cuts, { idx: text.length, closers: [...stack].reverse().join('') }]
  let attempts = 0
  for (let k = candidates.length - 1; k >= 0 && attempts < 64; k--, attempts++) {
    const { idx, closers } = candidates[k]
    try {
      return JSON.parse(text.slice(0, idx) + closers)
    } catch {
      // try an earlier cut
    }
  }
  return undefined
}

// --- parse -------------------------------------------------------------------

function parseInstrumentEntry(v: unknown): SidecarInstrument | null {
  if (!isObj(v)) return null
  // v1: { instrument, nets, leads }. v0 flat form: the entry IS the instrument.
  const inst = isObj(v.instrument) ? v.instrument : v
  if (typeof inst.kind !== 'string') return null
  const nets: Record<string, string> = {}
  for (const [k, val] of entriesOf(v.nets)) {
    if (typeof val === 'string' && val.length <= 512) nets[k] = val
  }
  const leads: Record<string, LeadPosition> = {}
  for (const [k, val] of entriesOf(v.leads)) {
    const pos = parseLeadPosition(val)
    if (TERMINALS.has(k) && pos) leads[k] = pos
  }
  return { instrument: inst, nets, leads }
}

/**
 * Parse sidecar text into a normalized Sidecar. Never throws. Structural
 * problems drop the affected entry and add a note; nothing here needs the board.
 */
export function parseSidecar(text: string): SidecarParse {
  const notes: string[] = []
  try {
    if (typeof text !== 'string' || text.length === 0) {
      return { status: 'unreadable', sidecar: null, notes: ['The setup file is empty.'] }
    }
    if (text.length > MAX_SIDECAR_BYTES) {
      return { status: 'unreadable', sidecar: null, notes: ['The setup file is larger than 8 MB, so it was not read.'] }
    }
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

    let value: unknown
    let salvaged = false
    try {
      value = JSON.parse(body)
    } catch {
      value = salvageJson(body)
      salvaged = value !== undefined
      if (!salvaged) {
        return {
          status: 'unreadable',
          sidecar: null,
          notes: ['The setup file is damaged and nothing could be recovered from it.'],
        }
      }
      notes.push('The setup file was cut off or damaged; the complete part at its start was recovered.')
    }
    if (!isObj(value)) {
      return { status: 'unreadable', sidecar: null, notes: ['The setup file does not hold a circsim setup.'] }
    }
    if (value.format !== undefined && value.format !== SIDECAR_FORMAT) {
      return { status: 'unreadable', sidecar: null, notes: ['The setup file is not a circsim setup file.'] }
    }

    let version = 0
    let newer = false
    if (value.version === undefined) {
      notes.push('The setup file has no version (saved by an early build); it is read as version 0 and will be rewritten as version 1 on the next save.')
    } else if (typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 1) {
      version = value.version
      if (version > SIDECAR_VERSION) {
        newer = true
        notes.push(`The setup file was saved by a newer circsim (format version ${version}). Settings this build understands were loaded; the file will not be overwritten.`)
      }
    } else {
      notes.push('The setup file has an unrecognized version; it is read as version 0.')
    }

    const sidecar: Sidecar = { format: SIDECAR_FORMAT, version }
    if (typeof value.savedBy === 'string') sidecar.savedBy = value.savedBy.slice(0, 64)

    if (isObj(value.board)) {
      sidecar.board = {}
      if (typeof value.board.fileName === 'string') sidecar.board.fileName = value.board.fileName.slice(0, 512)
      if (typeof value.board.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.board.sha256)) {
        sidecar.board.sha256 = value.board.sha256
      }
    }

    if ('ground' in value) {
      const g = value.ground
      if (g === null) sidecar.ground = { net: null }
      else if (typeof g === 'string') sidecar.ground = { net: g }
      else if (isObj(g) && (g.net === null || typeof g.net === 'string')) {
        sidecar.ground = { net: g.net as string | null }
        const lead = parseLeadPosition(g.lead)
        if (lead) sidecar.ground.lead = lead
      } else {
        notes.push('The saved ground was not readable and was ignored.')
      }
    }

    if ('instruments' in value) {
      if (Array.isArray(value.instruments)) {
        const list: SidecarInstrument[] = []
        let bad = 0
        for (const entry of value.instruments) {
          const parsed = parseInstrumentEntry(entry)
          if (parsed) list.push(parsed)
          else bad++
        }
        sidecar.instruments = list
        if (bad > 0) notes.push(`${bad} saved instrument${bad === 1 ? ' was' : 's were'} not readable and ${bad === 1 ? 'was' : 'were'} skipped.`)
      } else {
        notes.push('The saved instruments were not readable and were ignored.')
      }
    }

    if ('stubs' in value) {
      if (isObj(value.stubs)) {
        const stubs: Record<string, StubMode> = {}
        for (const [ref, raw] of entriesOf(value.stubs)) {
          const mode = isObj(raw) ? raw.mode : raw
          if (typeof mode === 'string' && STUB_MODES.has(mode)) stubs[ref] = mode as StubMode
          else notes.push(`The saved stub for ${ref} was not readable and was skipped.`)
        }
        sidecar.stubs = stubs
      } else {
        notes.push('The saved stubs were not readable and were ignored.')
      }
    }

    if ('pinMaps' in value) {
      if (isObj(value.pinMaps)) {
        const maps: Record<string, PinMap> = {}
        for (const [ref, raw] of entriesOf(value.pinMaps)) {
          const pm = parsePinMap(raw)
          if (pm) maps[ref] = pm
          else notes.push(`The saved pin map for ${ref} was not readable and was skipped.`)
        }
        sidecar.pinMaps = maps
      } else {
        notes.push('The saved pin maps were not readable and were ignored.')
      }
    }

    if ('railOverrides' in value) {
      if (isObj(value.railOverrides)) {
        const rails: Record<string, number> = {}
        for (const [net, raw] of entriesOf(value.railOverrides)) {
          if (isFiniteNum(raw) && raw > 0 && raw <= 1000) rails[net] = raw
          else notes.push(`The saved rail override for ${net} was not a valid voltage and was skipped.`)
        }
        sidecar.railOverrides = rails
      } else {
        notes.push('The saved rail overrides were not readable and were ignored.')
      }
    }

    if ('userModels' in value) {
      if (isObj(value.userModels)) {
        const models: Record<string, UserModelRecord> = {}
        for (const [ref, raw] of entriesOf(value.userModels)) {
          const parsed = parseUserModel(raw)
          if (typeof parsed === 'string') notes.push(`The saved model for ${ref} was skipped: ${parsed}.`)
          else models[ref] = parsed
        }
        sidecar.userModels = models
      } else {
        notes.push('The saved models were not readable and were ignored.')
      }
    }

    const status: SidecarStatus = newer ? 'newer' : salvaged ? 'salvaged' : version === 0 ? 'legacy' : 'ok'
    return { status, sidecar, notes }
  } catch (err) {
    // Defensive: parsing must never break an open.
    return {
      status: 'unreadable',
      sidecar: null,
      notes: [`The setup file could not be read (${err instanceof Error ? err.message : String(err)}).`],
    }
  }
}

// --- instrument rebuild (restore) ----------------------------------------------

/** Net-carrying fields of an instrument and the bench terminal each one is. */
function netFields(inst: { kind: string; mode?: unknown }): { field: string; terminal: string }[] {
  switch (inst.kind) {
    case 'dc-supply':
    case 'function-gen':
    case 'logic-input':
    case 'voltage-probe':
      return [{ field: 'netId', terminal: 'net' }]
    case 'potentiometer':
      return inst.mode === 'divider'
        ? [{ field: 'netHi', terminal: 'A' }, { field: 'netW', terminal: 'W' }, { field: 'netLo', terminal: 'Lo' }]
        : [{ field: 'netA', terminal: 'A' }, { field: 'netW', terminal: 'W' }]
    default:
      return []
  }
}

const WAVES = new Set(['sine', 'square', 'triangle', 'pulse'])

/**
 * Rebuild one instrument from untrusted fields, field by field. Returns the
 * instrument (net fields UNWIRED until the caller fills them) or the reason it
 * cannot be rebuilt.
 */
function rebuildInstrument(raw: Record<string, unknown>, partRefs: Set<string>, notes: string[]): Instrument | string {
  const id = raw.id
  if (typeof id !== 'string' || !ID_RE.test(id)) return 'it has no valid id'
  switch (raw.kind) {
    case 'dc-supply': {
      if (!isFiniteNum(raw.volts) || Math.abs(raw.volts) > 1000) return 'its voltage is not valid'
      const r = raw.seriesOhms
      if (!isFiniteNum(r) || r < 0 || r > 1e9) return 'its series resistance is not valid'
      return { kind: 'dc-supply', id, netId: UNWIRED, volts: raw.volts, seriesOhms: r }
    }
    case 'function-gen': {
      if (typeof raw.wave !== 'string' || !WAVES.has(raw.wave)) return 'its waveform is not valid'
      if (!isFiniteNum(raw.freqHz) || raw.freqHz <= 0 || raw.freqHz > 1e9) return 'its frequency is not valid'
      if (!isFiniteNum(raw.amplitudeV) || !isFiniteNum(raw.offsetV)) return 'its amplitude or offset is not valid'
      if (!isFiniteNum(raw.outputOhms) || raw.outputOhms < 0) return 'its output resistance is not valid'
      const inst: Instrument = {
        kind: 'function-gen', id, netId: UNWIRED, wave: raw.wave as 'sine' | 'square' | 'triangle' | 'pulse',
        freqHz: raw.freqHz, amplitudeV: raw.amplitudeV, offsetV: raw.offsetV, outputOhms: raw.outputOhms,
      }
      if (isFiniteNum(raw.dutyPct) && raw.dutyPct >= 0 && raw.dutyPct <= 100) inst.dutyPct = raw.dutyPct
      return inst
    }
    case 'logic-input': {
      if (raw.level !== 0 && raw.level !== 1) return 'its level is not valid'
      if (!isFiniteNum(raw.vHigh) || raw.vHigh <= 0 || raw.vHigh > 1000) return 'its logic voltage is not valid'
      return { kind: 'logic-input', id, netId: UNWIRED, level: raw.level, vHigh: raw.vHigh }
    }
    case 'voltage-probe': {
      const color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : '#6f6'
      return { kind: 'voltage-probe', id, netId: UNWIRED, color }
    }
    case 'current-probe': {
      const color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : '#6f6'
      let ref = typeof raw.ref === 'string' ? raw.ref : ''
      if (ref !== '' && !partRefs.has(ref)) {
        notes.push(`Current probe ${id} was clamped on ${ref}, which is no longer on the board; its clamp is left unwired.`)
        ref = ''
      }
      const inst: Instrument = { kind: 'current-probe', id, ref, color }
      if (typeof raw.pad === 'string' && raw.pad.length <= 64 && ref !== '') inst.pad = raw.pad
      return inst
    }
    case 'potentiometer': {
      if (!isFiniteNum(raw.totalOhms) || raw.totalOhms <= 0 || raw.totalOhms > 1e12) return 'its resistance is not valid'
      if (!isFiniteNum(raw.wiperPct)) return 'its wiper position is not valid'
      const wiperPct = Math.min(1, Math.max(0, raw.wiperPct))
      if (raw.mode === 'divider') {
        return { kind: 'potentiometer', mode: 'divider', id, netHi: UNWIRED, netW: UNWIRED, netLo: UNWIRED, totalOhms: raw.totalOhms, wiperPct }
      }
      if (raw.mode !== 'rheostat') return 'its mode is not valid'
      return { kind: 'potentiometer', mode: 'rheostat', id, netA: UNWIRED, netW: UNWIRED, totalOhms: raw.totalOhms, wiperPct }
    }
    default:
      return 'its kind is not one this build knows'
  }
}

// --- restore plan ------------------------------------------------------------

/**
 * Map a parsed sidecar onto the board that just opened: resolve net names to ids,
 * drop overrides for parts and nets that are gone, rebuild instruments. Pure;
 * returns the plan plus notes on everything skipped.
 */
export function planRestore(
  sidecar: Sidecar,
  ctx: RestoreContext,
): { plan: RestorePlan; restored: number; notes: string[] } {
  const notes: string[] = []
  let restored = 0
  const netIdByName = new Map<string, number>()
  for (const n of ctx.nets) netIdByName.set(n.kicadName, n.id)

  const plan: RestorePlan = {
    leadPositions: new Map(),
    stubOverrides: new Map(),
    pinMapOverrides: new Map(),
    railOverrides: new Map(),
    userModels: new Map(),
  }

  // Ground.
  if (sidecar.ground) {
    if (sidecar.ground.net === null) {
      plan.ground = { netId: null }
      restored++
    } else {
      const id = netIdByName.get(sidecar.ground.net)
      if (id === undefined) {
        notes.push(`The saved ground net ${sidecar.ground.net} is not on this board; the suggested ground was kept.`)
      } else {
        plan.ground = { netId: id }
        if (sidecar.ground.lead) plan.leadPositions.set(GROUND_LEAD_KEY, sidecar.ground.lead)
        restored++
      }
    }
  }

  // Instruments.
  if (sidecar.instruments) {
    const out: Instrument[] = []
    const seen = new Set<string>()
    for (const entry of sidecar.instruments) {
      const inst = rebuildInstrument(entry.instrument, ctx.partRefs, notes)
      const label = typeof entry.instrument.id === 'string' ? entry.instrument.id : String(entry.instrument.kind)
      if (typeof inst === 'string') {
        notes.push(`Instrument ${label} was skipped: ${inst}.`)
        continue
      }
      if (!('id' in inst) || seen.has(inst.id)) {
        notes.push(`Instrument ${label} was skipped: its id is used twice.`)
        continue
      }
      seen.add(inst.id)
      // Fill the net fields from names.
      const target = inst as unknown as Record<string, unknown>
      const fields = netFields(inst)
      for (const { field, terminal } of fields) {
        const fromNets = entry.nets[field]
        const fromFlat = typeof entry.instrument[field] === 'string' ? (entry.instrument[field] as string) : undefined
        const name = fromNets ?? fromFlat
        if (name === undefined) continue
        const id = netIdByName.get(name)
        if (id === undefined) {
          notes.push(`Instrument ${inst.id}: net ${name} is not on this board; its ${terminal} lead is left unwired.`)
          continue
        }
        target[field] = id
        const pos = entry.leads[terminal]
        if (pos) plan.leadPositions.set(leadKey(inst.id, terminal), pos)
      }
      if (inst.kind === 'current-probe' && inst.ref !== '') {
        const pos = entry.leads.clamp
        if (pos) plan.leadPositions.set(leadKey(inst.id, 'clamp'), pos)
      }
      out.push(inst)
      restored++
    }
    plan.instruments = out
  }

  // Stubs.
  for (const [ref, mode] of Object.entries(sidecar.stubs ?? {})) {
    if (!ctx.partRefs.has(ref)) {
      notes.push(`The saved stub for ${ref} was dropped: ${ref} is not on this board.`)
      continue
    }
    plan.stubOverrides.set(ref, { kind: 'stub', mode })
    restored++
  }

  // Pin maps.
  for (const [ref, pm] of Object.entries(sidecar.pinMaps ?? {})) {
    if (!ctx.partRefs.has(ref)) {
      notes.push(`The saved pin map for ${ref} was dropped: ${ref} is not on this board.`)
      continue
    }
    plan.pinMapOverrides.set(ref, pm)
    restored++
  }

  // Rail overrides.
  for (const [net, volts] of Object.entries(sidecar.railOverrides ?? {})) {
    if (!netIdByName.has(net)) {
      notes.push(`The saved rail override for ${net} was dropped: that net is not on this board.`)
      continue
    }
    plan.railOverrides.set(net, volts)
    restored++
  }

  // User models.
  for (const [ref, model] of Object.entries(sidecar.userModels ?? {})) {
    if (!ctx.partRefs.has(ref)) {
      notes.push(`The saved model for ${ref} was dropped: ${ref} is not on this board.`)
      continue
    }
    plan.userModels.set(ref, model)
    restored++
  }

  return { plan, restored, notes }
}

/**
 * Parse and plan in one step: the only call the open flow needs. Never throws.
 * `plan` is null only when nothing is usable (unreadable).
 */
export function loadSidecar(text: string, ctx: RestoreContext): LoadOutcome {
  const parsed = parseSidecar(text)
  if (!parsed.sidecar) {
    return { status: parsed.status, plan: null, restored: 0, notes: parsed.notes }
  }
  try {
    const { plan, restored, notes } = planRestore(parsed.sidecar, ctx)
    return { status: parsed.status, plan, restored, notes: [...parsed.notes, ...notes] }
  } catch (err) {
    return {
      status: 'unreadable',
      plan: null,
      restored: 0,
      notes: [`The setup file could not be applied (${err instanceof Error ? err.message : String(err)}).`],
    }
  }
}

// --- capture (write side) -------------------------------------------------------

export interface SidecarSnapshot {
  appVersion?: string
  board: { fileName: string | null; sha256: string | null }
  nets: CircuitNet[]
  groundNetId: number | null
  instruments: Instrument[]
  leadPositions: Map<string, LeadPosition>
  stubOverrides: Map<string, UserStubOverride>
  pinMapOverrides: Map<string, PinMap>
  railOverrides: Map<string, number>
  userModels: Map<string, UserModelRecord>
}

function sortedRecord<T>(m: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of [...m.keys()].sort()) out[k] = m.get(k) as T
  return out
}

/** Build the v1 sidecar document from the live bench state. */
export function buildSidecar(s: SidecarSnapshot): Sidecar {
  const nameById = new Map<number, string>()
  for (const n of s.nets) nameById.set(n.id, n.kicadName)

  const sidecar: Sidecar = { format: SIDECAR_FORMAT, version: SIDECAR_VERSION }
  if (s.appVersion) sidecar.savedBy = `circsim ${s.appVersion}`
  const board: { fileName?: string; sha256?: string } = {}
  if (s.board.fileName) board.fileName = s.board.fileName
  if (s.board.sha256) board.sha256 = s.board.sha256
  if (Object.keys(board).length > 0) sidecar.board = board

  const groundName = s.groundNetId === null ? null : nameById.get(s.groundNetId) ?? null
  sidecar.ground = { net: groundName }
  const gLead = s.leadPositions.get(GROUND_LEAD_KEY)
  if (groundName !== null && gLead) sidecar.ground.lead = { x: gLead.x, y: gLead.y }

  const instruments: SidecarInstrument[] = []
  for (const inst of s.instruments) {
    if (inst.kind === 'ground-ref') continue
    const fields = netFields(inst)
    const skip = new Set(fields.map(f => f.field))
    const instrument: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(inst)) if (!skip.has(k)) instrument[k] = v
    const nets: Record<string, string> = {}
    const leads: Record<string, LeadPosition> = {}
    for (const { field, terminal } of fields) {
      const id = (inst as unknown as Record<string, number>)[field]
      const name = id === UNWIRED ? undefined : nameById.get(id)
      if (name === undefined) continue
      nets[field] = name
      const pos = s.leadPositions.get(leadKey(inst.id, terminal))
      if (pos) leads[terminal] = { x: pos.x, y: pos.y }
    }
    if (inst.kind === 'current-probe') {
      const pos = s.leadPositions.get(leadKey(inst.id, 'clamp'))
      if (pos && inst.ref !== '') leads.clamp = { x: pos.x, y: pos.y }
    }
    instruments.push({ instrument, nets, leads })
  }
  sidecar.instruments = instruments

  sidecar.stubs = {}
  for (const [ref, o] of [...s.stubOverrides].sort(([a], [b]) => (a < b ? -1 : 1))) sidecar.stubs[ref] = o.mode
  sidecar.pinMaps = sortedRecord(s.pinMapOverrides)
  sidecar.railOverrides = sortedRecord(s.railOverrides)
  sidecar.userModels = sortedRecord(s.userModels)
  return sidecar
}

/** Stable, human-diffable JSON text for a sidecar. */
export function serializeSidecar(sidecar: Sidecar): string {
  return JSON.stringify(sidecar, null, 2) + '\n'
}

/** True when a file in this state may be overwritten by autosave without a backup. */
export function overwriteIsSafe(status: SidecarStatus | 'absent'): boolean {
  return status === 'ok' || status === 'absent'
}

/** True when autosave may write at all (never over a newer-format or unreadable file). */
export function autosaveAllowed(status: SidecarStatus | 'absent'): boolean {
  return status !== 'newer' && status !== 'unreadable'
}
