// Type declarations for scripts/gen-sample-board.mjs.
import type { SyntheticBoardSpec } from './gen-synthetic-board.mjs'

export const SAMPLE_NAME: string
export const SAMPLE_FILE: string
export function sampleBoardSpec(): SyntheticBoardSpec
export function generateSampleBoard(): string
