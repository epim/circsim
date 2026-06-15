/**
 * src/simhost/haltCoordinator.ts
 *
 * Halt-ownership state machine (Spec §7.4.3). Three actors issue halts on the
 * ngspice background thread: the user (pause), the alter batcher, and the pacing
 * loop. Without arbitration the 50 ms pacing timer races the alter batcher into
 * double-halt / missed-resume states.
 *
 * Rules (normative, Spec §7.4.3):
 *  - A single `haltOwner: 'none'|'user'|'alter'|'pacing'`.
 *  - The FIRST actor to halt becomes the owner; further halt requests while
 *    halted do not re-issue `bg_halt` (it is already halted) but `user` may seize
 *    ownership from `alter`/`pacing` (user pause outranks).
 *  - Only the current owner may resume. A resume request from a non-owner is a
 *    no-op. In particular an alter batch or pacing tick that runs DURING a user
 *    pause applies its work but must NOT resume — the user stays paused.
 *  - When the user resumes, ownership returns to 'none' (a paused-then-resumed
 *    session is back to free-running; pacing will re-acquire as needed).
 *
 * The coordinator is engine-agnostic: it calls injected `halt()` / `resume()`
 * thunks (which issue `bg_halt` / `bg_resume`) exactly once per real transition,
 * so it is fully unit-testable with a stub engine.
 */

export type HaltOwner = 'none' | 'user' | 'alter' | 'pacing'
export type HaltActor = Exclude<HaltOwner, 'none'>

/** Priority for seizing ownership while already halted. user > alter > pacing. */
const PRIORITY: Record<HaltActor, number> = { user: 3, alter: 2, pacing: 1 }

export interface HaltCoordinatorHooks {
  /** Issue `bg_halt` (called at most once per none→halted transition). */
  halt: () => void
  /** Issue `bg_resume` (called at most once per halted→none transition). */
  resume: () => void
}

export class HaltCoordinator {
  private owner: HaltOwner = 'none'
  private readonly hooks: HaltCoordinatorHooks

  constructor(hooks: HaltCoordinatorHooks) {
    this.hooks = hooks
  }

  getOwner(): HaltOwner {
    return this.owner
  }

  isHalted(): boolean {
    return this.owner !== 'none'
  }

  /** True if the simulation is halted by the user specifically. */
  isUserPaused(): boolean {
    return this.owner === 'user'
  }

  /**
   * Request a halt on behalf of `actor`. Issues `bg_halt` only on the first
   * none→halted transition. While already halted, a higher-priority actor (user)
   * seizes ownership without re-issuing `bg_halt`; a lower/equal actor is ignored.
   * Returns true if THIS call now holds (or took) ownership.
   */
  requestHalt(actor: HaltActor): boolean {
    if (this.owner === 'none') {
      this.owner = actor
      this.hooks.halt()
      return true
    }
    // Already halted. Allow a strictly-higher-priority actor to seize ownership
    // (user pause outranks an in-progress alter/pacing halt). No new bg_halt:
    // the engine is already stopped.
    if (PRIORITY[actor] > PRIORITY[this.owner as HaltActor]) {
      this.owner = actor
      return true
    }
    return this.owner === actor
  }

  /**
   * Request a resume on behalf of `actor`. Only the current owner may resume.
   * Issues `bg_resume` and returns ownership to 'none'. A non-owner resume is a
   * no-op (returns false) — this is what prevents an alter/pacing tick from
   * resuming a user pause.
   */
  requestResume(actor: HaltActor): boolean {
    if (this.owner !== actor) return false
    this.owner = 'none'
    this.hooks.resume()
    return true
  }

  /**
   * Force ownership to 'none' WITHOUT issuing bg_resume — used after a hard reset
   * (destroy all + reload on a bench restart) where the bg thread is already gone.
   */
  clear(): void {
    this.owner = 'none'
  }
}
