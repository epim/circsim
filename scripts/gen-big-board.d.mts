// Type declarations for scripts/gen-big-board.mjs.
export interface BigBoardSize {
  /** Two-pad footprints on a grid. */
  parts: number
  /** Copper track segments, spread over F.Cu and B.Cu. */
  tracks: number
  /** Distinct nets. */
  nets: number
}

export const ISSUE_BIG: BigBoardSize
export const TEST_MID: BigBoardSize
export function bigBoardText(size: BigBoardSize): string
