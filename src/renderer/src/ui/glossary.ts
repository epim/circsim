/**
 * ui/glossary.ts - the one source of truth for plain-language labels (issue #73).
 *
 * Each entry pairs a plain label with the technical term it stands for, a short
 * definition, and the docs page that explains it. The `<Term>` component, the
 * `termTitle()` helper (for tooltips on buttons), and the website glossary page
 * (website/docs/guides/glossary.md) all read from here; glossary.test.ts keeps
 * the website page and the docs slugs in step with this file.
 *
 * Docs slugs are paths under the public docs site, with an optional #anchor:
 * `guides/energize` is https://epim.github.io/circsim/guides/energize.
 */

export type TermId =
  | 'operatingPoint'
  | 'net'
  | 'ground'
  | 'simFields'
  | 'rawLog'
  | 'gmin'
  | 'sourceStepping'
  | 'floatingNode'
  | 'stub'
  | 'stubOpen'
  | 'stubShort'
  | 'unresolved'
  | 'pinMap'
  | 'psu'
  | 'seriesR'
  | 'rheostat'
  | 'divider'
  | 'totalR'
  | 'vHigh'
  | 'vdd'
  | 'transient'

export interface GlossaryEntry {
  id: TermId
  /** What the interface says. */
  plain: string
  /** The jargon it stands for, kept visible as the secondary label. */
  technical: string
  /** One or two sentences, no further jargon. */
  definition: string
  /** Docs page (and optional #anchor) under the public docs site. */
  docs: string
}

