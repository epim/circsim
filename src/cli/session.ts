/**
 * src/cli/session.ts
 *
 * Board-to-SolveInputs for the headless CLI (issue #28): what the renderer store
 * does in openBoardFromText + reResolve + the auto-supply, without a store. The
 * CLI never modifies a design file; every input is read-only.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { parseBoard } from '../core/kicad/board'
import { parseSchematicSimData, type SchematicSimData } from '../core/kicad/schematic'
import type { BoardModel } from '../core/kicad/types'
import { resolveAll } from '../core/models/resolve'
import type { Resolution } from '../core/models/types'
import { extract, suggestGround, suggestSupplies, type Circuit, type CircuitNet } from '../core/netlist/extract'
import type { Instrument } from '../core/spicegen/instruments'
import { buildSolveInputs, type SolveInputs } from '../core/solve'
import type { CliOptions } from './args'
import type { ModelLibrary } from './modelLibrary'

/** A failure the user can fix (bad path, unknown net); reported and exit 2. */
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

export interface Session {
  boardPath: string
  boardName: string
  schematicPath: string | null
  board: BoardModel
  circuit: Circuit
  resolutions: Resolution[]
  /** Null when no ground net could be designated. */
  groundNetId: number | null
  /** Why no solve can run (no ground, no supply), or null when one can. */
  cannotSolve: string | null
  instruments: Instrument[]
  /** Human-readable supply descriptions for reports. */
  supplies: { net: string; netId: number; volts: number; source: 'flag' | 'auto' }[]
  inputs: SolveInputs | null
}

const AUTO_SUPPLY_ID = 'auto-supply'

export function openSession(opts: CliOptions, library: ModelLibrary, cwd: string): Session {
  const boardPath = resolve(cwd, opts.board)
  let boardText: string
  try {
    boardText = readFileSync(boardPath, 'utf8')
  } catch (err) {
    throw new InputError(`cannot read board ${boardPath}: ${(err as Error).message}`)
  }

  let board: BoardModel
  try {
    board = parseBoard(boardText)
  } catch (err) {
    const e = err as { message?: string; line?: number; col?: number }
    const where = e.line !== undefined ? ` (line ${e.line}${e.col !== undefined ? `, col ${e.col}` : ''})` : ''
    throw new InputError(`cannot parse ${boardPath}: ${e.message ?? String(err)}${where}`)
  }

  let schematicPath: string | null = null
  let schematicSimData: SchematicSimData | undefined
  if (opts.schematic) {
    schematicPath = opts.schematic.path
      ? resolve(cwd, opts.schematic.path)
      : join(dirname(boardPath), `${basename(boardPath, extname(boardPath))}.kicad_sch`)
    if (!existsSync(schematicPath)) {
      throw new InputError(`schematic not found: ${schematicPath}`)
    }
    try {
      schematicSimData = parseSchematicSimData(readFileSync(schematicPath, 'utf8'))
    } catch (err) {
      throw new InputError(`cannot parse schematic ${schematicPath}: ${(err as Error).message}`)
    }
  }

  // Extract once with no ground to run the ground heuristic, then again with the
  // designated ground so its spiceNode is "0" (generateDeck relies on that).
  const probe = extract(board)
  let groundNetId: number | null
  if (opts.ground !== undefined) {
    groundNetId = findNet(probe.nets, opts.ground, '--ground').id
  } else {
    groundNetId = suggestGround(probe.nets)?.id ?? null
  }
  const circuit = groundNetId !== null ? extract(board, { groundNetId }) : probe

  const resolutions = resolveAll(
    circuit,
    schematicSimData,
    undefined,
    library.entries.length > 0 ? library.entries : undefined,
  )

  const instruments: Instrument[] = []
  const supplies: Session['supplies'] = []
  let cannotSolve: string | null = null

  if (groundNetId === null) {
    cannotSolve = 'no ground net found (none named GND, AGND, DGND, VSS or 0V); pass --ground NET'
  } else if (circuit.parts.length === 0 || circuit.nets.length === 0) {
    cannotSolve = 'the board has no parts or no nets to simulate'
  } else {
    if (opts.supplies.length > 0) {
      opts.supplies.forEach((spec, i) => {
        const net = findNet(circuit.nets, spec.net, '--supply')
        if (net.id === groundNetId) throw new InputError(`--supply ${spec.net}: that is the ground net`)
        instruments.push({ kind: 'dc-supply', id: `cli-supply-${i + 1}`, netId: net.id, volts: spec.volts, seriesOhms: 0.1 })
        supplies.push({ net: net.kicadName, netId: net.id, volts: spec.volts, source: 'flag' })
      })
    } else {
      // The GUI's open-time default: 5 V through 0.1 ohm on the top suggested rail.
      const top = suggestSupplies(circuit.nets).find((n) => n.id !== groundNetId)
      if (top) {
        instruments.push({ kind: 'dc-supply', id: AUTO_SUPPLY_ID, netId: top.id, volts: 5, seriesOhms: 0.1 })
        supplies.push({ net: top.kicadName, netId: top.id, volts: 5, source: 'auto' })
      } else {
        cannotSolve = 'no supply rail found (no net named like VCC, VDD, +5V, VIN); pass --supply NET=VOLTS'
      }
    }
  }

  const inputs =
    cannotSolve === null && groundNetId !== null
      ? buildSolveInputs(board, circuit, resolutions, instruments, groundNetId, {
          title: basename(boardPath),
          modelTexts: library.texts,
          copperAware: (opts.command === 'audit' && !opts.noOp) || opts.copper,
        })
      : null

  return {
    boardPath,
    boardName: basename(boardPath),
    schematicPath,
    board,
    circuit,
    resolutions,
    groundNetId,
    cannotSolve,
    instruments,
    supplies,
    inputs,
  }
}

/**
 * Find a net by name: exact KiCad name, then case-insensitive, then a unique
 * leaf match ("VCC" finds "/Power/VCC"). Ambiguous or missing is an InputError.
 */
export function findNet(nets: CircuitNet[], name: string, flag: string): CircuitNet {
  const exact = nets.find((n) => n.kicadName === name)
  if (exact) return exact
  const lower = name.toLowerCase()
  const ci = nets.filter((n) => n.kicadName.toLowerCase() === lower)
  if (ci.length === 1) return ci[0]
  const leaf = nets.filter((n) => n.kicadName.toLowerCase().split('/').pop() === lower)
  if (leaf.length === 1) return leaf[0]
  if (ci.length > 1 || leaf.length > 1) {
    const names = (ci.length > 1 ? ci : leaf).map((n) => n.kicadName).join(', ')
    throw new InputError(`${flag} ${name}: ambiguous, matches ${names}`)
  }
  throw new InputError(`${flag} ${name}: no such net (nets: ${nets.map((n) => n.kicadName).join(', ')})`)
}
