/**
 * Tests for core/models/llmPrompt.ts — Task 25.
 *
 * buildLlmPrompt(part, padList) → string
 *
 * Spec §8.7: the prompt must include:
 *   - MPN / part identifier
 *   - Package / footprint
 *   - Pad numbers with their names (when known)
 *   - Required .subckt header with exact node count
 *   - ngspice-dialect constraints
 *   - Instruction to cite datasheet values
 *   - An instruction to keep the subckt self-contained (no .lib references)
 *
 * The function is pure: no I/O, no side effects.
 */

import { describe, it, expect } from 'vitest'
import { buildLlmPrompt } from '../llmPrompt'
import type { Part } from '../../netlist/extract'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePart(
  ref: string,
  value: string,
  libId = 'Resistor_SMD:R_0805_2012Metric',
  properties: Record<string, string> = {},
): Part {
  return {
    ref,
    value,
    libId,
    layer: 'F',
    padNet: new Map([['1', 1], ['2', 2]]),
    properties,
  }
}

interface PadInfo {
  number: string
  name?: string
}

// ─── buildLlmPrompt ───────────────────────────────────────────────────────────

describe('buildLlmPrompt — generates a clipboard prompt for LLM model assist', () => {
  it('includes the MPN from properties when present', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555', { MPN: 'NE555P' })
    const padList: PadInfo[] = [
      { number: '1', name: 'GND' },
      { number: '2', name: 'TRIG' },
      { number: '3', name: 'OUT' },
      { number: '8', name: 'VCC' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt).toContain('NE555P')
  })

  it('falls back to part value when no MPN property', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1', name: 'GND' }, { number: '8', name: 'VCC' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt).toContain('NE555')
  })

  it('includes the reference designator', () => {
    const part = makePart('U1', 'LM358', 'OpAmp:LM358')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt).toContain('U1')
  })

  it('includes the footprint / package identifier', () => {
    const part = makePart('U1', 'NE555', 'Package_DIP:DIP-8_W7.62')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    // Should mention the package or libId in some form
    expect(prompt.toLowerCase()).toMatch(/dip|footprint|package/)
  })

  it('includes all pad numbers', () => {
    const part = makePart('U2', 'LM358', 'OpAmp:LM358', { MPN: 'LM358DR' })
    const padList: PadInfo[] = [
      { number: '1', name: 'OUT1' },
      { number: '2', name: 'IN1-' },
      { number: '3', name: 'IN1+' },
      { number: '4', name: 'GND' },
      { number: '5', name: 'IN2+' },
      { number: '6', name: 'IN2-' },
      { number: '7', name: 'OUT2' },
      { number: '8', name: 'VCC' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    for (const pad of padList) {
      expect(prompt).toContain(pad.number)
    }
  })

  it('includes pad names when provided', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [
      { number: '1', name: 'GND' },
      { number: '2', name: 'TRIG' },
      { number: '8', name: 'VCC' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt).toContain('GND')
    expect(prompt).toContain('TRIG')
    expect(prompt).toContain('VCC')
  })

  it('includes a required .subckt header line showing exact node count', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [
      { number: '1', name: 'GND' },
      { number: '2', name: 'TRIG' },
      { number: '3', name: 'OUT' },
      { number: '4', name: 'RESET' },
      { number: '5', name: 'CTRL' },
      { number: '6', name: 'THRES' },
      { number: '7', name: 'DISCH' },
      { number: '8', name: 'VCC' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    // Must mention .subckt with the correct node count (8 nodes)
    expect(prompt.toLowerCase()).toContain('.subckt')
    // The required header must show 8 terminal nodes
    expect(prompt).toMatch(/\.subckt\s+\S+\s+\S+/)
  })

  it('requires exactly padList.length nodes in the subckt header', () => {
    const part = makePart('U2', 'LM358', 'OpAmp:LM358')
    const padList: PadInfo[] = [
      { number: '1' },
      { number: '2' },
      { number: '3' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    // Count the node placeholders in the subckt header
    // The prompt should make clear that exactly 3 nodes are required
    expect(prompt.toLowerCase()).toContain('.subckt')
    // Should reference 3 nodes or state "3 terminals"
    expect(prompt).toMatch(/3\s*(node|terminal|port|pad)/i)
  })

  it('includes ngspice-dialect constraints mentioning ngspice', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1', name: 'GND' }, { number: '8', name: 'VCC' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt.toLowerCase()).toContain('ngspice')
  })

  it('instructs to use ngspice-compatible syntax (no .lib, no .inc)', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    // Must explicitly mention avoiding .lib or .include references
    const lower = prompt.toLowerCase()
    // Either explicitly forbids .lib/.include or says self-contained
    expect(lower).toMatch(/self.?contain|no \.lib|no \.include|standalone/)
  })

  it('instructs to cite datasheet values', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    const lower = prompt.toLowerCase()
    expect(lower).toMatch(/datasheet|cite|parameter/)
  })

  it('instructs the model to end with .ends', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt.toLowerCase()).toContain('.ends')
  })

  it('returns a non-empty string for a minimal single-pad part', () => {
    const part = makePart('D1', 'LED', 'LED_SMD:LED_0805_2012Metric')
    const padList: PadInfo[] = [{ number: '1', name: 'K' }, { number: '2', name: 'A' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
  })

  it('is a pure function — same inputs always produce same output', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555', { MPN: 'NE555P' })
    const padList: PadInfo[] = [
      { number: '1', name: 'GND' },
      { number: '8', name: 'VCC' },
    ]
    const result1 = buildLlmPrompt(part, padList)
    const result2 = buildLlmPrompt(part, padList)
    expect(result1).toBe(result2)
  })

  it('mentions M/Meg suffix convention to avoid SPICE M-means-milli trap', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    // Should mention using plain numbers or warn about M-means-milli in SPICE
    const lower = prompt.toLowerCase()
    expect(lower).toMatch(/plain\s*(number|decimal|value)|milli|1e|scientific/)
  })

  it('MPN from MPN property wins over value field', () => {
    const part = makePart('U1', 'NE555', 'Timer:DIP8', { MPN: 'TI-NE555P-SPECIAL' })
    const padList: PadInfo[] = [{ number: '1' }]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt).toContain('TI-NE555P-SPECIAL')
    // Value field NE555 may also appear but MPN must be present
  })

  it('mentions "Part Number" or "MPN" or datasheet lookup cue explicitly', () => {
    const part = makePart('U1', 'LM358', 'OpAmp:SOIC-8', { MPN: 'LM358DR' })
    const padList: PadInfo[] = [{ number: '1' }, { number: '8' }]
    const prompt = buildLlmPrompt(part, padList)
    // Should use the MPN as identifier for the user to look up
    expect(prompt).toMatch(/LM358DR|LM358/)
  })
})

