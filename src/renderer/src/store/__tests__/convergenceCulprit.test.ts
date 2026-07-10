/**
 * convergenceCulprit.test.ts — F2
 *
 * ngspice's transient-abort text names the deck element ("trouble with
 * mpmos_gen-instance m_q7") or node ("trouble with node vdrain") it struggled
 * with. These tests cover the mapping back to human refdes / KiCad net names:
 *   - instance → refdes across every deck naming shape generateDeck emits
 *     (m_q7, x_u2, d_d3, vsense_d1, a_u3_0, subckt-internal m.x_u2.m1)
 *   - node → net (spiceNode → kicadName)
 *   - absent/garbage text → null, never a crash
 * Plus the store integration: convergenceFailure events carry the culprit on
 * the convergenceCard.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseConvergenceCulprit } from '../convergenceCulprit'
import type { Circuit, Part } from '../../../../core/netlist/extract'
import { createAppStore } from '../appStore'
import { createMockSimClient } from '../../ipc/simClient'

const fixturesDir = join(__dirname, '../../../../../fixtures')

function part(ref: string, value = ''): Part {
  return { ref, value, libId: 'test:lib', layer: 'F', padNet: new Map(), properties: {} }
}

function circuitWith(parts: Part[], nets: { id: number; kicadName: string; spiceNode: string }[] = []): Circuit {
  return {
    parts,
    nets: nets.map(n => ({ ...n, padRefs: [] })),
    warnings: [],
  }
}

describe('parseConvergenceCulprit — instance → refdes', () => {
  const circuit = circuitWith([
    part('Q7', 'NCE4012S'),
    part('Q1', '2N3904'),
    part('U2', 'TL431'),
    part('D3', 'SMAJ24A'),
    part('D1'),
    part('U3', '74HC00'),
  ])

  it('MOSFET instance: "trouble with mpmos_gen-instance m_q7" → Q7 (NCE4012S)', () => {
    const c = parseConvergenceCulprit(
      'doAnalyses: TRAN:  Timestep too small; time = 1.2e-05, timestep = 1e-14: trouble with mpmos_gen-instance m_q7',
      circuit,
    )
    expect(c).toEqual({ kind: 'part', label: 'Q7', detail: 'NCE4012S' })
  })

  it('subckt instance: "trouble with instance x_u2" → U2', () => {
    const c = parseConvergenceCulprit('trouble with instance x_u2', circuit)
    expect(c).toEqual({ kind: 'part', label: 'U2', detail: 'TL431' })
  })

  it('diode instance: d_d3 → D3', () => {
    const c = parseConvergenceCulprit('trouble with dio-instance d_d3', circuit)
    expect(c).toEqual({ kind: 'part', label: 'D3', detail: 'SMAJ24A' })
  })

  it('sense-source instance: vsense_d1 → D1 (no value → no detail)', () => {
    const c = parseConvergenceCulprit('trouble with vsrc-instance vsense_d1', circuit)
    expect(c).toEqual({ kind: 'part', label: 'D1', detail: undefined })
  })

  it('xspice gate instance with index suffix: a_u3_0 → U3', () => {
    const c = parseConvergenceCulprit('trouble with d_nand-instance a_u3_0', circuit)
    expect(c).toEqual({ kind: 'part', label: 'U3', detail: '74HC00' })
  })

  it('subckt-internal device: m.x_u2.m1 → U2', () => {
    const c = parseConvergenceCulprit('trouble with mos1-instance m.x_u2.m1', circuit)
    expect(c).toEqual({ kind: 'part', label: 'U2', detail: 'TL431' })
  })

  it('longest refdes wins: m_q71 must NOT match Q7 or Q1', () => {
    const withQ71 = circuitWith([part('Q7', 'A'), part('Q1', 'B'), part('Q71', 'C')])
    const c = parseConvergenceCulprit('trouble with mpmos-instance m_q71', withQ71)
    expect(c).toEqual({ kind: 'part', label: 'Q71', detail: 'C' })
  })

  it('stub-resistor instance with multi-segment prefix: r_stub_q7_0 → Q7', () => {
    // generateDeck names unresolved-part stubs r_stub_<ref>_<i> — exactly the
    // parts most likely to be the convergence trouble on a real board. The
    // prefix contains an underscore, which the first parser version rejected
    // (review finding: the culprit banner named nobody for stubbed parts).
    const c = parseConvergenceCulprit('trouble with res-instance r_stub_q7_0', circuit)
    expect(c).toEqual({ kind: 'part', label: 'Q7', detail: 'NCE4012S' })
  })

  it('multi-segment prefix still respects the refdes boundary: r_stub_q71_0 ↛ Q7', () => {
    const withQ71 = circuitWith([part('Q7', 'A'), part('Q71', 'C')])
    const c = parseConvergenceCulprit('trouble with res-instance r_stub_q71_0', withQ71)
    expect(c).toEqual({ kind: 'part', label: 'Q71', detail: 'C' })
  })
})

describe('parseConvergenceCulprit — node → net', () => {
  const circuit = circuitWith(
    [],
    [
      { id: 1, kicadName: 'VDRAIN', spiceNode: 'vdrain' },
      { id: 2, kicadName: '/sig/OUT', spiceNode: 'sig_out' },
    ],
  )

  it('"trouble with node vdrain" → net VDRAIN', () => {
    const c = parseConvergenceCulprit(
      'TRAN: Timestep too small; trouble with node vdrain',
      circuit,
    )
    expect(c).toEqual({ kind: 'net', label: 'VDRAIN' })
  })

  it('unmapped node name is still surfaced verbatim', () => {
    const c = parseConvergenceCulprit('trouble with node n42', circuit)
    expect(c).toEqual({ kind: 'net', label: 'n42' })
  })
})

describe('parseConvergenceCulprit — robustness (no crash)', () => {
  it('abort text without a culprit → null', () => {
    const circuit = circuitWith([part('Q7')])
    expect(parseConvergenceCulprit('TRAN: Timestep too small; time = 1e-5', circuit)).toBeNull()
  })

  it('instance that maps to no known part → null', () => {
    const circuit = circuitWith([part('Q7')])
    expect(parseConvergenceCulprit('trouble with x-instance m_q99', circuit)).toBeNull()
  })

  it('empty detail / missing circuit → null', () => {
    expect(parseConvergenceCulprit('', circuitWith([]))).toBeNull()
    expect(parseConvergenceCulprit('trouble with instance m_q7', null)).toBeNull()
    expect(parseConvergenceCulprit('trouble with instance m_q7', undefined)).toBeNull()
  })
})

describe('store integration — convergenceCard.culprit', () => {
  it('a convergenceFailure naming an instance enriches the card with the refdes', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )

    mock.emit({
      type: 'convergenceFailure',
      detail: 'TRAN:  Timestep too small; trouble with res-instance r_r1',
    })

    const card = store.getState().convergenceCard
    expect(card).not.toBeNull()
    expect(card!.culprit).toEqual({
      kind: 'part',
      label: 'R1',
      detail: expect.any(String),
    })
  })

  it('a convergenceFailure naming a node enriches the card with the net name', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )

    mock.emit({
      type: 'convergenceFailure',
      detail: 'TRAN:  Timestep too small; trouble with node out',
    })

    expect(store.getState().convergenceCard!.culprit).toEqual({ kind: 'net', label: 'OUT' })
  })

  it('a convergenceFailure with no culprit keeps culprit null (no crash)', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    mock.emit({ type: 'convergenceFailure', detail: 'no convergence in iter' })
    expect(store.getState().convergenceCard!.culprit).toBeNull()
  })

  it('a later culprit-less convergenceFailure does not wipe an earlier identification', () => {
    // One abort can emit several matching lines; typically only the first
    // names the culprit ("trouble with … r_r1") and the wind-down prints a
    // bare "no convergence". The card is last-writer-wins, so it must carry
    // the previous culprit forward when the new text parses to nothing.
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )

    mock.emit({
      type: 'convergenceFailure',
      detail: 'TRAN:  Timestep too small; trouble with res-instance r_r1',
    })
    mock.emit({ type: 'convergenceFailure', detail: 'no convergence' })

    const card = store.getState().convergenceCard
    expect(card!.rawDetail).toBe('no convergence')
    expect(card!.culprit).toEqual({ kind: 'part', label: 'R1', detail: expect.any(String) })
  })

  it('the kept culprit is cleared with the card on dismiss (no leak across runs)', () => {
    const mock = createMockSimClient()
    const store = createAppStore({ simClient: mock })
    store
      .getState()
      .openBoardFromText(
        readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
        'fixture-rc.kicad_pcb',
      )
    mock.emit({
      type: 'convergenceFailure',
      detail: 'trouble with res-instance r_r1',
    })
    store.getState().dismissConvergenceCard()
    expect(store.getState().convergenceCard).toBeNull()

    mock.emit({ type: 'convergenceFailure', detail: 'no convergence' })
    expect(store.getState().convergenceCard!.culprit).toBeNull()
  })
})
