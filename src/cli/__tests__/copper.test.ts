import { describe, expect, it } from 'vitest'
import { parseArgs } from '../args'
import { openSession } from '../session'

function session(command: string, ...flags: string[]) {
  const parsed = parseArgs([command, 'fixtures/fixture-555.kicad_pcb', ...flags])
  expect(parsed.kind).toBe('run')
  if (parsed.kind !== 'run') throw new Error('CLI rejected copper flag')
  return openSession(parsed.options, { entries: [], texts: {} }, process.cwd())
}

describe('CLI copper selection', () => {
  it('audit builds a physical operating point by default', () => {
    expect(session('audit').inputs?.copperAware).toBe(true)
    expect(session('audit').inputs?.copperNetwork).toBeDefined()
  })
  it('op stays ideal unless --copper is requested', () => {
    expect(session('op').inputs?.copperAware).toBe(false)
    expect(session('op', '--copper').inputs?.copperNetwork).toBeDefined()
  })
})
