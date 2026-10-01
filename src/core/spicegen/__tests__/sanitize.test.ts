/**
 * Tests for core/spicegen/sanitize.ts: the deck gate (issue #35).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DeckRejectedError,
  SAFE_DOT_CARDS,
  assertSafeDeck,
  formatDeckViolations,
  sanitizeDeck
} from '../sanitize'

describe('sanitizeDeck: refused cards', () => {
  const refused: Array<[string, string, string]> = [
    ['control block open', '.control', 'control-card'],
    ['control block close', '.endc', 'control-card'],
    ['mixed case control', '  .CoNtRoL', 'control-card'],
    ['control with trailing text', '.control ; run', 'control-card'],
    ['legacy exec block', '.exec', 'control-card'],
    ['star-hash command comment', '*# shell calc', 'control-card'],
    ['ng_script comment', '*ng_script', 'control-card'],
    ['include with path', '.include /etc/passwd', 'file-include'],
    ['include abbreviation', '.inc "C:\\Windows\\win.ini"', 'file-include'],
    ['include upper case', '.INCLUDE foo.lib', 'file-include'],
    ['lib with path and section', '.lib C:\\models\\evil.lib typ', 'file-include'],
    ['lib with path only', '.lib ../evil.lib', 'file-include'],
    ['source', '.source evil.cir', 'file-include'],
    ['csparam', '.csparam x=1', 'file-include'],
    ['prefix-matched include', '.incfoo bar.lib', 'unknown-card'],
    ['unknown future card', '.frobnicate 1 2', 'unknown-card'],
    ['bare dot', '.', 'unknown-card'],
    ['tab-indented control', '\t.control', 'control-card'],
    ['nbsp-prefixed control', '\u00a0.control', 'control-card'],
    ['bom-prefixed control', '\ufeff.control', 'control-card'],
    ['xspice input_file', '.model src d_source(input_file="C:\\secret.txt")', 'file-reference'],
    ['xspice state_file', '.model st d_state(state_file = "/etc/shadow")', 'file-reference'],
    ['newline smuggling a control block', 'r1 a b 1k\n.control\nshell calc\n.endc', 'embedded-newline'],
    ['carriage return in the middle', 'r1 a b 1k\r.control', 'embedded-newline'],
    ['NUL byte', 'r1 a b 1k\0', 'embedded-newline']
  ]

  it.each(refused)('%s', (_name, card, rule) => {
    const res = sanitizeDeck(['* title', card, '.end'])
    expect(res.ok).toBe(false)
    expect(res.violations).toHaveLength(1)
    expect(res.violations[0].rule).toBe(rule)
    expect(res.violations[0].line).toBe(2)
  })

  it('reports every offending card with its 1-based index', () => {
    const res = sanitizeDeck(['* t', '.control', 'r1 a b 1k', '.include x', '.endc', '.end'])
    expect(res.violations.map((v) => [v.line, v.rule])).toEqual([
      [2, 'control-card'],
      [4, 'file-include'],
      [5, 'control-card']
    ])
  })

  it('refuses a control block buried inside a subckt definition', () => {
    const res = sanitizeDeck([
      '* t',
      '.subckt evil a b',
      '.control',
      'echo MARKER',
      '.endc',
      'r1 a b 1000',
      '.ends',
      '.end'
    ])
    expect(res.ok).toBe(false)
    expect(res.violations.map((v) => v.line)).toEqual([3, 5])
  })

  it('truncates long offending cards for display', () => {
    const res = sanitizeDeck([`.include ${'x'.repeat(500)}`])
    expect(res.violations[0].card.length).toBeLessThan(100)
  })
})

describe('sanitizeDeck: accepted cards', () => {
  it('accepts an ordinary deck', () => {
    const deck = [
      '* circsim deck - t',
      'v1 in 0 dc 5',
      'r1 in out 1k',
      'c1 out 0 1u ic=0',
      '.param rload=10k',
      '.model dled d(is=1e-19 rs=2 n=1.7)',
      '.subckt amp a b',
      'r1 a b 1000',
      '.ends amp',
      '+ continuation',
      '',
      '   ',
      '.options noopalter',
      '.ic v(out)=0',
      '.save all',
      '.save @r1[i]',
      '.tran 1u 1m uic',
      '.end'
    ]
    expect(sanitizeDeck(deck)).toEqual({ ok: true, violations: [] })
  })

  it('accepts uppercase and indented safe cards', () => {
    expect(sanitizeDeck(['  .SUBCKT X A B', '.ENDS X', '.END']).ok).toBe(true)
  })

  it('accepts a trailing carriage return from CRLF model text', () => {
    expect(sanitizeDeck(['r1 a b 1k\r', '.model d1 d(is=1e-14)\r']).ok).toBe(true)
  })

  it('does not treat dangerous words inside comments or names as cards', () => {
    const deck = [
      '* .control is mentioned in a plain comment',
      '* .include foo',
      'r_control a b 1k',
      'x1 a b include_helper',
      'r2 a b 1k ; .endc'
    ]
    expect(sanitizeDeck(deck).ok).toBe(true)
  })

  it('every safe dot card is accepted with arguments', () => {
    for (const name of SAFE_DOT_CARDS) {
      expect(sanitizeDeck([`.${name} a b c`]).ok, name).toBe(true)
    }
  })

  it('accepts every bundled model file (no false positives on the real library)', () => {
    const dir = join(process.cwd(), 'resources', 'models')
    const libs = readdirSync(dir).filter((f) => f.endsWith('.lib'))
    expect(libs.length).toBeGreaterThan(5)
    for (const f of libs) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n')
      const res = sanitizeDeck(lines)
      expect(res.violations, f).toEqual([])
    }
  })
})

describe('assertSafeDeck / DeckRejectedError', () => {
  it('passes a clean deck', () => {
    expect(() => assertSafeDeck(['* t', 'r1 a b 1k', '.end'])).not.toThrow()
  })

  it('throws a DeckRejectedError carrying the violations and a readable message', () => {
    try {
      assertSafeDeck(['* t', '.control', 'shell calc', '.endc', '.end'])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(DeckRejectedError)
      const err = e as DeckRejectedError
      expect(err.violations).toHaveLength(2)
      expect(err.message).toContain('deck rejected')
      expect(err.message).toContain('card 2 ".control"')
      expect(err.message).toContain('treated as code')
    }
  })

  it('caps the message at three violations', () => {
    const v = sanitizeDeck(['.control', '.control', '.control', '.control', '.control']).violations
    expect(formatDeckViolations(v)).toContain('and 2 more')
  })
})
