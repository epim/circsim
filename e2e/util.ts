/**
 * e2e/util.ts — shared E2E helpers.
 */

import type { ElectronApplication } from '@playwright/test'

/**
 * Forward the Electron main process's stdout/stderr into the test output.
 *
 * The SimHost supervisor already pipes the utilityProcess child's output to
 * the main process console with a `[simhost] ` prefix (simhostSupervisor.ts),
 * so this surfaces BOTH main-process and sim-engine diagnostics — including
 * the SimHost watchdog's exit message — in the Playwright report. Without it
 * a SimHost crash on CI is invisible: the renderer only shows the generic
 * "Simulator restarted" banner.
 *
 * On by default on CI; set CIRCSIM_E2E_LOGS=1 to enable locally.
 */
export function pipeAppOutput(app: ElectronApplication): void {
  if (!process.env['CI'] && !process.env['CIRCSIM_E2E_LOGS']) return
  const proc = app.process()
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[app] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[app:err] ${d}`))
}
