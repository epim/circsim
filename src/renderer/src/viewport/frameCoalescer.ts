/**
 * viewport/frameCoalescer.ts
 *
 * Run a callback at most once per animation frame on the newest value pushed
 * since the last run (#58). Pointer events can arrive at 120 Hz or more; hover
 * picking only needs the latest position once per frame.
 *
 * The frame scheduler is injectable so tests can drive frames by hand. By
 * default it is requestAnimationFrame / cancelAnimationFrame.
 */

export interface FrameScheduler {
  request(cb: () => void): number
  cancel(id: number): void
}

export interface FrameCoalescer<T> {
  /** Record the newest value and make sure a frame is scheduled. */
  push(value: T): void
  /** Drop a pending value and its scheduled frame. */
  cancel(): void
  /** Whether a value is waiting for the next frame. */
  readonly pending: boolean
}

const rafScheduler: FrameScheduler = {
  request: cb => requestAnimationFrame(() => cb()),
  cancel: id => cancelAnimationFrame(id),
}

export function createFrameCoalescer<T>(
  run: (value: T) => void,
  scheduler: FrameScheduler = rafScheduler,
): FrameCoalescer<T> {
  let latest: { value: T } | null = null
  let frameId: number | null = null

  function flush(): void {
    frameId = null
    const item = latest
    latest = null
    if (item) run(item.value)
  }

  return {
    push(value) {
      latest = { value }
      if (frameId === null) frameId = scheduler.request(flush)
    },
    cancel() {
      latest = null
      if (frameId !== null) {
        scheduler.cancel(frameId)
        frameId = null
      }
    },
    get pending() {
      return latest !== null
    },
  }
}
