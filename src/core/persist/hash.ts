/**
 * core/persist/hash.ts
 *
 * SHA-256 of a text, as lowercase hex, via Web Crypto (available in the
 * Electron renderer, in Node 20+ and in vitest; no node import, so core stays
 * environment-neutral). Used to tie a saved setup and an exported report to the
 * exact board file they were produced from.
 *
 * The hash is over the UTF-8 bytes of the text as read, which is what the
 * renderer holds (the main process reads the file as UTF-8). KiCad writes
 * UTF-8, so this equals the sha256 of the file on disk.
 */

export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}
