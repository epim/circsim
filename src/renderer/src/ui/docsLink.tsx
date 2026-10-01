/**
 * ui/docsLink.tsx - in-app links to the public docs site (issue #73).
 *
 * circsim makes no network calls itself (CLAUDE.md rules). A docs link hands the
 * page to the OS browser through the preload bridge, and main validates the slug
 * and opens the fixed docs origin (src/main/docsLinks.ts). Outside Electron (unit
 * tests, Storybook-style previews) there is no bridge and the call is a no-op.
 */

import React from 'react'

/**
 * Open a docs page, e.g. `openDocsPage('guides/energize')` or
 * `openDocsPage('concepts/models#stubs-and-interactive-pins')`. Resolves true
 * when the OS accepted the open.
 */
export async function openDocsPage(slug: string): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.circsim?.openDocsPage) return false
    return await window.circsim.openDocsPage(slug)
  } catch {
    return false
  }
}

export interface DocsLinkProps {
  /** Docs page slug (path under the docs site, optional #anchor). */
  to: string
  /** Visible text. Defaults to "Learn more". */
  children?: React.ReactNode
  /** Tooltip; defaults to naming the destination. */
  title?: string
  testId?: string
  style?: React.CSSProperties
}

/** A button styled as a link that opens a docs page in the system browser. */
export default function DocsLink({
  to,
  children,
  title,
  testId,
  style,
}: DocsLinkProps): React.ReactElement {
  return (
    <button
      type="button"
      style={{ ...linkStyle, ...style }}
      title={title ?? `Open the docs page "${to}" in your browser`}
      data-testid={testId ?? 'docs-link'}
      data-docs={to}
      onClick={e => {
        e.stopPropagation()
        void openDocsPage(to)
      }}
    >
      {children ?? 'Learn more'}
    </button>
  )
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#8ab4f8',
  textDecoration: 'underline',
  cursor: 'pointer',
  font: 'inherit',
}
