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

What gets bound is the model itself, not a link to the file. circsim copies the chosen `.subckt` block into the board's model, together with any helper subckts it instantiates and the top-level `.model`, `.param` and `.func` cards those blocks use. Unrelated parts in the same file are left out, and comments are dropped. Because the text is copied, the original `.lib` can move or disappear afterwards. If the file `.include`s or `.lib`s other files, circsim cannot follow them: the panel says so under the subckt list, and you can import those files too.

The panel checks the model before it lets you bind. A model that [the safety gate would refuse](#models-are-code), a block with no matching `.ends`, a `.subckt` declared inside another one, or a name circsim cannot save shows its reason in red and the **Bind** button stays hidden, instead of failing later when the board is loaded into the engine.

Imported models are prepended to circsim's library, so your model for a given part number wins over any bundled one. They are remembered for the rest of the session, and across restarts once you [save the board's setup](./save-and-report), which stores your models and every Model Doctor override beside the board. A model saved by an earlier circsim build as just a comment line (it never contained the model, so it could not load) is skipped when the setup is reopened, with a note naming the part; import the `.lib` again.

### Ask your LLM

No model file? Click **Ask your LLM** (in the **⋮** overflow menu). circsim gives you a ready-to-paste prompt:

1. **Copy the prompt** and paste it into your LLM of choice.
2. **Paste the `.subckt` response** back into circsim.
3. **Validate with ngspice**: circsim loads the model into the real engine and tells you whether it accepted it. If ngspice rejects it, nothing is saved; revise and retry. Multi-line models are fine: the whole pasted block is loaded, and the error text shown is ngspice's own. Validation checks that ngspice accepts the model, not that the throwaway circuit settles: a model that loads cleanly passes even if its test circuit has no operating point. Validation runs a throwaway test circuit in the engine, so your board's current readings stay on screen untouched, and the next run reloads the board into the engine.
4. **Save** to your library, which opens the pin-map editor so you can verify the terminal mapping (the LLM's suggested map is a suggestion, not gospel).

This keeps a fully-offline, no-API workflow honest: the model only counts once *ngspice itself* accepts it.

### Imported models are treated as code {#models-are-code}

A SPICE model is not just data. ngspice can run commands embedded in a model, including `shell`, `write`, `source` and `load`, and a model pasted from a forum or written by an LLM would run them with your user's privileges. circsim therefore gates every deck before ngspice sees it, and refuses a model that contains:

- a `.control` / `.endc` block (or the legacy `.exec`, or a `*#` command comment);
- a file reference: `.include`, `.inc`, `.lib`, `.source`, `.csparam`, or an `input_file` / `state_file` model parameter;
- any dot card circsim does not recognise as a plain circuit or analysis card;
- a card that contains a line break (ngspice would split it into several cards).

Models are always inlined into the deck, never loaded by path, so a legitimate model never needs any of these. When the gate refuses a deck you see an error that names the offending card, and the circuit is not loaded. Open the model file, delete the control block or include, and import it again. Only bring in model files you would be willing to read first.

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
