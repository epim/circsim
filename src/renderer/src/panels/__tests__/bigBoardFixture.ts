/**
 * bigBoardFixture.ts: a generated large-board fixture for the list-panel tests
 * (issue #72). The bundled sample boards have 4 and 8 nets, so list scale was
 * argued rather than measured. This builds a deterministic Circuit plus
 * Resolutions at any size (default 200 parts, the design target is several
 * hundred) so a test can count what the panels actually put in the DOM.
 *
 * Nothing here is a board file: it is plain data, so no third-party design is
 * committed.
 */

import type { Circuit, CircuitNet, Part } from '../../../../core/netlist/extract'
import type { Resolution } from '../../../../core/models/types'

export interface BigBoard {
  circuit: Circuit
  resolutions: Resolution[]
  /** Refs by status, for assertions. */
  unresolved: string[]
  stubbed: string[]
  documentedOpen: string[]
  ok: string[]
}

const RAILS = ['GND', 'VCC', '+5V', '+3V3', '/Power/VBUS', '/VIN_CHG', '/VBUS_SNS']

/** Build `nParts` parts over `nNets` nets. Deterministic (no randomness). */
export function makeBigBoard(nParts = 200, nNets = 300): BigBoard {
  const nets: CircuitNet[] = []
  // net 0 is the SPICE ground placeholder the extractor emits; panels skip it.
  nets.push({ id: 0, kicadName: '', spiceNode: '0', padRefs: [] })
  for (let i = 0; i < nNets; i++) {
    const name = i < RAILS.length ? RAILS[i] : `/sig/NET${i}`
    nets.push({ id: i + 1, kicadName: name, spiceNode: `n${i + 1}`, padRefs: [] })
  }

  const parts: Part[] = []
  const resolutions: Resolution[] = []
  const out: BigBoard = {
    circuit: { nets, parts, warnings: [] },
    resolutions,
    unresolved: [],
    stubbed: [],
    documentedOpen: [],
    ok: [],
  }

  for (let i = 0; i < nParts; i++) {
    const prefix = i % 10 === 0 ? 'U' : i % 3 === 0 ? 'Q' : 'R'
    const ref = `${prefix}${i + 1}`
    // Two pads per part; the first 40 parts all touch the rails so the rails
    // carry a high pad-degree (a real power net fans out to many pads).
    const a = i < 40 ? 2 + (i % 4) : 1 + ((i * 7) % nNets)
    const b = 1 + ((i * 13 + 5) % nNets)
    parts.push({
      ref,
      value: prefix === 'R' ? '10k' : prefix === 'Q' ? '2N7002' : `MCU${i}`,
      libId: 'test:lib',
      layer: 'F',
      padNet: new Map([
        ['1', a],
        ['2', b],
      ]),
      properties: {},
    })
    nets[a].padRefs.push({ ref, pad: '1' })
    nets[b].padRefs.push({ ref, pad: '2' })

    // Status mix: 5% unresolved, 5% stubbed, 3% documented-open, the rest ok.
    const m = i % 100
    if (m < 5) {
      resolutions.push({ ref, status: 'unresolved', tier: 6, warnings: [] })
      out.unresolved.push(ref)
    } else if (m < 10) {
      resolutions.push({
        ref,
        status: 'stubbed',
        tier: 5,
        warnings: [],
        model: { kind: 'stub', mode: 'open' },
      })
      out.stubbed.push(ref)
    } else if (m < 13) {
      resolutions.push({
        ref,
        status: 'documented-open',
        tier: 3,
        warnings: [],
        model: { kind: 'stub', mode: 'open' },
        note: 'Intentionally left open.',
      })
      out.documentedOpen.push(ref)
    } else {
      resolutions.push({
        ref,
        status: 'ok',
        tier: 2,
        warnings: [],
        model: { kind: 'primitive', card: `r_${ref.toLowerCase()} a b 10k` },
      })
      out.ok.push(ref)
    }
  }
  return out
}
