/**
 * libText.test.ts - issue #17 (Import .lib bound a comment stub, not the model).
 *
 * `bundleSubckt` is what Import .lib binds to a part. These tests cover the text
 * it produces from a vendor-style .lib (written here from scratch; no vendor
 * model text lives in this repo): the chosen subckt, its helper subckts, the
 * top-level cards it needs, and the refusals that keep a file out of the deck
 * when the deck gate or the sidecar would refuse it later.
 */

import { describe, it, expect } from 'vitest'
import {
  bundleSubckt,
  definesSubckt,
  parseLib,
  subcktNamesInText,
  subcktTerminals,
  unsafeModelTextReason,
} from '../libText'
import { sanitizeDeck } from '../../spicegen/sanitize'

/** A vendor-shaped file: comments, a top-level .model/.param/.func, helper subckts, an unrelated part. */
const VENDOR_LIB = [
  '* Fictional regulator macro-model (test fixture)',
  '* .subckt FAKE_IN_A_COMMENT 1 2',
  '.param rtop=1k',
  '.param rbot={rtop}',
  '.param unused=42',
  '.func halve(x) {x/2}',
  '.model dclamp D(Is=1e-14 Rs=1)',
  '.model dother D(Is=1e-12)',
  '.options reltol=0.01',
  '',
  '.SUBCKT HALF_CORE in out gnd',
  'r1 in out {rtop}',
  'r2 out gnd {rbot}',
  'd1 out gnd dclamp',
  '.ENDS HALF_CORE',
  '',
  '.subckt MYREG in gnd out',
  '+ params: gain=1',
  'xc in out gnd HALF_CORE',
  'e1 sense 0 value={halve(v(out))}',
  '.ends MYREG',
  '',
  '.subckt UNRELATED a b',
  '.control',
  'echo should never be reached',
  '.endc',
  'r1 a b 1k',
  '.ends UNRELATED',
  '',
].join('\r\n')

describe('subcktNamesInText / definesSubckt / subcktTerminals', () => {
  it('lists the subckts of a file in order and ignores commented-out ones', () => {
    expect(subcktNamesInText(VENDOR_LIB)).toEqual(['HALF_CORE', 'MYREG', 'UNRELATED'])
  })

  it('is case-insensitive for lookups and reads terminals before a params: tail', () => {
    expect(definesSubckt(VENDOR_LIB, 'myreg')).toBe(true)
    expect(definesSubckt(VENDOR_LIB, 'FAKE_IN_A_COMMENT')).toBe(false)
    expect(subcktTerminals(VENDOR_LIB, 'MYREG')).toEqual(['in', 'gnd', 'out'])
    expect(subcktTerminals(VENDOR_LIB, 'NOPE')).toBeNull()
  })

  it('reads a file that starts with a byte order mark', () => {
    expect(subcktNamesInText(String.fromCharCode(0xfeff) + '.subckt A 1 2\n.ends\n')).toEqual(['A'])
  })

  it('treats a bare carriage return as a line break', () => {
    expect(subcktNamesInText('.subckt A 1 2\r.ends\r.subckt B 1 2\r.ends\r')).toEqual(['A', 'B'])
  })
})

