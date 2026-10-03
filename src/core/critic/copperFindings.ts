import type { BoardModel } from '../kicad/types'
import type { CopperOp } from '../copper'
import type { CriticReport, Finding } from './types'
import { padWorldPos } from './geom'

/** Surface geometry gaps even when the physical operating point failed. */
export function withCopperFindings(report: CriticReport, board: BoardModel, copper?: CopperOp): CriticReport {
  const gaps: Finding[] = (copper?.unreachedPads ?? []).map(p => {
    const fp = board.footprints.find(fp => fp.ref === p.ref)
    const pad = fp?.pads.find(pad => pad.number === p.padNumber)
    const lead = p.isSource && copper?.network.rails.get(p.netId)?.entry.kind === 'lead'
    return {
      id: `floating:copper-gap:${p.ref}:${p.padNumber}`, check: 'floating', severity: 'warn',
      title: `${p.ref} pad ${p.padNumber}: ${p.hasCopper ? 'no copper path to the entry' : 'no copper contact'}`,
      detail: `The physical copper network does not ${p.hasCopper ? 'connect this pad to its entry' : 'have a track, via or pour contact at this pad'}.` +
        (lead ? ' A lead feeds this bare pad directly, but it still has no routed copper contact.' : ''),
      assumption: 'Copper resistance model; pour outlines use the configured mesh. Check the KiCad fill and entry.',
      refs: [p.ref], netId: p.netId,
      ...(fp && pad ? { location: padWorldPos(fp, pad) } : {}),
      suggestion: 'Check the routing and the supply or ground clip position in KiCad and on the bench.',
    }
  })
  if (!gaps.length) return report
  return { ...report, findings: [...report.findings, ...gaps], summary: { ...report.summary, warn: report.summary.warn + gaps.length } }
}
