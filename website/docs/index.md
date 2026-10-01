---
layout: home

hero:
  name: circsim
  text: The validation bench for routed boards
  tagline: Open any routed KiCad board, power it up, and probe it in 3D. An interactive SPICE bench and a read-only layout audit that catch mistakes before you pay for fabrication.
  actions:
    - theme: brand
      text: Get started
      link: /start/install
    - theme: alt
      text: First Light tutorial
      link: /start/first-light
    - theme: alt
      text: What can it tell me?
      link: /concepts/fidelity

features:
  - title: Any routed KiCad board, no setup
    details: Open a .kicad_pcb from KiCad 6 to 10 and press Energize. circsim rebuilds the circuit from the copper and matches parts to its bundled models, so there are no Sim.* fields to assign first.
  - title: Your schematic, when you have it
    details: Keep the .kicad_sch next to the board and circsim attaches it on open. Its Sim.* fields become the first model source and its pin names settle diode polarity.
  - title: A real bench, on your desk
    details: Clip a supply, a function generator, a potentiometer, and probes onto the board. Turn a knob and watch the LED respond live. It's the breadboard feeling, on a board you can't breadboard.
  - title: Honest about what it knows
    details: circsim tells you exactly which parts are modeled, which are stubbed, and where the physics stops. A validator you can't trust is worse than none, so it never hides the gaps.
  - title: A read-only audit of the layout
    details: Before you send it off, circsim checks the board it did NOT design for floating nets, thin power paths, and decoupling too far from the pin, and never touches your files.
---

## Why circsim exists

A routed board is the thing you are about to pay to have made. It might be your own KiCad layout, a contractor's delivery, or the output of an autorouter such as [Quilter](https://quilter.ai). Before you order it, you want to know two things: does the circuit work, and will the layout hold up?

Schematic simulators such as LTspice and KiCad's own ngspice integration run on the drawing, and each symbol needs a model assigned before you press go. circsim runs on the board file. It reads the net connectivity out of the `.kicad_pcb`, matches each part to a **SPICE model**, and gives you a bench to poke at it: apply power, read every net's voltage on the copper, drag a scope probe onto an output, and dial a knob while the waveform moves. When something is wrong, like a rail (a power-supply net) sagging to 0.3 V or an op-amp stuck at the rail, you see it *on the physical board you're about to fabricate*.

The second question belongs to the read-only [Board Critic](/concepts/board-critic), which reads the layout for floating nets, clearance, decoupling distance, IR-drop, and ampacity. Know one limit up front: the simulation treats every net as a single ideal node, so copper resistance shows up in the Critic's estimates and not in the simulated voltages. A schematic is optional. If the `.kicad_sch` sits next to the board with the same name, circsim attaches it and uses its `Sim.*` fields and pin names.

> **SPICE** is the decades-old, industry-standard way to simulate an electronic circuit by solving its equations numerically. circsim runs [ngspice](https://ngspice.sourceforge.io/), a well-established open-source SPICE engine (the same one inside KiCad), fully bundled. There's nothing to install.

It is fully offline, it is MIT-licensed, and it **never modifies your design files.**

![circsim with a board energized: the LED glowing on the 3D board, a supply lead clipped to the copper, the bench shelf with a PSU panel below, and the read-only Board Critic on the right.](/img/first-light-energized.png)

<div style="margin-top: 2rem; padding: 1rem 1.25rem; border-left: 3px solid var(--vp-c-brand-1); background: var(--vp-c-bg-soft); border-radius: 6px;">

**New here?** Start with [installing circsim](/start/install), then do the [First Light tutorial](/start/first-light): a one-LED dimmer that takes five minutes and shows the whole flow end to end.

</div>
