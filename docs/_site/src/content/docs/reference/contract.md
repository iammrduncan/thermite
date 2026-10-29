---
title: "Contract"
description: "Every field of a campaign contract in the three modes, with its type, default, allowed values and meaning."
type: reference
sidebar:
  order: 2
---

A **contract** is the JSON file that says what a [campaign](glossary.md) is for and how its results are judged: the project, the [kit](kit-manifest.md), the mode, its objective, goals or questions, and its limits. Agents cannot change it. Any change makes a new `version`.

This page lists every field. [Write a contract](../how-to/campaigns/write-a-contract.md) gives the steps, and [Campaign modes](../explanation/campaign-modes.md) says what each mode does.

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "matmul-speed",
  "version": 1,
  "title": "Speed up the matrix multiply",
  "mode": "hill_climb",
  "project": {
    "repo": "smoke-project",
    "kit": { "repo": "smoke-cpu", "commit": "4f0c2a9e8d7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/kernel/**"],
  "objective": {
    "primary": { "metric": "flops_per_s", "direction": "max", "min_effect": 0.05 }
  },
  "cells": ["small", "large"],
  "held_out_cells": ["held"]
}
```

Every field this example leaves out takes its default. The repository has one example for each mode in [`examples/contracts/`](https://github.com/iammrduncan/thermite/blob/main/examples/contracts).

## How a contract is checked

- **Unknown fields are refused** at every level, with `Unrecognized key: "<name>"`.
- **Errors** read `<field path>: <message>`. A rule about the contract as a whole has the path `(root)`, for example `(root): hill_climb campaigns need a target`.
- **The content hash** is the SHA-256 of the contract's canonical JSON, after defaults are filled in. Two files that differ only in key order or in a default written out have the same hash.
- **`thermite contract validate <file>`** checks a file on your computer. It prints `ok <mode> <campaign> v<version> sha256=<hash>`, or the errors, one per line, and exits with 1. For a hill climb or goal contract without `project.kit`, it also prints `warning: no project.kit: the judge cannot measure this campaign until the contract names a kit repository and commit`. See the [command line reference](command-line.md).
- **When a run is assigned**, the rig's harness checks the contract again, then [checks the kit against it](kit-manifest.md#the-kit-against-the-contract). The refusals are listed under [When a run is assigned](#when-a-run-is-assigned).

## Value types

| Type | What is allowed | Message when it is not |
| --- | --- | --- |
| id | Lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit; 1 to 64 characters | `lowercase id` |
| full commit id | 40 or 64 lowercase hexadecimal characters. Short ids are refused | `full git commit id (40 or 64 hex)` |
| sha256 | 64 lowercase hexadecimal characters | `sha256 hex` |
| duration | A number and a unit: `s`, `m`, `h` or `d`, such as `90s`, `30m`, `1.5h` or `7d` | `duration like "30m" or "8h"` |
| regular expression | A JavaScript regular expression that compiles | `invalid regular expression` |
| glob | A repository path pattern: `**` matches across folders, `*` within one folder name, `?` one character | none: any non-empty text |
| folder | A path from the top of a repository to a folder in it, its parts separated by `/`, such as `examples/matmul-cpu/project`. Letters, digits, `.`, `_`, `-`, `@` and `+`; no `/` at either end, and no part that starts with a dot, so `.`, `..` and `.git` are refused; at most 300 characters | `a folder in the repository, such as examples/matmul-cpu/project: its path from the top, with no / at either end and no part that starts with a dot` |
| kit cell, kit metric | The name of a cell or metric in the contract's kit. Checked when a run is assigned, not by the schema | see [the kit against the contract](kit-manifest.md#the-kit-against-the-contract) |

## Fields every mode has

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | `1` | required | The contract format |
| `campaign` | id | required | The campaign's name |
| `version` | integer ≥ 1 | required | The contract's version. Any change needs a new number: a rig refuses the same campaign and version with other content |
| `title` | text | required | A title for people. Workers' briefs, audits and research reports show it, and so do the dashboard's **Campaigns** page and the campaign's own page, as what the campaign is for |
| `mode` | `hill_climb`, `goal` or `research` | required | The kind of campaign. It decides which other fields the contract has |
| `project.repo` | text | required | The project's repository name on the rig. A run's starting commit is imported under this name, which must then be an id. The repository's address is not in the contract: it comes with the run's start (`thermite assign --seed`, or **Repository** on the **New campaign** page). Research contracts have no project, but still give a name, for example `research` |
| `project.commit` | full commit id | none | A starting commit. The harness does not read it; `thermite assign` uses it when you give no commit of your own |
| `project.folder` | folder | none: the whole repository | The project's folder, when the project is one folder of its repository. The rig fetches the repository's commit, and the run starts from that folder: from a commit whose files are the folder's own, with no parent. Every rig makes the same commit from the same repository commit and folder. Agents see only the folder's files, and `editable_paths`, the kit's commands and a champion's patch are relative to the folder. A commit without that folder is refused when the run is assigned: `commit <commit> has no folder <folder>`. Hill climb and goal campaigns use it; research campaigns ignore it |
| `project.kit.repo` | text | none | The kit's repository name on the rig. A kit is imported under this name, which must then be an id |
| `project.kit.commit` | full commit id | none | The kit commit the judge uses. Hill climb and goal campaigns need `project.kit`: without it the judge cannot measure |
| `target.type` | text | none | The kind of device the campaign measures on, such as `cpu` or `cuda-gpu`. Required in hill climb (`hill_climb campaigns need a target`). Control compares it with the rig's target when the dashboard starts a run: on the **New campaign** page, or with **Start a run** on the campaign's page. The harness compares the kit's own `target` with the rig |
| `target.class` | text | none | A name for the device class, such as `generic-cpu`. Required with `target.type`. Accepted, not used yet |
| `models` | list of `{name, sha256}` | `[]` | [Model files](glossary.md) the campaign uses: data files the project loads that are not in its repository, such as a model's weights. Not the agents' AI model. Each must be on the rig, or imported by the command that starts the run. The kit reaches one as `{models:<sha256>}`, and agents are told where they are |
| `lanes` | object | `{"count": 2, "trials_per_epoch": 3}` | How the work is split. See [Lanes](#lanes) |
| `budget` | object | `{"max_open_attempts": 4}` | Optional budgets and back-pressure. See [Budget](#budget) |
| `min_duration` | duration | none | Research: required. The time the run has to collect sources and claims: a floor, never a stop. After it, at each digest, the review panel is asked about the questions and hypotheses with no decision that stands, and a review that gives every question an end ends the run, as the progress rule does ([Research](#research)). Other modes: accepted, not used yet |
| `max_duration` | duration | none | Research: when the run ends at the latest, its questions answered or not. It may not be shorter than `min_duration`. Without it, a research run whose questions the review panel never finds answered runs until someone closes it. Other modes: accepted, not used yet |
| `search_policy` | object | none | Accepted, and read by nothing: Thermite has no web search of its own. See [Search policy](#search-policy) |
| `notes` | text | none | The campaign's additional information, from its author, in Markdown, with no length limit. See [The campaign's brief](#the-campaigns-brief) |
| `hypotheses` | list of text, each not empty | none | What the campaign's author thinks is true, one entry each. See [The campaign's brief](#the-campaigns-brief) |
| `agents_context` | object | none: each agent keeps the rig's settings | The campaign's own context window and compaction point for all its runs' agents. See [Agents' context](#agents-context) |
| `role_additions` | object: a role's id and its text | none: each role has its own text only | Your own words added to a role's instructions for this campaign's runs. See [Your additions to the agents' roles](#your-additions-to-the-agents-roles) |
| `kb_writes` | object: a role and its kinds | none: [the default](knowledge-base.md#who-writes-what) | Which kinds of item each role may write in its own slot of the campaign's collection in Thermite's knowledge base: `planner`, `worker`, `teacher`, `merged-by`, `auditor`, `review-panel`, `synthesizer`, `final-writer`, each a list of `note`, `decision`, `surprise`, `journal`, `finding`, `review`, `doc`, `reference`, `report`, `paper`, each once. A role left out, or given `[]`, writes nothing. See [Who writes what](knowledge-base.md#who-writes-what) |

### Agents' context

The rig sets each agent's context window and compaction point with its model ([Give each agent its own model](../how-to/models/model-per-agent.md)). A campaign may set its own for all its runs: the workers, the planner and the advisors.

```json title="contract.json (part)"
{ "agents_context": { "context_window": 131072, "compact_at": 70 } }
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agents_context.context_window` | integer, 4,096 to 100,000,000 | none | The most tokens of [context window](glossary.md) each agent works with. Each agent's window is the lower of this and its own: its provider's window, or the rig's cap on it. With an agent whose window Thermite does not know, this one |
| `agents_context.compact_at` | integer, 50 to 95 | none | The share of the window, in percent, at which each agent's conversation is [compacted](limits-and-pacing.md#compaction), in place of the rig's point |

Both are optional and have no default, so a contract without them keeps its hash. A change is a new version: a run keeps the settings it started with. Control refuses to start a run of a campaign whose window is above what a provider lists for one of the rig's agents' models; **Agents' context** on the campaign's page, [`POST /v1/campaigns/<campaign>/context`](rest-api.md#a-campaigns-context-settings), MCP's `set_campaign_context` and `thermite campaign context` save a new version with them; **New campaign** (step 5) and the **Copy** panel set them on a new campaign; and **Start a run** and its answer say what applies to each agent ([Set the agents' context](../how-to/campaigns/start-from-dashboard.md#set-the-agents-context)). A rig whose harness is older than this field refuses a contract that has it.

### Your additions to the agents' roles

A role's instructions are Thermite's code ([Agent roles](agent-roles.md)). A campaign can add text of its own to a role, with no change to that code: one entry for each role, by the role's id.

```json title="contract.json (part)"
{ "role_additions": { "worker": "Keep each change small enough to read in one sitting.", "planner": "Give each lane a different direction while the queue allows it." } }
```

| Mode | The roles an addition may name |
| --- | --- |
| `hill_climb`, `goal` | `worker`, `planner`, `teacher`, `merged-by`, `auditor`, `reviewer` |
| `research` | `research-worker`, `research-planner`, `research-teacher`, `research-merged-by`, `research-reviewer`, `synthesizer`, `final-writer` |

Each text is from 1 to 20,000 characters. A role the mode never runs is refused: `role_additions: a hill climb campaign runs no research-worker: its roles are worker, planner, teacher, merged-by, auditor, reviewer`. The model check and compaction take none.

Every prompt of the role carries its addition as a section of its own, after the role's own text, labelled as yours with the contract's version: `# The campaign owner's addition (contract version 3)`, then a line that says it adds to the role's instructions and replaces none of them, which come first where the two differ. The prompt's record shows the section's source as `owner's addition` ([What a run's agents were sent](agent-roles.md#what-a-runs-agents-were-sent)). An addition never decides a measurement, a verdict or a promotion: code does.

