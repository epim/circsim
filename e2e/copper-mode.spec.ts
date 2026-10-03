import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { launchBuiltApp } from './util'

const toggle = (page: Page) => page.getByTestId('copper-aware-toggle')

/** App completion includes the critic solve, deck restoration, and React commit. */
async function timePowerOn(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const control = document.querySelector('[data-testid="copper-aware-toggle"]') as HTMLInputElement
    const button = document.querySelector('[data-testid="power-on-btn"]') as HTMLButtonElement
    let busy = false
    const start = performance.now()
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Power On did not finish')) }, 30_000)
    const observer = new MutationObserver(() => {
      if (control.disabled) busy = true
      else if (busy) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(performance.now() - start)
      }
    })
    observer.observe(control, { attributes: true, attributeFilter: ['disabled'] })
    button.click()
  }))
}

test.describe('copper-aware bench', () => {
  let app: ElectronApplication
  test.afterEach(async () => { await app?.close() })

  test('toggle reruns the op, replaces net tint with physical pads, and keeps critic gaps visible', async () => {
    const launched = await launchBuiltApp()
    app = launched.app
    const page = launched.page
    await page.getByTestId('open-sample-btn').click()
    await expect(toggle(page)).not.toBeChecked()
    await page.getByTestId('power-on-btn').click()
    await expect(page.getByTestId('op-annotation').first()).toBeVisible()
    await expect(toggle(page)).toBeEnabled()
    await expect(page.locator('[data-finding-id^="floating:copper-gap:"]').first()).toBeVisible()
    await expect(page.getByTestId('pad-op-annotation')).toHaveCount(0)
    await toggle(page).check()
    await expect(page.getByTestId('pad-op-annotation').first()).toBeVisible()
    await expect(page.getByTestId('voltage-legend')).toContainText('at pads')
    await expect(page.getByTestId('pad-routing-gaps')).toBeVisible()
    await expect(toggle(page)).toBeEnabled()
    await toggle(page).uncheck()
    await expect(page.getByTestId('pad-op-annotation')).toHaveCount(0)
    await expect(toggle(page)).toBeEnabled()
    await expect(page.locator('[data-finding-id^="floating:copper-gap:"]').first()).toBeVisible()
    await expect(page.getByTestId('voltage-legend')).not.toContainText('at pads')
  })

  test('measure Power On in the app on bundled 555 and sensor-node', async () => {
    test.skip(!process.env['CIRCSIM_MEASURE_OP'], 'Opt-in measurements, not a timing gate')
    test.setTimeout(600_000)
    const launched = await launchBuiltApp()
    app = launched.app
    const page = launched.page
    const measurements: object[] = []
    for (const name of ['blinker-555', 'sensor-node']) {
      const path = join(__dirname, '..', 'resources', 'sample', `${name}.kicad_pcb`)
      await app.evaluate(({ dialog }, boardPath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [boardPath] })
      }, path)
      await page.getByTestId('open-board-header-btn').click()
      await expect(page.getByTestId('part-row').first()).toBeVisible()
      await expect(toggle(page)).toBeEnabled()
      if (name === 'sensor-node') {
        // Feed the documented board input so the regulator produces 3.3 V.
        await page.getByRole('button', { name: 'Remove Power supply (PSU)', exact: true }).click()
        await page.getByTestId('supply-chip').filter({ hasText: /^\+5V$/ }).click()
      }
      for (const copper of [false, true]) {
        await toggle(page).setChecked(copper)
        await expect(toggle(page)).toBeEnabled()
        for (let i = 0; i < 3; i++) await timePowerOn(page)
        const samples: number[] = []
        for (let i = 0; i < 15; i++) samples.push(await timePowerOn(page))
        samples.sort((a, b) => a - b)
        measurements.push({ board: name, copper, medianMs: samples[7], samples,
          gaps: await page.locator('[data-finding-id^="floating:copper-gap:"]').count(),
          fallback: (await page.getByTestId('voltage-legend').textContent())?.includes('Settled transient snapshot') ?? false,
        })
      }
    }
    process.stdout.write(`APP_OP_MEASUREMENTS ${JSON.stringify(measurements)}\n`)
  })
})
