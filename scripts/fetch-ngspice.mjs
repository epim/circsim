#!/usr/bin/env node
/**
 * fetch-ngspice.mjs — Download and unpack the ngspice Windows 64-bit shared library.
 *
 * Fetches ngspice-<version>_dll_64.7z from SourceForge master.dl (the only URL that
 * returns the binary directly — other SF mirrors return an HTML interstitial).
 *
 * Output layout:
 *   resources/ngspice/win32-x64/ngspice.dll
 *   resources/ngspice/win32-x64/libomp140.x86_64.dll
 *   resources/ngspice/win32-x64/lib/ngspice/*.cm   (table.cm deleted)
 *   resources/ngspice/win32-x64/manifest.json
 *
 * Usage: node scripts/fetch-ngspice.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

// 7zip-min ships a bundled 7za binary for win/mac/linux.
import * as _7z from '7zip-min'

// ---------------------------------------------------------------------------
// Config — version pinned in package.json config.circsim.ngspiceVersion
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const pkgJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))
const VERSION = pkgJson?.config?.circsim?.ngspiceVersion ?? '46'

const ARCHIVE_NAME = `ngspice-${VERSION}_dll_64.7z`
const DOWNLOAD_URL =
  `https://master.dl.sourceforge.net/project/ngspice/ng-spice-rework/${VERSION}/${ARCHIVE_NAME}?viasf=1`

const DEST_DIR = path.join(PROJECT_ROOT, 'resources', 'ngspice', 'win32-x64')
const CM_DEST_DIR = path.join(DEST_DIR, 'lib', 'ngspice')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a file. */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/** Glob for files matching a suffix inside a directory tree (non-recursive needed for flat dir). */
function globFiles(dir, suffix) {
  if (!fs.existsSync(dir)) return []
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...globFiles(full, suffix))
    } else if (entry.name.endsWith(suffix)) {
      results.push(full)
    }
  }
  return results
}

/** Find files by name anywhere under a directory tree. */
function findByName(dir, name) {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findByName(full, name))
    } else if (entry.name === name) {
      results.push(full)
    }
  }
  return results
}

/** Download URL → local file with validation (content-type + size). */
async function download(url, destFile) {
  console.log(`Downloading ${url} ...`)

  // Use fetch (Node 18+ built-in)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'circsim-build/1.0' },
    redirect: 'follow',
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10)

  // Fail loudly if we got an HTML interstitial instead of the binary
  if (contentType.includes('text/html')) {
    throw new Error(
      `DOWNLOAD FAILED: Server returned HTML instead of a 7z archive.\n` +
      `URL: ${url}\n` +
      `Content-Type: ${contentType}\n` +
      `This usually means a SourceForge interstitial page was returned. ` +
      `Try using the master.dl URL with ?viasf=1 parameter.`
    )
  }

  // The body arrives; write it to disk first, then validate size
  const tmpFile = destFile + '.tmp'
  const ws = createWriteStream(tmpFile)
  await pipeline(res.body, ws)

  const stat = fs.statSync(tmpFile)
  const MIN_SIZE = 2 * 1024 * 1024 // 2 MB
  if (stat.size < MIN_SIZE) {
    fs.unlinkSync(tmpFile)
    throw new Error(
      `DOWNLOAD FAILED: File is only ${stat.size} bytes (< 2 MB minimum).\n` +
      `The download likely returned an HTML page or incomplete data.\n` +
      `URL: ${url}`
    )
  }

  fs.renameSync(tmpFile, destFile)
  console.log(`Downloaded ${(stat.size / 1024 / 1024).toFixed(1)} MB → ${destFile}`)
  return destFile
}

