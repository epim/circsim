/**
 * plainLanguage.test.tsx - issue #73: primary-flow labels are plain language
 * with the technical term kept secondary, one shared <Term> component defines the
 * jargon, a docs glossary exists, and the app can open the docs pages.
 */

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import Term from '../Term'
import DocsLink, { openDocsPage } from '../docsLink'
import { GLOSSARY, TERM_IDS, termTitle, capitalized } from '../glossary'
import { NoBoardState } from '../../panels/EmptyStates'
import GroundSetup from '../../panels/GroundSetup'
import Toolbar from '../../panels/Toolbar'
import BenchShelf from '../../bench/BenchShelf'
import { AppStoreProvider } from '../../store/storeContext'
import { createAppStore, type AppState } from '../../store/appStore'
import { createMockSimClient } from '../../ipc/simClient'

const repoRoot = join(__dirname, '..', '..', '..', '..', '..')
const docsRoot = join(repoRoot, 'website', 'docs')
const fixturesDir = join(repoRoot, 'fixtures')

/**
 * The slug rule main enforces (src/main/docsLinks.ts). The renderer tsconfig
 * cannot import main code, so the validator regex is read from its source and
 * the test fails if that line moves or changes shape.
 */
function mainSlugRule(): RegExp {
  const src = readFileSync(join(repoRoot, 'src', 'main', 'docsLinks.ts'), 'utf8')
  const m = src.match(/const SLUG_RE = \/(.*)\/\r?\n/)
  if (!m) throw new Error('SLUG_RE not found in src/main/docsLinks.ts')
  return new RegExp(m[1])
}

function kebab(id: string): string {
  return id.replace(/[A-Z]/g, c => '-' + c.toLowerCase())
}

// ─── <Term> ────────────────────────────────────────────────────────────────────

describe('<Term>', () => {
  it('shows the plain label first and the technical term second', () => {
    const html = renderToStaticMarkup(<Term id="stubOpen" />)
    expect(html).toContain('data-term="stubOpen"')
    expect(html.indexOf('Ignore this part')).toBeGreaterThan(-1)
    expect(html.indexOf('Ignore this part')).toBeLessThan(html.indexOf('(Stub open)'))
  })

  it('can hide the technical term and capitalize the plain one', () => {
    const html = renderToStaticMarkup(<Term id="ground" capital showTechnical={false} />)
    expect(html).toContain('Ground (0 V reference)')
    expect(html).not.toContain('SPICE node 0)')
  })

  it('keeps the definition in the DOM for screen readers and is keyboard focusable', () => {
    const html = renderToStaticMarkup(<Term id="gmin" />)
    expect(html).toContain('tabindex="0"')
    expect(html).toMatch(/aria-describedby="[^"]+"/)
    expect(html).toContain(GLOSSARY.gmin.definition)
  })

  it('renders no popover until it is hovered or focused', () => {
    expect(renderToStaticMarkup(<Term id="gmin" />)).not.toContain('term-popover')
  })
})

describe('glossary entries', () => {
  it('every entry has a plain label, a technical term, a definition, and a valid docs slug', () => {
    expect(TERM_IDS.length).toBeGreaterThanOrEqual(12)
    for (const id of TERM_IDS) {
      const e = GLOSSARY[id]
      expect(e.id).toBe(id)
      expect(e.plain.trim().length, id).toBeGreaterThan(0)
      expect(e.technical.trim().length, id).toBeGreaterThan(0)
      expect(e.definition.length, id).toBeGreaterThan(30)
      expect(mainSlugRule().test(e.docs), `${id} docs slug ${e.docs}`).toBe(true)
    }
  })

  it('no entry text uses an em-dash', () => {
    for (const id of TERM_IDS) {
      const e = GLOSSARY[id]
      expect(`${e.plain}${e.technical}${e.definition}`, id).not.toContain(String.fromCharCode(0x2014))
    }
  })

  it('termTitle reads "Plain (technical): definition"', () => {
    expect(termTitle('stubShort')).toBe(
      `Replace with a wire (Stub short): ${GLOSSARY.stubShort.definition}`,
    )
    expect(capitalized('steady-state voltages')).toBe('Steady-state voltages')
  })

  it('every docs slug points at a real page, and every #anchor exists in it', () => {
    for (const id of TERM_IDS) {
      const [slug, anchor] = GLOSSARY[id].docs.split('#')
      const file = join(docsRoot, `${slug}.md`)
      expect(existsSync(file), `${id}: ${file}`).toBe(true)
      if (anchor) {
        const md = readFileSync(file, 'utf8')
        expect(md, `${id}: {#${anchor}} in ${slug}.md`).toContain(`{#${anchor}}`)
      }
    }
  })

  it('the website glossary page lists every term with the same definition', () => {
    const md = readFileSync(join(docsRoot, 'guides', 'glossary.md'), 'utf8')
    for (const id of TERM_IDS) {
      const e = GLOSSARY[id]
      expect(md, `${id} heading`).toContain(`## ${capitalized(e.plain)} {#${kebab(id)}}`)
      expect(md, `${id} technical term`).toContain(e.technical)
      expect(md, `${id} definition`).toContain(e.definition)
    }
  })

  it('the glossary page is reachable from the guides index and sidebar', () => {
    expect(readFileSync(join(docsRoot, 'guides', 'index.md'), 'utf8')).toContain('./glossary')
    expect(readFileSync(join(docsRoot, '.vitepress', 'config.mts'), 'utf8')).toContain('/guides/glossary')
  })
})

