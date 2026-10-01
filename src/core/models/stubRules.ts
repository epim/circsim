/**
 * core/models/stubRules.ts
 *
 * Automatic stubbing of parts that have no simulable model but that a bench
 * must not leave silently unmodeled (issue #29): microcontrollers and modules
 * (ESP32, STM32, ATmega, RP2040, nRF52, ...), addressable LEDs and USB-serial
 * bridges.
 *
 * A recognized part resolves to a SUPPLY-LOAD stub: a two-terminal subcircuit
 * from stubs.lib that draws the part's datasheet supply current between its
 * supply pad and its ground pad, and does nothing else. The rail therefore
 * sags and loads like the real board; the part's logic is not simulated.
 * The resolution is `stubbed` (amber in the UI), never `ok`, and its warning
 * says what the stub is and how to drive the pins instead.
 *
 * A part that looks like a controller but whose family has no datasheet figure
 * here (an STM32 of an unlisted series, a PIC), or whose supply pads cannot be
 * found, becomes an `interactive-pins` stub with a warning: no load is invented
 * for it.
 *
 * Crystals and resonators (a Y or X part on a Crystal footprint, or with a
 * frequency for a value) resolve to a documented open: their resonance matters
 * only to the oscillator that the missing controller model would provide.
 *
 * Rules run after the bundled library and user models matched by MPN or value
 * (tier 3), so a real model or a user binding always wins. A tier-3 match made only
 * from the refdes and footprint ("some IC in a SOIC-8") does not: it says nothing
 * about the device, so a recognized controller is stubbed instead. The rules run
 * before the final `unresolved` fallback.
 *
 * Pure: no electron, react, or three imports. The supply current of every family
 * lives in resources/models/stubs.lib (the deck text) and is repeated in `supplyMa`
 * here only for the warning text; a unit test keeps the two equal.
 *
 * Issue #29.
 */

import type { Circuit, CircuitNet, Part } from '../netlist/extract'
import { valueMatchAllowed, type SchematicPin } from './libraryMatch'
import type { LibraryEntry, PinMap, Resolution } from './types'

// ─── Rule table ───────────────────────────────────────────────────────────────

export interface StubRule {
  /** Id of the stub entry in resources/models/index.json (it names the stubs.lib subckt). */
  entryId: string
  /** Short family name for messages. */
  family: string
  /** What the stub represents, for the warning ("microcontroller", "addressable LED"). */
  kind: string
  /** Supply current the stub draws, in mA (equal to the stubs.lib figure). */
  supplyMa: number
  /** Patterns tested against the MPN property, the value, and the footprint name. */
  patterns: RegExp[]
}

/**
 * Families with a datasheet supply current. Order matters: the first rule whose
 * pattern matches wins, so a specific series precedes a general one.
 */
