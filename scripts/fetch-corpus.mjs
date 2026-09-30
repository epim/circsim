#!/usr/bin/env node
/**
 * fetch-corpus.mjs - Download the pinned real-board regression corpus.
 *
 * The corpus is a set of KiCad-written .kicad_pcb files taken from the KiCad
 * source repository's demo boards at fixed release tags, one or more per KiCad
 * format generation (6 to 10). The files are NOT stored in this repository
 * (project rule: no third-party board files in the tree). They are fetched at
 * test time into a cache directory, and every file is verified against the
 * sha256 recorded in scripts/corpus-manifest.json, so a moved tag or a
 * tampered mirror fails loudly instead of silently changing what CI tests.
 *
 * Usage:
 *   node scripts/fetch-corpus.mjs               fetch every missing file, verify all
 *   node scripts/fetch-corpus.mjs --only ID,ID  restrict to the given ids
 *   node scripts/fetch-corpus.mjs --pin         (maintainers) download and write the
 *                                               observed sha256 and size into the manifest
 *   node scripts/fetch-corpus.mjs --list        print the manifest table and exit
 *
 * Cache directory: $CIRCSIM_CORPUS_DIR, default <repo>/.corpus-cache
 * (gitignored; CI caches it keyed on the manifest hash).
 *
 * Exit code is non-zero if any file could not be fetched or fails verification.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
export const MANIFEST_PATH = path.join(__dirname, 'corpus-manifest.json')

export function corpusDir() {
  return process.env.CIRCSIM_CORPUS_DIR
    ? path.resolve(process.env.CIRCSIM_CORPUS_DIR)
    : path.join(PROJECT_ROOT, '.corpus-cache')
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

/** Absolute path of a corpus board inside the cache directory. */
export function corpusFile(entry) {
  return path.join(corpusDir(), `${entry.id}.kicad_pcb`)
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function download(url, attempts = 4) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i * i))
    }
  }
  throw new Error(`download failed after ${attempts} attempts: ${url}: ${lastErr?.message ?? lastErr}`)
}

async function main() {
  const args = process.argv.slice(2)
  const pin = args.includes('--pin')
  const list = args.includes('--list')
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null

  const manifest = readManifest()
  const entries = manifest.boards.filter((b) => !only || only.has(b.id))

  if (list) {
    for (const b of entries) {
      console.log(`${b.id.padEnd(28)} kicad ${String(b.kicadMajor).padEnd(3)} fmt ${b.formatVersion}  ${b.license}`)
    }
    return
  }

  const dir = corpusDir()
  fs.mkdirSync(dir, { recursive: true })
  let failures = 0
  let fetched = 0
  let cached = 0

  for (const entry of entries) {
    const file = corpusFile(entry)
    let buf = null
    if (fs.existsSync(file)) {
      const have = fs.readFileSync(file)
      if (pin || sha256Buffer(have) === entry.sha256) {
        buf = have
        cached++
      } else {
        console.warn(`[corpus] ${entry.id}: cached file fails sha256, refetching`)
      }
    }
    if (!buf) {
      try {
        buf = await download(entry.url)
        fetched++
      } catch (err) {
        console.error(`[corpus] FAIL ${entry.id}: ${err.message}`)
        failures++
        continue
      }
    }
    const digest = sha256Buffer(buf)
    if (pin) {
      entry.sha256 = digest
      entry.bytes = buf.length
      fs.writeFileSync(file, buf)
      continue
    }
    if (digest !== entry.sha256) {
      console.error(
        `[corpus] FAIL ${entry.id}: sha256 mismatch\n  expected ${entry.sha256}\n  actual   ${digest}\n  url      ${entry.url}`
      )
      failures++
      continue
    }
    fs.writeFileSync(file, buf)
  }

  if (pin) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`[corpus] pinned ${entries.length} boards into ${path.relative(PROJECT_ROOT, MANIFEST_PATH)}`)
  } else {
    console.log(`[corpus] ${entries.length - failures}/${entries.length} boards ready in ${dir} (${fetched} fetched, ${cached} cached)`)
  }
  if (failures > 0) process.exit(1)
}

// Run only when executed directly, so tests can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
