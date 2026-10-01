/**
 * e2e/util.ts — shared E2E helpers.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

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

/** Absolute path to the built (dev-layout) Electron entry; needs `npm run build`. */
export const APP_MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

/** Launch the built Electron app and wait for the first window to load. */
export async function launchBuiltApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [APP_MAIN],
    env: { ...process.env, CIRCSIM_E2E: '1' },
  })
  pipeAppOutput(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('load')
  // Let the React app mount and the store finish its SimHost handshake.
  await page.waitForTimeout(3000)
  return { app, page }
}

/**
 * Resolve the electron-builder --dir output for the host OS, or null when it
 * has not been built. The release installers ship these exact layouts, so the
 * packaged smoke exercises the asar-external ngspice and .cm paths on each OS:
 *   win32:  dist/win-unpacked/circsim.exe
 *   darwin: dist/mac[-arch]/circsim.app/Contents/MacOS/circsim
 *   linux:  dist/linux-unpacked/circsim
 */
export function resolvePackagedExe(
  platform: NodeJS.Platform = process.platform,
  distDir: string = join(__dirname, '..', 'dist'),
): string | null {
  const candidates: string[] = []
  if (platform === 'win32') {
    candidates.push(join(distDir, 'win-unpacked', 'circsim.exe'))
  } else if (platform === 'darwin') {
    let entries: string[] = []
    try {
      entries = readdirSync(distDir)
    } catch {
      entries = []
    }
    for (const name of entries.filter(n => n === 'mac' || n.startsWith('mac-')).sort()) {
      candidates.push(join(distDir, name, 'circsim.app', 'Contents', 'MacOS', 'circsim'))
    }
  } else {
    candidates.push(join(distDir, 'linux-unpacked', 'circsim'))
  }
  return candidates.find(c => existsSync(c)) ?? null
}
