/**
 * ui/Term.tsx - one shared way to show a technical term (issue #73).
 *
 * Renders the plain-language label first and the technical term as a smaller
 * secondary label. Hover, keyboard focus, or click opens a short definition with
 * a link to the docs page. The definition is always in the DOM for screen readers
 * (aria-describedby), so nothing depends on hover.
 *
 * Use `<Term id="..."/>` for running text. For buttons and `title` attributes
 * use `termTitle(id)` from ./glossary instead (a popover inside a button is not
 * a good control).
 */

import React, { useId, useRef, useState } from 'react'
import { GLOSSARY, capitalized, type TermId } from './glossary'
import DocsLink from './docsLink'
import { TEXT_HINT } from './palette'

export interface TermProps {
  id: TermId
  /** Show "(technical term)" after the plain label. Default true. */
  showTechnical?: boolean
  /** Capitalize the plain label (start of a sentence or a heading). */
  capital?: boolean
}

/**
 * Whether a blur on the term (or anything inside its popover) should close the
 * popover. Focus moving between the term and its own Learn-more link stays
 * inside the container, so the popover must stay open; otherwise the focused
 * link would unmount and keyboard focus would fall to <body>.
 */
export function shouldCloseOnBlur(
  container: { contains(node: unknown): boolean } | null,
  relatedTarget: unknown,
): boolean {
  if (!container || relatedTarget == null) return true
  return !container.contains(relatedTarget)
}

export default function Term({
  id,
  showTechnical = true,
  capital = false,
}: TermProps): React.ReactElement {
  const entry = GLOSSARY[id]
  const popId = useId()
  const ref = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const open = (): void => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    // Fixed positioning escapes the docks' overflow clipping; clamp to the window.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8))
    setPos({ left, top: r.bottom })
  }
  const close = (): void => setPos(null)

  return (
    <span
      ref={ref}
      style={termStyle}
      tabIndex={0}
      data-term={id}
      aria-describedby={popId}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={e => {
        if (shouldCloseOnBlur(ref.current, e.relatedTarget)) close()
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          close()
          // If focus was on the docs link, it is about to unmount: return it to the term.
          if (e.target !== e.currentTarget) ref.current?.focus()
        } else if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          // Only for the term itself; the docs link button must keep its own Enter/Space.
          e.preventDefault()
          if (pos) close()
          else open()
        }
      }}
    >
      {capital ? capitalized(entry.plain) : entry.plain}
      {showTechnical && <span style={techStyle}> ({entry.technical})</span>}
      <span id={popId} style={srOnlyStyle}>
        {entry.technical}: {entry.definition}
      </span>
      {pos && (
        // Padding (not margin) bridges the pointer from the text to the card.
        <span
          role="tooltip"
          style={{ ...popWrapStyle, left: pos.left, top: pos.top }}
          data-testid="term-popover"
        >
          <span style={popCardStyle}>
            <strong style={{ display: 'block', marginBottom: 2 }}>
              {capitalized(entry.plain)}
              <span style={techStyle}> ({entry.technical})</span>
            </strong>
            {entry.definition}{' '}
            <DocsLink to={entry.docs} testId="term-docs-link">
              Learn more in the docs
            </DocsLink>
          </span>
        </span>
      )}
    </span>
  )
}

const POPOVER_WIDTH = 260

const termStyle: React.CSSProperties = {
  textDecoration: 'underline dotted',
  textUnderlineOffset: 3,
  cursor: 'help',
}
const techStyle: React.CSSProperties = {
  color: TEXT_HINT,
  fontSize: '0.9em',
  fontWeight: 400,
}
const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}
const popWrapStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 1000,
  width: POPOVER_WIDTH,
  paddingTop: 6,
  textDecoration: 'none',
  cursor: 'default',
}
const popCardStyle: React.CSSProperties = {
  display: 'block',
  background: '#20202e',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '8px 10px',
  color: '#e6e6f0',
  fontSize: 12,
  fontWeight: 400,
  lineHeight: 1.4,
  fontStyle: 'normal',
  boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
}
