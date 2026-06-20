/**
 * core/live/coach.ts
 *
 * A plain-language "why isn't it glowing?" coach. Given the live operating-point
 * state of a board, it explains — in everyday words, with NO SPICE terms, node
 * numbers, or jargon — why each dark LED isn't lit, and what to try.
 *
 * This is a pure, deterministic core module: the same input always yields the
 * same notes in the same order (LEDs are reported in input order). It performs
 * no I/O and imports nothing from electron, react, or three.
 */

/** Default current below which an LED is treated as "off" (0.5 mA). */
export const DEFAULT_LED_ON_THRESHOLD_A = 0.5e-3

/**
 * One plain-language note about a single LED that isn't lighting up.
 * `severity` is always 'info' — these are gentle coaching hints, not errors.
 */
export interface DarkLedNote {
  /** The LED's part reference, e.g. "D1". */
  ref: string
  severity: 'info'
  /** Short headline, plain language (no jargon). */
  title: string
  /** A sentence or two explaining what's going on. */
  detail: string
  /** What to try next. */
  suggestion: string
}

/** One LED's wiring: which net feeds its anode (+) and which its cathode (−). */
export interface CoachLed {
  ref: string
  anodeNet: number
  cathodeNet: number
}

/** Everything the coach needs to reason about why LEDs are dark. */
export interface DiagnoseInput {
  /** The LEDs to check, reported back in this order. */
  leds: CoachLed[]
  /** Measured current through each part (amps), keyed by part ref. */
  currentsByRef: Map<string, number>
  /** Optional solved node voltages (volts), keyed by net id. */
  netVoltages?: Map<number, number>
  /** True once a supply (and ground) are driving the board. */
  hasSupply: boolean
  /** Override the "lit" current threshold (amps). Defaults to 0.5 mA. */
  ledOnThresholdA?: number
}

/**
 * Explain, in plain language, why each LED isn't glowing.
 *
 * An LED is "dark" when the magnitude of its measured current is below the
 * threshold, or no current was measured for it at all. LEDs at or above the
 * threshold are considered lit and produce no note.
 *
 * For each dark LED, exactly one message is chosen, in priority order:
 *   1) No supply yet            — nothing is powering the board.
 *   2) Wired in backwards       — anode voltage is below cathode voltage, so
 *                                 current would want to flow the wrong way
 *                                 (only checked when voltages are available).
 *   3) Otherwise                — almost no current is reaching it.
 */
export function diagnoseDarkLeds(input: DiagnoseInput): DarkLedNote[] {
  const threshold = input.ledOnThresholdA ?? DEFAULT_LED_ON_THRESHOLD_A
  const notes: DarkLedNote[] = []

  for (const led of input.leds) {
    const current = input.currentsByRef.get(led.ref)
    // Lit? A measured current at/above the threshold means it's already glowing.
    if (current !== undefined && Math.abs(current) >= threshold) {
      continue
    }

    // Case 1 — nothing is driving the board, so nothing can light.
    if (!input.hasSupply) {
      notes.push({
        ref: led.ref,
        severity: 'info',
        title: `${led.ref} has no power yet`,
        detail: `Nothing is powering the board yet — attach a supply (and ground) to light ${led.ref}.`,
        suggestion: 'Add a power supply and a ground connection, then turn it on.',
      })
      continue
    }

    // Case 2 — backwards. LEDs only pass current one way; if the anode side sits
    // at a lower voltage than the cathode side, it's blocking (reverse biased).
    if (input.netVoltages) {
      const anodeV = input.netVoltages.get(led.anodeNet)
      const cathodeV = input.netVoltages.get(led.cathodeNet)
      if (anodeV !== undefined && cathodeV !== undefined && anodeV < cathodeV) {
        notes.push({
          ref: led.ref,
          severity: 'info',
          title: `${led.ref} looks backwards`,
          detail: `${led.ref} looks like it's in backwards — current would flow the wrong way through it.`,
          suggestion: `Flip ${led.ref} around so its plus (+) side faces the higher voltage.`,
        })
        continue
      }
    }

    // Case 3 — powered and oriented correctly, but barely any current arrives.
    notes.push({
      ref: led.ref,
      severity: 'info',
      title: `${led.ref} isn't lit`,
      detail: `${led.ref} isn't lit — almost no current is reaching it. Check it's connected between power and ground with something to limit the current.`,
      suggestion: `Make sure ${led.ref} sits between power and ground, with a resistor to set the current.`,
    })
  }

  return notes
}