export const GLOSSARY: Record<TermId, GlossaryEntry> = {
  operatingPoint: {
    id: 'operatingPoint',
    plain: 'steady-state voltages',
    technical: 'DC operating point',
    definition:
      'The voltage on every net and the current through every part once everything has settled and nothing is changing. It is the same as measuring a powered board with a multimeter.',
    docs: 'guides/energize',
  },
  net: {
    id: 'net',
    plain: 'connection',
    technical: 'net',
    definition:
      'Every pad and trace that is wired together. All the points on one net sit at the same voltage.',
    docs: 'guides/glossary#net',
  },
  ground: {
    id: 'ground',
    plain: 'ground (0 V reference)',
    technical: 'ground net, SPICE node 0',
    definition:
      'The net every other voltage is measured against. The simulator needs exactly one, so Power On and Run stay disabled until you pick it.',
    docs: 'guides/ground-and-supply',
  },
  simFields: {
    id: 'simFields',
    plain: 'simulation settings from the schematic',
    technical: 'Sim.* fields',
    definition:
      'Optional properties on schematic symbols (Sim.Device, Sim.Pins and so on) that tell the simulator what a part is. Attaching the schematic gives circsim exact pin names and models.',
    docs: 'guides/attach-schematic',
  },
  rawLog: {
    id: 'rawLog',
    plain: "the simulator's full log",
    technical: 'raw ngspice log',
    definition:
      'The unedited text from ngspice, the simulation engine inside circsim. Useful to copy into a bug report; you do not need to read it.',
    docs: 'guides/warnings#convergence',
  },
  gmin: {
    id: 'gmin',
    plain: 'gentler solve',
    technical: 'gmin stepping',
    definition:
      'A fallback the solver uses when a straight solve will not settle: it adds tiny helper connections to ground and removes them step by step. The answer can be less trustworthy, so circsim flags it.',
    docs: 'guides/warnings#op-caveat',
  },
  sourceStepping: {
    id: 'sourceStepping',
    plain: 'ramped solve',
    technical: 'source stepping',
    definition:
      'A second fallback: the supplies are brought up from zero in small steps instead of all at once. Like the gentler solve, the result is flagged because it can be less trustworthy.',
    docs: 'guides/warnings#op-caveat',
  },
  floatingNode: {
    id: 'floatingNode',
    plain: 'unconnected net',
    technical: 'floating node',
    definition:
      'A net with no DC path to ground, such as an input wired to nothing. The simulator cannot decide its voltage, which is a common reason a solve fails.',
    docs: 'guides/warnings#convergence',
  },
  stub: {
    id: 'stub',
    plain: 'placeholder part',
    technical: 'stub',
    definition:
      'A stand-in used when a part has no real model: its pins are left unconnected, tied together, or driven by hand from a panel.',
    docs: 'concepts/models#stubs-and-interactive-pins',
  },
  stubOpen: {
    id: 'stubOpen',
    plain: 'Ignore this part',
    technical: 'Stub open',
    definition:
      "Leave this part's pins unconnected, as if it were not fitted. Right for a part you want removed from the simulation.",
    docs: 'concepts/models#stubs-and-interactive-pins',
  },
  stubShort: {
    id: 'stubShort',
    plain: 'Replace with a wire',
    technical: 'Stub short',
    definition:
      "Tie all of this part's pins together, as a jumper, a fitted zero-ohm resistor, or a closed switch would.",
    docs: 'concepts/models#stubs-and-interactive-pins',
  },
  unresolved: {
    id: 'unresolved',
    plain: 'no model found',
    technical: 'unresolved',
    definition:
      'circsim has no model for this part, so it contributes nothing to the simulation. Fix it in the Model Doctor.',
    docs: 'guides/model-doctor',
  },
  pinMap: {
    id: 'pinMap',
    plain: 'Pin matching',
    technical: 'pin map: pad to model terminal',
    definition:
      "Which pad on the board connects to which terminal of the part's simulation model. Wrong matching gives wrong results, for example a diode that conducts backwards.",
    docs: 'guides/model-doctor#pin-map',
  },
  psu: {
    id: 'psu',
    plain: 'Power supply',
    technical: 'PSU',
    definition:
      'A bench power supply: an adjustable DC voltage you clip onto a net. Its return goes through your ground.',
    docs: 'reference/instruments',
  },
  seriesR: {
    id: 'seriesR',
    plain: 'Source resistance',
    technical: 'Series R',
    definition:
      "The supply's internal resistance. Near zero is an ideal supply; raise it to model a weak source whose voltage sags under load.",
    docs: 'reference/instruments',
  },
  rheostat: {
    id: 'rheostat',
    plain: 'Variable resistor',
    technical: 'rheostat',
    definition:
      'The potentiometer used as a two-terminal resistor whose value you turn between zero and its total.',
    docs: 'reference/instruments',
  },
  divider: {
    id: 'divider',
    plain: 'Voltage divider',
    technical: 'divider',
    definition:
      'The potentiometer used with three terminals: the ends sit across a voltage and the wiper gives a voltage somewhere between them.',
    docs: 'reference/instruments',
  },
  totalR: {
    id: 'totalR',
    plain: 'Total resistance',
    technical: 'Total R',
    definition: 'The potentiometer value from end to end, before the wiper splits it.',
    docs: 'reference/instruments',
  },
  vHigh: {
    id: 'vHigh',
    plain: 'High level',
    technical: 'V High',
    definition:
      'The voltage the logic output drives when it is set to HI. Set it to match the logic power rail of the chip you are driving.',
    docs: 'reference/instruments',
  },
  vdd: {
    id: 'vdd',
    plain: 'chip power pin',
    technical: 'VDD',
    definition:
      'The positive supply pin of a digital chip. circsim reads its voltage to decide what counts as a logic high.',
    docs: 'guides/warnings#rail-note',
  },
  transient: {
    id: 'transient',
    plain: 'live run',
    technical: 'transient simulation',
    definition:
      'The Run button: the circuit is simulated moment by moment so you can watch voltages change on the scope.',
    docs: 'guides/probe-and-scope',
  },
}

export const TERM_IDS = Object.keys(GLOSSARY) as TermId[]

/** Capitalize the first letter (labels used mid-sentence are stored lower-case). */
export function capitalized(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/**
 * Tooltip text for places a component cannot go (button `title`, `aria-label`):
 * "Plain label (technical term): definition".
 */
export function termTitle(id: TermId): string {
  const e = GLOSSARY[id]
  return `${capitalized(e.plain)} (${e.technical}): ${e.definition}`
}