export const STUB_RULES: readonly StubRule[] = [
  {
    entryId: 'stub-mcu-esp32', family: 'ESP32', kind: 'microcontroller module', supplyMa: 100,
    patterns: [/ESP32/i, /ESP-?WROOM-?32/i, /ESP-?WROVER/i],
  },
  {
    entryId: 'stub-mcu-esp8266', family: 'ESP8266', kind: 'microcontroller module', supplyMa: 60,
    patterns: [/ESP8266/i, /(^|[^A-Z0-9])ESP-?(01|07|12)[A-Z]?($|[^A-Z0-9])/i, /ESP-?WROOM-?02/i],
  },
  {
    entryId: 'stub-mcu-stm32f1', family: 'STM32F1', kind: 'microcontroller', supplyMa: 36,
    patterns: [/STM32F1\d\d/i, /BLUE.?PILL/i],
  },
  {
    entryId: 'stub-mcu-stm32f4', family: 'STM32F4', kind: 'microcontroller', supplyMa: 100,
    patterns: [/STM32F4\d\d/i],
  },
  {
    entryId: 'stub-mcu-stm32-lowpower', family: 'STM32 C0/F0/G0/L0/L4', kind: 'microcontroller', supplyMa: 10,
    patterns: [/STM32(C0|F0|G0|L0|L4)\d/i],
  },
  {
    entryId: 'stub-mcu-atmega', family: 'ATmega', kind: 'microcontroller', supplyMa: 10,
    patterns: [/ATMEGA\d/i, /ARDUINO.?(NANO|UNO|PRO.?MINI)/i],
  },
  {
    entryId: 'stub-mcu-attiny', family: 'ATtiny', kind: 'microcontroller', supplyMa: 5,
    patterns: [/ATTINY\d/i],
  },
  {
    entryId: 'stub-mcu-rp2040', family: 'RP2040', kind: 'microcontroller', supplyMa: 25,
    patterns: [/RP2040/i, /RASPBERRY.?PI.?PICO/i],
  },
  {
    entryId: 'stub-mcu-nrf52', family: 'nRF52', kind: 'microcontroller', supplyMa: 6,
    patterns: [/NRF-?52\d/i],
  },
  {
    entryId: 'stub-mcu-samd21', family: 'SAMD21', kind: 'microcontroller', supplyMa: 6,
    patterns: [/SAMD21/i],
  },
  {
    entryId: 'stub-mcu-ch32v003', family: 'CH32V003', kind: 'microcontroller', supplyMa: 8,
    patterns: [/CH32V003/i],
  },
  {
    entryId: 'stub-mcu-msp430', family: 'MSP430', kind: 'microcontroller', supplyMa: 0.23,
    patterns: [/MSP430/i],
  },
  {
    entryId: 'stub-ws2812b', family: 'WS2812B', kind: 'addressable LED', supplyMa: 1,
    patterns: [/WS28(11|12|13)/i, /NEO.?PIXEL/i],
  },
  {
    entryId: 'stub-ch340', family: 'CH340', kind: 'USB-serial bridge', supplyMa: 12,
    patterns: [/CH340[CGKNST]?($|[^A-Z0-9])/i],
  },
]

/**
 * Controllers recognized by name only: no datasheet figure is bundled for their
 * series, so they become interactive-pins stubs with no supply load.
 */
const GENERIC_CONTROLLER_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Z0-9])STM32/i, /(^|[^A-Z0-9])STM8/i, /(^|[^A-Z0-9])(AT)?SAM[DEC]\d/i,
  /(^|[^A-Z0-9])D?SPIC\d/i, /(^|[^A-Z0-9])PIC(10|12|16|18|24|32)[A-Z]/i, /PIC\d\d[A-Z]*\d/i,
  /(^|[^A-Z0-9])LPC\d/i, /(^|[^A-Z0-9])GD32/i, /(^|[^A-Z0-9])CH32/i, /(^|[^A-Z0-9])CH5\d\d/i,
  /(^|[^A-Z0-9])PY32/i, /(^|[^A-Z0-9])HT32/i, /(^|[^A-Z0-9])AT32/i, /(^|[^A-Z0-9])MM32/i,
  /(^|[^A-Z0-9])NRF(5\d|91)/i, /(^|[^A-Z0-9])ESP/i, /(^|[^A-Z0-9])W806/i, /(^|[^A-Z0-9])BL[678]0\d/i,
  /(^|[^A-Z0-9])MK[LEMV]?\d\d[A-Z]/i, /(^|[^A-Z0-9])S32K/i, /(^|[^A-Z0-9])EFM32/i,
  /(^|[^A-Z0-9])EFR32/i, /(^|[^A-Z0-9])CC(13|26|32)\d\d/i, /(^|[^A-Z0-9])TM4C/i,
  /(^|[^A-Z0-9])PSOC/i, /(^|[^A-Z0-9])CY8C/i, /(^|[^A-Z0-9])R7FA/i, /(^|[^A-Z0-9])RL78/i,
  /(^|[^A-Z0-9])ATXMEGA/i, /(^|[^A-Z0-9])AT90/i, /(^|[^A-Z0-9])ATMEGA/i, /(^|[^A-Z0-9])ATTINY/i,
  /(^|[^A-Z0-9])TEENSY/i, /(^|[^A-Z0-9])XIAO/i, /(^|[^A-Z0-9])MAX32\d{3}/i,
]

/** Symbol or footprint library prefixes KiCad uses for controllers (`MCU_ST_STM32F1:...`). */
const MCU_LIBRARY_PREFIX = /(^|:)MCU_/i

/** Machine prefix of every stub-rule warning (the Model Doctor card shows it; tests key on it). */
export const STUB_NOTE_PREFIX = 'stub:'

