/**
 * Unit tests for openFidelityDocs (issue #62).
 *
 * Electron's shell.openPath never rejects: it resolves with an error string on
 * failure and '' on success. The handler used to discard that string, so the
 * renderer could never learn that the fidelity link failed. These run in plain
 * Node with an injected shell.
 */

import { describe, expect, it, vi } from 'vitest'
import { openFidelityDocs, FIDELITY_DOCS_URL, type DocsShell } from '../openDocs'

function makeShell(over: Partial<DocsShell> = {}): DocsShell {
  return {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => undefined),
    ...over,
  }
}

describe('openFidelityDocs (#62)', () => {
  it('online: opens the published fidelity page, never touches the local file', async () => {
    const sh = makeShell()
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => true })
    expect(res).toEqual({ ok: true, target: 'web' })
    expect(sh.openExternal).toHaveBeenCalledWith(FIDELITY_DOCS_URL)
    expect(sh.openPath).not.toHaveBeenCalled()
  })

  it('offline: opens the bundled file and reports success on an empty string', async () => {
    const sh = makeShell()
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => false })
    expect(res).toEqual({ ok: true, target: 'local' })
    expect(sh.openPath).toHaveBeenCalledWith('C:/docs/f.md')
    expect(sh.openExternal).not.toHaveBeenCalled()
  })

  it('offline: surfaces the error string shell.openPath resolves with', async () => {
    const sh = makeShell({ openPath: vi.fn(async () => 'Failed to open path') })
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => false })
    expect(res).toEqual({ ok: false, error: 'Failed to open path' })
  })

  it('online but the browser hand-off throws: falls back to the local file', async () => {
    const sh = makeShell({
      openExternal: vi.fn(async () => {
        throw new Error('no handler')
      }),
    })
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => true })
    expect(res).toEqual({ ok: true, target: 'local' })
    expect(sh.openPath).toHaveBeenCalledTimes(1)
  })

  it('both routes fail: returns the local error, never throws', async () => {
    const sh = makeShell({
      openExternal: vi.fn(async () => {
        throw new Error('no handler')
      }),
      openPath: vi.fn(async () => 'Failed to open path'),
    })
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => true })
    expect(res).toEqual({ ok: false, error: 'Failed to open path' })
  })

  it('a throwing openPath is reported as an error result, not a rejection', async () => {
    const sh = makeShell({
      openPath: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    const res = await openFidelityDocs({ shell: sh, localPath: 'C:/docs/f.md', isOnline: () => false })
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})