/** Unpack archive to destDir using 7zip-min. Returns a promise. */
function unpackArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    _7z.unpack(archivePath, destDir, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`=== fetch-ngspice v${VERSION} (Windows x64 DLL) ===`)

  if (process.platform !== 'win32') {
    console.warn(
      'WARNING: fetch-ngspice.mjs is intended for Windows. ' +
      'On macOS/Linux use scripts/build-ngspice.sh to compile from source.'
    )
    // Allow running on other platforms in CI for testing the script logic
  }

  // Create output directories
  fs.mkdirSync(DEST_DIR, { recursive: true })
  fs.mkdirSync(CM_DEST_DIR, { recursive: true })

  // Work in a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngspice-fetch-'))
  const archivePath = path.join(tmpDir, ARCHIVE_NAME)

  try {
    // 1. Download
    await download(DOWNLOAD_URL, archivePath)

    // 2. Extract
    console.log(`Extracting to ${tmpDir} ...`)
    await unpackArchive(archivePath, tmpDir)
    console.log('Extraction complete.')

    // 3. Find DLLs — locate by name anywhere in the extracted tree
    //    (don't hardcode the top-folder name to support future version bumps)
    const ngspiceDllSrc = findByName(tmpDir, 'ngspice.dll')[0]
    const libomp140Src = findByName(tmpDir, 'libomp140.x86_64.dll')[0]

    if (!ngspiceDllSrc) {
      throw new Error('ngspice.dll not found in extracted archive. Archive structure may have changed.')
    }
    if (!libomp140Src) {
      throw new Error(
        'libomp140.x86_64.dll not found in extracted archive.\n' +
        'This OpenMP runtime is REQUIRED — ngspice.dll will not load without it.'
      )
    }

    // 4. Find .cm files
    const cmFiles = globFiles(tmpDir, '.cm').filter(f => !f.includes(path.sep + path.basename(ARCHIVE_NAME)))

    if (cmFiles.length === 0) {
      throw new Error('No .cm files found in extracted archive. XSPICE code models are missing.')
    }

    console.log(`Found ${cmFiles.length} .cm files`)

    // 5. Copy DLLs
    const ngspiceDllDest = path.join(DEST_DIR, 'ngspice.dll')
    const libomp140Dest = path.join(DEST_DIR, 'libomp140.x86_64.dll')
    fs.copyFileSync(ngspiceDllSrc, ngspiceDllDest)
    fs.copyFileSync(libomp140Src, libomp140Dest)
    console.log(`Copied ngspice.dll → ${ngspiceDllDest}`)
    console.log(`Copied libomp140.x86_64.dll → ${libomp140Dest}`)

    // 6. Copy .cm files, DELETE table.cm (GPL-licensed third-party code)
    let deletedTable = false
    const copiedCm = []
    for (const cmSrc of cmFiles) {
      const name = path.basename(cmSrc)
      const dest = path.join(CM_DEST_DIR, name)
      if (name === 'table.cm') {
        console.log(`Skipping table.cm (GPL-licensed — excluded per §7.2)`)
        deletedTable = true
        continue
      }
      fs.copyFileSync(cmSrc, dest)
      copiedCm.push(name)
    }
    // If table.cm somehow ended up in dest, delete it
    const tableCmDest = path.join(CM_DEST_DIR, 'table.cm')
    if (fs.existsSync(tableCmDest)) {
      fs.unlinkSync(tableCmDest)
      deletedTable = true
      console.log(`Deleted table.cm from destination (GPL — excluded per §7.2)`)
    }

    console.log(`Copied .cm files: ${copiedCm.join(', ')}`)

    // 7. Verify digital.cm is present
    const digitalCm = path.join(CM_DEST_DIR, 'digital.cm')
    if (!fs.existsSync(digitalCm)) {
      throw new Error(
        'digital.cm is missing after extraction!\n' +
        'This file is required for XSPICE digital simulation. Archive may be corrupt.'
      )
    }
    console.log('Verified: digital.cm present')

    // 8. Copy spinit script if present
    const spinitSrc = findByName(tmpDir, 'spinit')[0]
    if (spinitSrc) {
      const spinitDest = path.join(DEST_DIR, 'spinit.stock')
      fs.copyFileSync(spinitSrc, spinitDest)
      console.log(`Copied stock spinit → ${spinitDest} (for reference; SimHost generates a patched version at runtime)`)
    }

    // 9. Build manifest.json
    const manifest = {
      version: VERSION,
      platform: 'win32-x64',
      source: DOWNLOAD_URL,
      fetched: new Date().toISOString(),
      files: {
        'ngspice.dll': sha256File(ngspiceDllDest),
        'libomp140.x86_64.dll': sha256File(libomp140Dest),
      },
      cmFiles: {},
      tablecmExcluded: true,
    }

    for (const name of copiedCm) {
      manifest.cmFiles[name] = sha256File(path.join(CM_DEST_DIR, name))
    }

    const manifestPath = path.join(DEST_DIR, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    console.log(`Wrote ${manifestPath}`)
    console.log('\nManifest contents:')
    console.log(JSON.stringify(manifest, null, 2))

    // 10. Final verification
    if (!fs.existsSync(ngspiceDllDest)) throw new Error('ngspice.dll missing after copy!')
    if (!fs.existsSync(libomp140Dest)) throw new Error('libomp140.x86_64.dll missing after copy!')
    if (!fs.existsSync(digitalCm)) throw new Error('digital.cm missing after copy!')
    if (fs.existsSync(tableCmDest)) throw new Error('table.cm MUST NOT be present (GPL)!')

    console.log('\n=== fetch-ngspice: SUCCESS ===')
    console.log(`DLLs at:      ${DEST_DIR}`)
    console.log(`CM files at:  ${CM_DEST_DIR}`)
    console.log(`table.cm excluded: ${!fs.existsSync(tableCmDest)}`)
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (_) {
      // non-fatal
    }
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
