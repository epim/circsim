/**
 * electron-builder.yml packaging-config invariants (Task 27, Spec §14, §15).
 *
 * Packaging correctness is the deploy step's #1 risk: a config that "works in
 * dev" but silently ships native libs inside asar (where dlopen can't reach
 * them) or omits the per-platform ngspice dir produces an installer that fails
 * only on a clean machine. These assertions lock the invariants the packaged
 * app depends on:
 *
 *   - asar:true (app code packed) but koffi asarUnpack'd (native .node addon
 *     must load by real path);
 *   - common resources (models, sample, docs) shipped via extraResources to the
 *     paths the runtime resolves (process.resourcesPath/...);
 *   - each platform target (win/mac/linux) bundles ONLY its own ngspice dir, to
 *     <resources>/ngspice/<platform> — exactly where resolveNgspicePaths looks;
 *   - target formats match the spec (NSIS x64; dmg x64+arm64; AppImage+deb x64).
 *
 * js-yaml is resolvable transitively (electron-builder dependency).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'

const CONFIG_PATH = join(process.cwd(), 'electron-builder.yml')

interface ResourceEntry {
  from: string
  to?: string
  filter?: string[]
}
interface TargetEntry {
  target: string
  arch?: string[]
}
interface PlatformBlock {
  target?: TargetEntry[]
  extraResources?: ResourceEntry[]
}
interface BuilderConfig {
  appId: string
  productName: string
  asar?: boolean
  asarUnpack?: string[]
  files?: string[]
  extraResources?: ResourceEntry[]
  win?: PlatformBlock
  mac?: PlatformBlock & { identity?: string | null }
  linux?: PlatformBlock
  nsis?: Record<string, unknown>
}

function loadConfig(): BuilderConfig {
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8')) as BuilderConfig
}

/** Normalize a `to:` target ('models', 'ngspice/win32-x64', ...) for matching. */
function tos(entries: ResourceEntry[] | undefined): string[] {
  return (entries ?? []).map((e) => (e.to ?? e.from).replace(/\\/g, '/'))
}

describe('electron-builder.yml — identity & asar (Spec §14)', () => {
  const cfg = loadConfig()

  it('declares appId and productName circsim', () => {
    expect(cfg.appId).toBeTruthy()
    expect(cfg.productName).toBe('circsim')
  })

  it('packs app code into asar', () => {
    expect(cfg.asar).toBe(true)
  })

  it('asarUnpacks koffi (native .node addon cannot load from inside asar)', () => {
    expect(Array.isArray(cfg.asarUnpack)).toBe(true)
    expect(cfg.asarUnpack!.some((p) => /koffi/.test(p))).toBe(true)
  })

  it('files include the built out/ bundles and package.json', () => {
    const f = cfg.files ?? []
    expect(f.some((p) => p.startsWith('out/'))).toBe(true)
    expect(f).toContain('package.json')
  })
})

describe('electron-builder.yml — common extraResources (outside asar)', () => {
  const cfg = loadConfig()
  const top = tos(cfg.extraResources)

  it('ships the bundled SPICE model library to <resources>/models', () => {
    expect(top).toContain('models')
    const entry = cfg.extraResources!.find((e) => (e.to ?? e.from) === 'models')!
    expect(entry.from).toMatch(/resources[\\/]models/)
  })

  it('ships the sample project to <resources>/sample', () => {
    expect(top).toContain('sample')
  })

  it('ships the fidelity + licensing docs (openDocs / About read these)', () => {
    expect(top.some((t) => /docs\/.*what-circsim-can-tell-you\.md/.test(t))).toBe(true)
    expect(top.some((t) => /docs\/licensing\.md/.test(t))).toBe(true)
  })

  it('ships the ngspice COPYING text (About dialog reads it verbatim)', () => {
    expect(top.some((t) => /ngspice\/COPYING/.test(t))).toBe(true)
  })

  it('does NOT bundle any ngspice platform lib at the top level (per-platform only)', () => {
    // top-level extraResources must not include a whole ngspice/<platform> dir
    expect(top.some((t) => /^ngspice\/(win32|darwin|linux)/.test(t))).toBe(false)
  })
})

