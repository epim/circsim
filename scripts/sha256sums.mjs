#!/usr/bin/env node
/**
 * sha256sums.mjs - build the SHA256SUMS release asset (issue #40, plan task R6).
 *
 * Walks a directory (recursively, so download-artifact folder layouts work),
 * hashes every release installer (.exe .dmg .AppImage .deb) and writes
 * `sha256sum -c` compatible lines: "<hex>  <basename>", sorted by name.
 *
 * Hard errors instead of a quietly wrong file:
 *  - no installer found (an empty SHA256SUMS would look like a valid release);
 *  - two files with the same basename (the line would be ambiguous).
 *
 * Usage: node scripts/sha256sums.mjs <dir> [--out <file>]
 * Without --out the sums are printed to stdout.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_EXTENSIONS = ['.exe', '.dmg', '.AppImage', '.deb']

function walk(dir) {
  const out = []
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name)
    if (dirent.isDirectory()) out.push(...walk(full))
    else if (dirent.isFile()) out.push(full)
  }
  return out
}

function hashFile(file) {
  const h = createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

/**
 * @param {string} dir directory holding the release installers
 * @returns {{ text: string, entries: { name: string, sha256: string }[] }}
 */
export function buildSha256Sums(dir) {
  const files = walk(dir).filter((f) => RELEASE_EXTENSIONS.includes(path.extname(f)))
  if (files.length === 0) {
    throw new Error(`sha256sums: no release files (${RELEASE_EXTENSIONS.join(' ')}) found under ${dir}`)
  }
  const seen = new Map()
  for (const f of files) {
    const name = path.basename(f)
    if (seen.has(name)) {
      throw new Error(`sha256sums: duplicate file name ${name} (${seen.get(name)} and ${f})`)
    }
    seen.set(name, f)
  }
  const entries = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, file]) => ({ name, sha256: hashFile(file) }))
  const text = entries.map((e) => `${e.sha256}  ${e.name}\n`).join('')
  return { text, entries }
}

// CLI entry
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined
  const dir = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1))
  if (!dir || (outIdx >= 0 && !outFile)) {
    console.error('usage: node scripts/sha256sums.mjs <dir> [--out <file>]')
    process.exit(2)
  }
  try {
    const { text, entries } = buildSha256Sums(dir)
    if (outFile) {
      fs.writeFileSync(outFile, text)
      console.error(`sha256sums: wrote ${entries.length} entries to ${outFile}`)
    } else {
      process.stdout.write(text)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