// ─── docs links ────────────────────────────────────────────────────────────────

describe('docs links', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('<DocsLink> renders a button naming its target page', () => {
    const html = renderToStaticMarkup(<DocsLink to="guides/energize">Learn more</DocsLink>)
    expect(html).toContain('data-docs="guides/energize"')
    expect(html).toContain('>Learn more<')
  })

  it('openDocsPage goes through the preload bridge with the slug', async () => {
    const openDocsPageMock = vi.fn().mockResolvedValue(true)
    ;(globalThis as { window?: unknown }).window = { circsim: { openDocsPage: openDocsPageMock } }
    await expect(openDocsPage('guides/energize')).resolves.toBe(true)
    expect(openDocsPageMock).toHaveBeenCalledWith('guides/energize')
  })

  it('openDocsPage is a harmless false outside Electron or when the bridge throws', async () => {
    await expect(openDocsPage('guides/energize')).resolves.toBe(false)
    const rejecting = vi.fn().mockRejectedValue(new Error('no'))
    ;(globalThis as { window?: unknown }).window = { circsim: { openDocsPage: rejecting } }
    await expect(openDocsPage('guides/energize')).resolves.toBe(false)
  })
})

// ─── the primary flow ──────────────────────────────────────────────────────────

function readFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

function render(store: ReturnType<typeof createAppStore>, el: React.ReactElement): string {
  const live = store as unknown as { getServerState?: () => AppState }
  live.getServerState = () => store.getState()
  return renderToStaticMarkup(<AppStoreProvider store={store}>{el}</AppStoreProvider>)
}

describe('primary flow wording (issue #73)', () => {
  it('first-run screen links to the first-five-minutes page and the glossary', () => {
    const html = renderToStaticMarkup(
      <NoBoardState onOpen={() => {}} onOpenSample={() => {}} onOpenFirstLight={() => {}} />,
    )
    expect(html).toContain('data-docs="start/first-run"')
    expect(html).toContain('data-docs="guides/glossary"')
  })

  it('ground panel says "Not set" in words and defines Sim.* fields on hover', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-555.kicad_pcb'), 'fixture-555.kicad_pcb')
    store.getState().setGround(null)
    const html = render(store, <GroundSetup />)
    expect(html).toContain('Not set: Power On and Run stay disabled until you pick one')
    expect(html).not.toContain('NOT SET')
    expect(html).toContain('data-term="simFields"')
    expect(html).toContain('data-docs="guides/ground-and-supply"')
  })

  it('Power On tooltip explains the operating point in plain words', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const html = render(store, <Toolbar overlay="realistic" onOverlay={() => {}} />)
    expect(html).toContain('Steady-state voltages (DC operating point)')
    expect(html).not.toContain('Run a DC operating-point check')
  })

  it('bench shelf says Power supply (PSU) and Source R with the term on hover', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    const html = render(store, <BenchShelf />)
    expect(html).toContain('Power supply (PSU)')
    expect(html).toContain('>Source R<')
    expect(html).toContain('Source resistance (Series R)')
    expect(html).not.toContain('>Series R<')
    expect(html).not.toContain('>PSU<')
  })

  it('potentiometer modes read Variable resistor and Voltage divider', () => {
    const store = createAppStore({ simClient: createMockSimClient() })
    store.getState().openBoardFromText(readFixture('fixture-rc.kicad_pcb'), 'fixture-rc.kicad_pcb')
    store.getState().addBenchInstrument('potentiometer')
    const html = render(store, <BenchShelf />)
    expect(html).toContain('>Variable resistor<')
    expect(html).toContain('>Voltage divider<')
    expect(html).toContain('>Total resistance<')
    expect(html).not.toContain('>Rheostat<')
    expect(html).not.toContain('>Divider<')
  })
})

// ─── no leftover jargon labels ─────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__') walk(full, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('renderer source: the jargon strings from issue #73 are gone from labels', () => {
  const sources = walk(join(repoRoot, 'src', 'renderer', 'src')).map(f => ({
    f,
    text: readFileSync(f, 'utf8'),
  }))
  const EM = String.fromCharCode(0x2014)
  const BANNED = [
    'Run a DC operating-point check',
    'NOT SET',
    'Show raw ngspice log',
    `No schematic ${EM} no Sim`,
    `Pin map ${EM} pad`,
    '>Stub open<',
    '>Series R<',
    "label=\"Series R\"",
    "label=\"V High\"",
    "label=\"Total R\"",
  ]
  for (const needle of BANNED) {
    it(`does not contain ${JSON.stringify(needle)}`, () => {
      const hits = sources.filter(s => s.text.includes(needle)).map(s => s.f)
      expect(hits).toEqual([])
    })
  }
})