describe('electron-builder.yml — per-platform ngspice bundling (Spec §15)', () => {
  const cfg = loadConfig()

  it('Windows bundles ONLY win32-x64 ngspice to <resources>/ngspice/win32-x64', () => {
    const win = tos(cfg.win?.extraResources)
    expect(win).toContain('ngspice/win32-x64')
    expect(win.some((t) => /darwin|linux/.test(t))).toBe(false)
    const fromDir = cfg.win!.extraResources!.find((e) => (e.to ?? '') === 'ngspice/win32-x64')!
    expect(fromDir.from.replace(/\\/g, '/')).toBe('resources/ngspice/win32-x64')
  })

  it('Windows target is NSIS x64', () => {
    const t = cfg.win?.target ?? []
    const nsis = t.find((x) => x.target === 'nsis')
    expect(nsis, 'NSIS target present').toBeTruthy()
    expect(nsis!.arch).toContain('x64')
  })

  it('macOS bundles its own darwin arch dirs and is unsigned (identity:null)', () => {
    const mac = tos(cfg.mac?.extraResources)
    expect(mac).toContain('ngspice/darwin-x64')
    expect(mac).toContain('ngspice/darwin-arm64')
    expect(mac.some((t) => /win32|linux/.test(t))).toBe(false)
    expect(cfg.mac?.identity).toBeNull()
  })

  it('macOS target is dmg with NO arch list (host arch only)', () => {
    // Listing both arches here made every mac runner cross-build the OTHER
    // arch's dmg too — with the wrong ngspice dir inside, since each runner
    // only has its own arch's ngspice and extraResources skips a missing
    // `from:` with just a warning. The last release leg to attach then
    // overwrote both dmgs, shipping one mac installer per release whose
    // simulator could not load. Host-arch-only builds (the electron-builder
    // default when no arch is listed) + one runner per arch produce both
    // dmgs correctly; ci.yml's release job verifies the bundled ngspice arch.
    const t = cfg.mac?.target ?? []
    const dmg = t.find((x) => x.target === 'dmg')
    expect(dmg, 'dmg target present').toBeTruthy()
    expect(dmg!.arch).toBeUndefined()
  })

  it('Linux bundles ONLY linux-x64 ngspice', () => {
    const lin = tos(cfg.linux?.extraResources)
    expect(lin).toContain('ngspice/linux-x64')
    expect(lin.some((t) => /win32|darwin/.test(t))).toBe(false)
  })

  it('Linux targets are AppImage + deb (x64)', () => {
    const t = cfg.linux?.target ?? []
    const names = t.map((x) => x.target)
    expect(names).toContain('AppImage')
    expect(names).toContain('deb')
    for (const x of t) expect(x.arch).toContain('x64')
  })
})

describe('electron-builder.yml — ngspice <resources> path matches resolver', () => {
  const cfg = loadConfig()

  // resolveNgspicePaths() (src/simhost/ngspiceFfi.ts) joins
  // process.resourcesPath + 'ngspice' + <platform>. The `to:` target of each
  // platform's ngspice extraResources must equal `ngspice/<platform>` so the
  // packaged layout matches the resolver exactly.
  it('every platform ngspice `to:` is ngspice/<platform>', () => {
    const checks: [string, string][] = [
      ['win', 'ngspice/win32-x64'],
      ['linux', 'ngspice/linux-x64'],
    ]
    for (const [plat, expected] of checks) {
      const block = (cfg as unknown as Record<string, PlatformBlock>)[plat]
      expect(tos(block.extraResources), `${plat} ngspice target`).toContain(expected)
    }
    // mac has two arch dirs
    const mac = tos(cfg.mac?.extraResources)
    expect(mac).toContain('ngspice/darwin-x64')
    expect(mac).toContain('ngspice/darwin-arm64')
  })
})
