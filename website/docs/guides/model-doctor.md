# Fix an unresolved part

When a part shows a red **"no model"** dot, circsim couldn't match it to a SPICE model, so it contributes nothing to the simulation and appears in the [fidelity banner](./warnings). The **Model Doctor** (left dock, under Parts) is where you fix it. It's a docked panel, never a blocking dialog, so you can keep working while it's open.

Click a part in the fidelity banner's **open Model Doctor** link, or click the part in the **Parts** panel, to reveal its card.

## What a card shows

Each problem part shows a status pill: **no model** (red), **stubbed** (amber), or **open by design** (grey). It also shows a reference, value, and library id, plus any warnings (an ambiguous match, an unverified pin order, an electrolytic-polarity caution). Below that is a row of actions.

## Your options

### Import a `.lib` {#import-a-lib}

If you have a SPICE model file for the part (from the manufacturer, or anywhere), click **Import .lib…**. The guided flow:

1. **Pick** a `.lib` or `.sub` file.
2. **Choose the subckt** to bind (if the file has several).
3. **Verify the pin map**: map each board pad to the correct model terminal. *Check this against the datasheet; a wrong pin map produces confidently-wrong results.*
4. **Bind** it to the part.

Imported models are prepended to circsim's library, so your model for a given part number wins over any bundled one, and it's remembered for next time.

### Ask your LLM

No model file? Click **Ask your LLM** (in the **⋮** overflow menu). circsim gives you a ready-to-paste prompt:

1. **Copy the prompt** and paste it into your LLM of choice.
2. **Paste the `.subckt` response** back into circsim.
3. **Validate with ngspice**: circsim loads the model into the real engine and tells you whether it accepted it. If ngspice rejects it, nothing is saved; revise and retry.
4. **Save** to your library, which opens the pin-map editor so you can verify the terminal mapping (the LLM's suggested map is a suggestion, not gospel).

This keeps a fully-offline, no-API workflow honest: the model only counts once *ngspice itself* accepts it.

### Stub it

Sometimes the right answer is "take this part out of the picture":

- **Stub open**: leave the pins electrically open (part not fitted, or removed from the sim).
- **Stub short** (⋮ menu): tie the pins together (a jumper, a fitted zero-ohm, a closed switch).

### Interactive pins {#interactive-pins}

For microcontrollers and complex digital ICs (which have no SPICE model and whose firmware doesn't run), choose **Interactive pins** (⋮ menu). This turns the part into a control panel (right dock) where each pin has a **Hi-Z / 0 / 1 / Watch** mode:

- **Hi-Z**: floating (high impedance).
- **0** / **1**: drive the pin low or high.
- **Watch**: read the pin's voltage.

Now you can answer "if GPIO5 goes high, does the LED light?" by driving the pin yourself, without pretending to simulate the chip.

## Edit the pin map {#pin-map}

Click **Pin map** on any card to open the pad ↔ terminal table. Each terminal is editable (with a datalist of the model's terminal names), and every edit commits immediately as your override: it beats every automatic source and survives re-resolution. This is where you fix a [reversed diode](../reference/pin-maps#diode-polarity) if the automatic sources got it wrong.

## Undo

A **Reset** button appears on any card you've overridden: it clears your changes and lets circsim re-resolve the part from scratch.

## Related

- [Models & resolution](../concepts/models): how matching works, and the model kinds.
- [Model library reference](../reference/model-library): what's built in.
- [Pin-map precedence](../reference/pin-maps): the full trust order.
