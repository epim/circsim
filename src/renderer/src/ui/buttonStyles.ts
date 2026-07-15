/**
 * ui/buttonStyles.ts — shared button hierarchy (Gemini UX finding 2).
 *
 * Three tiers, plain inline-style objects (the renderer has no stylesheet):
 *   btnPrimary   — solid call-to-action. At most ONE per view.
 *   btnSecondary — outline; normal-weight actions.
 *   btnGhost     — quiet text-like; tertiary/utility actions.
 *
 * Consumers may spread-and-override geometry ({ ...btnSecondary, padding: … });
 * the module fixes the hierarchy LANGUAGE (solid / outline / quiet), not sizes.
 * Adopted only where a view needs an explicit hierarchy — not an app-wide theme.
 */

import type React from 'react'

/** Solid call-to-action — at most one per view. */
export const btnPrimary: React.CSSProperties = {
  background: '#256b45',
  color: '#e8ffee',
  border: '1px solid #2e8556',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
}

/** Outline button — normal-weight actions. */
export const btnSecondary: React.CSSProperties = {
  background: 'transparent',
  color: '#ccd',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  cursor: 'pointer',
}

/** Quiet text-like button — tertiary/utility actions. */
export const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid transparent',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  cursor: 'pointer',
}
