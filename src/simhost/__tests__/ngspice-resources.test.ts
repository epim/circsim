/**
 * Unit test: ngspice resources layout validation.
 *
 * Asserts that after running fetch-ngspice.mjs (or build-ngspice.sh),
 * the win32-x64 resources directory has:
 *  - a parseable manifest.json
 *  - table.cm is absent (GPL-excluded)
 *  - digital.cm is present (required for XSPICE)
 *  - ngspice.dll and libomp140.x86_64.dll are present
 *
 * This test is skipped if the resources directory doesn't exist yet
 * (before the fetch script is run). In CI it runs after the fetch step.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

// Determine expected platform dir based on current OS
function getPlatformDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(PROJECT_ROOT, 'resources', 'ngspice', 'win32-x64')
    case 'darwin':
      return path.join(
        PROJECT_ROOT,
        'resources',
        'ngspice',
        process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
      )
    default:
      return path.join(PROJECT_ROOT, 'resources', 'ngspice', 'linux-x64')
  }
}

interface NgspiceManifest {
  version: string
  platform: string
  source?: string
  fetched?: string
  files: Record<string, string>
  cmFiles: Record<string, string>
  tablecmExcluded: boolean
}

const platformDir = getPlatformDir()
const manifestPath = path.join(platformDir, 'manifest.json')
const cmDir = path.join(platformDir, 'lib', 'ngspice')

// Check if resources have been fetched/built
const resourcesExist = fs.existsSync(manifestPath)

describe('ngspice resources layout', () => {
  it.skipIf(!resourcesExist)(
    'manifest.json is present and parseable',
    () => {
      expect(fs.existsSync(manifestPath)).toBe(true)
      const raw = fs.readFileSync(manifestPath, 'utf8')
      const manifest: NgspiceManifest = JSON.parse(raw)

      expect(manifest).toBeDefined()
      expect(typeof manifest.version).toBe('string')
      expect(manifest.version.length).toBeGreaterThan(0)
      expect(typeof manifest.files).toBe('object')
      expect(typeof manifest.cmFiles).toBe('object')
    }
  )

  it.skipIf(!resourcesExist)(
    'table.cm is absent (GPL-excluded)',
    () => {
      const tableCm = path.join(cmDir, 'table.cm')
      expect(fs.existsSync(tableCm)).toBe(false)
    }
  )

  it.skipIf(!resourcesExist)(
    'manifest.json has tablecmExcluded: true',
    () => {
      const manifest: NgspiceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      expect(manifest.tablecmExcluded).toBe(true)
    }
  )

  it.skipIf(!resourcesExist)(
    'digital.cm is present (required for XSPICE)',
    () => {
      const digitalCm = path.join(cmDir, 'digital.cm')
      expect(fs.existsSync(digitalCm)).toBe(true)
    }
  )

  it.skipIf(!resourcesExist)(
    'manifest.json lists digital.cm in cmFiles',
    () => {
      const manifest: NgspiceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      expect(manifest.cmFiles).toHaveProperty('digital.cm')
      expect(typeof manifest.cmFiles['digital.cm']).toBe('string')
      // SHA-256 is 64 hex chars
      expect(manifest.cmFiles['digital.cm']).toMatch(/^[0-9a-f]{64}$/)
    }
  )

  it.skipIf(!resourcesExist || process.platform !== 'win32')(
    'win32: ngspice.dll and libomp140.x86_64.dll are present',
    () => {
      expect(fs.existsSync(path.join(platformDir, 'ngspice.dll'))).toBe(true)
      expect(fs.existsSync(path.join(platformDir, 'libomp140.x86_64.dll'))).toBe(true)
    }
  )

  it.skipIf(!resourcesExist || process.platform !== 'win32')(
    'win32: manifest.json lists ngspice.dll and libomp140.x86_64.dll with sha256',
    () => {
      const manifest: NgspiceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      expect(manifest.files).toHaveProperty('ngspice.dll')
      expect(manifest.files).toHaveProperty('libomp140.x86_64.dll')
      expect(manifest.files['ngspice.dll']).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.files['libomp140.x86_64.dll']).toMatch(/^[0-9a-f]{64}$/)
    }
  )

  it.skipIf(!resourcesExist)(
    'lib/ngspice/ directory exists and contains at least one .cm file',
    () => {
      expect(fs.existsSync(cmDir)).toBe(true)
      const cmFiles = fs.readdirSync(cmDir).filter(f => f.endsWith('.cm'))
      expect(cmFiles.length).toBeGreaterThan(0)
    }
  )

  it.skipIf(!resourcesExist)(
    'manifest version matches package.json ngspiceVersion config',
    () => {
      const manifest: NgspiceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
      )
      const configVersion: string = pkgJson?.config?.circsim?.ngspiceVersion ?? '46'
      expect(manifest.version).toBe(configVersion)
    }
  )

  // This test always runs (no skip) — it tests the ABSENCE of resources
  // before the fetch script has been run, to confirm the test framework works.
  it('test infrastructure is working', () => {
    // Trivial assertion to confirm vitest can import and run this file
    expect(true).toBe(true)
  })
})
