/**
 * renderer/store/reportInput.ts - turns the live store state into the plain
 * ReportInput that src/core/report renders (issue #27).
 *
 * Kept out of core/report because it reads AppState (the renderer's store); the
 * report itself stays pure data in, text out so the headless CLI can build the
 * same input from a board without a renderer.
 */

import type { Instrument } from '../../../core/spicegen/instruments'
import { UNWIRED } from '../../../core/spicegen/instruments'
import { kicadFormatVersion, type ReportInput, type ReportInstrument } from '../../../core/report/report'
import { leadKey, GROUND_LEAD_KEY, type LeadPosition } from '../../../core/persist/sidecar'
import { opCaveatMessage, type AppState } from './appStore'

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6)))
}

function describeLeads(
  instId: string,
  terminals: string[],
  positions: Map<string, LeadPosition>,
): string {
  const out: string[] = []
  for (const t of terminals) {
    const p = positions.get(leadKey(instId, t))
    if (p) out.push(`${t} lead at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) mm`)
  }
  return out.join('; ')
}

function describeInstrument(
  inst: Instrument,
  netName: (id: number) => string,
  positions: Map<string, LeadPosition>,
): ReportInstrument | null {
  const net = (id: number): string => (id === UNWIRED ? 'unwired' : netName(id))
  switch (inst.kind) {
    case 'ground-ref':
      return null
    case 'dc-supply':
      return {
        id: inst.id,
        kind: inst.kind,
        connections: `net ${net(inst.netId)}`,
        settings: `${fmt(inst.volts)} V, ${fmt(inst.seriesOhms)} ohm series`,
        leadPositions: describeLeads(inst.id, ['net'], positions),
      }
    case 'function-gen':
      return {
        id: inst.id,
        kind: inst.kind,
        connections: `net ${net(inst.netId)}`,
        settings:
          `${inst.wave} ${fmt(inst.freqHz)} Hz, ${fmt(inst.amplitudeV)} V amplitude, ` +
          `${fmt(inst.offsetV)} V offset, ${fmt(inst.outputOhms)} ohm output`,
        leadPositions: describeLeads(inst.id, ['net'], positions),
      }
    case 'logic-input':
      return {
        id: inst.id,
        kind: inst.kind,
        connections: `net ${net(inst.netId)}`,
        settings: `level ${inst.level}, ${fmt(inst.vHigh)} V high`,
        leadPositions: describeLeads(inst.id, ['net'], positions),
      }
    case 'voltage-probe':
      return {
        id: inst.id,
        kind: inst.kind,
        connections: `net ${net(inst.netId)}`,
        settings: '',
        leadPositions: describeLeads(inst.id, ['net'], positions),
      }
    case 'current-probe':
      return {
        id: inst.id,
        kind: inst.kind,
        connections: inst.ref === '' ? 'unwired' : `clamp on ${inst.ref}${inst.pad ? ` pad ${inst.pad}` : ''}`,
        settings: '',
        leadPositions: describeLeads(inst.id, ['clamp'], positions),
      }
    case 'potentiometer': {
      const hi = inst.mode === 'rheostat' ? inst.netA : inst.netHi
      const conn =
        inst.mode === 'rheostat'
          ? `A ${net(hi)}, W ${net(inst.netW)}`
          : `A ${net(hi)}, W ${net(inst.netW)}, Lo ${net(inst.netLo)}`
      return {
        id: inst.id,
        kind: inst.kind,
        connections: conn,
        settings: `${inst.mode}, ${fmt(inst.totalOhms)} ohm, wiper ${fmt(inst.wiperPct * 100)}%`,
        leadPositions: describeLeads(inst.id, inst.mode === 'rheostat' ? ['A', 'W'] : ['A', 'W', 'Lo'], positions),
      }
    }
  }
}

export interface ReportMeta {
  appVersion: string
  /** ISO 8601 timestamp. */
  generatedAt: string
}

/** Snapshot the store into a ReportInput. */
export function buildReportInput(s: AppState, meta: ReportMeta): ReportInput {
  const nameById = new Map<number, string>()
  for (const n of s.circuit?.nets ?? []) nameById.set(n.id, n.kicadName)
  const netName = (id: number): string => nameById.get(id) ?? `net ${id}`

  const instruments: ReportInstrument[] = []
  for (const inst of s.instruments) {
    const row = describeInstrument(inst, netName, s.leadPositions)
    if (row) instruments.push(row)
  }

  let groundNet: string | null = s.groundNetId === null ? null : netName(s.groundNetId)
  const gLead = s.leadPositions.get(GROUND_LEAD_KEY)
  if (groundNet !== null && gLead) groundNet += ` (lead at (${gLead.x.toFixed(2)}, ${gLead.y.toFixed(2)}) mm)`

  const partValue = new Map<string, string>()
  for (const p of s.circuit?.parts ?? []) partValue.set(p.ref, p.value)

  const opRows: { net: string; volts: number }[] = []
  if (s.opVoltages) {
    for (const [id, volts] of s.opVoltages) {
      const name = nameById.get(id)
      if (name !== undefined) opRows.push({ net: name, volts })
    }
  }

  return {
    generatedAt: meta.generatedAt,
    appVersion: meta.appVersion,
    board: {
      fileName: s.project.boardFileName,
      sha256: s.project.boardSha256,
      kicadVersion: s.project.boardText ? kicadFormatVersion(s.project.boardText) : null,
    },
    schematicFileName: s.project.schematicFileName,
    groundNet,
    instruments,
    stubOverrides: [...s.stubOverrides].map(([ref, o]) => [ref, o.mode] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    pinMapOverrides: [...s.pinMapOverrides].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    railOverrides: [...s.railOverrides].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    userModels: [...s.userModels]
      .map(([ref, m]) => ({ ref, mpn: m.mpn, subcktName: m.subcktName, provenance: m.provenance }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    parts: s.resolutions.map(r => ({ ref: r.ref, value: partValue.get(r.ref) ?? '', resolution: r })),
    op: s.opVoltages
      ? {
          rows: opRows,
          caveat: s.opCaveat ? opCaveatMessage(s.opCaveat.method) : null,
          stale: s.opVoltagesStale,
        }
      : null,
    critic: s.criticReport,
  }
}