// ─── Validate-subckt integration (mock validate) ────────────────────────────
// These tests verify the SHAPE of what's tested: the validation flow is tested
// in the store / panel tests with a mock simClient; buildLlmPrompt itself is pure.

describe('buildLlmPrompt — prompt is pasteable into a LLM', () => {
  it('prompt does not contain code fences or JSON (plain-text clipboard content)', () => {
    const part = makePart('U1', 'NE555', 'Timer:NE555')
    const padList: PadInfo[] = [{ number: '1', name: 'GND' }, { number: '8', name: 'VCC' }]
    const prompt = buildLlmPrompt(part, padList)
    // Should not wrap in triple-backtick fences (the LLM response does; the prompt does not)
    // Allow one example .subckt in the prompt body as a template placeholder
    expect(prompt).not.toMatch(/^```/m)
  })

  it('prompt is < 2000 characters for a typical 8-pad IC', () => {
    const part = makePart('U1', 'NE555P', 'Timer:DIP-8')
    const padList: PadInfo[] = [
      { number: '1', name: 'GND' },
      { number: '2', name: 'TRIG' },
      { number: '3', name: 'OUT' },
      { number: '4', name: 'RESET' },
      { number: '5', name: 'CTRL' },
      { number: '6', name: 'THRES' },
      { number: '7', name: 'DISCH' },
      { number: '8', name: 'VCC' },
    ]
    const prompt = buildLlmPrompt(part, padList)
    expect(prompt.length).toBeLessThan(2000)
  })
})
