/**
 * A synthetic "lantern-class" board for the model-coverage measurement of
 * issue #29: the lantern-shape board of scripts/gen-synthetic-board.mjs (the
 * LM339 and CD4000 logic cluster, passives and headers of the maintainer's
 * private led_lantern rev B) plus the parts the founding spec names as the
 * target board: a microcontroller module, a USB-serial bridge, a Li-ion charger,
 * addressable LEDs, a linear and a switching regulator, an optocoupler and the
 * usual hobbyist discretes.
 *
 * Authored from scratch (no third-party board content). Not a test file: vitest
 * only collects *.test.ts.
 */

import { generateBoard, lanternShape } from '../../../../scripts/gen-synthetic-board.mjs'
import type { SyntheticFootprint, SyntheticBoardSpec } from '../../../../scripts/gen-synthetic-board.mjs'

/** A part with pads laid out on a grid; `nets` maps pad number to net name. */
function part(
  ref: string,
  value: string,
  lib: string,
  nets: Record<string, string>,
  index: number,
): SyntheticFootprint {
  const pads = Object.entries(nets).map(([num, net], i) => ({
    num, x: (i % 8) * 2, y: Math.floor(i / 8) * 2, w: 1.2, h: 1.2, net,
  }))
  return { ref, value, lib, at: { x: 200 + (index % 6) * 25, y: 90 + Math.floor(index / 6) * 25, rot: 0 }, side: 'F', pads }
}

