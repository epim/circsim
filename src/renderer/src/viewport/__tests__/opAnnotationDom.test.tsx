/**
 * opAnnotationDom.test.tsx — M7 (F8)
 *
 * The Viewport's hidden DOM mirror of the op annotations must carry
 * `data-net-name` alongside `data-net-id`, so tooling and E2E tests can find a
 * net's voltage by NAME (answering "what is PACK+ at?" without id lookups).
 * Static render only — the Three.js scene mounts in effects, which don't run
 * under renderToStaticMarkup.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderToStaticMarkup } from 'react-dom/server'
import Viewport from '../Viewport'
import { parseBoard } from '../../../../core/kicad/board'

const fixturesDir = join(__dirname, '../../../../../fixtures')

describe('M7 F8 — op-annotation DOM mirror carries data-net-name', () => {
  it('each annotation span has data-net-id AND data-net-name', () => {
    const board = parseBoard(
      readFileSync(join(fixturesDir, 'fixture-rc.kicad_pcb'), 'utf-8'),
    )
    const vin = [...board.netById.values()].find(n => n.name === 'VIN')!
    const out = [...board.netById.values()].find(n => n.name === 'OUT')!

    const html = renderToStaticMarkup(
      <Viewport board={board} netVoltages={new Map([[vin.id, 5], [out.id, 2.5]])} />,
    )
    expect(html).toContain('data-testid="op-annotation"')
    expect(html).toContain(`data-net-id="${vin.id}"`)
    expect(html).toContain('data-net-name="VIN"')
    expect(html).toContain('data-net-name="OUT"')
  })
})
