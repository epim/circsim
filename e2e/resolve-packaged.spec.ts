/**
 * e2e/resolve-packaged.spec.ts: pure unit checks for resolvePackagedExe (issue #66).
 *
 * No app is launched. A fake dist/ tree is built in the OS temp dir for each
 * platform layout electron-builder --dir produces, so the macOS and Linux
 * paths are exercised even when this runs on Windows.
 */

import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { resolvePackagedExe } from './util'

function touch(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
}

test.describe('resolvePackagedExe', () => {
  let dist: string

  test.beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'circsim-dist-'))
  })
  test.afterEach(() => {
    rmSync(dist, { recursive: true, force: true })
  })

  test('returns null when nothing is packaged, on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      expect(resolvePackagedExe(p, dist)).toBeNull()
    }
    expect(resolvePackagedExe('darwin', join(dist, 'no-such-dir'))).toBeNull()
  })

  test('windows: dist/win-unpacked/circsim.exe', () => {
    const exe = join(dist, 'win-unpacked', 'circsim.exe')
    touch(exe)
    expect(resolvePackagedExe('win32', dist)).toBe(exe)
  })

  test('linux: dist/linux-unpacked/circsim', () => {
    const exe = join(dist, 'linux-unpacked', 'circsim')
    touch(exe)
    expect(resolvePackagedExe('linux', dist)).toBe(exe)
  })

  test('macOS arm64: dist/mac-arm64/circsim.app/Contents/MacOS/circsim', () => {
    const exe = join(dist, 'mac-arm64', 'circsim.app', 'Contents', 'MacOS', 'circsim')
    touch(exe)
    expect(resolvePackagedExe('darwin', dist)).toBe(exe)
  })

  test('macOS x64: dist/mac/circsim.app/Contents/MacOS/circsim', () => {
    const exe = join(dist, 'mac', 'circsim.app', 'Contents', 'MacOS', 'circsim')
    touch(exe)
    expect(resolvePackagedExe('darwin', dist)).toBe(exe)
  })

  test('a layout for another OS is not picked up', () => {
    touch(join(dist, 'win-unpacked', 'circsim.exe'))
    expect(resolvePackagedExe('darwin', dist)).toBeNull()
    expect(resolvePackagedExe('linux', dist)).toBeNull()
  })
})
