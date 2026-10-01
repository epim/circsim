/**
 * src/main/hardening.ts (issues #37, #38)
 *
 * Session-level enforcement of two promises:
 *
 *  1. "No network calls, ever" (#38). The renderer's session denies every request
 *     that is not a local file, data, blob or devtools URL, so the promise is a
 *     property of the app rather than of nobody having added a fetch. The
 *     spellchecker (which downloads dictionaries from a Google CDN on Windows and
 *     Linux) is switched off, and every permission request is refused. Every
 *     request is counted in an audit object so a test can assert that an open,
 *     an energize and a critic run issued none.
 *
 *  2. One Content-Security-Policy (#37). The header the main process sets and the
 *     meta tag in index.html carry the same string (a unit test compares them), and
 *     neither allows 'unsafe-inline' for scripts or styles.
 *
 * Navigation guards keep a compromised page from opening windows or leaving the
 * app. No Electron runtime import here (types only), so everything is unit tested
 * with plain fakes.
 */

import type { Session, WebContents } from 'electron'

// ─── Content-Security-Policy ───────────────────────────────────────────────────

/**
 * The renderer's single CSP. `worker-src blob:` is for the board-open worker,
 * which Vite bundles inline (`?worker&inline`) and starts from a blob URL.
 * There is no `unsafe-inline` and no remote origin anywhere.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

// ─── request policy ────────────────────────────────────────────────────────────

/** Schemes that never leave the machine. */
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'blob:', 'devtools:'])

/** True when `url` is a local resource (not a network request at all). */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * True when the renderer session may issue a request for `url`: any local
 * resource, plus (in dev only) the electron-vite dev server and its websocket.
 * `devOrigin` is `process.env.ELECTRON_RENDERER_URL`, unset in a built app.
 */
export function isAllowedRequestUrl(url: string, devOrigin?: string | null): boolean {
  if (isLocalUrl(url)) return true
  if (!devOrigin) return false
  try {
    const target = new URL(url)
    const dev = new URL(devOrigin)
    const web = target.protocol === 'http:' || target.protocol === 'https:'
    const sock = target.protocol === 'ws:' || target.protocol === 'wss:'
    return (web || sock) && target.host === dev.host
  } catch {
    return false
  }
}

/** What the audit remembers about one request. */
export interface AuditedRequest {
  url: string
  resourceType: string
  allowed: boolean
}

/**
 * Running record of the session's requests, exposed on `globalThis` in the main
 * process for tests. `network` lists every request that was not a local
 * resource, allowed or not; an offline run leaves it empty.
 */
export class NetAudit {
  /** Every request seen, local or not. Proves the hook is live. */
  total = 0
  /** Requests for local resources (file, data, blob, devtools). */
  local = 0
  /** Requests that were not local, with the verdict. Capped. */
  network: AuditedRequest[] = []

  record(req: AuditedRequest): void {
    this.total++
    if (isLocalUrl(req.url)) {
      this.local++
      return
    }
    if (this.network.length < 500) this.network.push({ ...req, url: req.url.slice(0, 300) })
  }
}

// ─── permissions ───────────────────────────────────────────────────────────────

/**
 * The app asks for no device, notification, geolocation or media permission, so
 * all of those are denied. The one exception is `clipboard-sanitized-write`, which
 * the "Copy" buttons (Critic report, LLM prompt) need for navigator.clipboard
 * .writeText; it grants no read access and is only given to the app's own file
 * page.
 */
export function isAllowedPermission(permission: string, requestingUrl: string): boolean {
  return permission === 'clipboard-sanitized-write' && requestingUrl.startsWith('file:')
}

// ─── installation ──────────────────────────────────────────────────────────────

/** The slice of Electron's Session the guard touches (so tests can fake it). */
export type GuardableSession = Pick<
  Session,
  | 'webRequest'
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
  | 'setSpellCheckerEnabled'
>

export interface OfflineGuardOptions {
  /** `ELECTRON_RENDERER_URL` in dev, so the dev server stays reachable. */
  devOrigin?: string | null
  audit: NetAudit
  /** Called once per denied request (main logs it). */
  onDenied?: (url: string, resourceType: string) => void
}

/** Install the offline policy, the CSP header and the permission handlers on a session. */
export function installOfflineGuard(ses: GuardableSession, opts: OfflineGuardOptions): void {
  ses.setSpellCheckerEnabled(false)

  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequestUrl(details.url, opts.devOrigin)
    opts.audit.record({ url: details.url, resourceType: details.resourceType ?? '', allowed })
    if (!allowed) opts.onDenied?.(details.url, details.resourceType ?? '')
    callback({ cancel: !allowed })
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string[]> = {}
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() !== 'content-security-policy') headers[name] = value
    }
    headers['Content-Security-Policy'] = [CONTENT_SECURITY_POLICY]
    callback({ responseHeaders: headers })
  })

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isAllowedPermission(permission, details?.requestingUrl ?? wc?.getURL?.() ?? ''))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin ?? ''),
  )
  ses.setDevicePermissionHandler(() => false)
}

// ─── navigation guards ─────────────────────────────────────────────────────────

/** Strip the fragment so a same-page anchor or reload compares equal. */
function withoutHash(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

/**
 * True when a navigation may proceed: only to the page already showing (a
 * reload or a fragment change). Anything else, including another file: URL,
 * is refused; the app is a single page and opens boards through IPC.
 */
export function isAllowedNavigation(target: string, current: string): boolean {
  if (!target || !current) return false
  return withoutHash(target) === withoutHash(current)
}

/** The slice of WebContents the navigation guards use. */
export type GuardableContents = Pick<WebContents, 'setWindowOpenHandler' | 'on' | 'getURL'>

/** Deny window.open and every navigation away from the loaded page, for one WebContents. */
export function installNavigationGuards(contents: GuardableContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (!isAllowedNavigation(url, contents.getURL())) event.preventDefault()
  }
  contents.on('will-navigate', (event, url) => guard(event, url))
  contents.on('will-redirect', (event, url) => guard(event, url))
  // Also reported for subframes; the app has none, so a subframe navigation is refused.
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
    else guard(event, event.url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
