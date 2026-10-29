---
title: "Set a budget or a stop time"
description: "Thermite runs until the job is done. Set a limit on time, devices or spending when you want one."
type: how-to
sidebar:
  order: 7
---

Thermite runs a campaign until its job is done: a hill climb until you stop it, a goal campaign until its goals are met, and a research campaign until the review panel finds its questions answered, its open questions stop adding, or its `max_duration` is over; without any of these, until you stop it. Nothing else stops it unless you set a limit. [Why Thermite runs until the job is done](../../explanation/runs-until-done.md) says why.

Set a limit when you want one, and always before agents use a paid model key.

| Limit | Where you set it | What it counts | Where it works |
| --- | --- | --- | --- |
| A stop time | **Stop after (hours)** on the **New campaign** page, or `budget.wall_hours` in the contract | Hours since the run was created, paused time included | Every rig |
| Device hours | `budget.device_hours` in the contract | Hours the judge's jobs for the run took, each from its start to its end | Every rig |
| Model spend | `budget.llm_usd` in the contract | Dollars of the tokens that the workers' [trials](../../reference/glossary.md) used, at the token prices the rig was given | Only on a rig that has both token prices: the local stack, once you set them |

A limit pauses only a run with agents that has a model. A run with no agents, such as a [try](../../reference/glossary.md) of the kit or a run started with `--agents off`, is never paused by a limit.

:::caution[The model spend limit is not your total spend]
- It counts only the workers' trials. The planner's calls are not counted, and the advisors' calls are not counted either: they have a daily limit of their own (see [Configure advisors](../operate/advisors.md#spending)).
- A trial's tokens count when that trial ends, at one pair of prices for every model the rig uses.
- Rigs that control sets up on machines and clusters, and rigs you join yourself, can't be given the prices ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). There, `llm_usd` never pauses anything.

Where `llm_usd` can't count what you spend, set a stop time, and set a spending limit with your model provider, on the key the rig uses.
:::

## Set a stop time on the dashboard

On **Campaigns › New campaign**, step **5 Where it runs**, open **Advanced** and enter the hours in **Stop after (hours)**, such as `48`. Empty means no limit. The page has no field for money or device hours: for those, write a contract.

## Set limits in the contract

Add a `budget` with only the limits you want:

```json title="contract.json (part)"
"budget": { "wall_hours": 48, "device_hours": 20, "llm_usd": 150 }
```

Then validate the contract and start a run: see [Write a contract](write-a-contract.md) and [Start a campaign from the command line](start-from-command-line.md).

## Set the token prices for model spend

`budget.llm_usd` counts only when the rig's harness has both token prices, in dollars per million tokens. On the local stack, set them in your shell and start the stack again:

```sh
export THERMITE_LLM_USD_PER_MTOK_IN=3
export THERMITE_LLM_USD_PER_MTOK_OUT=15
docker compose up -d
```

Add your `-f` options if you start the stack with override files. The harness keeps the prices only while it runs with them: a later `up -d` from a shell without them starts it again without prices. To keep them, put both lines, without `export`, in the `.env` file in your Thermite folder. Without both prices, `llm_usd` never pauses anything, and nothing warns you.

## Check what happens at the limit

When a limit is reached, no new trial starts. The trials that are running go on to their end, so the spend can go a little past `llm_usd`. Once they have ended, the run is paused with one of these reasons:

- `the wall-time budget is spent`
- `the device-hours budget is spent`
- `the model budget is spent ($150.12)`, with the amount spent

The run's state is **Paused**, and its **History** says, for example, `Run sort-speed-1 paused: the wall-time budget is spent.` Its queued judge jobs wait too. Nothing is lost: the champion and every verdict stay.

A research campaign ends by itself instead: after `min_duration`, when the review panel's decisions give every question an end, it starts no new trial, writes its final report, with the rig's final writer's research paper first, and closes with `every question is answered`; when its open questions all stop adding and nothing improved for a quarter of its running time, it ends the same way and closes with `research stopped adding: its open questions are saturated` ([When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends)). After `max_duration` of running time it writes its final report and closes with `the research window is over`, ended or not. Without an end and without `max_duration` it runs until you stop it: `min_duration` is a floor, never a stop. Time its agents could not work, stopped by the model provider, waiting for its rate limit or while the rig drained before an image update, does not count.

## Go on after a limit

Resuming doesn't help: the run is still over its limit, so it is paused again at once. No command changes a run's limits ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Start a new run instead. Its limits count from zero.

- **From the command line:** to change a limit, edit `budget` and raise the contract's `version`. Then assign a new run with `--seed-commit` and the old run's champion, so the new run starts where the old one stopped. The champion's attempt page shows its full commit under **Commit**.
- **On the dashboard:** **Start a run**, on the campaign's page, starts a new run with the same limits, counted from zero. It starts from the latest saved version's starting commit or, for a campaign started from the command line, with its newest assignment's contract and commit: not from the old champion. To change **Stop after (hours)**, fill in the **New campaign** page again with the same **Campaign name**: this saves a new version, and later runs use it. To go on from the old champion, [take the result](take-the-result.md), commit it on a branch of your project, and give that branch in **Start from** in the new version.

## Limits that are not budgets

- A Claude or ChatGPT subscription's usage window: when it is used up, the run's agents wait for it to reset, then go on.
- **One try lasts (minutes)** on the **New campaign** page ends one trial, and the next starts fresh. A command over an agent's memory or disk limit is stopped.

Neither ends a campaign. The [limits and pacing reference](../../reference/limits-and-pacing.md) lists them all.
