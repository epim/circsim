import { describe, it, expect } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import {
  MainDiagnostics,
  assembleBundle,
  sanitizeBundleName,
  validateRendererFiles,
} from '../diagnosticsBundle'

function entryNames(zip: Uint8Array): string[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const nlen = v.getUint16(p + 28, true)
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen)))
    p += 46 + nlen
  }
  return names
}

function entryText(zip: Uint8Array, name: string): string {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true)
    const csize = v.getUint32(p + 20, true)
    const nlen = v.getUint16(p + 28, true)
    const lho = v.getUint32(p + 42, true)
    const n = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen))
    if (n === name) {
      const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true)
      const body = zip.subarray(start, start + csize)
      return new TextDecoder().decode(method === 8 ? inflateRawSync(body) : body)
    }
    p += 46 + nlen
  }
  throw new Error(`no entry ${name}`)
}

describe('MainDiagnostics', () => {
  it('keeps SimHost output and crash exits with their codes', () => {
    const d = new MainDiagnostics()
    d.recordOutput('stderr', 'watchdog: no progress\n', Date.UTC(2026, 8, 30, 12, 0, 0))
    d.recordCrash({ willRespawn: true, exitCode: 86, reason: 'watchdog' }, Date.UTC(2026, 8, 30, 12, 0, 1))
    const files = d.files()
    expect(files.find(f => f.name === 'simhost-output.log')!.text).toBe(
      '2026-09-30T12:00:00.000Z [stderr] watchdog: no progress\n',
    )
    const crashes = JSON.parse(files.find(f => f.name === 'crashes.json')!.text)
    expect(crashes).toEqual([
      { willRespawn: true, exitCode: 86, reason: 'watchdog', at: '2026-09-30T12:00:01.000Z' },
    ])
  })

  it('is bounded', () => {
    const d = new MainDiagnostics()
    for (let i = 0; i < 2000; i++) d.recordOutput('stdout', `line ${i}`)
    for (let i = 0; i < 200; i++) d.recordCrash({ willRespawn: true, exitCode: i, reason: 'crashed' })
    const log = d.files().find(f => f.name === 'simhost-output.log')!.text.trim().split('\n')
    expect(log.length).toBe(500)
    expect(log[log.length - 1]).toContain('line 1999')
    expect(JSON.parse(d.files().find(f => f.name === 'crashes.json')!.text).length).toBe(50)
  })

  it('writes empty files when nothing happened', () => {
    const files = new MainDiagnostics().files()
    expect(files.find(f => f.name === 'simhost-output.log')!.text).toBe('')
    expect(JSON.parse(files.find(f => f.name === 'crashes.json')!.text)).toEqual([])
  })
})

describe('validateRendererFiles', () => {
  it('accepts plain relative names', () => {
    expect(validateRendererFiles([{ name: 'decks/pass1.cir', text: 'x' }])).toEqual([
      { name: 'decks/pass1.cir', text: 'x' },
    ])
  })
  it.each([
    ['not an array', 'nope'],
    ['non-string text', [{ name: 'a', text: 1 }]],
    ['parent traversal', [{ name: '../evil', text: '' }]],
    ['embedded traversal', [{ name: 'a/../../evil', text: '' }]],
    ['absolute path', [{ name: '/etc/passwd', text: '' }]],
    ['drive path', [{ name: 'C:/x', text: '' }]],
    ['backslash', [{ name: 'a\\b', text: '' }]],
    ['duplicate', [{ name: 'a', text: '' }, { name: 'a', text: '' }]],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRendererFiles(value)).toThrow()
  })
})

describe('sanitizeBundleName', () => {
  it('strips directories and forces .zip', () => {
    expect(sanitizeBundleName('../../etc/passwd')).toBe('passwd.zip')
    expect(sanitizeBundleName('C:\\Users\\x\\bundle.zip')).toBe('bundle.zip')
    expect(sanitizeBundleName(undefined)).toBe('circsim-diagnostics.zip')
    expect(sanitizeBundleName('my board.zip')).toBe('my-board.zip')
  })
})

describe('assembleBundle', () => {
  it('zips renderer and main files, and main wins a name collision', () => {
    const zip = assembleBundle(
      [
        { name: 'manifest.json', text: '{}' },
        { name: 'environment.json', text: 'forged' },
      ],
      [{ name: 'environment.json', text: 'real' }],
    )
    expect(entryNames(zip)).toEqual(['manifest.json', 'environment.json'])
    expect(entryText(zip, 'environment.json')).toBe('real')
  })
})
