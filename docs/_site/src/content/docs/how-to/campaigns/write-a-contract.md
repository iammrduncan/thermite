---
title: "Write a contract"
description: "Write the file that says what a campaign must achieve, for a hill climb, a goal campaign or a research campaign."
type: how-to
sidebar:
  order: 3
---

A contract is the JSON file that says what a [campaign](../../reference/glossary.md) must achieve and how the judge decides. You write one to start campaigns from the command line or an agent. The **New campaign** page writes one for you.

A contract is frozen: to change anything, you write a new version. The [contract reference](../../reference/contract.md) lists every field with its default.

## Before you start

- Choose the mode: a **hill climb** improves one measured number, a **goal** campaign works until a list of checks passes, and a **research** campaign collects sourced findings. See [Choose a campaign mode](choose-a-mode.md).
- For a hill climb or a goal campaign, have a [kit](../../reference/glossary.md) committed in its own repository. The contract names its cells (test cases), metrics and verifiers. See [Write a kit for your project](write-a-kit.md).

## 1. Fill in the fields every contract has

| Field | What to write |
| --- | --- |
| `schema_version` | `1` |
| `campaign` | The campaign's name: up to 64 lowercase letters, digits, dashes and underscores, starting with a letter or a digit. No dot |
| `version` | `1` for a new campaign. Raise it for every change |
| `title` | One sentence for people. Agents see it too |
| `mode` | `hill_climb`, `goal` or `research` |
| `project.repo` | The project's short name on the rig: up to 64 lowercase letters, digits, dots, dashes and underscores, such as `project`. Validation takes other text, but a run's start refuses it. It is not an address: you give the address when you start a run, with `--seed` or the dashboard's **Repository** |
| `project.commit` | Optional: the full commit to start from, when `--seed` gives no `@COMMIT` |
| `project.kit` | The kit's `repo` name and full `commit`. Needed for a hill climb or a goal campaign |

Optional, in every mode:

- `lanes`: `count`, how many [lanes](../../reference/glossary.md) the planner plans (2 when `lanes` is left out), and `trials_per_epoch`, [trials](../../reference/glossary.md) per lane per round, at most (3). How many trials run at the same time is the rig's **Workers at a time**, not `count`: see [Start a campaign from the dashboard](start-from-dashboard.md#5-where-it-runs). If you write `lanes`, write `count` in it. `lanes.limits` raises a lane's memory, disk, time and process limits; `count` is 16 at most.
- `budget`: `wall_hours`, `device_hours` and `llm_usd`. None is set unless you set it. See [Set a budget or a stop time](budget-and-stop-time.md).
- `notes`: the campaign's additional information, in Markdown: background, links, what was tried, limits, and what good looks like. The workers and the advisors read it in every mode, and the planner in a hill climb or goal campaign.
- `hypotheses`: what you think is true, one entry each, for the agents to test. A research run starts with them as its hypotheses.
- `ideas`, in a hill climb or a goal campaign: ideas to try, one entry each. The planner turns those that fit into experiments.
- `links`, in a hill climb or a goal campaign: starting links, pages the agents get with the brief. A research campaign's are its `seeds`.
- `models`: [model files](../../reference/glossary.md) the project needs, each with its `name` and `sha256`: data files your project loads that are not in its repository, such as a model's weights.

