/**
 * tabCues.test.ts — Gemini finding 5 (Net Voltages tab discoverability).
 * The unread dot shows after the first successful op, until the user first
 * opens the tab; it never shows while the tab is already active.
 */

import { describe, it, expect } from 'vitest'
import { showNetsTabCue } from '../tabCues'

describe('showNetsTabCue', () => {
  it('no op result yet → no cue', () => {
    expect(showNetsTabCue(false, false, 'log')).toBe(false)
  })
  it('first op landed, tab never seen, log tab active → cue', () => {
    expect(showNetsTabCue(true, false, 'log')).toBe(true)
  })
  it('tab already seen → no cue', () => {
    expect(showNetsTabCue(true, true, 'log')).toBe(false)
  })
  it('nets tab currently active → no cue', () => {
    expect(showNetsTabCue(true, false, 'nets')).toBe(false)
  })
})
