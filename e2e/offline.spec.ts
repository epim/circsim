/**
 * e2e/offline.spec.ts: the offline promise and the renderer hardening, enforced
 * (issues #37, #38, #39).
 *
 * Drives the built app through open, energize and the Board Critic on the First
 * Light sample and asserts, from the main process's own request audit (every
 * request the default session saw), that nothing but local resources was
 * requested. Also asserts silkscreen text reached the scene (before #39 the
 * labels never rendered), that the page logged no Content-Security-Policy
 * violation, that a request to a remote host is cancelled, that window.open and
 * navigation away are refused, and that readFile only serves files the user
 * opened.
 *
 * Prerequisite: npm run build.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { pipeAppOutput, APP_MAIN, resolvePackagedExe } from './util'

interface NetAuditShape {
  total: number
  local: number
  network: { url: string; resourceType: string; allowed: boolean }[]
}

declare global {
  interface Window {
    __cspViolations?: string[]
    __circsimSilkscreen?: { meshes: number; glyphs: number }
  }
}

const REPO_PACKAGE_JSON = join(__dirname, '..', 'package.json')

/** Launch the dev-layout build, or the packaged app when CIRCSIM_E2E_PACKAGED=1. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const packaged = process.env['CIRCSIM_E2E_PACKAGED'] === '1' ? resolvePackagedExe() : null
  if (process.env['CIRCSIM_E2E_PACKAGED'] === '1' && !packaged) throw new Error('packaged binary not built')
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: [], env: { ...process.env } as Record<string, string> }
      : { args: [APP_MAIN], env: { ...process.env, CIRCSIM_E2E: '1' } as Record<string, string> },
  )
  pipeAppOutput(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  // Let the React app mount and the store finish its SimHost handshake, then
  // start recording policy violations. (Not a reload: that would race the
  // port handshake.) Everything that follows, the board open, its worker and
  // every panel render, happens under the listener.
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', e => {
      window.__cspViolations?.push(`${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  return { app, page }
}

async function readAudit(app: ElectronApplication): Promise<NetAuditShape | null> {
  return app.evaluate(() => (globalThis as unknown as { __circsimNetAudit?: NetAuditShape }).__circsimNetAudit ?? null)
}

test.describe('offline enforcement and renderer hardening', () => {
  let app: ElectronApplication

  test.afterEach(async () => {
    try {
      await app?.close()
    } catch {
      // already closed
    }
  })

  test('First Light open, energize and critic: zero network requests, silkscreen renders, no CSP violations', async () => {
    const started = await launch()
    app = started.app
    const page = started.page

    await page.locator('[data-testid="open-first-light-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 20_000 })

    // Silkscreen text reaches the scene as one mesh with glyph quads in it.
    await expect
      .poll(() => page.evaluate(() => window.__circsimSilkscreen?.glyphs ?? 0), { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__circsimSilkscreen?.meshes ?? 0)).toBe(1)

    // Energize, then let the critic audit land.
    await page.locator('[data-testid="energize-btn"]').click()
    await expect(page.locator('[data-testid="op-annotation"]').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-testid="critic-panel"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)

    const audit = await readAudit(app)
    expect(audit, 'main-process request audit is missing').not.toBeNull()
    // The hook is alive (the page itself was a file request) and nothing left the machine.
    expect(audit!.total).toBeGreaterThan(0)
    expect(audit!.network).toEqual([])

    expect(await page.evaluate(() => window.__cspViolations ?? [])).toEqual([])
  })

  test('a request to a remote host is cancelled and logged; the copy button still works', async () => {
    const started = await launch()
    app = started.app
    const page = started.page

    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://example.com/circsim-offline-probe')
        return 'fetched'
      } catch {
        return 'blocked'
      }
    })
    expect(outcome).toBe('blocked')
    const audit = await readAudit(app)
    // Either the CSP (connect-src 'self') stopped it before the network layer, or the
    // session denied it; in no case may an allowed non-local request appear.
    expect(audit!.network.filter(r => r.allowed)).toEqual([])

    // Clipboard write is the one permission the app needs; deny-all must not break it.
    await page.locator('[data-testid="open-sample-btn"]').click()
    await expect(page.locator('[data-testid="critic-finding"]').first()).toBeVisible({ timeout: 20_000 })
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await page.locator('[data-testid="critic-copy-btn"]').click()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()).then(t => t.length), { timeout: 5_000 })
      .toBeGreaterThan(0)
  })

  test('the page cannot fetch or XHR a file outside the app, only its own', async () => {
    const started = await launch()
    app = started.app
    const page = started.page

    // A file that exists and is not one of the app's own: refused by the session.
    const target = pathToFileURL(REPO_PACKAGE_JSON).href
    const outcome = await page.evaluate(async url => {
      const viaFetch = await fetch(url).then(
        r => `fetched ${r.status}`,
        () => 'blocked',
      )
      const viaXhr = await new Promise<string>(resolve => {
        const x = new XMLHttpRequest()
        x.onload = () => resolve(`read ${x.responseText.length}`)
        x.onerror = () => resolve('blocked')
        x.open('GET', url)
        x.send()
      })
      return { viaFetch, viaXhr }
    }, target)
    expect(outcome).toEqual({ viaFetch: 'blocked', viaXhr: 'blocked' })

    const audit = await readAudit(app)
    expect(audit!.network.some(r => !r.allowed && r.url === target)).toBe(true)
    expect(audit!.network.filter(r => r.allowed)).toEqual([])
  })

  test('window.open and navigation away are refused', async () => {
    const started = await launch()
    app = started.app
    const page = started.page
    const before = page.url()

    await page.evaluate(() => {
      window.open('https://example.com/', '_blank')
    })
    await page.evaluate(() => {
      window.location.href = 'https://example.com/'
    })
    await page.waitForTimeout(1000)
    expect(app.windows().length).toBe(1)
    expect(page.url()).toBe(before)
  })

  test('readFile serves only files the user opened', async () => {
    const started = await launch()
    app = started.app
    const page = started.page

    // A real file on disk that was never opened: refused, not read.
    const refused = await page.evaluate(
      async p => {
        try {
          await window.circsim.readFile(p)
          return 'read'
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      },
      REPO_PACKAGE_JSON,
    )
    expect(refused).not.toBe('read')
    expect(await page.evaluate(p => window.circsim.fileExists(p), REPO_PACKAGE_JSON)).toBe(false)

    // Opening a board grants it and its companions, nothing beside them.
    await page.locator('[data-testid="open-first-light-btn"]').click()
    await expect(page.locator('[data-testid="part-row"]').first()).toBeVisible({ timeout: 20_000 })
    const demo = await page.evaluate(() => window.circsim.getFirstLightDemoPath())
    expect((await page.evaluate(p => window.circsim.readFile(p), demo)).length).toBeGreaterThan(0)
    const outsideSibling = join(demo, '..', '..', '..', 'package.json')
    expect(await page.evaluate(p => window.circsim.fileExists(p), outsideSibling)).toBe(false)
  })
})
