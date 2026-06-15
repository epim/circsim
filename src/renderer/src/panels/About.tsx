/**
 * renderer/panels/About.tsx — Task 27 (Spec §14)
 *
 * The About dialog surfaces circsim's licensing posture, which is a product
 * requirement (Spec §5/§14: honest, visible provenance — this audience cannot
 * audit a silently-non-compliant bundle):
 *
 *   - circsim itself: MIT.
 *   - ngspice: the verbatim COPYING text shipped beside the bundled binaries
 *     (read at runtime from <resources>/ngspice/COPYING via getLicenseTexts so
 *     it is the ACTUAL file in the installer, not a hand-copied snippet).
 *   - Bundled SPICE model library: an in-house, MIT provenance statement —
 *     every file in resources/models/ carries a "Provenance:" header and no
 *     vendor model text is included (enforced by the license-hygiene CI gate).
 *   - A link to the full docs/licensing.md table (opened in the system viewer).
 *
 * UI-only. The license texts come from the preload bridge; a render fallback
 * keeps the dialog useful even if the files can't be read (e.g. headless CI).
 */

import React, { useEffect, useState } from 'react'

export interface AboutProps {
  open: boolean
  onClose: () => void
}

/**
 * Shape of the licensing texts returned by the preload bridge. Derived from the
 * `window.circsim.getLicenseTexts` ambient signature so there is a single source
 * of truth (circsim.d.ts) without exporting a global type.
 */
type LicenseTexts = Awaited<ReturnType<Window['circsim']['getLicenseTexts']>>

const FALLBACK_PROVENANCE =
  'The bundled SPICE model library was written in-house for circsim from public ' +
  'datasheet parameters and is MIT-licensed. Every file in resources/models/ carries ' +
  'a "Provenance:" header; no vendor (TI/ADI/onsemi) or Micro-Cap/Intusoft model text ' +
  'is included. The GPL-encumbered ngspice "table.cm" code model is excluded from every ' +
  'platform bundle.'

export default function About({ open, onClose }: AboutProps): React.ReactElement | null {
  const [texts, setTexts] = useState<LicenseTexts | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadError(false)
    if (typeof window !== 'undefined' && window.circsim?.getLicenseTexts) {
      window.circsim
        .getLicenseTexts()
        .then((t) => {
          if (!cancelled) setTexts(t)
        })
        .catch(() => {
          if (!cancelled) setLoadError(true)
        })
    } else {
      setLoadError(true)
    }
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const version = texts?.appVersion ?? '0.1.0'
  const modelProvenance = texts?.modelProvenance || FALLBACK_PROVENANCE
  const ngspiceCopying = texts?.ngspiceCopying || ''

  return (
    <div style={backdropStyle} role="dialog" aria-modal="true" aria-label="About circsim" data-testid="about-dialog">
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <strong style={{ fontSize: 16 }}>About circsim</strong>
          <button style={closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          <p style={leadStyle}>
            <strong>circsim</strong> v{version} — a cross-platform PCB simulator. Open a routed
            KiCad board, see it in 3D, attach virtual bench instruments, and run an interactive
            ngspice simulation.
          </p>

          <Section title="Application license">
            <p>
              circsim is licensed under the <strong>MIT License</strong> ({texts?.appLicense ?? 'MIT'}).
              Copyright © 2026 circsim contributors.
            </p>
          </Section>

          <Section title="Bundled SPICE model library">
            <p>{modelProvenance}</p>
          </Section>

          <Section title="ngspice (simulation engine)">
            <p>
              circsim bundles the ngspice shared library and its XSPICE code models, distributed
              under the ngspice license below (a BSD-style / “New BSD” license, with parts under the
              original SPICE / Berkeley terms). The GPL-encumbered <code>table.cm</code> code model
              is not included.
            </p>
            {ngspiceCopying ? (
              <pre style={copyingStyle}>{ngspiceCopying}</pre>
            ) : (
              <p style={mutedStyle}>
                The full ngspice COPYING text ships in the installer at{' '}
                <code>resources/ngspice/COPYING</code>.
                {loadError ? ' (Not available in this view.)' : ''}
              </p>
            )}
          </Section>

          <Section title="Other components">
            <ul style={ulStyle}>
              <li>Electron, React, Three.js, zustand, troika-three-text, koffi — MIT.</li>
              <li>
                KiCad <code>.wrl</code> 3D models are <strong>never bundled</strong>; they are
                loaded only from the user&apos;s own KiCad install at runtime.
              </li>
            </ul>
          </Section>

          <p style={{ marginTop: 14 }}>
            <span
              style={linkStyle}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (typeof window !== 'undefined' && window.circsim?.openDocs) {
                  void window.circsim.openDocs()
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  if (typeof window !== 'undefined' && window.circsim?.openDocs) {
                    void window.circsim.openDocs()
                  }
                }
              }}
            >
              What can circsim tell you? (fidelity &amp; limits)
            </span>
          </p>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section style={{ marginTop: 14 }}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#cdd' }}>{children}</div>
    </section>
  )
}

// ── styles ───────────────────────────────────────────────────────────────────
const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}
const dialogStyle: React.CSSProperties = {
  width: 'min(680px, 92vw)',
  maxHeight: '86vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#15151f',
  color: '#eee',
  border: '1px solid #2a2a3a',
  borderRadius: 8,
  boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
}
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a3a',
}
const closeBtn: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  border: 'none',
  color: '#aaa',
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
}
const bodyStyle: React.CSSProperties = {
  padding: '8px 18px 18px',
  overflowY: 'auto',
}
const leadStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#bcd',
  lineHeight: 1.5,
}
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#8ab',
  marginBottom: 4,
}
const copyingStyle: React.CSSProperties = {
  marginTop: 6,
  background: '#0d0d14',
  color: '#aab',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  padding: 10,
  fontSize: 11,
  fontFamily: 'monospace',
  whiteSpace: 'pre-wrap',
  maxHeight: 220,
  overflowY: 'auto',
}
const mutedStyle: React.CSSProperties = { color: '#889', fontStyle: 'italic' }
const ulStyle: React.CSSProperties = { margin: '4px 0 0', paddingLeft: 18 }
const linkStyle: React.CSSProperties = {
  color: '#ffd27a',
  textDecoration: 'underline',
  cursor: 'pointer',
}
