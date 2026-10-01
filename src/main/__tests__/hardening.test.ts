/**
 * Issues #37 and #38: one CSP, offline enforcement in the session layer, and
 * navigation guards. Fakes stand in for Electron's Session and WebContents.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  CONTENT_SECURITY_POLICY,
  NetAudit,
  installNavigationGuards,
  installOfflineGuard,
  isAllowedNavigation,
  isAllowedPermission,
  isAllowedRequestUrl,
  type GuardableContents,
  type GuardableSession,
} from '../hardening'

describe('Content-Security-Policy', () => {
  it('has no unsafe-inline, unsafe-eval or remote origin', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval/)
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/)
  })

  it('is the very string in index.html (header and meta agree)', () => {
    const html = readFileSync(join(__dirname, '..', '..', 'renderer', 'index.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)
    expect(meta, 'index.html has a CSP meta tag').not.toBeNull()
    expect(meta![1]).toBe(CONTENT_SECURITY_POLICY)
  })

  it('locks down plugins, base URI, forms and frames', () => {
    for (const d of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"]) {
      expect(CONTENT_SECURITY_POLICY).toContain(d)
    }
  })
})

describe('isAllowedRequestUrl', () => {
  it('allows local resources', () => {
    for (const u of [
      'file:///C:/app/resources/app.asar/out/renderer/index.html',
      'file:///opt/circsim/assets/index.js',
      'blob:file:///1234-abcd',
      'data:image/png;base64,AAAA',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(isAllowedRequestUrl(u)).toBe(true)
    }
  })

  it('denies every network scheme and host', () => {
    for (const u of [
      'https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data/font-meta/latin.json',
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
      'http://127.0.0.1:8080/x',
      'http://localhost:5173/',
      'ws://localhost:5173/',
      'wss://example.com/',
      'ftp://example.com/x',
      'chrome-extension://abcdef/page.html',
      'not a url',
      '',
    ]) {
      expect(isAllowedRequestUrl(u), u).toBe(false)
    }
  })

  it('allows only the dev server origin, and only when one is configured', () => {
    expect(isAllowedRequestUrl('http://localhost:5173/src/main.tsx', 'http://localhost:5173')).toBe(true)
    expect(isAllowedRequestUrl('ws://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isAllowedRequestUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isAllowedRequestUrl('https://example.com/', 'http://localhost:5173')).toBe(false)
  })
})

describe('isAllowedPermission', () => {
  it('denies everything except the clipboard write the copy buttons use', () => {
    const app = 'file:///C:/app/index.html'
    for (const p of ['geolocation', 'media', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'openExternal']) {
      expect(isAllowedPermission(p, app), p).toBe(false)
    }
    expect(isAllowedPermission('clipboard-sanitized-write', app)).toBe(true)
    expect(isAllowedPermission('clipboard-sanitized-write', 'https://example.com/')).toBe(false)
  })
})

describe('NetAudit', () => {
  it('counts local requests and keeps network ones', () => {
    const a = new NetAudit()
    a.record({ url: 'file:///x/index.html', resourceType: 'mainFrame', allowed: true })
    a.record({ url: 'blob:file:///1', resourceType: 'script', allowed: true })
    a.record({ url: 'https://example.com/', resourceType: 'xhr', allowed: false })
    expect(a.total).toBe(3)
    expect(a.local).toBe(2)
    expect(a.network).toEqual([{ url: 'https://example.com/', resourceType: 'xhr', allowed: false }])
  })
})

type Listener = (details: unknown, callback: (r: unknown) => void) => void

function fakeSession(): { ses: GuardableSession; handlers: Record<string, unknown> } {
  const handlers: Record<string, unknown> = {}
  const ses = {
    setSpellCheckerEnabled: vi.fn((v: boolean) => {
      handlers['spell'] = v
    }),
    setPermissionRequestHandler: vi.fn((h: unknown) => {
      handlers['permissionRequest'] = h
    }),
    setPermissionCheckHandler: vi.fn((h: unknown) => {
      handlers['permissionCheck'] = h
    }),
    setDevicePermissionHandler: vi.fn((h: unknown) => {
      handlers['device'] = h
    }),
    webRequest: {
      onBeforeRequest: vi.fn((h: unknown) => {
        handlers['beforeRequest'] = h
      }),
      onHeadersReceived: vi.fn((h: unknown) => {
        handlers['headers'] = h
      }),
    },
  } as unknown as GuardableSession
  return { ses, handlers }
}

describe('installOfflineGuard', () => {
  it('turns the spellchecker off', () => {
    const { ses, handlers } = fakeSession()
    installOfflineGuard(ses, { audit: new NetAudit() })
    expect(handlers['spell']).toBe(false)
  })

  it('cancels a remote request, lets a file request through, and audits both', () => {
    const { ses, handlers } = fakeSession()
    const audit = new NetAudit()
    const onDenied = vi.fn()
    installOfflineGuard(ses, { audit, onDenied })
    const before = handlers['beforeRequest'] as Listener

    const cb1 = vi.fn()
    before({ url: 'file:///app/index.html', resourceType: 'mainFrame' }, cb1)
    expect(cb1).toHaveBeenCalledWith({ cancel: false })

    const cb2 = vi.fn()
    before({ url: 'https://redirector.gvt1.com/dict.bdic', resourceType: 'other' }, cb2)
    expect(cb2).toHaveBeenCalledWith({ cancel: true })
    expect(onDenied).toHaveBeenCalledWith('https://redirector.gvt1.com/dict.bdic', 'other')
    expect(audit.network).toHaveLength(1)
    expect(audit.network[0].allowed).toBe(false)
  })

  it('sets the one CSP on every response, replacing any other casing', () => {
    const { ses, handlers } = fakeSession()
    installOfflineGuard(ses, { audit: new NetAudit() })
    const cb = vi.fn()
    ;(handlers['headers'] as Listener)(
      { responseHeaders: { 'content-security-policy': ["script-src 'unsafe-inline'"], 'Content-Type': ['text/html'] } },
      cb,
    )
    const headers = (cb.mock.calls[0][0] as { responseHeaders: Record<string, string[]> }).responseHeaders
    expect(headers['Content-Security-Policy']).toEqual([CONTENT_SECURITY_POLICY])
    expect(Object.keys(headers).filter(k => k.toLowerCase() === 'content-security-policy')).toHaveLength(1)
    expect(headers['Content-Type']).toEqual(['text/html'])
  })

  it('denies permission requests, permission checks and device access', () => {
    const { ses, handlers } = fakeSession()
    installOfflineGuard(ses, { audit: new NetAudit() })
    const cb = vi.fn()
    ;(handlers['permissionRequest'] as (...a: unknown[]) => void)(
      { getURL: () => 'file:///app/index.html' },
      'geolocation',
      cb,
      { requestingUrl: 'file:///app/index.html' },
    )
    expect(cb).toHaveBeenCalledWith(false)
    expect((handlers['permissionCheck'] as (...a: unknown[]) => boolean)(null, 'media', 'file:///app/index.html')).toBe(
      false,
    )
    expect((handlers['device'] as () => boolean)()).toBe(false)
  })
})

describe('navigation guards', () => {
  it('only a reload or fragment change of the loaded page is allowed', () => {
    const cur = 'file:///app/out/renderer/index.html'
    expect(isAllowedNavigation(cur, cur)).toBe(true)
    expect(isAllowedNavigation(`${cur}#panel`, cur)).toBe(true)
    expect(isAllowedNavigation('file:///C:/Users/me/.ssh/id_rsa', cur)).toBe(false)
    expect(isAllowedNavigation('https://example.com/', cur)).toBe(false)
    expect(isAllowedNavigation('', cur)).toBe(false)
  })

  function fakeContents(url: string): {
    contents: GuardableContents
    emit: (event: string, ...args: unknown[]) => { prevented: boolean }
    openHandler: () => { action: string }
  } {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    let open: () => { action: string } = () => ({ action: 'allow' })
    const contents = {
      getURL: () => url,
      setWindowOpenHandler: (h: () => { action: string }) => {
        open = h
      },
      on: (event: string, l: (...a: unknown[]) => void) => {
        listeners.set(event, l)
        return contents
      },
    } as unknown as GuardableContents
    return {
      contents,
      openHandler: () => open(),
      emit: (event, ...args) => {
        const e = { prevented: false, preventDefault() { this.prevented = true } } as Record<string, unknown> & {
          prevented: boolean
        }
        const first = args[0] && typeof args[0] === 'object' ? Object.assign(e, args[0]) : e
        listeners.get(event)?.(first, ...(typeof args[0] === 'string' ? args : []))
        return { prevented: e.prevented }
      },
    }
  }

  it('denies window.open', () => {
    const f = fakeContents('file:///app/index.html')
    installNavigationGuards(f.contents)
    expect(f.openHandler()).toEqual({ action: 'deny' })
  })

  it('prevents will-navigate away but not a same-page reload', () => {
    const f = fakeContents('file:///app/index.html')
    installNavigationGuards(f.contents)
    expect(f.emit('will-navigate', 'https://example.com/').prevented).toBe(true)
    expect(f.emit('will-navigate', 'file:///app/index.html').prevented).toBe(false)
    expect(f.emit('will-redirect', 'https://example.com/').prevented).toBe(true)
  })

  it('prevents subframe navigation and webview attachment', () => {
    const f = fakeContents('file:///app/index.html')
    installNavigationGuards(f.contents)
    expect(f.emit('will-frame-navigate', { url: 'file:///app/index.html', isMainFrame: false }).prevented).toBe(true)
    expect(f.emit('will-frame-navigate', { url: 'https://example.com/', isMainFrame: true }).prevented).toBe(true)
    expect(f.emit('will-frame-navigate', { url: 'file:///app/index.html', isMainFrame: true }).prevented).toBe(false)
    expect(f.emit('will-attach-webview').prevented).toBe(true)
  })
})
