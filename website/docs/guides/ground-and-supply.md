# Set ground & supply

Before circsim can solve a circuit it needs to know two things: which net is **ground** (the reference every voltage is measured against) and where **power** comes in. Both are handled in the **Ground & Power** panel in the right dock, though [Energize](./energize) will make reasonable choices for you automatically.

## Designate ground

Ground becomes SPICE node `0`: the reference for the whole simulation. A circuit with no ground can't be solved, so **Power On and Run show a "Designate a ground net first" card until ground is set** (Energize sets it for you when it can recognise a ground name; on a board with only auto-generated net names such as `Net-(R1-Pad1)` it shows the same card and waits for you to pick the net).

circsim suggests a ground net from the net names (`GND`, `AGND`, `VSS`, `0V`, …). To confirm or change it:

- click a **suggested net chip** in the Ground & Power panel, **or**
- click the actual net **on the 3D board**.

Once set, the panel shows the ground net in green. Use **Change…** to pick a different one; the quick-pick chips beside it are ranked, with ground-named nets (`AGND`, `PGND`, `VSS`, …) first and then the nets with the most pads.

::: tip Wrong ground = wrong everything
If your voltages look bizarre (or the solve won't converge), the ground net is the first thing to check. Every voltage is *relative to* ground: pick the wrong net and the whole picture shifts.
:::

## Attach a supply

Power enters the simulation through a bench instrument, not through the board's connector (a bare-board connector is electrically open; there's no battery on it). The Ground & Power panel makes this one click:

- **Suggested supply nets** appear as chips (best candidate first). Click one to clip a **5 V, 0.1 Ω DC supply** onto that net. A net that's already supplied shows a **✓**. Click it to edit the supply instead of stacking a second one.
- If your rail isn't suggested (an unusual name), click **Choose…**. The list is ranked the same way the suggestions are (likely power names first, then the nets with the most pads) and has a filter box, so on a board with hundreds of nets you can type part of the name. It shows the top 50 matches at a time.

The supply shows up as a **PSU** front panel on the [bench shelf](./bench-and-leads), where you can adjust its voltage, series resistance, or re-route its lead.

## Or just Energize

If you don't want to think about any of this yet, press **`⚡ Energize`**. It designates a ground net, clips a 5 V supply onto the best-looking power net if you haven't attached a source, and solves, all in one click. Once you're driving the bench deliberately, use **Power On**, which never rigs anything and leaves ground and supplies entirely to you.

## Next

- **[Energize & read the operating point](./energize)**
- **[Use the bench & draw leads](./bench-and-leads)**: attach more than one supply, or a function generator.
