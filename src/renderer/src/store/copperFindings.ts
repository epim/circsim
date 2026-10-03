import type { BoardModel } from '../../../core/kicad/types'
import type { CopperOp } from '../../../core/copper'
import type { CriticReport, Finding } from '../../../core/critic/types'
import { padWorldPos } from '../../../core/critic/geom'

/** Surface geometry gaps even when the physical operating point failed. */
export function withCopperFindings(report: CriticReport, board: BoardModel, copper?: CopperOp): CriticReport {
  const gaps: Finding[] = (copper?.unreachedPads ?? []).map(p => {
    const fp = board.footprints.find(fp => fp.ref === p.ref)
    const pad = fp?.pads.find(pad => pad.number === p.padNumber)
    return {
      id: `floating:copper-gap:${p.ref}:${p.padNumber}`, check: 'floating', severity: 'warn',
      title: `${p.ref} pad ${p.padNumber}: ${p.hasCopper ? 'no copper path to the entry' : 'no copper contact'}`,
      detail: `The physical power or ground network does not ${p.hasCopper ? 'connect this pad to its supply or return entry' : 'have a track, via or pour contact at this pad'}.` +
        (p.isSource ? ' A lead feeds this bare pad directly, but it still has no routed copper contact.' : ''),
      assumption: 'Power and ground copper model; pour outlines use the configured mesh. Check the KiCad fill and source entry.',
      refs: [p.ref], netId: p.netId,
      ...(fp && pad ? { location: padWorldPos(fp, pad) } : {}),
      suggestion: 'Check the routing and the supply or ground clip position in KiCad and on the bench.',
    }
  })
  if (!gaps.length) return report
  return { ...report, findings: [...report.findings, ...gaps], summary: { ...report.summary, warn: report.summary.warn + gaps.length } }
}
