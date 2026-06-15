/**
 * Unit tests for the halt-ownership state machine (Spec §7.4.3 / Task 10).
 *
 * The whole point of the state machine is that the 50 ms pacing timer and the
 * alter batcher cannot race each other (or the user pause) into double-halt /
 * missed-resume states. These tests pin every transition with a stub engine that
 * just counts bg_halt / bg_resume calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HaltCoordinator } from '../haltCoordinator'

describe('HaltCoordinator', () => {
  let halt: ReturnType<typeof vi.fn>
  let resume: ReturnType<typeof vi.fn>
  let c: HaltCoordinator

  beforeEach(() => {
    halt = vi.fn()
    resume = vi.fn()
    c = new HaltCoordinator({ halt, resume })
  })

  it('starts with no owner, not halted', () => {
    expect(c.getOwner()).toBe('none')
    expect(c.isHalted()).toBe(false)
  })

  it('first halt issues bg_halt once and sets owner', () => {
    expect(c.requestHalt('pacing')).toBe(true)
    expect(c.getOwner()).toBe('pacing')
    expect(halt).toHaveBeenCalledTimes(1)
  })

  it('only the owner may resume', () => {
    c.requestHalt('pacing')
    // alter cannot resume a pacing halt
    expect(c.requestResume('alter')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
    expect(c.getOwner()).toBe('pacing')
    // pacing (the owner) can
    expect(c.requestResume('pacing')).toBe(true)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(c.getOwner()).toBe('none')
  })

  it('does not double-issue bg_halt when a second actor requests while halted', () => {
    c.requestHalt('pacing')
    c.requestHalt('alter') // lower priority than pacing? alter > pacing → seize
    // bg_halt still only once: engine already stopped.
    expect(halt).toHaveBeenCalledTimes(1)
  })

  it('user pause outranks an in-progress alter/pacing halt (seizes ownership, no extra bg_halt)', () => {
    c.requestHalt('alter')
    expect(c.getOwner()).toBe('alter')
    // user seizes ownership without re-halting
    expect(c.requestHalt('user')).toBe(true)
    expect(c.getOwner()).toBe('user')
    expect(halt).toHaveBeenCalledTimes(1)
  })

  it('alter during a user pause applies but does NOT resume (user stays paused)', () => {
    // user pauses
    c.requestHalt('user')
    expect(c.getOwner()).toBe('user')
    // an alter batch runs during the pause: it requests halt (already halted,
    // lower priority — ignored, stays user) and then tries to resume.
    expect(c.requestHalt('alter')).toBe(false) // cannot seize from user
    expect(c.getOwner()).toBe('user')
    expect(c.requestResume('alter')).toBe(false) // cannot resume user's pause
    expect(resume).not.toHaveBeenCalled()
    expect(c.isUserPaused()).toBe(true)
  })

  it('pacing during a user pause does not resume', () => {
    c.requestHalt('user')
    expect(c.requestHalt('pacing')).toBe(false)
    expect(c.requestResume('pacing')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
    expect(c.getOwner()).toBe('user')
  })

  it('full pacing cycle: halt then resume returns to none', () => {
    c.requestHalt('pacing')
    c.requestResume('pacing')
    expect(c.getOwner()).toBe('none')
    expect(halt).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('alter halt/resume cycle is self-contained', () => {
    expect(c.requestHalt('alter')).toBe(true)
    expect(c.requestResume('alter')).toBe(true)
    expect(c.getOwner()).toBe('none')
    expect(halt).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('user resume after user pause returns ownership to none', () => {
    c.requestHalt('user')
    expect(c.requestResume('user')).toBe(true)
    expect(c.getOwner()).toBe('none')
  })

  it('clear() drops ownership without issuing bg_resume (bench restart path)', () => {
    c.requestHalt('pacing')
    c.clear()
    expect(c.getOwner()).toBe('none')
    expect(resume).not.toHaveBeenCalled()
  })

  it('resume on a non-halted coordinator is a no-op', () => {
    expect(c.requestResume('user')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
  })
})