// ─── Supply and ground pad discovery ──────────────────────────────────────────

/** Name without the sheet path and the sign: "/PWR/+3V3" is "3V3". */
function normalizeRailName(name: string): string {
  const tail = name.split('/').pop() ?? name
  return tail.trim().replace(/^[+~]+/, '').toUpperCase()
}

const GROUND_NAME = /^(A|D|P|S)?GND[A-Z0-9_]*$|^VSS[A-Z0-9_]*$|^0V$/
const SUPPLY_NAME =
  /^(V(DD|CC|IO|BAT|BUS|IN|REG|CORE|PWR)[A-Z0-9_]*|[AD]VDD[A-Z0-9_]*|\d+V\d*(_[A-Z0-9_]+)?|\d+\.\d+V|V\d+V?\d*)$/
/** Rails that feed an analog block only; a digital supply pin outranks them. */
const ANALOG_SUPPLY_NAME = /^(VDDA|AVDD|VDDA?REF|VREF|VCCA|VBAT|VBUS)/

/** How good a name is as the pad that carries the part's supply current (0 = not a supply). */
function supplyRank(name: string): number {
  const n = normalizeRailName(name)
  if (GROUND_NAME.test(n) || !SUPPLY_NAME.test(n)) return 0
  if (/^(VDD|VCC|VDDIO|IOVDD|\d+V\d*(_[A-Z0-9_]+)?|\d+\.\d+V|V\d+V?\d*)$/.test(n)) return 3
  if (ANALOG_SUPPLY_NAME.test(n)) return 1
  return 2
}

function groundRank(name: string): number {
  const n = normalizeRailName(name)
  if (!GROUND_NAME.test(n)) return 0
  return /^(GND|VSS|0V|DGND)$/.test(n) ? 3 : 2
}

/** Pad numbers in a stable order: numeric first (1, 2, 10), then alphanumeric (A1, B2). */
function sortedPads(pads: Iterable<string>): string[] {
  return [...pads].sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    const aNum = Number.isFinite(na)
    const bNum = Number.isFinite(nb)
    if (aNum && bNum) return na - nb
    if (aNum !== bNum) return aNum ? -1 : 1
    return a.localeCompare(b)
  })
}

export interface SupplyPads {
  /** Pad that carries the supply current. */
  vdd: string
  /** Pad that returns it. */
  gnd: string
  /** Where the answer came from. */
  via: 'schematic' | 'footprint' | 'net-names'
}

/** The best-ranked pad, ties to the lowest pad number. */
function bestPad(
  pads: readonly string[],
  rank: (pad: string) => number,
): string | undefined {
  let best: string | undefined
  let bestRank = 0
  for (const pad of pads) {
    const r = rank(pad)
    if (r > bestRank) {
      best = pad
      bestRank = r
    }
  }
  return best
}

/**
 * Find the pads that carry a part's supply and ground, in order of authority:
 *   1. the attached schematic's power-input pin names (the design's own statement),
 *   2. the stub entry's datasheet pin map for the placed footprint, when it has one,
 *   3. the names of the nets on the part's pads (`+3V3`, `VCC`, `GND`).
 * A supply on the ground net, or no ground, is "not found".
 */
export function findSupplyPads(
  part: Part,
  circuit: Pick<Circuit, 'nets'>,
  schematicPins: readonly SchematicPin[] | undefined,
  entry?: LibraryEntry,
): SupplyPads | null {
  return findSupplyPadsIn(part, netsById(circuit), schematicPins, entry)
}

/** Net id to net, for lookups that must not scan the net list per part. */
export type NetsById = ReadonlyMap<number, CircuitNet>

/** Index a circuit's nets by id. resolveAll builds it once and reuses it for every part (issue #76). */
export function netsById(circuit: Pick<Circuit, 'nets'>): Map<number, CircuitNet> {
  return new Map(circuit.nets.map(n => [n.id, n]))
}

