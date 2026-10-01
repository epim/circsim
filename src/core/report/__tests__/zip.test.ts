import { describe, it, expect } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { buildZip, crc32 } from '../zip'

interface Parsed {
  name: string
  method: number
  crc: number
  data: Uint8Array
}

/** Independent reader: walks the central directory and inflates each entry. */
function readZip(zip: Uint8Array): Parsed[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  expect(v.getUint32(eocd, true)).toBe(0x06054b50)
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out: Parsed[] = []
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50)
    const method = v.getUint16(p + 10, true)
    const crc = v.getUint32(p + 16, true)
    const csize = v.getUint32(p + 20, true)
    const nlen = v.getUint16(p + 28, true)
    const lho = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen))
    const lnlen = v.getUint16(lho + 26, true)
    const lxlen = v.getUint16(lho + 28, true)
    const start = lho + 30 + lnlen + lxlen
    const body = zip.subarray(start, start + csize)
    out.push({ name, method, crc, data: method === 8 ? inflateRawSync(body) : body })
    p += 46 + nlen
  }
  return out
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe('buildZip', () => {
  const entries = [
    { name: 'a.txt', data: 'hello\n' },
    { name: 'dir/b.cir', data: 'x'.repeat(5000) },
    { name: 'empty.txt', data: '' },
    { name: 'utf8-é.txt', data: 'café' },
  ]

  it('round-trips stored entries', () => {
    const parsed = readZip(buildZip(entries))
    expect(parsed.map(e => e.name)).toEqual(entries.map(e => e.name))
    for (const [i, e] of parsed.entries()) {
      expect(e.method).toBe(0)
      expect(new TextDecoder().decode(e.data)).toBe(entries[i].data)
      expect(e.crc).toBe(crc32(e.data))
    }
  })

  it('deflates compressible entries and stores ones that do not shrink', () => {
    const zip = buildZip(entries, { deflateRaw: d => deflateRawSync(d) })
    const parsed = readZip(zip)
    expect(parsed[1].method).toBe(8)
    expect(parsed[0].method).toBe(0) // 6 bytes do not shrink
    expect(parsed[2].method).toBe(0) // empty
    expect(new TextDecoder().decode(parsed[1].data)).toBe('x'.repeat(5000))
    expect(zip.length).toBeLessThan(buildZip(entries).length)
  })
})
