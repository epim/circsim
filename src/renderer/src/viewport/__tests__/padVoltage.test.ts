import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoard } from '../../../../core/kicad/board'
import { createPadVoltageOverlay, padVoltageRange } from '../padVoltage'

describe('physical pad voltage overlay', () => {
  it('scales to pad values, including ground lift and excluding missing/nonfinite data', () => {
    expect(padVoltageRange({ R1: { '1': 4.8, '2': 0.3 }, R2: { '1': NaN } })).toEqual({ min: 0.3, max: 4.8 })
    expect(padVoltageRange({})).toBeNull()
  })
  it('colors two pads on one net independently and clears missing values between solves', () => {
    const board = parseBoard(readFileSync(join(__dirname, '../../../../../fixtures/fixture-rc.kicad_pcb'), 'utf8'))
    const overlay = createPadVoltageOverlay(board)
    overlay.setVoltages({ R1: { '1': 5, '2': 0.3 }, R2: { '1': 2.5 } }, { min: 0, max: 5 })
    overlay.setVisible(true)
    expect(overlay.group.visible).toBe(true)
    expect(overlay.colorFor('R1', '2')).not.toEqual(overlay.colorFor('R2', '1'))
    expect(overlay.colorFor('R2', '1')).not.toBeNull()
    overlay.setVoltages({ R1: { '1': 5 } }, { min: 0, max: 5 })
    expect(overlay.colorFor('R2', '1')).toBeNull()
    overlay.setVoltages(null, null)
    expect(overlay.group.visible).toBe(false)
    overlay.dispose()
  })
})
