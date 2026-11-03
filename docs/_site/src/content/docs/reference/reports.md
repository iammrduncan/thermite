---
title: "Reports"
description: "The dashboard's Reports page: what each finished run produced, newest first, with its filters, each mode's card and where to read the rest."
type: reference
sidebar:
  order: 25
---

**Reports**, in the sidebar (address `/ui/reports`), shows what each finished run produced, newest first: one card for each closed run on every rig. Only the owner reads it, as the whole dashboard.

## Each card

A card names the run's campaign and the run, its mode, when it ended and its rig, then what it produced:

| Mode | The card's headline | Under it | Its links |
| --- | --- | --- | --- |
| Research | The paper's title, from its first heading; `Its final report` without a paper; `It ended before its final report` without either | `final report`, `paper` (or why there is none) and how many questions have an answer card | **Open the run**, and **paper.md** when the paper is in |
| Hill climb | `Champion #N: X.XX× its starting point`, or `No win over its starting point` | Its attempts, with its confirmed wins, regressions, neutral and invalid attempts | **Open the run**, and **Champion #N as a patch** once the rig published it |
| Goal | `Its goals were met`, `Not possible: you accepted the run's conclusion`, or `It ended without meeting its goals` | How many of its goals were met | **Open the run** |

The run's page holds the whole of it: a research run's final report and research folder, a hill climb's champions and attempts, a goal run's goals and conclusions.

## Filters and pages

**Mode** and **Campaign** above the cards are drop-downs of several choices, each with how many finished runs have it; each choice in force shows as a chip that takes it away, and **Clear** takes them all. A rig check's runs are left out: **Show the rig checks' runs too** brings them in. The page shows 25 cards at a time; **Newest**, **‹ Newer** and **Older ›** move through the rest.

## What moved off it

The page showed each rig's daily summary and the full resets before. A full reset under way is on its rig's page now, in a card with its state and **Cancel the reset**, and in **Needs you** when it waits for you to confirm the wipe ([Fully reset a rig](../how-to/operate/rig-lifecycle.md#fully-reset-a-rig)). The supervisors' daily summaries are still sent: MCP's `rig_reports` and REST's `GET /v1/reports` read them.