[The campaign's brief](../../reference/contract.md#the-campaigns-brief) says what each agent gets. `thermite assign --info-file brief.md` puts a Markdown file in `notes`, so you can keep it beside the contract.

## 2. Write a hill climb

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "sort-speed",
  "version": 1,
  "title": "Make the sort faster on large inputs",
  "mode": "hill_climb",
  "project": {
    "repo": "project",
    "kit": { "repo": "project-kit", "commit": "89abcdef0123456789abcdef0123456789abcdef" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/sort/**"],
  "forbidden_patterns": ["clock_gettime", "gettimeofday"],
  "objective": {
    "primary": { "metric": "items_per_s", "direction": "max", "min_effect": 0.05 }
  },
  "cells": ["small", "large"],
  "held_out_cells": ["held"],
  "acceptance": { "runs_per_cell": 3 },
  "notes": "The sort must stay stable. Do not change the public header."
}
```

- `target` is required in a hill climb, and optional in the other modes. `type` is `cpu` or `cuda-gpu`. `class` is a free name for the kind of device, such as `generic-cpu`: it is required with `type`, but nothing checks it yet.
- `editable_paths` are the files a change may touch: `**` matches any folders, `*` any part of a name. `forbidden_patterns` are regular expressions. A change outside the paths, or one that adds a matching line, is refused before it is built.
- `objective.primary` names one of the kit's metrics, which way is better (`max` or `min`), and `min_effect`, the smallest gain that counts, as a fraction: `0.05` is 5%.
- `cells` are measured for every change. `held_out_cells` run only when the judge confirms a change that already looked better, so a change can't win by helping only the cells agents see.
- `acceptance.runs_per_cell` (1 to 9; 1 unless set) runs each cell several times per measurement and keeps the middle value. The **New campaign** page's **Runs per case** sets 3 unless changed, so write `3` to judge as a campaign made there does. `acceptance.equivalence_band` (0.005) is how close counts as "no change". On a noisy machine, such as a shared CPU, raise both: Thermite's own smoke check uses 3 and 0.05.
- `acceptance.audit` sets when a confirmed win goes to the rig's auditor, if it has one: a gain above `absolute` (0.15, that is 15%), or above `ratio_to_median` (3) times the median of the run's earlier wins, once it has three. See [Decide what waits for you](decide-what-waits.md#audits).

To keep a second metric from getting worse, add a guard. To refuse a change whose metric crosses a line, add a hard constraint. Both name kit metrics:

```json title="contract.json (part)"
"guards": [
  { "metric": "peak_mib", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 }
],
"hard_constraints": [
  { "kind": "max", "metric": "peak_mib", "value": 512 }
]
```

Here `peak_mib` may get at most 2% worse in one promotion, and at most 5% worse than where the run started: the judge's first job measures the starting point on every cell (the run's [baseline](../../reference/contract.md#the-baseline)), and each confirmation holds the guard against those values.

## 3. Write a goal campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "new-format",
  "version": 1,
  "title": "Support the new 16-bit format end to end",
  "mode": "goal",
  "project": {
    "repo": "project",
    "kit": { "repo": "project-kit", "commit": "89abcdef0123456789abcdef0123456789abcdef" }
  },
  "editable_paths": ["src/**", "tests/**"],
  "goals": [
    {
      "id": "builds",
      "description": "The project builds with the new format",
      "verify": { "type": "code", "verifier": "builds" }
    },
    {
      "id": "correct",
      "description": "Results match the reference on every golden input",
      "verify": { "type": "code", "verifier": "goldens" }
    },
    {
      "id": "fast",
      "description": "At least 150 million items per second on the large input",
      "verify": {
        "type": "metric_threshold",
        "metric": "items_per_s",
        "op": ">=",
        "value": 150000000,
        "cells": ["large"]
      }
    },
    {
      "id": "readable",
      "description": "The change is clear enough to maintain",
      "required": false,
      "verify": { "type": "review", "criteria": ["clear names", "no dead code"] }
    }
  ],
  "deliverable": "a commit that meets every required goal",
  "insufficient": ["special-casing the golden inputs"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 }
}
```

Each goal has an `id`, a `description` and one way to `verify` it:

| `verify.type` | Met when | Needs |
| --- | --- | --- |
| `code` | The kit's check passes on every cell of the named verifier | `verifier`: a verifier in the kit's `kit.json` |
| `metric_threshold` | In every cell, the metric's 95% interval over `threshold_reps` runs (5) is wholly on the passing side of `op` and `value` | `metric`: a kit metric. `cells`: leave it out for every cell |
| `review` | The rig's review panel passes it; you accept it too when the run asks you about reviews. A review panel chosen on **Edit rig** is three reviewers with one model; one in the advisors file has two to five | `criteria`. See [Configure advisors](../operate/advisors.md) |

The rest of a goal contract:

- `required` is `true` unless you write `false`. `success.policy` is `all_required` (every required goal), or `k_of_n` with `success.k`.
- `deliverable` says what a solution is, and `insufficient` lists results that must never count as success. The review panel reads both; the auditor reads `insufficient`.
- `adversarial_checklist`, when not empty, sends every change that would become the new best to an audit first.
- `infeasibility` lets the harness propose ending the campaign as "not possible" once `min_refuted_approaches` approaches have failed. Only you can accept it. Without it, the campaign goes on until its goals are met.
- `held_out_cells` are checked only to confirm a change that has gained a goal.

Code goals are checked in the order of their kit verifiers' `priority`.

The judge first checks which goals the starting point already meets. If it meets every required goal, the judge checks it a second time, with the held-out cases of the goals met, and no trial starts meanwhile. If that check agrees, the run closes with `Every required goal is met: the campaign is complete.` Measure where the project starts before you set a `metric_threshold`, as [Your first goal campaign](../../tutorials/first-goal-campaign.md) does.

## 4. Write a research campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "allocators",
  "version": 1,
  "title": "How allocators keep tail latency low",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "How do modern memory allocators keep tail latency low under contention?",
  "questions": [
    "Which designs do production allocators use for thread-local caching?",
    "What do published benchmarks show about their tail latency, and under which workloads?"
  ],
  "seeds": ["https://example.com/allocators/overview"],
  "scope": { "exclude_domains": ["example.net"] },
  "min_duration": "8h",
  "max_duration": "24h"
}
```

- `project.repo` is required in every mode. A research campaign fetches no repository, so any short name does, such as `research`.
- `min_duration` is required: the time the run has to collect sources and claims, a floor, never a stop. After it, at each digest, the rig's review panel decides each question and each hypothesis that needs a verdict; once every question has an end, answered or the best that sources allow, the run writes its final report, with its research paper and the decisions, and ends by itself. It also ends when its open questions stop adding (the progress rule). `min_verified_claims`, when you set it, is a floor of verified claims the run must have before the review panel is first asked: a whole number, 1 or more. It only delays the check. The run ends after `max_duration` of running time at the latest, ended or not; without `max_duration` and without an end it runs until you close it. Paused time doesn't count, nor time its agents could not work: because of the model provider, while the rig drained before an image update, or while the harness did not run at all, such as while the host was asleep or the stack was stopped. Durations look like `30m`, `8h` or `2d`. [When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends) has the whole check.
- A question can be long and have several lines. A claim can name the question it answers. The report counts the verified claims for each of the `questions`, and lists a question with none as open. There is no web search: the harness fetches and archives the `seeds` when the run starts, and agents follow links from them.
- `scope.include_domains`, when not empty, limits fetching to those domains. `scope.exclude_domains` are never fetched.
- `quality.min_independent_sources` (2): the report lists a verified claim whose quotes come from at least this many domains apart from the others, and says for each finding how many of its claims do.

A research campaign needs a model on the rig. Without one, no agent works and the run never ends; the **New campaign** page won't start agents on a rig that has none. Research workers run in Pi or OpenCode v2, never in Claude Code:

- A Claude subscription can't serve them. Nothing stops the start, but every trial ends with `research workers run in Pi or OpenCode, and a Claude subscription runs only in Claude Code: give this rig another model for research` ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
- On a rig whose agents run in **Codex**, research workers run in Pi, with the same model.
- OpenCode's own free models work when the rig's agents run in **OpenCode v2**. Where they would run in Pi, the dashboard refuses to start the run and says to set the agents' harness to OpenCode; a run started another way, such as with `thermite assign`, ends every trial with `… is one of OpenCode's own models, which work only inside OpenCode: set this rig's agents' harness to OpenCode on its Edit rig page`.

## 5. Validate it

```sh
npx thermite contract validate contract.json
```

A valid contract prints `ok <mode> <campaign> v<version> sha256=<hash>`. Otherwise each mistake is printed as `<field>: <message>`, for example:

- `lanes.count: Invalid input: expected number, received undefined`: add `count` to `lanes`.
- `(root): Unrecognized key: "<field>"`: remove the field or fix its spelling. Contracts accept only known fields.
- `campaign: a campaign's name is lowercase letters, digits, dashes and underscores, …`: use only those, with no dot.

The [contract reference](../../reference/contract.md#validation-messages) lists every message. Validation checks the contract alone. When a run starts, the rig also checks it against the kit: every cell, metric and verifier it names must be in the kit, and the kit's target must be the rig's. [If it is refused](start-from-command-line.md#if-it-is-refused) says what to do when that check fails.

## 6. Change it

Change anything, then raise `version` by one. A rig refuses a contract whose campaign and version it already has with other content: `contract <campaign> v<n> exists with other content`. Then [start a run from the command line](start-from-command-line.md).
