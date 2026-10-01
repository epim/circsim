/**
 * contrast.test.ts - issue #70: hint and disabled text must clear WCAG 2.1 AA
 * (4.5:1) on the dark surfaces. Two guards:
 *   1. the shared palette tokens pass on every dark surface;
 *   2. no renderer source goes back to the known sub-AA greys the issue measured
 *      (#555 / #666 and the other low greys found in the same audit).
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio, DARK_SURFACES, TEXT_HINT, TEXT_MUTED } from '../palette'

describe('palette contrast', () => {
  it('measures the issue evidence correctly (sanity of the checker)', () => {
    expect(contrastRatio('#555555', '#0c0c14')).toBeCloseTo(2.61, 1)
    expect(contrastRatio('#555555', '#1a1a24')).toBeCloseTo(2.31, 1)
    expect(contrastRatio('#555555', '#0d1117')).toBeCloseTo(2.54, 1)
    expect(contrastRatio('#666666', '#181822')).toBeCloseTo(3.07, 1)
  })

  for (const [name, color] of [['TEXT_HINT', TEXT_HINT], ['TEXT_MUTED', TEXT_MUTED]] as const) {
    it(`${name} (${color}) is at least 4.5:1 on every dark surface`, () => {
      for (const bg of DARK_SURFACES) {
        expect(contrastRatio(color, bg), `${color} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') walk(full, out)
    } else if (/\.(ts|tsx|css)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('renderer source has no sub-AA grey text', () => {
  // Foreground greys below 4.5:1 on the #15151f panel surface.
  const BANNED = ['#555', '#555555', '#666', '#666666', '#556', '#484f58', '#6e7681', '#6c7689', '#777', '#777777']
  const root = join(__dirname, '..', '..')
  const files = walk(root)

  it('finds the renderer sources', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('no `color:` declaration uses a banned grey', () => {
    const offenders: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/(?<![a-zA-Z])color:\s*'(#[0-9a-fA-F]{3,6})'/g)) {
          if (BANNED.includes(m[1].toLowerCase())) offenders.push(`${f}:${i + 1} ${m[1]}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
