/**
 * Store wiring for issues #4, #5, #6, #7: ngspice complaints about a part
 * become that part's status, a BOM that does nothing says so in the log, and
 * notes on resolved parts (BOM changes, polarity guesses) reach the log.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'
import type { LibraryEntry } from '../../../../core/models/types'

const fixturesDir = join(__dirname, '../../../../../fixtures')
const rcBoard = readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8')

describe('ngspice log lines to per-part status', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb')
  })

  const statusOf = (ref: string) => store.getState().resolutions.find(r => r.ref === ref)?.status

  it('control: both parts start ok', () => {
    expect(statusOf('R1')).toBe('ok')
    expect(statusOf('R2')).toBe('ok')
  })

  it('an "ignored!" warning (level warn) demotes the named part and marks the deck dirty', () => {
    store.setState({ deckDirty: false })
    store.getState().ingestEvent({
      type: 'log',
      level: 'warn',
      text: "stderr Warning: 'r_r1 vin out' is not a valid resistor instance line, ignored!",
    })
    expect(statusOf('R1')).toBe('unresolved')
    expect(statusOf('R2')).toBe('ok')
    expect(store.getState().resolutions.find(r => r.ref === 'R1')?.model).toBeUndefined()
    expect(store.getState().deckDirty).toBe(true)
  })

  it('a "could not find a valid modelname" error names its part from the card on the line before', () => {
    const { ingestEvent } = store.getState()
    ingestEvent({ type: 'log', level: 'error', text: 'stderr Error on line 4 or its substitute:' })
    ingestEvent({ type: 'log', level: 'info', text: 'stderr r_r2 out 0' })
    ingestEvent({ type: 'log', level: 'info', text: 'stderr could not find a valid modelname' })
    expect(statusOf('R2')).toBe('unresolved')
    expect(statusOf('R1')).toBe('ok')
    const warnings = store.getState().resolutions.find(r => r.ref === 'R2')!.warnings
    expect(warnings.some(w => /could not find a valid modelname/.test(w))).toBe(true)
  })

  it('unrelated log lines change nothing', () => {
    const before = store.getState().resolutions
    store.getState().ingestEvent({ type: 'log', level: 'info', text: 'stdout Circuit: * circsim deck' })
    expect(store.getState().resolutions).toBe(before)
  })

  it('an unknown element in a warning changes nothing', () => {
    const before = store.getState().resolutions
    store.getState().ingestEvent({
      type: 'log',
      level: 'warn',
      text: "stderr Warning: 'r_zz9 a b' is not a valid resistor instance line, ignored!",
    })
    expect(store.getState().resolutions).toBe(before)
  })
})

describe('BOM import is never silent', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb')
  })

  const logText = () => store.getState().logLines.map(l => l.text).join('\n')

  it('a BOM that fails to parse logs the parser error as a warning', () => {
    store.getState().setBomFromText('Foo,Bar\n1,2\n')
    expect(logText()).toMatch(/BOM: No ref column/)
    expect(store.getState().logLines.some(l => l.level === 'warn' && l.text.startsWith('BOM:'))).toBe(true)
  })

  it('rows that match no board ref are counted in the log', () => {
    store.getState().setBomFromText('Reference,Value\nR1,10k\nR99,1k\n')
    expect(logText()).toMatch(/BOM: 1 of 2 rows name refs that are not on the board \(R99\)/)
  })

  it('a clean BOM logs nothing', () => {
    store.getState().setBomFromText('Reference,Value\nR1,10k\n')
    expect(logText()).not.toMatch(/BOM:/)
  })

  it('a BOM value reaches resolution through the store', () => {
    store.getState().setBomFromText('Reference,Value\nR1,22k\n')
    const r1 = store.getState().resolutions.find(r => r.ref === 'R1')
    expect(r1?.model).toMatchObject({ kind: 'primitive' })
    expect(r1?.model?.kind === 'primitive' ? r1.model.card : '').toMatch(/ 22000$/)
  })

  it('a BOM given at open time is reported against the opened board', () => {
    const s = createAppStore({ simClient: createMockSimClient() })
    s.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb', { bomText: 'Reference,Value\nQ7,NPN\n' })
    expect(s.getState().logLines.some(l => /BOM: 1 of 1 rows name refs that are not on the board \(Q7\)/.test(l.text))).toBe(true)
  })
})

// A part that resolves ok has no Model Doctor card (the Doctor lists parts whose
// status is not ok), so what the BOM did to it (issue #4) and a polarity guess on
// it (issue #5) are stated in the sim log, once, when the file is loaded.
describe('notes on resolved parts reach the sim log', () => {
  const library = (
    JSON.parse(readFileSync(join(process.cwd(), 'resources', 'models', 'index.json'), 'utf8')) as {
      entries: LibraryEntry[]
    }
  ).entries

  // fixture-rc with R2 swapped for D8, the lantern's SS14 on its real EasyEDA footprint.
  const at = rcBoard.lastIndexOf('(footprint "Resistor_SMD:R_0805_2012Metric"')
  const jlcDiodeBoard =
    rcBoard.slice(0, at) +
    rcBoard
      .slice(at)
      .replace('Resistor_SMD:R_0805_2012Metric', 'SMA_L4.2-W2.6-LS5.0-RD_1')
      .replace('reference "R2"', 'reference "D8"')
      .replace('value "10k"', 'value "SS14"')

  it('a BOM that changes a resolved part names the part and the change', () => {
    const s = createAppStore({ simClient: createMockSimClient() })
    s.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb')
    s.getState().setBomFromText('Reference,Value\nR1,22k\n')
    expect(s.getState().resolutions.find(r => r.ref === 'R1')?.status).toBe('ok')
    expect(s.getState().logLines.map(l => l.text)).toContain(
      'BOM: R1: value "22k" from the BOM replaces the board value "10k"',
    )
  })

  it('a BOM given at open time names the parts it changed', () => {
    const s = createAppStore({ simClient: createMockSimClient() })
    s.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb', { bomText: 'Reference,Value\nR2,1k\n' })
    expect(s.getState().logLines.map(l => l.text)).toContain(
      'BOM: R2: value "1k" from the BOM replaces the board value "10k"',
    )
  })

  it('opening a JLC-footprint diode without its schematic logs the polarity guess as a warning', () => {
    const s = createAppStore({ simClient: createMockSimClient(), library })
    s.getState().openBoardFromText(jlcDiodeBoard, 'jlc-diode.kicad_pcb')
    expect(s.getState().resolutions.find(r => r.ref === 'D8')?.status).toBe('ok')
    const lines = s.getState().logLines.filter(l => l.text.startsWith('D8: pinmap-unverified: polarity of "SMA_L4.2'))
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('warn')
  })

  it('a board with no polarity guess and no BOM logs nothing of the kind', () => {
    const s = createAppStore({ simClient: createMockSimClient(), library })
    s.getState().openBoardFromText(rcBoard, 'fixture-rc.kicad_pcb')
    expect(s.getState().logLines.some(l => /pinmap-unverified|^BOM:/.test(l.text))).toBe(false)
  })
})
