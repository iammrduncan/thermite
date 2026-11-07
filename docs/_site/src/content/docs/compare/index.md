---
title: "Compare Thermite"
description: "How Thermite differs from other autoresearch harnesses: who measures, who decides, and what happens to the work that loses."
type: comparison
sidebar:
  order: 1
  label: "Overview"
---

Autoresearch tools run the same loop: an agent changes something, a run measures it, and the better version stays. They differ in who you have to trust at each step, and in how much you have to set up. These questions separate them.

| Question | Thermite | [pi-autoresearch](pi-autoresearch.md) |
| --- | --- | --- |
| Who writes the benchmark? | You, in a kit the agents never see | The agent, which may change it during the loop |
| Who reports the number? | The judge | The agent |
| Who decides what stays? | The judge, by the rules in the contract | The agent, unless the checks failed |
| What happens to a change that loses? | Kept, with its code and the reasons | Its code is reverted; the agent's notes stay in the log |
| What ends the work? | Only a limit you set | Your limit, or built-in stops at 200 automatic turns and after more than 20 failures in a row |
| How many agents? | Many, each isolated, with one planner | One |
| What does it take to start? | Docker or Podman, about twenty minutes, then a kit for each project | One install command; the agent sets up the rest |

## Comparisons

- [Thermite vs pi-autoresearch](pi-autoresearch.md): the terminal extension that Thermite grew out of.

## How these pages are written

Thermite's authors write these pages, so read them with that in mind. To keep them honest:

- Each page names the versions it compares and the date it was checked.
- Each claim about another tool links to that tool's code or documentation at that version.
- Each page says where the other tool is the better choice, and what Thermite costs you.

If a page is wrong or out of date, [open an issue](https://github.com/iammrduncan/thermite/issues).
