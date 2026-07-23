# Drive a microcontroller's pins

circsim can't run your firmware: a microcontroller (ESP32, STM32, RP2040, ATmega, …) has no SPICE model, and the code that would run on it isn't executed. But that doesn't make an MCU board un-checkable. circsim turns the chip into a panel of **interactive pins** you drive by hand, so you can answer the questions that actually matter for the *hardware*:

> "If I drive GPIO5 high, does the LED (or the relay, or the MOSFET gate) on that net actually turn on?"
> "Will the pull-up on this I²C line hold the bus high?"
> "Does my level-shifter output move when the input does?"

This is the MCU equivalent of the [First Light](../start/first-light) walkthrough. You won't simulate the processor; you'll simulate everything *around* it while you play the part of the firmware.

## The idea

When a part has no model, circsim doesn't fake one. For a microcontroller you tell it to treat the chip as **interactive pins**: the chip contributes no circuitry of its own, and instead each of its pins becomes a control with four modes:

- **Hi-Z**: high-impedance, i.e. floating / disconnected. This is the **default for every pin**: the chip starts out doing nothing, exactly like an unpowered MCU.
- **0**: drive the pin low (0 V).
- **1**: drive the pin high (to your logic level).
- **Watch**: read the pin's voltage without driving it (a virtual multimeter probe).

You only touch the pins you care about; everything else stays Hi-Z.

## Walkthrough

You'll need one of your own boards with a microcontroller on it (the bundled demos don't include an MCU). The flow:

### 1. Open the board and find the MCU

[Open your `.kicad_pcb`](./open-board). The microcontroller will show in the **Parts** panel, usually as a red **"no model"** part, since no SPICE model matches it. Click it to reveal its card in the **[Model Doctor](./model-doctor)**.

### 2. Switch it to Interactive pins

On the MCU's Model Doctor card, open the **⋮** overflow menu and choose **Interactive pins**. The part is now an interactive-pin stub: it adds no circuitry, and a new **"{ref}: Interactive Pins"** panel appears in the right dock, one row per pin (pad number, pin name, and the net it lands on), each with a **Hi-Z / 0 / 1 / Watch** control.

::: tip What happened to all the other pins?
Nothing, and that's the point. Every pin is **Hi-Z (floating)** until you set it otherwise. The chip won't drive, sink, or load any net until you tell a specific pin to. So a 40-pin part doesn't suddenly inject 40 unknowns; it sits quiet until you drive the one or two pins you're testing.
:::

### 3. Give the rest of the board power

Interactive pins drive *logic levels*, but the analog parts around the MCU still need their supply. [Designate ground and attach a supply](./ground-and-supply) to the board's power rail (or just press **Energize** once and adjust). If a net needs a pull-up to a rail to behave (an open-drain output, an I²C line), make sure that rail is powered.

### 4. Drive a pin and watch the board respond

Find the pin connected to the thing you want to test, say the GPIO feeding an LED's current-limit resistor. Set that pin to **1**. Then [Energize](./energize) (or, if you're already energized, it re-solves live):

- The pin now drives its net to your logic-high voltage.
- The LED on that net lights up, or *doesn't*, which is just as useful (a backwards LED, a wrong resistor, a pin on the wrong net all show up here).

Flip the same pin to **0** and watch it turn off. You've verified the output path end-to-end without a single line of firmware.

### 5. Set the logic level correctly

The high level a pin drives comes from a **Logic Input**: you can add one from the [bench](./bench-and-leads) and set its **V High** to match your MCU's I/O voltage (3.3 V for most modern parts, 5 V for classic AVRs). Driving a 3.3 V GPIO net at 5 V would give you misleading thresholds downstream, so match it to the real part.

### 6. Read an input with Watch

To check a net *into* the MCU (a voltage divider on an ADC pin, a sensor output, a reset line), set that pin to **Watch** and read its voltage in the panel after a solve. That tells you what the firmware *would* see, which is often the real question ("is my divider actually landing at 1.65 V on the ADC pin?").

## What this does and doesn't prove

::: tip It's enough to verify
- An output path: GPIO → resistor → LED / MOSFET gate / relay driver works.
- A pull-up/pull-down actually reaches the right level.
- A divider or sensor front-end lands where the ADC expects it.
- No pin is wired to the wrong net.
:::

::: warning It can't verify
- **Timing between pins**: you're setting levels by hand, one at a time; there's no firmware sequencing signals.
- **Anything the code does**: protocols, PWM duty from a timer, ADC sampling. The processor isn't running.
- **The MCU's own electrical characteristics**: drive strength, input leakage, internal pull-ups (add an explicit resistor if you want to model one).
:::

See [what circsim can and can't tell you](../concepts/fidelity#mcus-and-complex-ics-are-stubs) for the full picture on MCUs.

## A related case: driving real logic gates

Interactive pins are for parts circsim *can't* model. But the 74HC and CD4000 logic families **are** modeled behaviorally, and you drive them the same way, with a **Logic Input** from the bench:

1. Add a **Logic Input** and set its **V High** to the chip's rail (5 V for 74HC, or whatever powers your CD4000). Draw its lead to the gate's input net.
2. [Energize](./energize), then toggle the Logic Input **LO / HI** and watch the gate's output net flip: the truth table, live.
3. For a **Schmitt-trigger RC astable** (a 74HC14 or CD40106 inverter with a resistor and cap around it), you don't even need to toggle anything: the gate's real hysteresis makes it self-oscillate. Just power it, [probe the output](./probe-and-scope), and press **Run** to watch it oscillate on the scope.

If a CD4000 part's logic thresholds look wrong, check its rail. See the [rail-voltage note](../reference/model-library#digital-logic-behavioral-xspice) and [rail sensing](../reference/architecture#rail-sensing).

## Related

- [Fix an unresolved part](./model-doctor): where the Interactive pins mode lives.
- [Use the bench & draw leads](./bench-and-leads): add a Logic Input to set the right level.
- [Models & resolution](../concepts/models#stubs-and-interactive-pins): the concept behind stubs and interactive pins.