The field is optional and has no default, so a contract without it keeps its hash. It is part of the contract, so the [signed](signed-commands.md) `assign_campaign` command carries it, and a change is a new version: a run keeps the additions it started with, and a copy takes its source's. **New campaign**, the campaign's page (**Your additions to the agents' roles**), [`POST /v1/campaigns/<campaign>/additions`](rest-api.md#the-owners-additions-to-a-campaigns-roles), MCP's [`set_campaign_additions`](mcp-tools.md#set_campaign_additions) and [`thermite campaign additions`](command-line.md#campaign-additions) set them. An assignment from the operator's or an agent's token carries the additions of the campaign's saved version, as the owner saved them, and no others ([`issue_command`](mcp-tools.md#command-kinds-for-each-role)). A rig whose harness is older than this field refuses a contract that has it.

### The campaign's brief

The brief is what the campaign's author tells the agents beyond the objective: step **2 The brief** on the **New campaign** page. The agents weigh it as starting points, not rules: the objective, the judge and the owner's messages decide.

```json title="contract.json (part)"
{
  "notes": "## Background\nThe kernel is `src/kernel/work.c`. It runs at batch size 1.\n\n## What was tried\n- Shared-memory tiling: no gain.",
  "links": ["https://git.example.com/team/project/issues/12"],
  "ideas": ["Fuse the dequantize step into the inner loop.", "Load 128-bit vectors."],
  "hypotheses": ["The kernel is memory bound at batch size 1."]
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `notes` | text | none | The additional information, in Markdown: the project and its links, what was tried, limits, and what good looks like. No length limit of its own |
| `links` | list of URLs | none | Hill climb and goal only: starting links, pages the agents get with the brief. Nothing fetches them up front; a worker fetches one when it needs it. A research campaign's starting links are its [`seeds`](#research) |
| `ideas` | list of text, each not empty | none | Hill climb and goal only: ideas to try, one entry each. The planner turns those that fit into experiments. A research contract with it is refused: `Unrecognized key: "ideas"` |
| `hypotheses` | list of text, each not empty | none | What the author thinks is true, one entry each, for the agents to test. A research run starts with them as its own hypotheses |

All four are optional and have no default, so a contract without them keeps its hash. An entry may have several lines. The whole contract goes to a rig in one signed command, which control refuses above 3.5 MiB: `the assign_campaign command is too large to deliver`. A rig whose harness is older than `links`, `ideas` and `hypotheses` refuses a contract that has them.

What each agent gets, and whether it gets the whole text:

| Who | Where | Whole or cut |
| --- | --- | --- |
| The planner | `campaign_brief` in its context: `additional_information`, `starting_links`, `ideas_to_try` and `hypotheses` | Whole |
| Each worker of a hill climb or goal | The section "The campaign's brief" in its trial brief | Whole up to 32,000 characters. A longer brief is cut there, with a line that says so and where the whole text is: `BRIEF.md` in the run's folder |
| Each research worker | The same section in its research brief, after the questions and their answer cards | As for a worker |
| The teachers, the auditor and the review panel | `campaign_brief` in their brief or package, before the evidence and the diff | Whole. Only the package's own cut can reach it: a package is cut at its end, to fit the advisor's window and to at most 120,000 characters for the teachers' brief or 200,000 for a package ([Compaction](limits-and-pacing.md#compaction)), so the cut takes the evidence and the diff before the brief |
| A research run's final writer | `campaign_brief` at the end of its paper package, after the questions, verdicts, figures and rules | Whole, unless the package is cut to fit the writer's window or 200,000 characters: the cut is at the package's end, so it takes the brief first |
| The run's folder | `BRIEF.md`, for every mode | Whole |

A research run starts with the contract's `hypotheses` as its first hypotheses, the author's: each one is a `hypothesis_added` event with no lane, no supporting claim and the status `author`. They and promoted ones are the ones the review panel gives a verdict; the workers' own go to the run's pool ([Hypotheses](../explanation/campaign-modes.md#research)), and only the brief changes the author's. The run's folder lists them under `hypotheses/`, and the campaign's collection in [Thermite's knowledge base](knowledge-base.md) keeps them. **Copy** keeps the brief; a copy over REST, MCP or the command line may give its own ([Copy a campaign](rest-api.md#copy-a-campaign)). The campaign's page shows it under **The brief**.

### Lanes

A [lane](glossary.md) is one worker's line of search. An epoch is one round of planning: the planner gives each lane an experiment from the run's [experiment queue](glossary.md), and each lane then runs its trials one after another, each later one on the next queued experiment. The dashboard calls an epoch a **round**.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `lanes.count` | integer, 1–16 | required when `lanes` is given; 2 when `lanes` is left out | Lanes planned in each epoch. A `lane_count` [directive](advisors-file.md#what-each-role-must-answer) can lower it. A rig has users for lanes 1 to 16 only, so more is refused. How many trials run at the same time is the rig's own setting, **Workers at a time**, which is 1 unless it is changed: see [Settings](settings.md#the-rigs-settings) |
| `lanes.trials_per_epoch` | integer ≥ 1 | 3 | Trials each lane runs in one epoch, at most. The epoch ends once every free lane has run them: a lane still on a long trial doesn't hold it, and joins the next epoch when its trial ends |
| `lanes.limits` | object | none | What each lane may use. Every field is optional, and the defaults below apply to what is left out |
| `lanes.queue_target` | integer, 0–1000 | none: 2 for each lane | **Ideas kept ready**: the experiments the run's queue keeps ready for the lanes' later trials in a round, counted after each round's hand-out. A target that drives ideas, never a cap: below it, the planner is asked to top the queue up, the lanes' distinct ideas go up next, and the teachers are asked for ideas at once. `0` asks for none. The lanes it counts are the round's, so a `lane_count` directive lowers the default too. Hill climb and goal only: a research run's research plan fills its queue. See [Keeping the queue at its target](../explanation/agents-lanes-planner.md#keeping-the-queue-at-its-target) |

| `lanes.keep_working` | boolean | none: `false` | **Keep working while the judge works** (hill climb and goal): a lane's next trial starts as soon as its last one ends, and a round ends without waiting for verdicts, while the judge works through their changes, at most `budget.max_open_attempts` of them. Off, a lane waits for the judge's verdict on its last change, and a round for its lanes' verdicts. A run's `keep_working` rule turns it on or off while it runs ([Steer a run](../how-to/campaigns/steer-a-run.md#steer-from-the-command-line)) |

A contract without `lanes.queue_target` or `lanes.keep_working` keeps its hash: these fields have no default in the contract itself.

`lanes.limits`:

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `run_timeout_s` | 10–7200 | none | Time limit, in seconds, for one command a worker runs. Without it, a command runs until it ends or the trial ends. On a trial with a length, a Pi worker's command also stops 3 minutes before the trial's end ([Lanes and agents](limits-and-pacing.md#lanes-and-agents)) |
| `run_rss_mib` | 256–16384 | 2048 | Memory, in MiB, for everything a lane runs at once, OpenCode, Claude Code or Codex included when the lane uses one |
| `workspace_mib` | 256–65536 | 2048 | Disk, in MiB, for the trial's workspace, build trees included. Each development run gets the same amount |
| `dev_run_timeout_s` | 10–3600 | none on a development device of its own; 300 on a device the judge shares | Time limit, in seconds, for one development run. On a trial with a length, a Pi worker's development run also stops 3 minutes before the trial's end |
| `dev_run_rss_mib` | 256–16384 | 4096 | Memory, in MiB, for one development run |
| `trial_minutes` | 1–1440 | the rig's trial length, which is none unless someone sets it | One trial's length, in minutes. The worker's brief gives the time it ends, in UTC. Without one, a trial lasts until its worker submits, or stops and answers a nudge without any work. A `trial_minutes` rule on a run comes before it ([Steer a run](../how-to/campaigns/steer-a-run.md#steer-from-the-command-line)) |
| `failures_in_a_row` | 1–10000 | none | A trial ends after this many failed model calls in a row: a provider's 5xx, a broken connection, a stream that went silent, or a request it refused. A rate limit's waits never count. Without it, the worker waits a growing pause after each failure and goes on. Once no model call has worked for 30 minutes, the trial ends and the run's agents stop until a model check passes ([Limits and pacing](limits-and-pacing.md#the-model-provider)) |
| `cutoffs_in_a_row` | 1–10000 | none | A trial ends after this many replies in a row cut off at the output limit without a tool call (Pi). Without it, the worker is told to think less and goes on |
| `nudges` | 0–10000 | none | How many times a worker that stops without submitting is told to go on; then its trial ends. `0`: never. Without it, it is told for as long as it keeps working, and a nudge it answers without any work ends the trial |
| `notes_per_turn` | 1–10000 | none | The field notes a Pi worker records from one model reply. A note past it is not recorded, and its answer says so: `not recorded: this campaign keeps at most 20 notes from one reply.` The trial goes on, and the next reply counts from 0. Without it, every note is recorded. The notes of OpenCode, Claude Code and Codex are not counted: the harness doesn't see where their replies end |
| `processes` | 64–65536 | 256 | Processes and threads that each of a lane's users may have at once: the user of its commands (with OpenCode, Claude Code or Codex when the lane uses one), of its development runs, and of its Pi worker. At the limit, starting one more fails (`Resource temporarily unavailable`); nothing is stopped. Raise it for builds or tests that start many threads |

A limit ends one command or one trial, never the campaign. [Limits and pacing](limits-and-pacing.md) lists every limit Thermite has.

### Budget

No budget is set unless you set one, and without one a run keeps going. A spent budget **pauses** the run once its running trials have ended: the run's status becomes paused, with the reason shown, and the judge's queued jobs for it wait too. [Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md) gives the steps.

| Field | Type | Default | Meaning | Reason shown |
| --- | --- | --- | --- | --- |
| `budget.wall_hours` | number > 0 | none | Hours since the run was created, paused time included. It also shapes the search: every lane starts again from the champion at a third and two thirds of it (every 20 epochs without it) | `the wall-time budget is spent` |
| `budget.device_hours` | number > 0 | none | Hours the judge's finished jobs for this run have taken | `the device-hours budget is spent` |
| `budget.llm_usd` | number ≥ 0 | none | US dollars of model tokens the run's trials have used. Counted only when the rig sets both `THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT` (prices per million tokens); without them, it has no effect | `the model budget is spent ($<amount>)` |
| `budget.max_open_attempts` | integer ≥ 1 | 4 | Back-pressure, not a budget: no new trial starts while this many of the run's attempts wait for the judge (queued, building, screening, confirming, verifying, waiting for an audit or for approval) | none: lanes wait |

### Search policy

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `search_policy.allowed_purposes` | list of text | `[]` | What public search may be used for. Accepted, not used |
| `search_policy.blocked_patterns` | list of regular expressions | `[]` | Accepted, not used: Thermite has no web search of its own, and a research worker has no search tool. Web search comes from an MCP server the campaign names |

## Hill climb and goal: what a candidate may change

A **candidate** is a change an agent submits. These two fields are checked before anything is built, in the judge's first gate (V0).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `editable_paths` | list of globs, at least one | required | Paths a candidate may change. A change to any other path is refused with `path not editable: <path>`. Binary files, symbolic links and submodules are always refused. When a worker submits, only these paths are taken |
| `forbidden_patterns` | list of regular expressions | `[]` | An added line that matches one (case matters) is refused with `forbidden pattern <pattern>: <line>` |

## Hill climb

`"mode": "hill_climb"`: improve one metric, step by step, while guards hold. The judge first measures the run's starting point alone, its **baseline** ([below](#the-baseline)). Each candidate is then **screened** against the **champion** (the run's current best) in interleaved **blocks**: one or more timed runs of each **arm** (candidate and champion) on each **cell** (one measured input from the kit). A win is then **confirmed** on fresh blocks before it is promoted. [Verdicts and states](verdicts.md) lists the verdicts.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `objective.primary.metric` | kit metric | required | The metric to improve |
| `objective.primary.direction` | `max` or `min` | required | Which way is better |
| `objective.primary.min_effect` | number > 0 | required | The smallest gain that counts, as a fraction: `0.05` is 5%. A gain that is clearly above zero, but whose whole interval is below this, is `neutral` ("gain below min_effect") |
| `objective.policy` | `single` or `lexicographic` | `single` | Accepted, not used yet |
| `objective.secondary` | list of `{metric, direction}` | `[]` | Accepted, not used yet. Each metric is checked against the kit when a run is assigned, but the judge does not use it |
| `guards` | list of guards (below) | `[]` | Metrics that may not get worse beyond set fractions |
| `hard_constraints` | list of constraints (below) | `[]` | Absolute bounds on a metric |
| `monitor_only` | list of metric names | `[]` | Accepted, not used yet. Not checked against the kit either |
| `cells` | list of kit cells, at least one | required | The cells (test cases; the dashboard calls them **cases**) measured in every block |
| `held_out_cells` | list of kit cells | `[]` | Cells measured only at confirmation, never one of `cells`. A candidate must be correct on each, and its primary metric no worse than twice `acceptance.equivalence_band`, on the median of three runs. When one fails, the agents learn only its kind, such as `confirmation failed: a held-out check timed out`, and the owner sees which cell, and its ratio against the threshold ([Held-out failures](verdicts.md#held-out-failures)) |
| `acceptance` | object | all defaults below | How the judge decides |

A guard:

| Field | Type | Meaning |
| --- | --- | --- |
| `metric` | kit metric | The guarded metric |
| `direction` | `max` or `min` | Which way is better for it |
| `max_step_regression` | number ≥ 0 | How much worse, as a fraction, it may get in one promotion. A guard that is clearly worse makes the verdict `tradeoff`; one that is not yet clear keeps screening going |
| `max_total_regression` | number ≥ 0 | How much worse it may get against the run's starting point, checked two ways at confirmation: the sum of the step estimates of the promotions since the starting point, with this step's (`cumulative guard allowance spent: <metric>`), and the candidate's measured values against the [baseline](#the-baseline)'s (`the guard's total allowance against the starting point is spent: <metric> <change> against the starting point (allowed -<allowance>, and its noise <noise>)`). Either one spent makes the confirmation a `tradeoff` |

A hard constraint is one of:

| Form | Meaning |
| --- | --- |
| `{"kind": "min", "metric": "<m>", "value": <number>}` | The candidate's mean of `<m>` on each cell must be at least `value`, or the verdict is `infeasible` |
| `{"kind": "max", "metric": "<m>", "value": <number>}` | The mean must be at most `value`, or the verdict is `infeasible` |
| `{"kind": "check", "check": "<name>"}` | Refused when the contract is checked, with `hard_constraints.<i>` and the reason: the kit's own checks run on every candidate anyway. Bound a metric with `min` or `max` instead. A contract stored before v0.1.1 that has one keeps it, and nothing checks it |

`acceptance`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `acceptance.alpha_screen` | number between 0 and 1 | 0.1 | Error rate for screening, split evenly across the looks |
| `acceptance.alpha_confirm` | number between 0 and 1 | 0.05 | Error rate for confirmation |
| `acceptance.equivalence_band` | number > 0 | 0.005 | A difference whose whole interval is within ± this fraction is `neutral` ("equivalent") |
| `acceptance.looks` | list of integers ≥ 1, at least one | `[3, 6, 9]` | Block counts at which screening may decide. The largest is the most blocks screening runs |
| `acceptance.confirm_blocks` | integer ≥ 1 | 5 | Fresh blocks for confirmation |
| `acceptance.runs_per_cell` | integer, 1–9 | 1 | Runs of each arm on each cell in one block. The block uses their median. The [baseline](#the-baseline)'s blocks use it too. For a kit described on the **New campaign** page, its **Runs per case** sets it, 3 unless changed |
| `acceptance.audit.ratio_to_median` | number > 0 | 3 | A confirmed gain more than this many times the median of the run's earlier confirmed gains waits for an audit. It applies once there are three earlier gains |
| `acceptance.audit.absolute` | number > 0 | 0.15 | A confirmed gain above this fraction goes to an audit first ([Audits](../how-to/campaigns/decide-what-waits.md#audits)) |

[Decide what waits for you](../how-to/campaigns/decide-what-waits.md) covers audits and approvals.

### The baseline

A hill climb's first judge job, `baseline`, measures the run's starting point: champion #1, the seed. It needs no field of its own.

| What | How |
| --- | --- |
| When | Before anything else of the run. The judge leases no other job of the run (`evaluate`, `confirm`, `calibrate`) until the baseline exists, and the planner plans no round and no trial starts: **Live** says `round <n> waits for the judge's baseline of the starting point (champion #<n>)`. The A/A calibration comes after it. A run an older harness started gets its baseline as soon as this harness runs it: at once if it is running, when it is resumed if it is paused |
| What runs | The starting point's build, alone, in 3 blocks over every cell in `cells` (never `held_out_cells`), each block running each cell `acceptance.runs_per_cell` times. Each block's value is the median of its runs, as for a candidate |
| What is kept | For each cell and each kit metric (the primary metric, every guard and the rest), the median of the blocks' values, their median absolute deviation (`mad`) and their count, in the judge's `baseline` event: `{run, job, champion_seq, commit, attempt, blocks, runs_per_cell, primary, guards, units, cells, files, bytes, summary}`, where `cells` is cell → metric → `{median, mad, n}`. Each value is also a measurement of the arm `baseline` |
| The kit's files | During the baseline, the kit's check gets `THERMITE_BASELINE_DIR`, a folder only the judge can reach, to write to; every later check of the run reads the same folder and cannot change it. At most 64 MiB and 1,000 files. Each file's path, size and SHA-256 are in `files` ([The check's baseline folder](kit-manifest.md#the-checks-baseline-folder)) |
| The guards | Each guard's `max_total_regression` holds against these values at every confirmation (below) |
| It fails | When the starting point does not build, a cell crashes or is stopped at a kit limit, the kit's check fails, a value is impossible, or the check's folder is over its limit: whatever would make a candidate `invalid` or `crash_candidate`. The judge records `baseline_failed`, `{run, job, champion_seq, commit, reasons, summary}`, and the run is in **setup** (below). A failure of the rig itself, such as a device that is never ready, is not the starting point's: the judge tries again at once, and after a second such failure 10 minutes after each, and the run waits |
| Where it shows | The run's **Overview** has the block **Where the run started**: each measured case, at most 40, with the main metric and each guard, as the median of the blocks and, after `±`, their median absolute deviation as a share of it; under the table, the champion and its commit, the blocks and runs, the files the check kept and, once the A/A calibration has run, the rig's noise. Until the judge has measured it, the block reads `waiting for the judge`, and the line at the top of the **Overview** says `The judge measures the starting point on every case first: no round or trial starts until it has.` In setup, the block reads `the run is in setup`, with the judge's reasons, and the line says `The judge could not measure the starting point (champion #<n>): the run is in setup, …`. **History** says `The judge measured the starting point, champion #<n>, on every case: <summary>. Every change is held against these values.`, or `The judge could not measure the starting point, champion #<n>: <reason>. The run is in setup: …`. [`get_run`](mcp-tools.md#get_run) has `baseline`, `setup` and `baseline_waiting` |

**Setup.** While the starting point can't be measured, each round of the run is a setup round, planned without the planner: each lane gets one experiment in the direction `setup`, at the top of the queue, and one trial. Its brief gives the judge's reasons and asks for a change within the editable paths, never the kit, that makes the project build and run every cell. Each change submitted while the run is in setup, by a lane or a person, is judged by a `baseline` job of its own instead of being screened:

- if the judge can measure it, it becomes the run's starting point: a new champion whose `champion_promoted` event has `setup: true`, its verdict `starting_point`, and its values the run's baseline (`attempt` names it). The gain over the starting point counts from it, and the guards' totals too;
- if not, its verdict is `invalid` or `crash_candidate`, with reasons that begin `the judge could not measure this setup change, so the run is still in setup:`, and the lane goes on.

A change still waiting when another setup change became the starting point is screened against the champion, as any change is. Setup experiments left in the queue then are dropped. Pausing and resuming a run in setup has the judge measure its starting point once more, for when the cause was the rig's.

**A guard against the baseline.** At confirmation, for each guard, the judge takes on each cell the median of the candidate's values in the confirmation's blocks and compares it with the baseline's median, as a log ratio in the guard's direction, and averages over the cells, as a block's effect does. The starting point's own spread on the same cells, the mean of log(1 + `mad` / median), is its noise, which never counts against a change. The allowance is spent when the candidate is worse than the starting point by more than `max_total_regression` and that noise together. These values are compared across time, so a rig whose own speed changes during a run reads that change as the candidate's; the step guard (`max_step_regression`) is measured against the champion in the same blocks, so it is not affected. Each guard in the verdict's record has `vs_start`: `{estimate, noise, spent}`.

## Goal

`"mode": "goal"`: meet a list of goals, each checked by the judge or, for subjective goals, by a review panel (and by the owner, when the run asks).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `goals` | list of goals (below), at least one | required | The goals. Each `id` must be unique |
| `success.policy` | `all_required` or `k_of_n` | `all_required` | When the campaign is complete. `all_required`: every goal with `required: true` is met, and at least one goal must be required. `k_of_n`: at least `k` goals are met |
| `success.k` | integer ≥ 1 | none | For `k_of_n`: how many goals must be met, at most the number of goals |
| `deliverable` | text | required | What a verified solution is: a commit, an artifact or a report. The review panel gets it |
| `insufficient` | list of text | `[]` | Outcomes that must never count as success. The auditor and the review panel get the list; code does not check it |
| `adversarial_checklist` | list of text | `[]` | Failure modes to audit for. When the list is not empty, every promotion waits for an audit, and the auditor gets the list |
| `infeasibility.allowed` | boolean | `false` | Whether the harness may propose that the goals are not possible. The proposal closes the run, unless the run asks the owner (`ask_owner.not_possible`), who then accepts or rejects it |
| `infeasibility.min_refuted_approaches` | integer ≥ 1 | none | Required when `allowed` is `true`. The proposal comes only after this many approach families each had 3 or more judged attempts and no progress |
| `independence_epochs` | integer ≥ 0 | 2 | Accepted, not used yet |
| `min_live_families` | integer ≥ 1 | 2 | Accepted, not used yet |
| `threshold_reps` | integer, 2–20 | 5 | Runs on each cell when a `metric_threshold` goal is checked |
| `held_out_cells` | list of kit cells | `[]` | Cells measured only at confirmation: for the goals a candidate newly meets, and, before the run closes, for every goal the champion meets. A verifier whose cells are all held out never shows as met in the goal report. A threshold goal whose `cells` mix measured and held-out cells is screened on the measured ones. When a held-out cell fails, the agents learn only its kind ([Held-out failures](verdicts.md#held-out-failures)) |

Each goal:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | id | required | Unique among the goals |
| `description` | text | required | What the goal means. Workers, the planner and the goal report show it |
| `priority` | integer ≥ 1 | 1 | Accepted, not used yet: it is stored with the goal. The order goals are checked in comes from the kit verifier's `priority` |
| `required` | boolean | `true` | Whether `all_required` needs this goal |
| `parent` | id of another goal | none | Accepted, not used yet: it is stored with the goal. It must name a goal in the list |
| `verify` | one of the three forms below | required | How the goal is checked |

`verify` is one of:

| Form | Meaning |
| --- | --- |
| `{"type": "code", "verifier": "<name>"}` | A verifier in the kit: the goal is met when the kit's check passes on every run of the verifier's cells. A verifier can require others to pass first. See [the kit's verifiers](kit-manifest.md#verifiers) |
| `{"type": "metric_threshold", "metric": "<m>", "op": ">=", "value": <number>, "cells": ["<cell>"]}` | `<m>` must be a metric in the kit. On each cell, the judge runs the build `threshold_reps` times and works out a 95% interval of the mean. The goal is met when every cell's whole interval passes, unmet when any cell's whole interval fails, and `inconclusive` otherwise. `op` is `>=`, `<=`, `>` or `<`. Without `cells`, every cell of the kit that is not held out is used |
| `{"type": "review", "criteria": ["<criterion>", ...]}` | A subjective goal, with at least one criterion. The review panel, models that do not see who made the change, reviews each new champion, and the goal is met when the review panel passes it, or, when the run asks the owner about reviews, when the owner accepts it |

A goal campaign ends when the success policy is met on two validations of the champion, or when a "not possible" proposal is taken: at once, or, when the run asks, once the owner accepts it. Its budgets pause it, as in every mode; `min_duration` and `max_duration` have no effect.

## Research

`"mode": "research"`: collect sources, verified claims and findings on a topic until its questions are answered. Research contracts have no `editable_paths` or cells, and use no kit. They need `min_duration`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `topic` | text | required | What to research. Briefs and reports show it |
| `questions` | list of text, at least one | required | The questions. Each may be long and have several lines. Claims, hypotheses and research tasks name the question by its place in this list, its index, from 0, and the plan works on the least-covered questions first. What people read counts from 1: a worker's brief, `INDEX.md`, `REPORT.md` and a task's title show both, `Question 1 (index 0)`; the paper and the dashboard show `Question 1`. Every research worker's brief has them whole |
| `seeds` | list of URLs | `[]` | The starting links: **Starting links** in the brief on the **New campaign** page. The harness fetches and archives them when the run starts, one after another, beside the first trials; Live says `starting links: <n> of <m> archived`, with the reason for each it could not. Every research worker's brief lists them under "Starting links". With no web search, workers follow links from these |
| `rubrics` | list of strings, one per question | none | What an answer to each question must cover, in the order of `questions`. The review panel judges each question's answer card against its rubric. A list whose length is not the number of questions is refused. Without it, a question's rubric is the question itself. Left out of a contract, it is not added, so a contract written before it keeps its hash |
| `min_verified_claims` | integer ≥ 1 | none | A floor: the run must have at least this many verified claims, in all, before the review panel is first asked about its questions. It only delays the check; it never ends a run. **Verified claims before the check** on the **New campaign** page. Without it, the check needs only an answer card for each question. Left out of a contract, it is not added, so a contract written before it keeps its hash |
| `mcp_servers` | list | none | The MCP servers the campaign's agents use, as a kit's [`mcp_servers`](kit-manifest.md#mcp-servers) names them: a research campaign has no kit. The **New campaign** page writes it from **Time and tools** › **MCP servers for the agents**. Control refuses to start a run that names a server **Settings** lacks |
| `scope.include_domains` | list of domain names, in lowercase | `[]` | When not empty, only these domains and their subdomains are fetched. Others are refused with `outside the campaign's domains: <host>` |
| `scope.exclude_domains` | list of domain names, in lowercase | `[]` | These domains and their subdomains are never fetched: `excluded domain <host>` |
| `scope.source_types` | list of text | `[]` | Accepted, not used yet |
| `scope.languages` | list of text | `[]` | Accepted, not used yet |
| `report_cadence.digest_minutes` | integer ≥ 1 | 60 | Minutes between digests. After `min_duration`, the review panel is asked, and the progress rule is checked, at a digest |
| `report_cadence.report_hours` | number > 0 | 24 | Accepted, not used yet. A research run writes digests and one final report |
| `quality.verbatim_quotes` | `true` | `true` | Always on: a claim counts only when every quote is found word for word in its archived source |
| `quality.min_independent_sources` | integer ≥ 1 | 2 | Different registrable domains a verified claim's quotes must come from to be listed as independently sourced: `docs.example.com` and `blog.example.com` count as one, `example.com`. The report lists those claims apart from the rest, and says for each finding how many of its claims are |
| `fetch_policy.respect_robots` | boolean | `true` | Whether fetches obey each site's `robots.txt` |
| `fetch_policy.per_domain_per_minute` | integer ≥ 1 | 6 | Fetches per domain per minute. Further fetches wait; they are not refused |
| `fetch_policy.max_bytes` | integer ≥ 1 | 5000000 | The largest response fetched, in bytes. A larger one is refused: `larger than <n> bytes`. Asked for again in the same run, it is refused at once, with no new download |
| `fetch_policy.allow_logins` | `false` | `false` | Always off |

A research run ends when every question has an end. After `min_duration`, at a digest, the harness asks the rig's review panel when every question has an answer card, the run has `min_verified_claims` verified claims if the contract sets it, no review of the run waits, and some question or required hypothesis (the author's and promoted ones) has no decision that stands, or a required hypothesis has only an `undecided` with no claim for or against it. Each reviewer decides each such item; code checks every answer's cited claims and numbers; each item is decided by the majority of the answers that pass, with the dissent kept; and a question's decision stands until its answer card changes. The review passes when every question then has an end, `answered` (at a certainty, judged against its `rubrics` entry) or `insufficient` (the best that sources allow), and every required hypothesis a decision: `supported`, `refuted`, or `undecided` with claims behind it. An `undecided` with no claim for or against it gets a task of the plan's to find some. A pass is taken at once, or when the owner accepts it if the run asks about reviews (`ask_owner.reviews`). Then no new trial starts, and the rig's final writer writes the run's [research paper](../explanation/campaign-modes.md#the-research-paper). Once code accepts the paper and the running trials end (on a rig with no final writer, once the trials end), the run writes its final report, the paper first, then the review panel's decisions, and closes with the reason `every question is answered`. While questions stay open, the run goes on. When its open questions are all saturated and no item improved for a quarter of its running time (and of its minimum), the progress rule ends it the same way, with the reason `research stopped adding: its open questions are saturated`. [When a research run ends](../explanation/campaign-modes.md#when-a-research-run-ends) has the whole check. A research run also closes when its running time reaches `max_duration`, ended or not, and then writes its final report. Without an end or `max_duration` it runs until someone closes it: `min_duration` is a floor, never a stop. Time while the run is paused does not count, and neither does time its agents could not run: while they were stopped by the provider (no credits, a refused key, no model call that worked for 30 minutes, a failing model check) or waited for its rate limit ([Limits and pacing](limits-and-pacing.md#the-model-provider)), or while its rig drained before an image update, when no trial or plan could start ([A rig on a cluster](../how-to/operate/rig-lifecycle.md#a-rig-on-a-cluster)). A finding needs no contract field: code accepts one when every claim it cites is verified and every number in it appears in those claims ([Campaign modes](../explanation/campaign-modes.md#research)).

## Accepted, not used yet

These fields pass validation and become part of the contract and its hash, but nothing in Thermite acts on them yet:

| Mode | Fields |
| --- | --- |
| Every mode | `target.class`; `search_policy` |
| Hill climb and goal | `min_duration`, `max_duration` |
| Hill climb | `objective.policy`; `objective.secondary` (checked against the kit only); `monitor_only`; hard constraints of kind `check` |
| Goal | `independence_epochs`; `min_live_families`; each goal's `priority` and `parent` (stored only) |
| Research | `scope.source_types`; `scope.languages`; `report_cadence.report_hours` |

## Validation messages

| Message | When |
| --- | --- |
| `lowercase id` | An id field is not an id |
| `sha256 hex` | A model's `sha256` is not 64 lowercase hexadecimal characters |
| `full git commit id (40 or 64 hex)` | A commit is short or not hexadecimal |
| `duration like "30m" or "8h"` | `min_duration` or `max_duration` has no unit, or another unit |
| `invalid regular expression` | A pattern in `forbidden_patterns` or `search_policy.blocked_patterns` does not compile |
| `Unrecognized key: "<name>"` | A field the contract does not have |
| `duplicate goal id <id>` | Two goals have the same `id` |
| `goal <id> has unknown parent <parent>` | A goal's `parent` names no goal in the list |
| `all_required needs at least one required goal` | `success.policy` is `all_required` and no goal is required |
| `k_of_n needs 1 <= k <= number of goals` | `success.policy` is `k_of_n` and `k` is missing or larger than the number of goals |
| `infeasibility.allowed requires min_refuted_approaches` | `infeasibility.allowed` is `true` without `min_refuted_approaches` |
| `max_duration is shorter than min_duration` | Both are set, and `max_duration` is shorter |
| `at most 16: a rig has users for lanes 1 to 16 only` | `lanes.count` is more than 16 |
| `research campaigns need min_duration` | A research contract has no `min_duration` |
| `rubrics has <n> entries for <m> questions: give one for each question, in order` | A research contract's `rubrics` is not one for each of its `questions` |
| `hill_climb campaigns need a target` | A hill climb contract has no `target` |
| `<cells> is in both cells and held_out_cells: a held-out cell is measured only at confirmation, so it can't be one of cells` (`are`, for more than one) | A hill climb names a cell in both `cells` and `held_out_cells`. The path is `held_out_cells` |

## When a run is assigned

The `assign_campaign` [signed command](signed-commands.md) carries the contract and its hash. Control does not sign one whose contract asks for more than 16 lanes: it answers `This contract asks for <n> lanes. A rig runs 16 at most: it has users for lanes 1 to 16 only. Set lanes.count to 16 or fewer.` Nor, for a run with agents, one whose `agents_context.context_window` is above what a provider lists for the model control gives one of the rig's agents: `This campaign sets a context window of <n> tokens. <model>, the model of the <agent> on <rig>, takes at most <m> tokens. Set the campaign's window to <m> or less, or give that agent another model.` The rig's harness refuses the command with one of these, and creates no run:

| Message | Cause |
| --- | --- |
| `invalid contract: <errors>` | The contract does not validate |
| `contract hash does not match contract_sha` | The hash in the command is not the contract's |
| `run <run> already exists` | The rig has a run with that name |
| `queue experiment <n>: <problem>` | The command copies experiments into the new run's [experiment queue](glossary.md) (**Start a run** › **Copy the untried experiments of**), and the `<n>`th of them, counting from 1, does not fit an experiment's [limits](limits-and-pacing.md#the-experiment-queue) |
| `contract <campaign> v<version> exists with other content` | The rig has this campaign and version with a different hash |
| `model <name> is not listed in the contract` | The command imports a model that `models` does not list |
| `model <name> (<sha256>) has not been imported` | A model in `models` is not on the rig |
| `a <mode> campaign needs a seed commit` | A hill climb or goal run was sent without a starting commit |
| `kit commit <commit> is not in kit <repo>; import its bundle first` | The kit commit is not on the rig |
| `kit <repo> at <commit> has no valid kit.json: <error>` | The kit's manifest is missing or refused |
| `the kit does not fit the contract: <problems>` | The kit lacks a cell, metric or verifier the contract names, a case the contract runs has no `work` parameter above zero for one of the kit's rate metrics, or the kit measures on another target. See [the kit against the contract](kit-manifest.md#the-kit-against-the-contract) |
| `seed commit <commit> is not in <repo>; import its bundle first` | The starting commit is not on the rig |
| `commit <commit> has no folder <folder>` | The project's `folder` is not in the starting commit |
| `the kit names the MCP servers <list>, and the assignment names <list>: start the run from control, which reads the kit's servers, or give the kit's mcp_servers in the assignment` | The command's `mcp_servers` is not the kit's (for a research run, `the contract` and its `mcp_servers`) |
