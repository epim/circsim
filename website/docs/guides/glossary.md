# Glossary

circsim shows a plain-language label first and the technical term second. Hover a dotted-underlined word in the app, or look it up here. The definitions below are the same ones the app shows, and each links to the page that explains it in full.

## Chip power pin {#vdd}

**Also called:** VDD

The positive supply pin of a digital chip. circsim reads its voltage to decide what counts as a logic high.

Read more: [Read the warnings & fidelity banner](/guides/warnings#rail-note)

## Connection {#net}

**Also called:** net

Every pad and trace that is wired together. All the points on one net sit at the same voltage.

## Gentler solve {#gmin}

**Also called:** gmin stepping

A fallback the solver uses when a straight solve will not settle: it adds tiny helper connections to ground and removes them step by step. The answer can be less trustworthy, so circsim flags it.

Read more: [Read the warnings & fidelity banner](/guides/warnings#op-caveat)

## Ground (0 V reference) {#ground}

**Also called:** ground net, SPICE node 0

The net every other voltage is measured against. The simulator needs exactly one, so Power On and Run stay disabled until you pick it.

Read more: [Set ground & supply](/guides/ground-and-supply)

## High level {#v-high}

**Also called:** V High

The voltage the logic output drives when it is set to HI. Set it to match the logic power rail of the chip you are driving.

Read more: [Bench instruments reference](/reference/instruments)

## Ignore this part {#stub-open}

**Also called:** Stub open

Leave this part's pins unconnected, as if it were not fitted. Right for a part you want removed from the simulation.

Read more: [Models & resolution](/concepts/models#stubs-and-interactive-pins)

## Live run {#transient}

**Also called:** transient simulation

The Run button: the circuit is simulated moment by moment so you can watch voltages change on the scope.

Read more: [Probe nets & read the scope](/guides/probe-and-scope)

## No model found {#unresolved}

**Also called:** unresolved

circsim has no model for this part, so it contributes nothing to the simulation. Fix it in the Model Doctor.

Read more: [Fix an unresolved part](/guides/model-doctor)

## Pin matching {#pin-map}

**Also called:** pin map: pad to model terminal

Which pad on the board connects to which terminal of the part's simulation model. Wrong matching gives wrong results, for example a diode that conducts backwards.

Read more: [Fix an unresolved part](/guides/model-doctor#pin-map)

## Placeholder part {#stub}

**Also called:** stub

A stand-in used when a part has no real model: its pins are left unconnected, tied together, or driven by hand from a panel.

Read more: [Models & resolution](/concepts/models#stubs-and-interactive-pins)

## Power supply {#psu}

**Also called:** PSU

A bench power supply: an adjustable DC voltage you clip onto a net. Its return goes through your ground.

Read more: [Bench instruments reference](/reference/instruments)

## Ramped solve {#source-stepping}

**Also called:** source stepping

A second fallback: the supplies are brought up from zero in small steps instead of all at once. Like the gentler solve, the result is flagged because it can be less trustworthy.

Read more: [Read the warnings & fidelity banner](/guides/warnings#op-caveat)

## Replace with a wire {#stub-short}

**Also called:** Stub short

Tie all of this part's pins together, as a jumper, a fitted zero-ohm resistor, or a closed switch would.

Read more: [Models & resolution](/concepts/models#stubs-and-interactive-pins)

## Simulation settings from the schematic {#sim-fields}

**Also called:** Sim.* fields

Optional properties on schematic symbols (Sim.Device, Sim.Pins and so on) that tell the simulator what a part is. Attaching the schematic gives circsim exact pin names and models.

Read more: [Attach a schematic](/guides/attach-schematic)

## Source resistance {#series-r}

**Also called:** Series R

The supply's internal resistance. Near zero is an ideal supply; raise it to model a weak source whose voltage sags under load.

Read more: [Bench instruments reference](/reference/instruments)

## Steady-state voltages {#operating-point}

**Also called:** DC operating point

The voltage on every net and the current through every part once everything has settled and nothing is changing. It is the same as measuring a powered board with a multimeter.

Read more: [Energize & read the operating point](/guides/energize)

## The simulator's full log {#raw-log}

**Also called:** raw ngspice log

The unedited text from ngspice, the simulation engine inside circsim. Useful to copy into a bug report; you do not need to read it.

Read more: [Read the warnings & fidelity banner](/guides/warnings#convergence)

## Total resistance {#total-r}

**Also called:** Total R

The potentiometer value from end to end, before the wiper splits it.

Read more: [Bench instruments reference](/reference/instruments)

## Unconnected net {#floating-node}

**Also called:** floating node

A net with no DC path to ground, such as an input wired to nothing. The simulator cannot decide its voltage, which is a common reason a solve fails.

Read more: [Read the warnings & fidelity banner](/guides/warnings#convergence)

## Variable resistor {#rheostat}

**Also called:** rheostat

The potentiometer used as a two-terminal resistor whose value you turn between zero and its total.

Read more: [Bench instruments reference](/reference/instruments)

## Voltage divider {#divider}

**Also called:** divider

The potentiometer used with three terminals: the ends sit across a voltage and the wiper gives a voltage somewhere between them.

Read more: [Bench instruments reference](/reference/instruments)
