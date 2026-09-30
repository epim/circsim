/**
 * Store wiring for issues #4, #6, #7: ngspice complaints about a part become
 * that part's status, and a BOM that does nothing says so in the log.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'

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
