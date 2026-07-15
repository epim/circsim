/**
 * ui/tabCues.ts — Gemini finding 5: Net Voltages tab discoverability.
 *
 * New users focused on the 3D annotations may never notice the tabular
 * voltage readout in the bottom dock. After the FIRST successful operating
 * point of the session, the "Net voltages" tab shows a small unread dot
 * until the user first opens it. Per-session, in-memory (App-local state).
 */

export function showNetsTabCue(
  hasOpVoltages: boolean,
  netsTabSeen: boolean,
  bottomTab: 'log' | 'nets',
): boolean {
  return hasOpVoltages && !netsTabSeen && bottomTab !== 'nets'
}
