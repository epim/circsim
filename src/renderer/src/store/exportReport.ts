/**
 * renderer/store/exportReport.ts - build and save a report from the live store
 * (issue #27). The window.circsim bridge is injected so this is unit-testable.
 */

import { buildReport, reportToHtml, reportToMarkdown } from '../../../core/report/report'
import { baseName } from '../../../core/persist/paths'
import type { AppStore } from './appStore'
import { buildReportInput } from './reportInput'

export type ReportFormat = 'md' | 'pdf'

export interface ReportExportApi {
  exportReport(req: {
    format: ReportFormat
    content: string
    suggestedName: string
  }): Promise<{ cancelled: boolean; filePath?: string }>
}

/** Default file name (no extension): the board's name plus "-report". */
export function suggestedReportName(boardFileName: string | null): string {
  const base = boardFileName ? baseName(boardFileName).replace(/\.kicad_pcb$/i, '') : ''
  return `${base || 'circsim'}-report`
}

/**
 * Render the report for the open board in the requested format and hand it to
 * the main process, which shows the save dialog. Resolves with the dialog
 * outcome; `null` when no board is open.
 */
export async function exportReport(
  store: AppStore,
  format: ReportFormat,
  api: ReportExportApi,
  meta: { appVersion: string; now?: () => Date },
): Promise<{ cancelled: boolean; filePath?: string } | null> {
  const s = store.getState()
  if (!s.board || !s.circuit) return null
  const input = buildReportInput(s, {
    appVersion: meta.appVersion,
    generatedAt: (meta.now ?? (() => new Date()))().toISOString(),
  })
  const doc = buildReport(input)
  return api.exportReport({
    format,
    content: format === 'md' ? reportToMarkdown(doc) : reportToHtml(doc),
    suggestedName: suggestedReportName(s.project.boardFileName),
  })
}