/** The parts added to the lantern-shape board, in the order they appear on it. */
export function targetClassParts(): SyntheticFootprint[] {
  let i = 0
  const p = (ref: string, value: string, lib: string, nets: Record<string, string>): SyntheticFootprint =>
    part(ref, value, lib, nets, i++)
  const r = (ref: string, value: string, a: string, b: string): SyntheticFootprint =>
    p(ref, value, 'Resistor_SMD:R_0805_2012Metric', { '1': a, '2': b })
  return [
    // Controllers and modules.
    p('U20', 'ESP32-WROOM-32', 'RF_Module:ESP32-WROOM-32', { '1': 'GND', '2': '+3V3', '3': '/EN', '4': '/IO_A', '15': 'GND', '38': 'GND' }),
    p('U21', 'STM32F103C8T6', 'Package_QFP:LQFP-48_7x7mm_P0.5mm', { '23': 'GND', '24': '+3V3', '35': 'GND', '36': '+3V3', '47': 'GND', '48': '+3V3', '10': '/SPI_SCK' }),
    p('U22', 'ATmega328P-AU', 'Package_QFP:TQFP-32_7x7mm_P0.8mm', { '3': 'GND', '4': '+5V', '5': 'GND', '6': '+5V', '21': 'GND', '28': '/SDA' }),
    p('U23', 'RP2040', 'Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm', { '1': '+3V3', '10': '+3V3', '57': 'GND', '5': '/GP1' }),
    // USB-serial bridge, charger, regulators.
    p('U24', 'CH340C', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', { '1': 'GND', '2': '/TXD', '3': '/RXD', '4': '/CH340_V3', '16': '+5V' }),
    p('U25', 'TP4056', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', { '1': 'GND', '2': '/PROG', '3': 'GND', '4': '+5V', '5': '/VBAT', '6': '/STDBY', '7': '/CHRG', '8': '+5V' }),
    p('U26', 'AP2112K-3.3', 'Package_TO_SOT_SMD:SOT-23-5', { '1': '+5V', '2': 'GND', '3': '+5V', '5': '+3V3' }),
    p('U27', 'LM317T', 'Package_TO_SOT_THT:TO-220-3_Vertical', { '1': '/ADJ', '2': '/LM317_OUT', '3': '+5V' }),
    p('U28', 'MT3608', 'Package_TO_SOT_SMD:SOT-23-6', { '1': '/BOOST_SW', '2': 'GND', '3': '/BOOST_FB', '4': '+5V', '5': '+5V', '6': '/BOOST_OUT' }),
    p('U29', 'LM2596S-ADJ', 'Package_TO_SOT_SMD:TO-263-5_TabPin3', { '1': '+5V', '2': '/BUCK_SW', '3': 'GND', '4': '/BUCK_FB', '5': 'GND' }),
    // Isolation and analog.
    p('U30', 'PC817', 'Package_DIP:DIP-4_W7.62mm', { '1': '/OPTO_A', '2': 'GND', '3': 'GND', '4': '/OPTO_C' }),
    p('U31', 'NE5532', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', { '1': '/AUDIO_A', '2': '/AUDIO_A', '3': '/AUDIO_IN', '4': 'GND', '8': '+5V' }),
    p('U32', 'MCP6002', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', { '1': '/SENSE_OUT', '2': '/SENSE_OUT', '3': '/SENSE', '4': 'GND', '8': '+5V' }),
    p('U33', '74HC02', 'Package_SO:SOIC-14_3.9x8.7mm_P1.27mm', { '1': '/NOR_Y', '2': '/NOR_A', '3': '/NOR_B', '7': 'GND', '14': '+5V' }),
    // Addressable LEDs, indicators, power discretes.
    p('D20', 'WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm', { '1': '+5V', '2': '/LED_DOUT1', '3': 'GND', '4': '/LED_DIN' }),
    p('D21', 'WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm', { '1': '+5V', '2': '/LED_DOUT2', '3': 'GND', '4': '/LED_DOUT1' }),
    p('D22', 'WS2812B', 'LED_SMD:LED_WS2812B_PL9823_5.0x5.0mm', { '1': '+5V', '2': '/LED_DOUT3', '3': 'GND', '4': '/LED_DOUT2' }),
    p('D23', 'SS34', 'Diode_SMD:D_SMA', { '1': '/BUCK_SW', '2': 'GND' }),
    p('D24', 'yellow', 'LED_SMD:LED_0805_2012Metric', { '1': 'GND', '2': '/STDBY' }),
    p('Q20', 'IRLZ44N', 'Package_TO_SOT_THT:TO-220-3_Vertical', { '1': '/LOAD_G', '2': '/LOAD_D', '3': 'GND' }),
    p('Q21', 'IRLML6402', 'Package_TO_SOT_SMD:SOT-23', { '1': '/PG', '2': '+5V', '3': '/SWITCHED' }),
    p('Y1', '8MHz', 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', { '1': '/XI', '2': 'GND', '3': '/XO', '4': 'GND' }),
    // The resistors that give the new parts a defined bias (pull-ups, the PROG and
    // divider resistors, loads), so the whole board has a solvable operating point.
    r('R50', '10k', '/LOAD_G', 'GND'),
    r('R51', '100', '+5V', '/LOAD_D'),
    r('R52', '10k', '/PG', 'GND'),
    r('R53', '1k', '/SWITCHED', 'GND'),
    r('R54', '1.2k', '/PROG', 'GND'),
    r('R55', '10k', '+5V', '/CHRG'),
    r('R56', '2k', '+5V', '/STDBY'),
    r('R57', '240', '/LM317_OUT', '/ADJ'),
    r('R58', '720', '/ADJ', 'GND'),
    r('R59', '500', '/LM317_OUT', 'GND'),
    r('R60', '330', '+5V', '/OPTO_A'),
    r('R61', '4.7k', '+5V', '/OPTO_C'),
    r('R62', '10k', '+3V3', '/EN'),
  ]
}

/** The synthetic lantern-class board, as a spec (for generateBoard). */
export function lanternClassSpec(): SyntheticBoardSpec {
  const base = lanternShape(10)
  const extra = targetClassParts()
  const nets = new Set<string>(base.nets)
  for (const fp of extra) for (const pad of fp.pads) if (pad.net) nets.add(pad.net)
  return {
    ...base,
    nets: [...nets],
    outline: { x0: 95, y0: 85, x1: 360, y1: 160 },
    footprints: [...base.footprints, ...extra],
  }
}

/** The board file text. */
export function lanternClassBoardText(): string {
  return generateBoard(lanternClassSpec())
}
