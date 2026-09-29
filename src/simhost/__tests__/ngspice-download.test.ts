/**
 * Unit test: pinned, move-tolerant ngspice download (issue #36).
 *
 * SourceForge moved ngspice 46 from ng-spice-rework/46/ to
 * ng-spice-rework/old-releases/46/ and every CI leg went red. The download
 * helper must (a) fall through to the next candidate path on 404 and
 * (b) refuse any body whose sha256 differs from the pin, without falling
 * through to another mirror.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { candidateUrls, downloadVerified, loadPin } from '../../../scripts/ngspice-download.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const GOOD = crypto.randomBytes(3 * 1024)
const GOOD_SHA = crypto.createHash('sha256').update(GOOD).digest('hex')
const EVIL = crypto.randomBytes(3 * 1024)

let server: http.Server
let base = ''
let tmp = ''
const hits: string[] = []

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngspice-dl-test-'))
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/new/a.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(GOOD)
    } else if (req.url === '/evil/a.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(EVIL)
    } else if (req.url === '/html/a.bin') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>interstitial</html>')
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('gone')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ngspice pins', () => {
  it('has a well-formed sha256 pin for the configured version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'))
    const version = pkg.config.circsim.ngspiceVersion as string
    for (const kind of ['dll', 'source'] as const) {
      const pin = loadPin(version, kind)
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(pin.archive).toContain(version)
    }
  })

  it('throws for a version with no pin', () => {
    expect(() => loadPin('9999', 'dll')).toThrow(/no pinned sha256/i)
  })
})

describe('candidateUrls', () => {
  it('lists both the current and the old-releases path for each kind', () => {
    for (const kind of ['dll', 'source'] as const) {
      const urls = candidateUrls('46', kind)
      expect(urls.some((u) => u.includes('/ng-spice-rework/46/'))).toBe(true)
      expect(urls.some((u) => u.includes('/ng-spice-rework/old-releases/46/'))).toBe(true)
    }
  })
})

describe('downloadVerified', () => {
  it('falls through a 404 path to the next candidate and accepts a matching hash', async () => {
    hits.length = 0
    const dest = path.join(tmp, 'ok.bin')
    const r = await downloadVerified({
      urls: [`${base}/moved/a.bin`, `${base}/new/a.bin`],
      destFile: dest,
      sha256: GOOD_SHA,
      minSize: 1024,
    })
    expect(r.url).toBe(`${base}/new/a.bin`)
    expect(fs.readFileSync(dest).equals(GOOD)).toBe(true)
    expect(hits).toEqual(['/moved/a.bin', '/new/a.bin'])
  })

  it('rejects a body whose sha256 differs from the pin and leaves no file', async () => {
    hits.length = 0
    const dest = path.join(tmp, 'evil.bin')
    await expect(
      downloadVerified({
        urls: [`${base}/evil/a.bin`, `${base}/new/a.bin`],
        destFile: dest,
        sha256: GOOD_SHA,
        minSize: 1024,
      })
    ).rejects.toThrow(/sha256 mismatch/i)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(dest + '.tmp')).toBe(false)
    // A mismatch is a hard failure: the next mirror is not tried.
    expect(hits).toEqual(['/evil/a.bin'])
  })

  it('skips an HTML interstitial and moves on', async () => {
    const dest = path.join(tmp, 'html.bin')
    const r = await downloadVerified({
      urls: [`${base}/html/a.bin`, `${base}/new/a.bin`],
      destFile: dest,
      sha256: GOOD_SHA,
      minSize: 1024,
    })
    expect(r.url).toBe(`${base}/new/a.bin`)
  })

  it('fails with every attempted URL listed when all candidates are missing', async () => {
    await expect(
      downloadVerified({
        urls: [`${base}/moved/a.bin`, `${base}/nope/a.bin`],
        destFile: path.join(tmp, 'none.bin'),
        sha256: GOOD_SHA,
        minSize: 1024,
      })
    ).rejects.toThrow(/moved\/a\.bin[\s\S]*nope\/a\.bin/)
  })

  it('exposes a CLI the source build script can call', () => {
    const res = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, 'scripts', 'ngspice-download.mjs')],
      { encoding: 'utf8' }
    )
    expect(res.status).not.toBe(0)
    expect(res.stderr).toMatch(/usage/i)
  })
})
