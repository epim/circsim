/**
 * EmptyStates.test.tsx — Gemini finding 2 (button hierarchy).
 *
 * The first-run card must have exactly ONE solid primary CTA (Open sample
 * project); the other two are quiet outline buttons. Static SSR render —
 * pure props component, no store needed.
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoBoardState } from '../EmptyStates'
import { btnPrimary, btnSecondary } from '../../ui/buttonStyles'

const noop = (): void => {}

function render(): string {
  return renderToStaticMarkup(
    <NoBoardState onOpen={noop} onOpenSample={noop} onOpenFirstLight={noop} />,
  )
}

describe('NoBoardState — first-run button hierarchy (Gemini finding 2)', () => {
  it('renders all three open buttons with their stable E2E testids', () => {
    const html = render()
    for (const id of ['open-sample-btn', 'open-first-light-btn', 'open-board-btn']) {
      expect(html).toContain(`data-testid="${id}"`)
    }
  })

  it('sample project is the single solid primary CTA', () => {
    const html = render()
    const solidBg = String(btnPrimary.background) // '#256b45'
    // the primary background appears exactly once in the whole card…
    expect(html.split(solidBg).length - 1).toBe(1)
    // …and it is on the sample-project button (style attr precedes the testid in the same tag)
    expect(html).toMatch(
      new RegExp(`<button style="[^"]*background:${solidBg}[^"]*"[^>]*data-testid="open-sample-btn"`),
    )
  })

  it('the other two are transparent outline buttons', () => {
    const html = render()
    expect(String(btnSecondary.background)).toBe('transparent')
    for (const id of ['open-first-light-btn', 'open-board-btn']) {
      expect(html).toMatch(
        new RegExp(`<button style="[^"]*background:transparent[^"]*"[^>]*data-testid="${id}"`),
      )
    }
  })

  it('sample project comes first in DOM order', () => {
    const html = render()
    expect(html.indexOf('open-sample-btn')).toBeLessThan(html.indexOf('open-first-light-btn'))
    expect(html.indexOf('open-first-light-btn')).toBeLessThan(html.indexOf('open-board-btn'))
  })
})
