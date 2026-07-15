# Backlog — candidate features, not yet scheduled

## Critic check: schematic polarity audit for diodes/LEDs

**What:** when a schematic is attached (the picker flow), audit every
two-terminal polarized part: compare the applied SPICE pin map against the
symbol's pin names (`A`/`K` for diodes/LEDs — ground truth in the design
files) and flag any part where the model's anode/cathode assignment
disagrees with the schematic.

**Why:** the D7 incident (led_lantern rev B, fixed in f6680b6). Footprint-name
regexes can only encode *beliefs* about a library's pad-numbering convention
(KiCad D_* = pad 1 cathode, JLC/EasyEDA = pad 1 anode). The convention
partition guard (`library-convention-guard.test.ts`) locks those beliefs
against a name corpus, but a consistently held *wrong* belief passes any
unit test written under it. The schematic carries the actual answer — the
board designer resolved D7 exactly this way (symbol pin 1 = "A"). An
automated cross-check would have caught the reversed diode with zero human
input, pre-fab.

**Scope sketch:** read `lib_symbols` pin names from the attached
`.kicad_sch`; for each D/LED ref with a model-card diode resolution, map
pad → symbol pin → name; expect the pad the pin map sends to terminal 1 to
be named `A` (and terminal 2 `K`); mismatch → Critic finding (red, with the
"flip pin map" fix-it pointing at the Model Doctor pin-map override).
