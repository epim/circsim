/**
 * renderer/panels/LibImport.tsx — Task 25
 *
 * "Import .lib…" flow for binding a user's own vendor .lib/.sub file to
 * an unresolved part (Spec §8.5 Tier 4, §8.7).
 *
 * Flow:
 *   1. File picker (via injected `openFilePicker`) → returns file path + text.
 *   2. Scan the file for .subckt definitions (userLibrary.extractSubcktNames).
 *   3. User picks which subckt to bind to this part.
 *   4. Pin-map editor: user maps each pad number → model terminal name.
 *   5. Confirm → `onSave(mpn, filePath, subcktName, pinMap)` → caller persists
 *      to userLibrary with provenance 'user-import'.
 *
 * The component is pure React; all file I/O is injected so it's testable.
 * Validated by build + Phase 6 E2E.
 *
 * Spec §8.5 Tier 4, §8.7, Task 25.
 */

import React, { useState, useCallback } from 'react'
import type { Part } from '../../../core/netlist/extract'
import type { PinMap } from '../../../core/models/types'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PickedFile {
  path: string
  text: string
}

export interface LibImportProps {
  part: Part
  /**
   * Open a native file picker for .lib/.sub files.
   * Returns the picked file's path + contents, or null if cancelled.
   * Injected so the component is testable (mock returns a PickedFile directly).
   */
  openFilePicker(): Promise<PickedFile | null>
  /**
   * Called when the user confirms the binding.
   * @param mpn        The part identifier (from properties or value).
   * @param filePath   The .lib/.sub file path.
   * @param subcktName The .subckt name the user selected.
   * @param pinMap     The user-confirmed pad → terminal mapping.
   */
  onSave(mpn: string, filePath: string, subcktName: string, pinMap: PinMap): void
  /** Close this panel. */
  onClose(): void
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LibImport({
  part,
  openFilePicker,
  onSave,
  onClose,
}: LibImportProps): React.ReactElement {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [subcktNames, setSubcktNames] = useState<string[]>([])
  const [selectedSubckt, setSelectedSubckt] = useState<string>('')
  const [pinMap, setPinMap] = useState<PinMap>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mpnFromProps =
    part.properties['MPN'] ??
    part.properties['Part Number'] ??
    part.properties['mpn']
  const mpn = mpnFromProps ?? (part.value || part.ref)

  const padNumbers = [...part.padNet.keys()].sort(sortPads)

  const handlePickFile = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSubcktNames([])
    setSelectedSubckt('')
    setPinMap({})
    try {
      const picked = await openFilePicker()
      if (!picked) {
        setLoading(false)
        return
      }
      setFilePath(picked.path)
      // Parse the file for .subckt names
      const names = extractSubcktNamesFromText(picked.text)
      if (names.length === 0) {
        setError('No .subckt definitions found in this file.')
        setLoading(false)
        return
      }
      setSubcktNames(names)
      // Auto-select if there's exactly one
      if (names.length === 1) {
        setSelectedSubckt(names[0])
        // Pre-fill a suggested pin map from the position in the subckt header.
        const suggested = suggestPinMapFromText(picked.text, names[0], padNumbers)
        setPinMap(suggested)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [openFilePicker, padNumbers])

  const handleSubcktSelect = useCallback(
    (name: string, fileText?: string) => {
      setSelectedSubckt(name)
      if (fileText) {
        const suggested = suggestPinMapFromText(fileText, name, padNumbers)
        setPinMap(suggested)
      }
    },
    [padNumbers],
  )

  const handlePinMapChange = useCallback((pad: string, terminal: string) => {
    setPinMap(prev => ({ ...prev, [pad]: terminal }))
  }, [])

  const handleSave = useCallback(() => {
    if (!filePath || !selectedSubckt) return
    onSave(mpn, filePath, selectedSubckt, pinMap)
  }, [mpn, filePath, selectedSubckt, pinMap, onSave])

  const canSave = !!filePath && !!selectedSubckt

  return (
    <div style={panelStyle} data-testid="lib-import-panel">
      <div style={headerStyle}>
        <span style={titleStyle}>Import .lib — {mpn}</span>
        <button style={closeBtnStyle} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* Step 1: Pick file */}
      <section style={sectionStyle}>
        <div style={stepLabelStyle}>Step 1: Pick a .lib or .sub file</div>
        {filePath && (
          <div style={filePathStyle} title={filePath}>
            {shortPath(filePath)}
          </div>
        )}
        <button
          style={{ ...actionBtnStyle, background: loading ? '#555' : '#2980b9' }}
          onClick={handlePickFile}
          disabled={loading}
          aria-label="Open file picker"
          data-testid="pick-file-button"
        >
          {loading ? 'Loading…' : filePath ? 'Change file…' : 'Browse…'}
        </button>
        {error && (
          <div style={errorStyle} data-testid="lib-import-error">
            {error}
          </div>
        )}
      </section>

      {/* Step 2: Pick subckt */}
      {subcktNames.length > 0 && (
        <section style={sectionStyle}>
          <div style={stepLabelStyle}>Step 2: Choose the subckt to bind</div>
          <select
            style={selectStyle}
            value={selectedSubckt}
            onChange={e => handleSubcktSelect(e.target.value)}
            aria-label="Select subckt"
            data-testid="subckt-select"
          >
            {subcktNames.length > 1 && <option value="">— pick one —</option>}
            {subcktNames.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </section>
      )}

      {/* Step 3: Pin map editor */}
      {selectedSubckt && padNumbers.length > 0 && (
        <section style={sectionStyle}>
          <div style={stepLabelStyle}>Step 3: Verify the pin map</div>
          <div style={{ color: '#d9a', fontSize: 11, marginBottom: 8 }}>
            Map each board pad to the correct terminal in the .subckt. Verify
            against the datasheet — wrong pin maps produce wrong results.
          </div>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Pad</th>
                <th style={thStyle}>Model terminal</th>
              </tr>
            </thead>
            <tbody>
              {padNumbers.map(pad => (
                <tr key={pad}>
                  <td style={tdStyle}>{pad}</td>
                  <td style={tdStyle}>
                    <input
                      type="text"
                      style={pinInputStyle}
                      value={pinMap[pad] ?? ''}
                      onChange={e => handlePinMapChange(pad, e.target.value)}
                      placeholder="terminal name"
                      aria-label={`terminal for pad ${pad}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Step 4: Confirm */}
      {canSave && (
        <section style={sectionStyle}>
          <button
            style={{ ...actionBtnStyle, background: '#8e44ad' }}
            onClick={handleSave}
            aria-label="Bind model to part"
            data-testid="lib-import-save"
          >
            Bind to {part.ref}
          </button>
        </section>
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract .subckt names from raw file text (avoids filesystem access in the
 * renderer — the file text is already provided by the picker).
 */
function extractSubcktNamesFromText(text: string): string[] {
  // extractSubcktNames in userLibrary takes a file path; here we have the text.
  // Re-implement the simple regex inline to avoid Node's fs in the renderer.
  const names: string[] = []
  const SUBCKT_REGEX = /^\s*\.subckt\s+(\S+)/gim
  for (const match of text.matchAll(SUBCKT_REGEX)) {
    names.push(match[1])
  }
  return names
}

/**
 * Suggest a PinMap by parsing the .subckt header node order and matching
 * it positionally to the board pad numbers.
 *
 * Format: `.subckt <name> <node1> <node2> ...`
 *
 * If the node count matches the pad count, maps pad[i] → node[i].
 * Otherwise, returns an empty map (user must fill manually).
 */
function suggestPinMapFromText(
  text: string,
  subcktName: string,
  padNumbers: string[],
): PinMap {
  const escapedName = subcktName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headerRegex = new RegExp(
    `^\\s*\\.subckt\\s+${escapedName}\\s+(.+)`,
    'im',
  )
  const m = text.match(headerRegex)
  if (!m) return {}

  const nodes = m[1].trim().split(/\s+/).filter(Boolean)
  if (nodes.length !== padNumbers.length) return {}

  const map: PinMap = {}
  padNumbers.forEach((pad, i) => {
    map[pad] = nodes[i]
  })
  return map
}

/** Shorten a long path for display. */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return p
  return '…/' + parts.slice(-2).join('/')
}

/** Sort pads: numeric pads numerically, otherwise lexical. */
function sortPads(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b)
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: '#12101a',
  color: '#eee',
  border: '1px solid #3a2a4a',
  borderRadius: 8,
  maxHeight: '90vh',
  overflowY: 'auto',
  minWidth: 360,
  maxWidth: 560,
  fontSize: 13,
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderBottom: '1px solid #2a1a3a',
  background: '#1a1028',
}

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
}

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 16,
  cursor: 'pointer',
  lineHeight: 1,
  padding: '0 4px',
}

const sectionStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid #1a1020',
}

const stepLabelStyle: React.CSSProperties = {
  color: '#aaa',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 8,
}

const filePathStyle: React.CSSProperties = {
  color: '#7ec',
  fontSize: 11,
  fontFamily: 'monospace',
  marginBottom: 6,
  wordBreak: 'break-all',
}

const actionBtnStyle: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  padding: '6px 14px',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 600,
}

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  color: '#e74c3c',
  fontSize: 12,
  background: '#2a1010',
  padding: '6px 10px',
  borderRadius: 4,
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  background: '#1a1520',
  border: '1px solid #3a2a4a',
  borderRadius: 4,
  color: '#eee',
  padding: '4px 8px',
  fontSize: 12,
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  color: '#888',
  fontWeight: 500,
  padding: '3px 6px',
  borderBottom: '1px solid #2a2040',
}

const tdStyle: React.CSSProperties = {
  padding: '3px 6px',
  borderBottom: '1px solid #1a1530',
}

const pinInputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0c0a14',
  border: '1px solid #2a2040',
  borderRadius: 3,
  color: '#ddd',
  fontSize: 12,
  padding: '2px 6px',
  boxSizing: 'border-box',
}

// Re-export extractSubcktNames for external consumers (tests, store integration).
export { extractSubcktNamesFromText }
