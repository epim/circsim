#!/usr/bin/env node
/**
 * ngspice-download.mjs - Pinned, move-tolerant download of ngspice release archives.
 *
 * Shared by scripts/fetch-ngspice.mjs (Windows DLL archive) and
 * scripts/build-ngspice.sh (source tarball). Two guarantees:
 *
 *   1. Move tolerance: each archive is tried at several candidate SourceForge
 *      paths (the release directory, then old-releases/, where SourceForge
 *      moves superseded versions). A 404, an HTML interstitial or a network
 *      error moves on to the next candidate.
 *   2. Integrity: the downloaded bytes must hash to the sha256 pinned in
 *      scripts/ngspice-pins.json. A mismatch is a hard failure; no other
 *      candidate is tried and the partial file is deleted.
 *
 * CLI (used by build-ngspice.sh):
 *   node scripts/ngspice-download.mjs <dll|source> <destFile>
 *   node scripts/ngspice-download.mjs --print-sha256 <dll|source>
 * The version comes from package.json config.circsim.ngspiceVersion.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const PINS_PATH = path.join(__dirname, 'ngspice-pins.json')

/** Compute SHA-256 hex of a file. */
export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** Look up the pinned archive name and sha256 for a version and kind. */
export function loadPin(version, kind, pinsPath = PINS_PATH) {
  const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'))
  const pin = pins?.[version]?.[kind]
  if (!pin || !/^[0-9a-f]{64}$/.test(pin.sha256 ?? '') || !pin.archive) {
    throw new Error(
      `No pinned sha256 for ngspice ${version} (${kind}) in ${pinsPath}. ` +
        'Add the version and its archive hash to the pins file when bumping ngspiceVersion.'
    )
  }
  return pin
}

/**
 * Candidate URLs for a pinned archive, most likely first. SourceForge keeps
 * the newest release under ng-spice-rework/<v>/ and moves older ones under
 * ng-spice-rework/old-releases/<v>/, so both are listed.
 */
export function candidateUrls(version, kind) {
  const { archive } = loadPin(version, kind)
  const paths = [`ng-spice-rework/${version}`, `ng-spice-rework/old-releases/${version}`]
  if (kind === 'dll') {
    // master.dl with viasf=1 is the only host that returns the DLL binary directly.
    return paths.map(
      (p) => `https://master.dl.sourceforge.net/project/ngspice/${p}/${archive}?viasf=1`
    )
  }
  return paths.map((p) => `https://downloads.sourceforge.net/project/ngspice/${p}/${archive}`)
}

/**
 * Download the first candidate URL that serves the file and verify its sha256.
 * Resolves with { url, sha256 }. Rejects on hash mismatch (immediately) or when
 * no candidate serves the file (message lists every attempt).
 */
export async function downloadVerified({ urls, destFile, sha256, minSize = 1 }) {
  const expected = sha256.toLowerCase()
  const failures = []

  for (const url of urls) {
    console.log(`Downloading ${url} ...`)
    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'circsim-build/1.0' }, redirect: 'follow' })
    } catch (err) {
      failures.push(`${url}: ${err.message}`)
      continue
    }
    if (!res.ok) {
      failures.push(`${url}: HTTP ${res.status} ${res.statusText}`)
      continue
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) {
      failures.push(`${url}: server returned HTML (interstitial page), not the archive`)
      continue
    }

    const tmpFile = destFile + '.tmp'
    try {
      await pipeline(res.body, createWriteStream(tmpFile))
    } catch (err) {
      fs.rmSync(tmpFile, { force: true })
      failures.push(`${url}: transfer failed: ${err.message}`)
      continue
    }

    const size = fs.statSync(tmpFile).size
    if (size < minSize) {
      fs.rmSync(tmpFile, { force: true })
      failures.push(`${url}: only ${size} bytes (< ${minSize} minimum)`)
      continue
    }

    const actual = sha256File(tmpFile)
    if (actual !== expected) {
      fs.rmSync(tmpFile, { force: true })
      throw new Error(
        `sha256 mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}\n` +
          'Refusing to use the download. If ngspice was legitimately re-released, ' +
          'update scripts/ngspice-pins.json after verifying the new archive.'
      )
    }

    fs.renameSync(tmpFile, destFile)
    console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB, sha256 verified: ${actual}`)
    return { url, sha256: actual }
  }

  throw new Error(
    `Could not download ngspice archive from any candidate URL:\n  ${failures.join('\n  ')}`
  )
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function cli() {
  const args = process.argv.slice(2)
  const printOnly = args[0] === '--print-sha256'
  const [kind, destFile] = printOnly ? [args[1], 'unused'] : args
  if ((kind !== 'dll' && kind !== 'source') || !destFile) {
    console.error(
      'Usage: node scripts/ngspice-download.mjs <dll|source> <destFile>\n' +
        '       node scripts/ngspice-download.mjs --print-sha256 <dll|source>'
    )
    process.exit(2)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))
  const version = pkg?.config?.circsim?.ngspiceVersion ?? '46'
  const pin = loadPin(version, kind)
  if (printOnly) {
    process.stdout.write(pin.sha256 + '\n')
    return
  }
  await downloadVerified({
    urls: candidateUrls(version, kind),
    destFile,
    sha256: pin.sha256,
    minSize: 2 * 1024 * 1024,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((err) => {
    console.error('\nFATAL:', err.message)
    process.exit(1)
  })
}