describe('bundleSubckt: the text Import .lib binds (reproduction of #17)', () => {
  it('is the real model, never a path or comment stub', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).not.toMatch(/user-import from/)
    expect(definesSubckt(r.text, 'MYREG')).toBe(true)
    // The bundle is subckt blocks only: no top-level cards, no comments.
    for (const line of r.text.split('\n')) expect(line.startsWith('*')).toBe(false)
  })

  it('pulls in the helper subckt a block instantiates, selected block first', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.subckts).toEqual(['MYREG', 'HALF_CORE'])
    expect(definesSubckt(r.text, 'HALF_CORE')).toBe(true)
  })

  it('leaves out subckts the selection does not use, including a hostile one elsewhere in the file', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(definesSubckt(r.text, 'UNRELATED')).toBe(false)
    expect(r.text).not.toMatch(/\.control/i)
  })

  it('joins continuation lines so every deck entry is one card', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toMatch(/^\.subckt MYREG in gnd out params: gain=1$/m)
    expect(r.text).not.toMatch(/^\+/m)
  })

  it('hoists the top-level .model, .param and .func a block uses, and only those', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lines = r.text.split('\n')
    // HALF_CORE uses rtop, rbot (which needs rtop) and dclamp.
    const core = lines.slice(lines.findIndex(l => /^\.SUBCKT HALF_CORE/i.test(l)))
    expect(core.some(l => l === '.param rtop=1k')).toBe(true)
    expect(core.some(l => l === '.param rbot={rtop}')).toBe(true)
    expect(core.some(l => /^\.model dclamp /.test(l))).toBe(true)
    // MYREG uses halve().
    const reg = lines.slice(0, lines.findIndex(l => /^\.SUBCKT HALF_CORE/i.test(l)))
    expect(reg.some(l => l.startsWith('.func halve('))).toBe(true)
    // Cards nobody uses stay out.
    expect(r.text).not.toMatch(/unused/)
    expect(r.text).not.toMatch(/dother/)
    expect(r.text).not.toMatch(/\.options/i)
    // A hoisted card sits right after its subckt header, never before it.
    const hdr = lines.findIndex(l => /^\.SUBCKT HALF_CORE/i.test(l))
    expect(lines[hdr + 1]).toMatch(/^\.(param|model|func)/)
  })

  it('does not shadow an instance-overridable header param with a top-level .param of the same name', () => {
    const lib = ['.param gain=1', '.subckt AMP in out params: gain=10', 'e1 out 0 in 0 {gain}', '.ends AMP', ''].join('\n')
    const r = bundleSubckt(lib, 'AMP')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).not.toMatch(/^\.param gain=1$/m)
  })

  it('does not hoist a model the block already defines itself', () => {
    const lib = ['.model dx D(Is=1e-9)', '.subckt P a k', '.model dx D(Is=1e-14)', 'd1 a k dx', '.ends P', ''].join('\n')
    const r = bundleSubckt(lib, 'P')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text.match(/^\.model dx /gm)).toHaveLength(1)
    expect(r.text).toMatch(/Is=1e-14/)
  })

  it('terminates on a subckt that instantiates itself or a cycle', () => {
    const lib = ['.subckt A 1 2', 'x1 1 2 B', '.ends A', '.subckt B 1 2', 'x1 1 2 A', 'x2 1 2 B', '.ends B', ''].join('\n')
    const r = bundleSubckt(lib, 'A')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.subckts).toEqual(['A', 'B'])
  })

  it('the bundle passes the deck gate and the sidecar model-text check', () => {
    const r = bundleSubckt(VENDOR_LIB, 'MYREG')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(sanitizeDeck(r.text.split('\n')).ok).toBe(true)
    expect(unsafeModelTextReason(r.text)).toBeNull()
  })

  it('warns, without failing, when the file includes other files', () => {
    const lib = ['.include other.lib', '.subckt A 1 2', 'r1 1 2 1k', '.ends A', ''].join('\n')
    const r = bundleSubckt(lib, 'A')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings.join(' ')).toMatch(/include/i)
    expect(r.text).not.toMatch(/\.include/i)
  })
})

describe('bundleSubckt: refusals', () => {
  it('names a subckt that is not in the file', () => {
    const r = bundleSubckt(VENDOR_LIB, 'NOPE')
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.error).toMatch(/NOPE/)
  })

  it('refuses a selected subckt that carries a control block, with the gate reason', () => {
    const r = bundleSubckt(VENDOR_LIB, 'UNRELATED')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/\.control/)
  })

  it('refuses a block that includes a file', () => {
    const r = bundleSubckt('.subckt A 1 2\n.include C:\\secret.txt\n.ends A\n', 'A')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/\.include/)
  })

  it('refuses a file that was cut off before .ends', () => {
    const r = bundleSubckt('.subckt A 1 2\nr1 1 2 1k\n', 'A')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/\.ends/)
  })

  it('refuses a subckt declared inside another (the deck generator cannot inline it)', () => {
    const r = bundleSubckt('.subckt A 1 2\n.subckt B 1 2\n.ends B\n.ends A\n', 'A')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/inside/)
  })

  it('refuses a name the sidecar could not save, so the binding cannot vanish on reopen', () => {
    const r = bundleSubckt('.subckt a/b 1 2\n.ends\n', 'a/b')
    expect(r.ok).toBe(false)
  })

  it('refuses a block using a directive the sidecar will not load back', () => {
    const r = bundleSubckt('.subckt A 1 2\n.if (1)\nr1 1 2 1k\n.endif\n.ends A\n', 'A')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/\.if/)
  })
})

describe('parseLib', () => {
  it('keeps top-level cards apart from subckt bodies', () => {
    const lib = parseLib(VENDOR_LIB)
    expect(lib.topLevel).toContain('.param rtop=1k')
    expect(lib.subckts.map(s => s.name)).toEqual(['HALF_CORE', 'MYREG', 'UNRELATED'])
    expect(lib.subckts.every(s => !s.unterminated && !s.nested)).toBe(true)
  })
})