/** findSupplyPads over a prebuilt net index: the per-part cost is the part's own pads, not the net count. */
export function findSupplyPadsIn(
  part: Part,
  netInfo: NetsById,
  schematicPins: readonly SchematicPin[] | undefined,
  entry?: LibraryEntry,
): SupplyPads | null {
  const pads = sortedPads(part.padNet.keys())
  const netName = (pad: string): string => {
    const id = part.padNet.get(pad)
    return id === undefined ? '' : (netInfo.get(id)?.kicadName ?? '')
  }
  const isGroundNet = (pad: string): boolean => {
    const id = part.padNet.get(pad)
    return id !== undefined && netInfo.get(id)?.spiceNode === '0'
  }
  const sameNet = (a: string, b: string): boolean => part.padNet.get(a) === part.padNet.get(b)
  const accept = (vdd: string | undefined, gnd: string | undefined, via: SupplyPads['via']): SupplyPads | null =>
    vdd !== undefined && gnd !== undefined && !sameNet(vdd, gnd) ? { vdd, gnd, via } : null

  // 1. Schematic power-input pins.
  if (schematicPins && schematicPins.length > 0) {
    const nameOfPad = new Map<string, string>()
    for (const p of schematicPins) {
      if (p.type === 'power_in' && part.padNet.has(p.number) && !nameOfPad.has(p.number)) {
        nameOfPad.set(p.number, p.name)
      }
    }
    const powerPads = pads.filter(p => nameOfPad.has(p))
    const found = accept(
      bestPad(powerPads, p => supplyRank(nameOfPad.get(p)!)),
      bestPad(powerPads, p => groundRank(nameOfPad.get(p)!)),
      'schematic',
    )
    if (found) return found
  }

  // 2. The entry's datasheet pin map for this footprint.
  if (entry) {
    for (const [pattern, map] of Object.entries(entry.pinMaps ?? {})) {
      let hit = false
      try {
        hit = new RegExp(pattern, 'i').test(part.libId)
      } catch {
        hit = false
      }
      if (!hit) continue
      const vdd = Object.keys(map).find(p => map[p] === 'vdd' && part.padNet.has(p))
      const gnd = Object.keys(map).find(p => map[p] === 'gnd' && part.padNet.has(p))
      const found = accept(vdd, gnd, 'footprint')
      if (found) return found
    }
  }

  // 3. Net names.
  const groundPad =
    pads.find(isGroundNet) ?? bestPad(pads, p => groundRank(netName(p)))
  const supplyPad = bestPad(
    pads.filter(p => !isGroundNet(p)),
    p => supplyRank(netName(p)),
  )
  return accept(supplyPad, groundPad, 'net-names')
}

// ─── Classification ───────────────────────────────────────────────────────────

export type StubClass =
  | { kind: 'supply-load'; rule: StubRule }
  | { kind: 'controller'; reason: string }
  | { kind: 'crystal' }

/** Refdes prefixes of crystals and resonators. */
const CRYSTAL_REFDES = new Set(['Y', 'X', 'XTAL'])
const CRYSTAL_FOOTPRINT = /^(Crystal|Resonator|XTAL)/i
const CRYSTAL_VALUE = /^\d+(\.\d+)?\s*[kM]Hz$|crystal|xtal|resonator/i

/** Why a crystal is left open, for the documented-open note. */
export const CRYSTAL_NOTE =
  'Crystal or ceramic resonator: its resonance only matters to the oscillator that the missing controller model would provide. Intentionally left open.'

