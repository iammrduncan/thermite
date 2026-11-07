---
title: "Compare Thermite"
description: "How Thermite differs from other autoresearch harnesses: who measures, who decides, and what happens to the work that loses."
type: comparison
sidebar:
  order: 1
  label: "Overview"
---

Autoresearch tools run the same loop: an agent changes something, a run measures it, and the better version stays. They differ in who you have to trust at each step, and in how much you have to set up. These questions separate them.

| Question | Thermite | [Karpathy's autoresearch](karpathy-autoresearch.md) | [pi-autoresearch](pi-autoresearch.md) | [CORAL](coral.md) |
| --- | --- | --- | --- | --- |
| Who writes the benchmark? | You, in a kit the agents never see | It is fixed in the repository | The agent, which may change it during the loop | You, and agents can read its source |
| Who reports the number? | The judge | The agent, from a log | The agent | The grader |
| Who decides what stays? | The judge, by the rules in the contract | The agent, by a rule in its prompt | The agent, unless the checks failed | Nothing is dropped; the score ranks every attempt |
| What happens to a change that loses? | Kept, with its code and the reasons | Reset; one line stays in a results file | Its code is reverted; the agent's notes stay in the log | Kept, with its commit and score |
| How is noise handled? | Paired blocks, then fresh runs to confirm | One run | An advisory score | One grade, unless your grader repeats |
| What ends the work? | Only a limit you set | Only you | Your limit, or built-in stops at 200 automatic turns and after more than 20 failures in a row | Only a limit you set |
| How many agents? | Many, each isolated, with one planner | One | One | Many, sharing their work |
| What does it take to start? | Docker or Podman, about twenty minutes, then a kit for each project | uv, one NVIDIA GPU and a prompt | One install command; the agent sets up the rest | One install script and a grader |

## Comparisons

- [Thermite vs Karpathy's autoresearch](karpathy-autoresearch.md): the three files that started it.
- [Thermite vs pi-autoresearch](pi-autoresearch.md): the terminal extension that Thermite grew out of.
- [Thermite vs CORAL](coral.md): the closest tool to Thermite, with a different idea of what agents should share.

## How these pages are written

Thermite's authors write these pages, so read them with that in mind. To keep them honest:

- Each page names the versions it compares and the date it was checked.
- Each claim about another tool links to that tool's code or documentation at that version.
- Each page says where the other tool is the better choice, and what Thermite costs you.

If a page is wrong or out of date, [open an issue](https://github.com/iammrduncan/thermite/issues).
