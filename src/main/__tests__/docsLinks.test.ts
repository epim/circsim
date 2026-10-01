/**
 * docsLinks.test.ts - issue #73: the app opens the public docs through a
 * validated slug (origin pinned in main) and ships a real application menu with
 * Help entries, instead of Electron's default menu.
 */

import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  DOCS_BASE_URL,
  HELP_PAGES,
  ISSUES_URL,
  buildMenuTemplate,
  docsPageUrl,
} from '../docsLinks'

describe('docsPageUrl', () => {
  it('resolves docs slugs under the public docs origin', () => {
    expect(docsPageUrl('guides/energize')).toBe('https://epim.github.io/circsim/guides/energize')
    expect(docsPageUrl('concepts/models#stubs-and-interactive-pins')).toBe(
      'https://epim.github.io/circsim/concepts/models#stubs-and-interactive-pins',
    )
    expect(docsPageUrl('')).toBe(DOCS_BASE_URL)
  })

  it('rejects anything that could leave the docs origin or the docs path', () => {
    for (const bad of [
      'https://evil.example/x',
      '//evil.example',
      '/guides/energize',
      '../secret',
      'guides/../x',
      'guides/energize?x=1',
      'guides/energize ',
      'javascript:alert(1)',
      'file:///C:/Windows',
      'Guides/Energize',
      'a'.repeat(300),
    ]) {
      expect(docsPageUrl(bad), bad).toBeNull()
    }
  })

  it('rejects non-strings', () => {
    expect(docsPageUrl(undefined)).toBeNull()
    expect(docsPageUrl(42)).toBeNull()
    expect(docsPageUrl({ toString: () => 'guides/energize' })).toBeNull()
  })

  it('every Help page slug is a valid slug', () => {
    for (const p of HELP_PAGES) expect(docsPageUrl(p.slug), p.label).not.toBeNull()
  })
})

function helpItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const help = template.find(t => t.label === 'Help')
  expect(help).toBeDefined()
  return help!.submenu as MenuItemConstructorOptions[]
}

describe('buildMenuTemplate', () => {
  const deps = () => ({
    isMac: false,
    appName: 'circsim',
    isPackaged: true,
    openDocsPage: vi.fn(),
    openExternal: vi.fn(),
  })

  it('has a Help menu whose entries open the docs pages and the issue tracker', () => {
    const d = deps()
    const items = helpItems(buildMenuTemplate(d))
    const labelled = items.filter(i => i.label)
    expect(labelled.map(i => i.label)).toContain('Glossary of Terms')
    expect(labelled.map(i => i.label)).toContain('Report an Issue')

    const glossary = labelled.find(i => i.label === 'Glossary of Terms')!
    ;(glossary.click as () => void)()
    expect(d.openDocsPage).toHaveBeenCalledWith('guides/glossary')

    const issue = labelled.find(i => i.label === 'Report an Issue')!
    ;(issue.click as () => void)()
    expect(d.openExternal).toHaveBeenCalledWith(ISSUES_URL)
  })

  it('keeps Edit and View so copy, paste, and zoom still work', () => {
    const labels = buildMenuTemplate(deps()).map(t => t.label)
    expect(labels).toEqual(expect.arrayContaining(['Edit', 'View', 'Window', 'Help']))
  })

  it('hides developer tools in packaged builds only', () => {
    const view = (packaged: boolean): MenuItemConstructorOptions[] =>
      buildMenuTemplate({ ...deps(), isPackaged: packaged }).find(t => t.label === 'View')!
        .submenu as MenuItemConstructorOptions[]
    expect(view(true).some(i => i.role === 'toggleDevTools')).toBe(false)
    expect(view(false).some(i => i.role === 'toggleDevTools')).toBe(true)
  })

  it('uses an app menu on macOS and a File menu elsewhere', () => {
    expect(buildMenuTemplate({ ...deps(), isMac: true })[0].label).toBe('circsim')
    expect(buildMenuTemplate({ ...deps(), isMac: false })[0].label).toBe('File')
  })
})
