/**
 * docsLink.test.ts: issue #62, the fidelity link reports failures.
 */

import { describe, it, expect, vi } from 'vitest'
import { openDocsAndReport, docsFailureMessage, DOCS_FALLBACK_URL } from '../docsLink'

describe('openDocsAndReport (#62)', () => {
  it('clears the message on success', async () => {
    const onMessage = vi.fn()
    await openDocsAndReport({ openDocs: async () => ({ ok: true, target: 'web' }) }, onMessage)
    expect(onMessage).toHaveBeenLastCalledWith(null)
  })

  it('reports the error string main returned, with the online fallback address', async () => {
    const onMessage = vi.fn()
    await openDocsAndReport(
      { openDocs: async () => ({ ok: false, error: 'Failed to open path' }) },
      onMessage,
    )
    const msg = onMessage.mock.calls.at(-1)?.[0] as string
    expect(msg).toContain('Failed to open path')
    expect(msg).toContain(DOCS_FALLBACK_URL)
  })

  it('reports a rejected bridge call instead of swallowing it', async () => {
    const onMessage = vi.fn()
    await openDocsAndReport(
      {
        openDocs: async () => {
          throw new Error('ipc closed')
        },
      },
      onMessage,
    )
    expect(onMessage.mock.calls.at(-1)?.[0]).toContain('ipc closed')
  })

  it('does nothing when the bridge is missing (browser / test environment)', async () => {
    const onMessage = vi.fn()
    await openDocsAndReport(undefined, onMessage)
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('docsFailureMessage names the fidelity page address', () => {
    expect(docsFailureMessage('x')).toContain('epim.github.io/circsim/concepts/fidelity')
  })
})
