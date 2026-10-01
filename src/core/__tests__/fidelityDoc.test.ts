/**
 * One fidelity source, rendered in the app and on the site (issue #61).
 *
 * website/docs/concepts/fidelity.md is the only hand-edited copy. The in-app
 * "what circsim can tell you" page (About dialog and the fidelity banner link,
 * both via the circsim:openDocs IPC handler) is the HTML rendered from it by
 * scripts/fidelity-doc.mjs and committed as docs/what-circsim-can-tell-you.html.
 *
 * These tests fail when the committed copy drifts from the website page, when a
 * second hand-edited copy comes back, or when the renderer meets markdown it
 * cannot render (it throws instead of leaking raw syntax into the app).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { renderFidelityHtml, SITE_BASE } from '../../../scripts/fidelity-doc.mjs'

const ROOT = join(__dirname, '../../..')
const SOURCE = join(ROOT, 'website/docs/concepts/fidelity.md')
const BUNDLED_HTML = join(ROOT, 'docs/what-circsim-can-tell-you.html')
const OLD_MARKDOWN_COPY = join(ROOT, 'docs/what-circsim-can-tell-you.md')

describe('fidelity doc: single source', () => {
  it('the website page is the only markdown copy', () => {
    expect(existsSync(SOURCE)).toBe(true)
    expect(existsSync(OLD_MARKDOWN_COPY)).toBe(false)
  })

  it('the bundled HTML equals the render of the website page (run `npm run docs:fidelity` after editing it)', () => {
    const rendered = renderFidelityHtml(readFileSync(SOURCE, 'utf8'))
    expect(readFileSync(BUNDLED_HTML, 'utf8').replace(/\r\n/g, '\n')).toBe(rendered)
  })

  it('the bundled copy carries the facts the old copy had drifted from', () => {
    const html = readFileSync(BUNDLED_HTML, 'utf8').replace(/\r\n/g, '\n')
    expect(html).toContain('about 0.1 Ω')
    expect(html).not.toContain('0.07 Ω')
    expect(html).toContain('27 °C')
    expect(html).toContain('Board Critic</a> does estimate copper resistance')
    expect(html).toContain('Triangle-wave sources')
    expect(html).toContain('minimize the banner')
  })

  it('electron-builder ships the HTML to <resources>/docs and the main process opens that file', () => {
    const cfg = yaml.load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')) as {
      extraResources: { from: string; to?: string }[]
    }
    const entry = cfg.extraResources.find((e) => e.from === 'docs/what-circsim-can-tell-you.html')
    expect(entry?.to).toBe('docs/what-circsim-can-tell-you.html')
    const main = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    expect(main).toContain("docPath('what-circsim-can-tell-you.html')")
    expect(main).not.toContain('what-circsim-can-tell-you.md')
  })
})

describe('renderFidelityHtml', () => {
  it('leaves no markdown syntax in the rendered page', () => {
    const html = readFileSync(BUNDLED_HTML, 'utf8').replace(/\r\n/g, '\n')
    const body = html.replace(/<style>[\s\S]*?<\/style>/, '')
    expect(body).not.toMatch(/^:::/m)
    expect(body).not.toContain('**')
    expect(body).not.toMatch(/\]\(/)
    expect(body).not.toMatch(/^#{1,6} /m)
    expect(body).not.toMatch(/^- /m)
  })

  it('maps relative site links to the hosted docs, which are the only network references', () => {
    const html = renderFidelityHtml('See [the Critic](./board-critic) and [energize](../guides/energize).\n')
    expect(html).toContain(`href="${SITE_BASE}/concepts/board-critic"`)
    expect(html).toContain(`href="${SITE_BASE}/guides/energize"`)
  })

  it('renders headings, lists, emphasis, code and containers', () => {
    const html = renderFidelityHtml(
      [
        '# Title',
        '',
        'Plain **bold** and *italic* and `code` with <b> and &.',
        '',
        '- one',
        '- two',
        '  continued',
        '',
        '::: warning Be careful',
        '- inside',
        ':::',
        ''
      ].join('\n')
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('&lt;b&gt; and &amp;.')
    expect(html).toContain('<li>two continued</li>')
    expect(html).toContain('<div class="box warning"><p class="box-title">Be careful</p>')
  })

  it('throws on markdown it cannot render instead of showing raw syntax', () => {
    expect(() => renderFidelityHtml('| a | b |\n|---|---|\n| 1 | 2 |\n')).toThrow(/table/i)
    expect(() => renderFidelityHtml('```\ncode\n```\n')).toThrow(/fence/i)
    expect(() => renderFidelityHtml('![x](y.png)\n')).toThrow(/image/i)
    expect(() => renderFidelityHtml('> quote\n')).toThrow(/blockquote/i)
    expect(() => renderFidelityHtml('::: details Foo\nx\n:::\n')).toThrow(/container/i)
  })
})
