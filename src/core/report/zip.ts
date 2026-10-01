/**
 * core/report/zip.ts
 *
 * A minimal ZIP writer for the diagnostics bundle (issue #26). Pure TypeScript,
 * no dependencies: entries are written as STORED (method 0) by default, or as
 * DEFLATE (method 8) when the caller injects a raw-deflate function (main passes
 * node:zlib's deflateRawSync, which keeps this file free of Node imports).
 *
 * Scope: file names are UTF-8 (general purpose flag bit 11), sizes stay under
 * 4 GiB (no ZIP64), and there is no encryption or data descriptor. That is the
 * whole of what a bug-report bundle needs, and every common unzip tool reads it.
 */

export interface ZipEntry {
  /** Forward-slash relative path inside the archive, e.g. `decks/pass1.cir`. */
  name: string
  data: string | Uint8Array
}

export interface ZipOptions {
  /** Raw deflate (RFC 1951) of the input. Omit to store entries uncompressed. */
  deflateRaw?: (data: Uint8Array) => Uint8Array
  /** Modification time stamped on every entry. Defaults to now. */
  now?: Date
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3), as ZIP stores it. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  // DOS dates start at 1980 and have 2-second resolution.
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** Build a ZIP archive holding `entries`, in order. */
export function buildZip(entries: ZipEntry[], opts: ZipOptions = {}): Uint8Array {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(opts.now ?? new Date())
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const crc = crc32(raw)
    let body = raw
    let method = 0
    if (opts.deflateRaw && raw.length > 0) {
      const deflated = opts.deflateRaw(raw)
      if (deflated.length < raw.length) {
        body = deflated
        method = 8
      }
    }

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // flags: UTF-8 names
    lv.setUint16(8, method, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, name.length, true)
    // extra, comment, disk number, internal attrs, external attrs: zero
    cv.setUint32(42, offset, true) // local header offset
    central.set(name, 46)

    localParts.push(local, body)
    centralParts.push(central)
    offset += local.length + body.length
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const parts = [...localParts, ...centralParts, end]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
