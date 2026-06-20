/**
 * core/live/__tests__/coach.test.ts
 *
 * TDD for the "why isn't it glowing?" coach. Each test wires up a tiny live
 * snapshot (LEDs + currents + optional voltages) and asserts the plain-language
 * note picked for each case, that lit LEDs are silent, and that the output is
 * deterministic.
 */

import { describe, it, expect } from 'vitest'
import { diagnoseDarkLeds, DEFAULT_LED_ON_THRESHOLD_A, type DiagnoseInput } from '../coach'

// A single LED D1 with anode on net 1, cathode on net 2.
const D1 = { ref: 'D1', anodeNet: 1, cathodeNet: 2 }

describe('diagnoseDarkLeds', () => {
  it('case 1: dark LED with no supply → "nothing is powering the board"', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map(), // no current measured
      hasSupply: false,
    }
    const notes = diagnoseDarkLeds(input)
    expect(notes).toHaveLength(1)
    expect(notes[0].ref).toBe('D1')
    expect(notes[0].severity).toBe('info')
    expect(notes[0].detail).toBe(
      'Nothing is powering the board yet — attach a supply (and ground) to light D1.',
    )
    // Plain language only: no SPICE/jargon or node numbers leak through.
    expect(notes[0].detail).not.toMatch(/net|node|\bV\d|spice|rpot|@d_/i)
  })

  it('case 2: reverse-biased (anode V < cathode V) → "in backwards"', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map([['D1', 0]]),
      netVoltages: new Map([
        [1, 0], // anode held low
        [2, 5], // cathode held high → reverse biased
      ]),
      hasSupply: true,
    }
    const notes = diagnoseDarkLeds(input)
    expect(notes).toHaveLength(1)
    expect(notes[0].detail).toBe(
      "D1 looks like it's in backwards — current would flow the wrong way through it.",
    )
  })

  it('case 3: powered, oriented right, but no current → generic "isn\'t lit"', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map([['D1', 1e-9]]),
      netVoltages: new Map([
        [1, 5], // anode higher than cathode → not reverse biased
        [2, 0],
      ]),
      hasSupply: true,
    }
    const notes = diagnoseDarkLeds(input)
    expect(notes).toHaveLength(1)
    expect(notes[0].detail).toBe(
      "D1 isn't lit — almost no current is reaching it. Check it's connected between power and ground with something to limit the current.",
    )
  })

  it('case 3 also applies when voltages are absent (cannot judge orientation)', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map([['D1', 0]]),
      hasSupply: true,
    }
    const notes = diagnoseDarkLeds(input)
    expect(notes).toHaveLength(1)
    expect(notes[0].detail).toContain("isn't lit")
  })

  it('a lit LED (current at/above threshold) produces no note', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map([['D1', DEFAULT_LED_ON_THRESHOLD_A]]),
      hasSupply: true,
    }
    expect(diagnoseDarkLeds(input)).toEqual([])
  })

  it('magnitude counts: a lit LED with negative current is still silent', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map([['D1', -2e-3]]),
      netVoltages: new Map([
        [1, 0],
        [2, 5],
      ]),
      hasSupply: true,
    }
    expect(diagnoseDarkLeds(input)).toEqual([])
  })

  it('no supply takes priority over a reverse-bias reading', () => {
    const input: DiagnoseInput = {
      leds: [D1],
      currentsByRef: new Map(),
      netVoltages: new Map([
        [1, 0],
        [2, 5],
      ]),
      hasSupply: false,
    }
    const notes = diagnoseDarkLeds(input)
    expect(notes[0].detail).toContain('Nothing is powering the board yet')
  })

  it('is deterministic: notes follow input order and repeat identically', () => {
    const input: DiagnoseInput = {
      leds: [
        { ref: 'D3', anodeNet: 5, cathodeNet: 6 },
        { ref: 'D1', anodeNet: 1, cathodeNet: 2 },
        { ref: 'D2', anodeNet: 3, cathodeNet: 4 }, // lit → no note
      ],
      currentsByRef: new Map([['D2', 3e-3]]),
      hasSupply: true,
    }
    const first = diagnoseDarkLeds(input)
    const second = diagnoseDarkLeds(input)
    expect(first.map((n) => n.ref)).toEqual(['D3', 'D1'])
    expect(second).toEqual(first)
  })
})
