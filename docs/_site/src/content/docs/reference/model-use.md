---
title: "Model use and cost"
description: "Every part of the dashboard's model use and cost: the top of a run's page and its Stats tab, a campaign page's sidebar, the Metrics page, and Model prices in Settings › Providers."
type: reference
sidebar:
  order: 22
---

The dashboard shows what the agents' model calls used and cost in four places:

- **A run's page**: at the top, above its tabs, so on every tab, one line and two cards of the run's [model use](glossary.md), after a hill climb's champion card; its **Stats** tab has the calls and the table by agent and model.
- **A campaign's page**, in its sidebar: its model use, summed over all its runs on every rig, with each run.
- **Metrics**, in the main navigation after **Rigs** (address `/ui/metrics`): the whole system's, by model and by campaign, for today, the last 7 days or all.
- **Settings › Providers**, under the providers: **Model prices**, each model's price, which the cost uses.

Code counts every call where it is made, never an agent ([The model usage records](../explanation/how-it-fits-together.md#the-model-usage-records)). Control sums the records when a page is drawn. The REST route [`GET /v1/usage`](rest-api.md#model-usage) and the MCP tool [`model_usage`](mcp-tools.md#model_usage) give the same numbers. Every label and column with an **i** says what its number means when you hover it.

## The words

| Word | Where | What it means |
| --- | --- | --- |
| `not reported` | Any figure | The harness that ran the calls does not give that figure, so it is not counted. It is never shown as 0 |
| `on a plan` | Cost | The calls ran on a subscription: a Claude or ChatGPT provider, or Claude Code. Their tokens are counted, not priced |
| `no price` | Cost | No price is known for the model: its provider's list gives none and you set none. Never $0 |
| `free` | Cost | The model's price is 0 in every part: its provider's list's, or the one you set |
| `<$0.01` | Cost | Less than half a cent, but more than nothing |

A cost with an **i** before it leaves something out or adds something. Its **i** says what: the GPU time on RunPod in it, the tokens on a plan or with no price that are not in it, the free tokens, and the tokens in that were priced as not cached because their harness does not report the cache (Pi, for example, when the provider's answer does not name its cached tokens).

## The six numbers

**Metrics** starts with six tiles. A run's page gives four of them, shorter, in two cards: **Cost**, and **Tokens** with **Output speed**. Its calls are on its **Stats** tab, and its time in calls is in its line.

| Tile | What it shows |
| --- | --- |
| **Cost** | The dollars, split by a bar into tokens in (not cached), cached in, out, and **GPU time on RunPod**. Under it, the tokens with no dollars: `144k tokens on a plan · 350k no price · 3.3k free` |
| **Tokens in** | Every token sent to the models, split into `cached` (the provider read them from its cache), `not cached`, and `not reported by` the harnesses that do not say |
| **Tokens out** | Every token the models wrote, with the reasoning tokens under it where the provider counts them |
| **Calls** | The model calls. Records that do not say how many calls they cover (a Codex turn) count as none, and an **i** says how many there are. On Metrics, the line under it counts the runs and campaigns, such as `12 runs · 3 campaigns`. The bars under it count the calls in each hour of today, or on each day (each week, past 62 days), once there are two or more to draw: **Today** has none before 1 a.m. |
| **Output speed** | Tokens out a second over each call's whole time, from the request to the last token: the median, with `p10–p90` under it (8 of 10 calls are in this range) |
| **Time in calls** | All calls added together, from the request to the last token, with the median time to the first token under it |

## A run's page

At the top of the run's page, above its tabs, so on every tab, are one line and two cards. A hill climb has a third card first, its champion. A run with no agents and no pod spend on RunPod, such as a try of a kit, has none of them, and no **Stats** tab.

The line counts the run's trials and rounds, then gives its time and its time in calls: `48 trials · 16 rounds · 30 h 0 m · 6 h 34 m in calls`.

- The run's time is from its start to now, or to its end once it is finished. A paused run's time goes on.
- The time in calls adds all its calls together, from the request to the last token, so calls at the same time each count. Its **i** says how many records do not report their time, which are not in it. Where no record reports one, the line says `time in calls not reported`.
- A run that has made no model call yet ends the line with `no model call yet`, and has no cards but a hill climb's champion.

Under the line:

- **Champion #N**, on a hill climb: the champion's value of the main metric, with its unit, as the judge measured it when it confirmed the change (the cases' geometric mean), such as `14.6 tok/s`. Under it, its gain over the starting point, measured on this rig, and the starting point's value: `+88.0% over the start, 7.73 tok/s`. A champion whose verdict did not record its values (one judged by an older harness) shows an estimate from the starting point's value and the gain, marked `≈`: `≈14.5 tok/s`. Before any change is promoted, it shows the starting point's value and `the starting point: no change promoted yet`.
- **Cost**: the dollars and their split, as on Metrics, with the pod's spend while this run was at work on a RunPod rig. The tokens with no dollars are not under it: the **Stats** tab gives each agent's and model's cost, in dollars or in [words](#the-words).
- One card with **Tokens**, in and out together, such as `30.1M in · 995k out`, with the split of tokens in under it, as on Metrics; and **Output speed**. The reasoning tokens are on Metrics.

### The Stats tab

**Stats**, the last of the run's tabs (`?view=stats` in the address), has the details:

- **Calls**: the run's calls, how many calls the workers made in a trial (`28 a trial`), and the median time to the first token (`first token 1.8 s`). The bars beside it count the calls in each round, from `round 1` to the latest; a run with fewer than two rounds has no bars.
- **By agent and model**: one row for each agent's calls to each model.

A run that has made no model call yet says `No model call recorded yet. Code counts each call of the agents when it ends.` A run with no agents and no model use says `No model use: this run has no agents.`

**By agent and model** has its rows in groups, as [Edit rig](../how-to/models/model-per-agent.md) names the agents:

- **The work**: **Workers**, then the **Planner**.
- **The advisors**: **Teachers** (with `teacher 1` or `teacher 2` under it when the run has two teachers and the rig's settings say which model is which, and `merged by` for the model that merges their advice), the **Auditor**, the **Review panel**, the **Synthesizer** (with `answer cards` under it), whose calls write a research run's answer cards, and the **Final writer** (with `research paper` under it), whose calls write a research run's paper. The synthesizer and the final writer use their own models from **Edit rig**, or else the first teacher's; their calls are recorded under their own names (`synthesizer` and `final_writer`), not the teachers'.
- **The rig**: on a rig launched on RunPod, the row **GPU time on RunPod**: the pod's spend while this run was at work, with its time at the pod's price an hour, such as `5 h 36 m at $1.65/h`.

| Column | What it shows |
| --- | --- |
| **Agent** | The agent, and the line under it |
| **Model** | The model, with the harness that ran it and the provider that served it under it: `Pi · my-litellm` |
| **Calls** | Its calls |
| **In** | Its tokens in |
| **Cached** | Its tokens in that the provider read from its cache |
| **Not cached** | Its tokens in that the provider read again |
| **Out** | Its tokens out, with reasoning |
| **tok/s** | The median of its calls' output speed, with p10–p90 under it |
| **Cost** | Its tokens at the model's price, or one of [the words](#the-words) |
| **Share** | Its tokens in and out, as a part of the run's |

On a narrow screen the table keeps **Agent**, **In**, **Cached**, **Out**, **tok/s** and **Cost**, and shows the model under the agent.

## A campaign's page

The campaign's sidebar has its own **Model use**, over all its runs on every rig. Its line on the right counts the runs with records or pod spend.

- **Cost**: the dollars and their split, as on Metrics. The tokens with no dollars are on Metrics.
- **Tokens in**, with the part that was cached under it. Where a harness does not report the cache, the part is of the tokens that were reported, and an **i** says how many were not.
- **Tokens out**, with the reasoning tokens.
- **Calls**, with the time in calls under it.
- **Output speed**, with the median time to the first token.
- A table of its runs: **Run** (a link to the run's page, with `at work`, `paused`, `completed` or `finished` and its rig), **In**, **Out** and **Cost**. A run's cost includes its pod's spend on RunPod.
- **By model, on Metrics ›** opens Metrics.

A campaign whose runs have made no model call yet says `No model call recorded yet.`

## Metrics

**Metrics** shows the model use of every campaign and rig. The chips **Today**, **7 days** and **All** choose the period; **7 days** is the default. They are links, such as `/ui/metrics?period=today`.

- **Today** starts at midnight in your own time zone. The page's script adds your browser's zone to the address (`tz`, such as `tz=Europe/Paris`); without the script, today starts at midnight UTC. The line under the title says which zone the page uses: `every campaign and rig · times in Europe/Paris`.
- **7 days** is the 7 days up to now.
- **All** is every record.

With no call in the period, the page says `No model call in this period.`, or for **All** `No model call recorded yet. Code counts each call of the agents when it ends, on every rig.`

Under the six numbers:

- **By model**: one row for each provider's model, with its provider and every harness that ran it under it (`my-litellm · Pi, OpenCode v2`), its **Calls**, **In**, **Out**, **Cached** (the part of tokens in), **tok/s**, **Cost** and **Share**. When a RunPod pod spent in the period, the last row is **GPU time on RunPod**, with the pods' rigs. On Metrics it includes the time no run was at work, which no campaign counts.
- **By campaign**: one row for each campaign, with its mode, its **Runs**, then the same columns. A run that control has no campaign for is `no campaign`.

## Model prices

In **Settings › Providers**, under the providers, **Model prices** is one table of the models' prices, in US dollars for a million tokens. It has one row for each model of each provider, except subscriptions: a Claude or ChatGPT provider's calls are on its plan.

| Column | What it shows |
| --- | --- |
| **Model** | The model's id at its provider |
| **Provider** | The provider that serves it |
| **In** | Dollars for a million tokens in that the provider did not read from its cache |
| **Cached in** | Dollars for a million tokens in that the provider read from its cache. Empty: the **In** price |
| **Out** | Dollars for a million tokens out, with reasoning |
| **Price from** | Where the price comes from: `provider's list`, `yours`, `free` or `no price` |

On a narrow screen the provider shows under the model.

| Price from | Meaning |
| --- | --- |
| `provider's list` | The provider's model list gives the price. Control keeps it up to date with the list. Its prices show as text, not as fields, and can't be changed |
| `free` | The list gives a price of 0 |
| `yours` | You set it here, or with [`POST /v1/model-prices`](rest-api.md#model-usage) or [`set_model_price`](mcp-tools.md#set_model_price) |
| `no price` | Neither: the model's calls show `no price` |

A model with no listed price has three fields. **Save prices**, under the table, saves every row at once, and waits until a price changes. To set a price, fill in **In** and **Out**; to remove yours, empty all three. The line beside **Save prices** then says `Saved. Every cost follows.`: a price you set or change costs every call of the model, the earlier ones too. With no change it says `Nothing changed.` Each change is in the audit log as `model_price_set` or `model_price_cleared`, by `owner:ui`.

The line beside **Save prices** says why a row can't be saved, with the model and its provider: as you type it starts with `Not yet.`, and after you press **Save prices** with `Not saved.`, such as `Not saved. small-model of lab: set In and Out, or leave all three empty.` Rows without a problem are saved even then, and the line ends with how many, such as `The other 2 changes are saved.`

| Message | Why |
| --- | --- |
| `a price is a number, such as 0.60.` | A field holds something other than a number of US dollars |
| `set In and Out, or leave all three empty.` | Only one of **In** and **Out** is set, or **Cached in** without **In** |
