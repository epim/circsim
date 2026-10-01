/**
 * src/main/docsLinks.ts - docs URLs and the application menu (issue #73).
 *
 * Pure (no `electron` runtime import) so it unit-tests without Electron.
 * index.ts wires `docsPageUrl` into an IPC handler and feeds `buildMenuTemplate`
 * to `Menu.buildFromTemplate`.
 *
 * circsim makes no network calls of its own. "Help" hands a fixed https URL to
 * the operating system's browser (`shell.openExternal`); the renderer can only
 * choose a page slug, which is validated here against a strict pattern so the
 * origin can never be changed from the renderer.
 */

import type { MenuItemConstructorOptions } from 'electron'

/** Public docs site (VitePress, deployed by .github/workflows/docs.yml). */
export const DOCS_BASE_URL = 'https://epim.github.io/circsim/'
/** Where "Report an issue" points. */
export const ISSUES_URL = 'https://github.com/epim/circsim/issues'

/** Lowercase path segments joined by "/", optional "#anchor"; empty means the docs home. */
const SLUG_RE = /^(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?(?:#[a-z0-9][a-z0-9-]*)?$/

/**
 * Resolve a docs slug (`guides/energize`, `concepts/models#stubs`) to a full URL
 * under DOCS_BASE_URL, or null when the slug is not a plain docs path.
 */
export function docsPageUrl(slug: unknown): string | null {
  if (typeof slug !== 'string' || slug.length > 200 || !SLUG_RE.test(slug)) return null
  return DOCS_BASE_URL + slug
}

/** Help-menu pages, in menu order. Slugs are relative to the docs site. */
export const HELP_PAGES: readonly { label: string; slug: string }[] = [
  { label: 'circsim Documentation', slug: '' },
  { label: 'Your First Five Minutes', slug: 'start/first-run' },
  { label: 'Glossary of Terms', slug: 'guides/glossary' },
  { label: 'What Can circsim Tell Me?', slug: 'concepts/fidelity' },
  { label: 'Reading the Warnings', slug: 'guides/warnings' },
]

export interface MenuDeps {
  isMac: boolean
  appName: string
  /** Packaged builds hide the developer tools entry. */
  isPackaged: boolean
  /** Open a docs page by slug (already known to be valid). */
  openDocsPage: (slug: string) => void
  /** Open a fixed external URL (issue tracker). */
  openExternal: (url: string) => void
}

/**
 * The application menu: standard File, Edit, View, Window entries (so copy,
 * paste, zoom, and full screen keep working) and a real Help menu that opens
 * the public docs.
 */
export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    ...(deps.isPackaged ? [] : ([{ role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]

  const helpSubmenu: MenuItemConstructorOptions[] = [
    ...HELP_PAGES.map(p => ({
      label: p.label,
      click: () => deps.openDocsPage(p.slug),
    })),
    { type: 'separator' },
    { label: 'Report an Issue', click: () => deps.openExternal(ISSUES_URL) },
  ]

  const template: MenuItemConstructorOptions[] = []
  if (deps.isMac) {
    template.push({
      label: deps.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  } else {
    template.push({
      label: 'File',
      submenu: [{ role: 'quit' }],
    })
  }
  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: 'Help', role: 'help', submenu: helpSubmenu },
  )
  return template
}
