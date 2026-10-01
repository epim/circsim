/**
 * renderer/diagnostics/saveDiagnostics.ts
 *
 * Gathers the store's view of the board into a diagnostics bundle (issue #26)
 * and hands it to main for the save dialog and zip. The layout of the bundle
 * lives in core/report/diagnostics.ts; this file only reads state.
 */

import type { AppState, AppStore } from '../store/appStore'
import {
  buildDiagnosticsFiles,
  bundleFileName,
  kicadFileVersion,
  sha256Hex,
  type DiagnosticsFile,
  type DiagnosticsInput,
} from '../../../core/report/diagnostics'

/** Snapshot the store as bundle inputs. */
export async function gatherDiagnosticsInput(
  state: AppState,
  appVersion: string,
  now: Date,
): Promise<DiagnosticsInput> {
  const boardText = state.project.boardText
  const solve = state.lastSolve
  const crash = state.crashNotice
  return {
    generatedAt: now.toISOString(),
    board: {
      fileName: state.project.boardFileName,
      schematicFileName: state.project.schematicFileName,
      // The store's hash is set only while it matches this boardText, so it is
      // the same value; hash here when it has not landed yet, never report null.
      sha256: boardText === null ? null : (state.project.boardSha256 ?? await sha256Hex(boardText)),
      kicadFileVersion: kicadFileVersion(boardText),
    },
    versions: { app: appVersion, ngspice: state.ngspiceVersion },
    crash: crash
      ? {
          willRespawn: crash.willRespawn,
          exitCode: crash.exitCode ?? null,
          reason: crash.reason ?? 'unknown',
          at: crash.at,
        }
      : null,
    decks: {
      pass1: solve?.pass1Deck ?? null,
      pass2: solve?.pass2Deck ?? null,
      pass2Status: solve?.pass2 ?? null,
      run: state.lastRunDeck,
    },
    solve: solve ? { status: solve.status, at: solve.at } : null,
    op: solve && solve.status === 'solved'
      ? { values: solve.opValues, ...(solve.opMethod ? { method: solve.opMethod } : {}) }
      : null,
    resolutions: state.resolutions,
    instruments: state.instruments,
    log: state.logLines,
  }
}

export interface SaveDiagnosticsResult {
  saved: boolean
  path?: string
  error?: string
}

/** Collect the files the renderer contributes to a bundle. */
export async function collectDiagnosticsFiles(
  store: AppStore,
  appVersion: string,
  now: Date = new Date(),
): Promise<{ suggestedName: string; files: DiagnosticsFile[] }> {
  const state = store.getState()
  const input = await gatherDiagnosticsInput(state, appVersion, now)
  return {
    suggestedName: bundleFileName(state.project.boardFileName, now),
    files: buildDiagnosticsFiles(input),
  }
}

/** Save the bundle via main's save dialog. Never throws. */
export async function saveDiagnostics(
  store: AppStore,
  api: Pick<Window['circsim'], 'saveDiagnosticsBundle'> = window.circsim,
  appVersion: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
): Promise<SaveDiagnosticsResult> {
  try {
    const req = await collectDiagnosticsFiles(store, appVersion)
    return await api.saveDiagnosticsBundle(req)
  } catch (err) {
    return { saved: false, error: err instanceof Error ? err.message : String(err) }
  }
}
