/**
 * renderer/panels/ExportReport.tsx - the "Export report" header action
 * (issue #27): one button, two formats. Markdown is for pasting into a forum
 * thread or an LLM chat; PDF is for a reviewer or a record of a pre-fab check.
 *
 * data-testid hooks: export-report-btn, export-report-md, export-report-pdf,
 * export-report-status
 */

import React, { useState } from 'react'
import { useApp, useAppStoreApi } from '../store/storeContext'
import { exportReport, type ReportFormat } from '../store/exportReport'

export default function ExportReport(): React.ReactElement | null {
  const store = useAppStoreApi()
  const board = useApp(s => s.board)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  if (!board) return null

  const run = async (format: ReportFormat): Promise<void> => {
    setOpen(false)
    setBusy(true)
    setStatus(null)
    try {
      const res = await exportReport(store, format, window.circsim, { appVersion: __APP_VERSION__ })
      if (res && !res.cancelled && res.filePath) setStatus(`Saved ${res.filePath}`)
    } catch (err) {
      setStatus(`Could not export the report: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        style={btn}
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        data-testid="export-report-btn"
        title="Save a report of this board's setup, models, operating point and Board Critic findings"
      >
        {busy ? 'Exporting...' : 'Export report'}
      </button>
      {open && (
        <span style={menu}>
          <button style={menuItem} onClick={() => void run('md')} data-testid="export-report-md">
            Markdown (.md)
          </button>
          <button style={menuItem} onClick={() => void run('pdf')} data-testid="export-report-pdf">
            PDF (.pdf)
          </button>
        </span>
      )}
      {status && (
        <span style={{ fontSize: 11, color: '#9ab', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} data-testid="export-report-status" title={status}>
          {status}
        </span>
      )}
    </span>
  )
}

const btn: React.CSSProperties = {
  background: '#2a2a45',
  color: '#eee',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 13,
}
const menu: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  background: '#1e1e32',
  border: '1px solid #3a3a55',
  borderRadius: 4,
  marginTop: 2,
  minWidth: 140,
}
const menuItem: React.CSSProperties = {
  background: 'transparent',
  color: '#eee',
  border: 'none',
  textAlign: 'left',
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 12,
}