function refdesLetters(ref: string): string {
  const m = ref.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/** The footprint name without its library: "RF_Module:ESP32-WROOM-32" is "ESP32-WROOM-32". */
function footprintTail(libId: string): string {
  const i = libId.lastIndexOf(':')
  return i >= 0 ? libId.slice(i + 1) : libId
}

/**
 * Recognize a part that needs a stub. Text searched, in order: the explicit MPN
 * property (a BOM MPN is merged in by the caller), the value, the footprint name.
 * Refuses refdes that are never a device (connectors, passives, test points).
 */
export function classifyStubPart(part: Part): StubClass | null {
  if (
    CRYSTAL_REFDES.has(refdesLetters(part.ref)) &&
    (CRYSTAL_FOOTPRINT.test(footprintTail(part.libId)) || CRYSTAL_VALUE.test(part.value.trim()))
  ) {
    return { kind: 'crystal' }
  }
  if (!valueMatchAllowed(part.ref)) return null

  const mpnKey = Object.keys(part.properties).find(k => k.toLowerCase() === 'mpn')
  const texts = [
    mpnKey !== undefined ? part.properties[mpnKey] : '',
    part.value,
    footprintTail(part.libId),
  ].filter(t => t.trim() !== '')

  for (const rule of STUB_RULES) {
    if (texts.some(t => rule.patterns.some(re => re.test(t)))) return { kind: 'supply-load', rule }
  }

  const named = texts.find(t => GENERIC_CONTROLLER_PATTERNS.some(re => re.test(t)))
  if (named !== undefined) return { kind: 'controller', reason: `its name "${named}" is a known microcontroller family` }
  if (MCU_LIBRARY_PREFIX.test(part.libId)) return { kind: 'controller', reason: `its library "${part.libId}" is a microcontroller library` }
  return null
}

// ─── Resolution ───────────────────────────────────────────────────────────────

function interactivePinsStub(part: Part, warning: string): Resolution {
  return {
    ref: part.ref,
    status: 'stubbed',
    model: { kind: 'stub', mode: 'interactive-pins' },
    tier: 6,
    warnings: [warning],
  }
}

function formatMa(ma: number): string {
  return ma < 1 ? `${Math.round(ma * 1000)} uA` : `${ma} mA`
}

/**
 * Resolve a part that no model, user binding or Sim.* field claimed. Returns null
 * when the part is not one the stub rules know (it stays `unresolved`).
 */
export function resolveStubPart(
  part: Part,
  netInfo: NetsById,
  entryById: ReadonlyMap<string, LibraryEntry> | undefined,
  schematicPins: readonly SchematicPin[] | undefined,
): Resolution | null {
  const cls = classifyStubPart(part)
  if (!cls) return null

  if (cls.kind === 'crystal') {
    return {
      ref: part.ref,
      status: 'documented-open',
      model: { kind: 'stub', mode: 'open' },
      note: CRYSTAL_NOTE,
      tier: 6,
      warnings: [],
    }
  }

  if (cls.kind === 'controller') {
    return interactivePinsStub(
      part,
      `${STUB_NOTE_PREFIX} ${part.ref} (${part.value}) is treated as a microcontroller because ${cls.reason}, ` +
      `but no datasheet supply current is bundled for its series: it is stubbed as interactive pins and draws no supply current. ` +
      `Bind a model in the Model Doctor if its load matters`,
    )
  }

  const { rule } = cls
  const entry = entryById?.get(rule.entryId)
  if (!entry || entry.model.type !== 'subckt' || !entry.model.file) {
    return interactivePinsStub(
      part,
      `${STUB_NOTE_PREFIX} ${part.ref} (${part.value}) is a ${rule.family} ${rule.kind}, but the supply-load stub "${rule.entryId}" ` +
      `is not in the model library: it is stubbed as interactive pins and draws no supply current`,
    )
  }

  const pads = findSupplyPadsIn(part, netInfo, schematicPins, entry)
  if (!pads) {
    return interactivePinsStub(
      part,
      `${STUB_NOTE_PREFIX} ${part.ref} (${part.value}) is a ${rule.family} ${rule.kind}, but its supply and ground pads could not be ` +
      `identified from the schematic pin names or the net names: it is stubbed as interactive pins and draws no supply current`,
    )
  }

  const pinMap: PinMap = { [pads.vdd]: 'vdd', [pads.gnd]: 'gnd' }
  const railId = part.padNet.get(pads.vdd)
  const rail = (railId === undefined ? undefined : netInfo.get(railId)?.kicadName) ?? `pad ${pads.vdd}`
  return {
    ref: part.ref,
    status: 'stubbed',
    model: { kind: 'subckt', libFile: entry.model.file, subcktName: entry.model.name, pinMap },
    tier: 6,
    warnings: [
      `${STUB_NOTE_PREFIX} ${part.ref} (${part.value}) is a ${rule.family} ${rule.kind} modeled as a supply-load stub: ` +
      `it draws about ${formatMa(rule.supplyMa)} from supply pad ${pads.vdd} (${rail}) ` +
      `to ground pad ${pads.gnd} (found from ${pads.via === 'schematic' ? 'the schematic pin names' : pads.via === 'footprint' ? 'the datasheet pinout' : 'the net names'}) ` +
      `and nothing else; its logic and pins are not simulated`,
    ],
  }
}
