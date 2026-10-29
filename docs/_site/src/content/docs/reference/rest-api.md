---
title: "REST API"
description: "Every route control serves, who may call it and what it returns."
type: reference
sidebar:
  order: 6
---

Control, the central service that shows and steers every [rig](glossary.md), serves an HTTP API for scripts. This page lists every route: who may call it, what it takes and what it gives back. [Script Thermite with the REST API](../how-to/automate/rest-api.md) shows how to use it. Agents use [MCP](mcp-tools.md) instead.

```sh
curl -fsS http://127.0.0.1:8800/v1/health
curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  'http://127.0.0.1:8800/v1/commands?limit=5'
```

The first request needs no token and answers `{"ok":true,…}`. The second uses the owner's token from a local install and answers `{"commands":[...]}`, the five newest [signed commands](signed-commands.md).

## Addresses

Control listens on `THERMITE_CONTROL_LISTEN`, by default `0.0.0.0:8800`. The local compose file publishes it on `127.0.0.1:8800`; `THERMITE_CONTROL_PORT` changes the port on your computer.

| Path | What it serves |
| --- | --- |
| `/v1/...` | This API |
| `/metrics` | [Metrics](#metrics-series) for Prometheus |
| `/v1/join/...` | [Join commands](#join-commands) |
| `/mcp` | The [MCP server](mcp-tools.md) |
| `/ui` | The dashboard. `GET /` redirects to `/ui` |

## Tokens

Every request except `GET /v1/health` sends a token as `Authorization: Bearer <token>`. [Tokens and roles](tokens.md) says how each token is made.

| Token | Routes it may call |
| --- | --- |
| None | `GET /v1/health` |
| Owner | Every route under [Routes for people and scripts](#routes-for-people-and-scripts) |
| Reader | `GET /metrics`, `GET /v1/usage`, `GET /v1/model-prices`, `GET /v1/rigs/<rig>/live`, `GET /v1/kits` and `GET /v1/kits/<name>` only |
| Operator, agent | None. These tokens work only on [MCP](mcp-tools.md) |
| A rig's own token | The [routes used by rigs](#routes-used-by-rigs), for that rig only |
| A join token | The two [join routes](#join-commands), once |

Request bodies are JSON, except a champion's patch, a piece of an export's file and a kit's git bundle, which are sent as raw bytes.

## Errors

| Status | Body | When |
| --- | --- | --- |
| 401 | `{"error":"unauthorized"}` | No token, a wrong token, or a token that may not call the route |
| 400 | `{"error":"the request's body is not JSON"}` | The body of a route that takes JSON does not parse |
| 400 | `{"error":"invalid request"}` | The body does not match the route's schema. The schema's own message is not sent back. Control writes it to its output and to its audit log, as action `failed`. These routes answer `bad request: <field>: <message>` instead, as each one's section says: a campaign's `runs`, `copy`, `context` and `folder`, `POST /v1/campaign-folders` and its `rename`, and a rig's `model`, `settings` and `cluster/resources` |
| 403 | `{"error":"this rig is retired in control"}` | A rig-facing route, called for a retired rig |
| 409 | `{"error":"Control cannot work with this rig: …"}` | A rig-facing route, called for a rig whose protocol control cannot work with. See [Rig versions](#rig-versions) |
| 413 | `Payload Too Large` | A body past its route's limit, as the tables below give it. A rig's supervisor sends a page of its reports again in halves, and its live lines fewer at a time |
| 403, 404, 409, 422 | `{"error":"<why>"}` | Route by route, as the tables below say |
| 404 | `{"error":"<why>","code":"<code>"}` | Where one status means two things to the rig's supervisor, the error also names a code, and the supervisor acts on the code, never on the words: `not_assigned` on `GET /v1/rigs/<rig>/kb`, as [Routes used by rigs](#routes-used-by-rigs) says |
| 409 | `{"error":"<why>"}` | A refusal while control does the work, such as a refused propagation or a reset in the wrong state, in its own words. A command that control refuses (`POST /v1/commands`) answers 400 with the reason, 404 for an unknown rig, or 409 when it would start a stopped RunPod pod that control could not start, or start a run while control's disk is at its floor. A run that control does not start (`POST /v1/campaigns/<campaign>/runs`), or a campaign it does not copy (`POST /v1/campaigns/<campaign>/copy`), answers 400, 404 or 409 with the reason, as [Campaigns](#campaigns) lists; so do a campaign it does not archive or move, and a folder it does not make, rename or delete ([Archive a campaign, and folders](#archive-a-campaign-and-folders)) |
| 500 | `{"error":"<why>"}` | A fault in control. Control writes it to its output and to its audit log, as action `failed` |

Every request that ends in an error inside control, or with a 5xx status, is written to control's output as a JSON line with `"msg":"request failed"`, and to the [audit log](#audit-log-actions) as action `failed` by actor `control`.

A `limit` in a query string is a whole number. Control keeps it between 1 and 5000; anything that is not a whole number gives the route's default.

## Routes for people and scripts

All of these take the owner's token, except where the table says otherwise. `<rig>`, `<run>` and `<id>` stand for a rig's name, a run's id and a command's or reset's id.

### Health

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/health` | None | Says control is up, how it holds the [message bus](../how-to/operate/message-bus.md#check-it), which it needs: `connected` (it holds a connection to the bus's server now) or `away` (it holds none, and tries again), each of its loops (below), and its disk against its floor (`disk`, with `degraded`). Once control serves, it answers 200 whatever the bus does, and 200 with `"degraded":true` while its disk is at its floor, and 503 with `"ok":false` while one of its loops is late; while it starts, building its views from the bus's events, it answers 503 with `"ok":false` and `"starting":true`, and every other route 503 with `retry-after: 5` | None | `{"ok":true,"loops":{"resets":{"age_seconds":4,"limit_seconds":1800,"late":false},…},"bus":"connected"}` |

Each part of Thermite answers a health route like this one: control here, the harness on its own port ([The harness's API](#the-harnesss-api-for-proposers)), and the supervisor on `THERMITE_SUPERVISOR_HEALTH_LISTEN`, `127.0.0.1:8701` in its container by default. Each gives its long-running loops by name, each with `age_seconds`, the seconds since it last came around, `limit_seconds`, and `late`; the route answers 503 while one is late. A loop is late after ten of its periods, and never before 30 minutes, so that a round that pushes or uploads an export, or copies the ledger, has time to end. Work whose length is research's is never counted: a loop that waits on it says so in `busy` and is never late meanwhile. The limits are mechanical, never a limit on research.

| Part | Loop | Comes around every | Late after |
| --- | --- | --- | --- |
| Control | `resets` (full resets), `drains` (drains and their deadlines), `runpod_tests`, `runpod_rigs`, `pull_mode`, `quiet_rigs`, `bus_users`, `bus_config`, `disk` (its disk floor), `gpu_clouds` | 10 s, 10 s, 15 s, 30 s, 0.25 s, 60 s, 5 s, 5 s, 60 s, 15 min | 30 min; `gpu_clouds` 150 min |
| Harness | `judge:<card>`, one for each judge card | 1 s between jobs | 30 min; never while it has a job (`busy`: `job 12`) |
| Harness | `scheduler` | 2 s | 30 min; never during the planner's call (`busy`) |
| Harness | `exports` (and the disk's floor, and drains' deadlines) | 5 s | 30 min |
| Supervisor | `report` | `THERMITE_POLL_SECONDS` (60 s) | 30 min |
| Supervisor | `commands`, `live` | `THERMITE_COMMAND_POLL_SECONDS` (5 s), `THERMITE_LIVE_INTERVAL_MS` (3 s) | 30 min |

Control's answer also gives its own disk against its floor, [`THERMITE_DISK_FLOOR_GIB`](settings.md#address-and-state): `disk` holds `floor_gib`, `low`, `since`, `checked_at`, `places` (`state`, its state folder, and `bus store`, the room the bus's store has left under its limit, each with `free_gib` and `total_gib`) and `unread` (a place it could not read, with why), and `degraded` is `low`. At its floor control holds new runs but is well, and answers 200 ([Troubleshoot](../how-to/operate/troubleshoot.md#controls-disk-is-at-its-floor)). The harness's answer also gives the rig's name and its free disk against its floor (`disk`, as the rig's report carries it: [The disk card](rig-page.md#the-disk-card)); a rig at its floor holds new work but is well, and answers 200. Compose, the release bundle, the machines' units and Kubernetes each check these routes ([Troubleshoot](../how-to/operate/troubleshoot.md#a-part-that-is-unhealthy)).

### Rigs and their history

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/rigs` | Owner | Lists the rigs that have reported, or that control refuses, and are not retired; every rig enrolled through control; every rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode); every rig launched on a GPU cloud; and control's own build | None | `{"control":{version, commit, protocol, oldest_protocol}, "rigs":[{id, last_seen, last_cursor, ledger_id, summary, state, version}], "enrolled":[{rig, created_at, created_by, rotated_at, retired_at}], "pull":[{rig, pod, url, port, box_public, code_expires_at, config, pod_sign_public, pod_box_public, enrolled_at, last_exchange_at, refused_total, error, created_at, created_by}], "runpod":[runpod rig]}`. `state` is `reporting`, `stale` or `offline`, and `version` is the rig's builds against control's: see [Rig versions](#rig-versions). A rig that never sent a report has `last_seen` `1970-01-01T00:00:00.000Z`. `last_cursor` is the cursor after the last event control holds of the rig's current ledger (`ledger_id`), as the apply of its events stream left it. `enrolled` includes retired rigs. In `pull`, `pod` and `url` are `null` until the pod is launched, `code_expires_at` is `null` when the code does not expire, the pod's keys are `null` until it enrolls, `refused_total` counts the requests the pod refused, and `error` is what control's last connection to the pod found. No code, path or private key is in it. `runpod` is as in [Rigs on a GPU cloud](#rigs-on-a-gpu-cloud) |
| `GET /v1/rigs/<rig>/view` | Owner | One rig as the dashboard sees it: hardware, judge, runs with their champions and attempts, goals, audits, checks, model and settings | None | `{id, last_seen, stale, state, version, ledger_id, summary, supervisor, hardware, jobs, runs, recent, judge, checks, model, settings, gpu_split}`, and `runpod` for a rig launched on a GPU cloud (a `runpod rig`, as in [Rigs on a GPU cloud](#rigs-on-a-gpu-cloud)). `stale` is true when `state` is `stale` or `offline`. `recent` is the newest 50 events, newest first, without the agents' model calls ([Model usage](#model-usage) sums them); each event's `seq` is its place in the message bus's `EVENTS` stream, as `GET /v1/rigs/<rig>/events` gives it. Each run has the fields the MCP tool [`get_run`](mcp-tools.md#get_run) returns, among them `goal_checks` (how each goal of a goal run is checked, as its rig's kit runs it), `queue` (every experiment of its experiment queue, with its state and place, as [`run_queue`](mcp-tools.md#run_queue) describes them), `rules` (the rules for its plan), `handouts` (the planner's newest 50 hand-outs, oldest first), `messages` (the owner's messages, with who read them and the rules the planner made from each) and `journal` (every note its agents wrote, oldest first: see [`get_run`](mcp-tools.md#get_run)). 404 `{"error":"not found"}`. Each run has `agents_stopped` and `has_agents`, a goal run its `goals` with each goal's `values`, `goals_confirming`, `goals_complete` and `champion_held_out`, a hill climb its `baseline`, `setup` and `baseline_waiting`, and a research run its answer checks in `reviews` and its `paper`, as [`get_run`](mcp-tools.md#get_run) gives them |
| `GET /v1/rigs/<rig>/events` | Owner | The rig's events, in every ledger, in the order control received them, read from the message bus's `EVENTS` stream | `after`: a place in the stream, the `seq` of the last event read, default 0. `limit`, default 500 | `{"events":[{seq, ledger_id, id, at, actor, kind, subject, body, run, received_at}]}`, oldest first. `received_at` is when control took the event: when the `EVENTS` stream stored it, by the bus's clock. `seq` is the event's place in the `EVENTS` stream, which counts every rig's events: the next page starts after the last one's, and a page holds fewer than `limit` only at the end. `id` is the event's number in its ledger. `run` is the run the event is about, as the rig's ledger recorded it, or `null` for the rig's own events and for events received before v0.1.1 |
| `GET /v1/rigs/<rig>/live` | Owner or reader | The live log: what the planner, the judge, each trial and the supervisor are doing now | `after`: control's line id; without it, the newest lines. `source`: `planner`, `judge`, `supervisor` or `trial:<id>`. `limit`, default 500 | `{"sources":[{source, lane, run, last_at, lines, ended}], "entries":[{id, seq, at, source, kind, text, lane, run, signed}]}`, entries oldest first. `signed` is false for the supervisor's own lines |
| `GET /v1/leaderboard` | Owner | For each hill-climb campaign, each run's champion, its gain over its own baseline and the rigs whose judges cross-verified it, best gain first. Goal and research runs are not listed | None | `{"campaigns":{"<campaign>":[{rig, run, mode, status, champion_seq, gain, verified_by, values}]}}`; `values`: `{start, champion, unit, estimated}`, as [`leaderboard`](mcp-tools.md#leaderboard) gives it |
| `GET /v1/reports` | Owner | The supervisors' daily reports, in Markdown, newest first | `limit`, default 20. `rig`: one rig only | `{"reports":[{id, rig, kind, body, at}]}` |
| `GET /v1/rigs/<rig>/exports` | Owner | The [exports](exports.md) the rig sent to control, newest first: the newest 1,000 | None | `{"exports":[{name, run, full, from_event, through_event, files, files_kept, bytes, bytes_received, created_at, complete_at}]}`. `run` is the run a run's export holds, or `null` for the rig's own; `complete_at` is `null` until every file is kept |
| `GET /v1/rigs/<rig>/exports/<name>` | Owner | One export on control: its manifest and each file | None | `{name, run, full, from_event, through_event, files, files_kept, bytes, bytes_received, created_at, complete_at, manifest}`, with `files` as `[{path, size, sha256, kept}]`. 404 `{"error":"no such export"}` |
| `GET /v1/rigs/<rig>/exports/<name>/file` | Owner | Downloads one file of an export on control | `?path=<path>` | The file, as `application/octet-stream`, with the header `x-thermite-sha256`. 404 `no such file in that export` (also for a file not kept yet) or `the file is gone from control's folder` |
| `GET /v1/rigs/<rig>/exports/<name>/archive` | Owner | Downloads a complete export on control as one archive, as **Download** on the dashboard's **Exports** page does | None | `<rig>-<name>.tar.gz`, as `application/gzip` with `content-disposition: attachment`: a folder `<rig>-<name>/` with the export's `manifest.json` and every file at its path ([Download an export](exports.md#download-an-export)). 404 `{"error":"no such export"}`, `the export is still arriving: not every file reached control`, `control keeps no exports: it has no folder for them`, `<path> is gone from control's folder` or `<path> on control has <n> bytes, not <size>` |
| `GET /v1/rigs/<rig>/results-left` | Owner | Whether all of the rig's results have left it: in its results repository, or on control | `?export=<name>`: also that export. Optional | `{left, why, to, waiting, champions_waiting, reported_at}`. [Have all results left the rig?](exports.md#have-all-results-left-the-rig) explains each field and answer |

A live line's `kind` is `text`, `thinking`, `tool`, `result`, `message`, `status` or `log`. Control keeps the newest 20,000 live lines of each rig, and each open trial's newest 400 past them.

### Runs

A run is addressed by its name alone: a run's name is used once on control, on every rig. Control reads it wherever it ran: on its rig's current ledger, on a ledger from before the rig's full reset, or on a retired rig. What a run owns, such as an attempt or a champion's patch, is addressed under the run. The rig a run ran on is a fact about it, in the answers, never part of the address.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/runs/<run>` | Owner | One run, as [`get_run`](mcp-tools.md#get_run) gives it: each list that grows with the run cut to its newest entries, the research report to its first 4,000 characters, the texts in the lists' entries cut when the answer is above 40,000 characters, and `cut` saying what was left out | Query: `attempts` (50), `limit` (10), `list`, `offset` (0), `full_report` (`true` or `false`), as `get_run`'s inputs | The run's view with `cut`; with `list`, `{id, list, total, from, to, entries}`. `400` for an argument out of range or a list the run has not; 404 `{"error":"no run <run>"}` |
| `GET /v1/runs/<run>/attempts/<attempt>` | Owner | One attempt of the run, as [`get_attempt`](mcp-tools.md#get_attempt) gives it | None | `{run, campaign, rig, earlier, champion_seq, attempt}`. `rig` is the rig the run ran on. `earlier` is `null`, `retired` (its rig is retired) or `reset` (it ran before its rig's full reset). `champion_seq` is the champion the attempt became, or `null`. `attempt` is the attempt as `get_run`'s `attempts` give it: its lane, lifecycle, verdicts with their deltas and intervals, the judge's reasons, the main metric's values, its files, the flaws its author declared, the violations a static check found and its newest held-out check. 404 `{"error":"no run <run>"}` or `{"error":"run <run> has no attempt <attempt>"}` |
| `GET /v1/runs/<run>/directions` | Owner | One run's directions, what a rule may name, with the rules in force | none | `{run, mode, directions, rules}`. `directions`: each `{name, description, tried, wins, queued, lanes, rules, to_design}`, by name, as MCP's [`run_queue`](mcp-tools.md#run_queue) gives them; `to_design` is `true` while only a rule names the direction and the planner has not designed it yet. `rules`: each `{id, author, at, body, legacy}`; `legacy` is `true` for an old rule in words, which the planner converts at its next round, and a converted rule's `body` has `converted_from`, `{rule, words}`. See [Directions](../how-to/campaigns/choose-what-runs-next.md#directions). 404 `{"error":"no run <run>"}` |
| `GET /v1/runs/<run>/untried` | Owner | One run's untried experiments, ready to start a new run's queue: what **Copy the untried experiments of** in **Start a run** copies, and what `thermite assign --queue-from` sends | `campaign`: the new run's campaign; the run's own when not given | `{run, rig, campaign, queue}`. `rig` is the rig the run ran on; `campaign` is the run's own. `queue` holds its experiments up next, in their order, then its lanes' ideas, at most 500, each as `assign_campaign`'s [`queue`](signed-commands.md#assign_campaign) takes it: `{title, details?, family?, why?, by, state, from: {run, id}}`. Control takes the words and the author from its own records of the run, as MCP's `issue_command` does, when the run's campaign is `campaign` or one whose folder `campaign` may read; otherwise the author is `copied`. 404 `{"error":"no run <run>"}` |
| `GET /v1/runs/<run>/champions/<seq>/patch` | Owner | Downloads one of the run's published champions as a patch | None | The patch, as `text/x-diff`, with the headers `x-thermite-base-commit` (the commit it applies to) and `x-thermite-sha256`. 404 `{"error":"no patch for that champion"}` |
| `GET /v1/runs/<run>/prompts` | Owner | The prompts the run's agents were sent, oldest first, as [`agent_prompts`](mcp-tools.md#agent_prompts) lists them ([Agent roles](agent-roles.md#what-a-runs-agents-were-sent)) | None | `{run, rig, prompts}`. Each prompt: `{id, at, role, program, lane, trial, call, version, chars, sections}`; `id` is its number on its rig, `call` the round, audit, review or paper outside a trial, `version` the first 12 hexadecimal digits of the SHA-256 of the role's own text, and each section `{id, source, part, chars}`. 404 `{"error":"no run <run>"}` |
| `GET /v1/runs/<run>/prompts/<id>` | Owner | One of the run's prompts, each section with its text | None | The prompt as listed, with `rig`, and each section `{id, source, part, chars, text, cut, from_definition}`: `text` as the rig sent it to control (at most 8,000 characters of the prompt in all), or a fixed text of the role's definition (`from_definition`), or `null` when control's build has another version of the role. `cut` is `true` for a section control has part of; the whole is on the rig and in the run's export. 404 `{"error":"no prompt <id> in <run>"}` |

A name used by more than one run before v0.1.1 (on two rigs, or again after a full reset) stands for the newest run of that name. [Take the result](../how-to/campaigns/take-the-result.md) uses the patch route.

### Model usage

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/usage` | Owner or reader | The agents' model usage, summed for one run, for a campaign (all its runs on every rig) or for the whole system, over a period | `run`: one run, by its name. `campaign`: one campaign. Neither `run` nor `campaign`: the whole system. `period`: `today` (since midnight UTC, or in `tz`), `7d` (the last 7 days) or `all`, default `all`. `tz`: the time zone whose midnight starts `today`, by its IANA name, such as `Europe/Paris`; default `UTC`. An empty field counts as not given | `{scope, period, tz, since, total, by_agent, by_model, by_agent_model}`, with `by_run` for a campaign and `by_campaign` for the system, below. 400 `{"error":"<why>"}`: `Give a run or a campaign, not both.`, `The period is today, 7d or all.`, `The time zone is a name such as Europe/Paris, America/Chicago or UTC.`, `A run is 1 to 100 characters.` (a campaign, 1 to 200), or `It takes run, campaign, period and tz, not <field>.` |

It sums the [model usage records](../explanation/how-it-fits-together.md#the-model-usage-records) the rigs reported, by the time each call started. A run or a campaign with no records gives sums of 0 records. The MCP tool [`model_usage`](mcp-tools.md#model_usage) gives the same answer.

| Field | Meaning |
| --- | --- |
| `scope` | `{kind: "run", run}`, `{kind: "campaign", campaign}` or `{kind: "system"}` |
| `period`, `since` | The period, and when it starts; `since` is `null` for `all` |
| `tz` | The time zone whose midnight starts `today`: the one asked for, or `UTC` |
| `total` | The sums of every record in the scope and period |
| `by_agent` | The sums of each agent with records, in this order: `workers`, `planner`, `teachers`, `merged_by` (the teachers' merged by model), `auditor`, `review_panel`, `synthesizer` (the writer of a research run's answer cards), `final_writer` (the writer of its paper). Each has `agent` and its `name` in words, such as `Teachers (merged by)`, `Review panel`, `Synthesizer` or `Final writer` |
| `by_model` | The sums of each model, with its `harness`, its `provider` (`null`: a rig's own settings, or an advisors file that names none) and its `model`, the most tokens first |
| `by_agent_model` | The sums of each agent's calls to each model, with the agent's `agent` and `name`, and the model's `harness`, `provider` and `model`: in the agents' order, then the most tokens first |
| `by_run` | For a campaign: the sums of each run, with its `rig`, its `run` and its `share` of the campaign's tokens (in and out, from 0 to 1), the largest first |
| `by_campaign` | For the system: the sums of each campaign, with its `campaign` (`null` for a run whose campaign control has no record of) and its `share` of the system's tokens, the largest first |

Each set of sums has these fields. A figure that no record reports is `null`, never 0.

| Field | Meaning |
| --- | --- |
| `records` | How many records it sums |
| `calls` | The model calls the records cover, where they say |
| `calls_not_reported` | Records that do not say how many calls they cover: a Codex turn, or a Claude Code advisor's call |
| `tokens_in` | Every input token |
| `cached_in`, `uncached_in` | The input tokens read from the provider's cache, and the others, over the records that report the cache |
| `cached_share` | `cached_in` over the input of the records that report the cache, from 0 to 1 |
| `tokens_out` | Every output token, the reasoning included |
| `reasoning` | The reasoning tokens, over the records that report them |
| `out_per_s` | Output tokens a second: each record's output over its time in calls, for the records with a time and some output. `{median, p10, p90}`: the median and the 10th and 90th percentiles, each interpolated between the two nearest records |
| `call_ms` | The time in calls, in milliseconds, over the records that report it |
| `first_token_ms` | The median time from a request to its first token, in milliseconds |
| `not_reported` | `{cached, reasoning, time, first_token}`: how many records do not report each figure |
| `cost` | What the calls and the pods cost, in US dollars, below |

`cost` has these fields. A record's cost is its tokens at its model's price now: input not read from the cache, cached input (at the input price when the model has no cached price, and every input token at the input price when the record does not report its cache) and output.

| Field | Meaning |
| --- | --- |
| `usd` | The priced records' cost and the pods' spend. `null` when no record has a price and no pod spent: never 0 for what is not known |
| `input_usd`, `cached_input_usd`, `output_usd` | The priced records' cost, by part |
| `pod_usd` | What a RunPod rig's pod cost while its rig ran these runs, as control counted it every 30 seconds: each count goes to the run its rig was running then, split evenly when it ran two, and to no run when it ran none. In `by_agent`, `by_model` and `by_agent_model`, always `null`. `null`: no pod spend |
| `priced` | Records with a price: the provider's list's, else the owner's |
| `on_plan` | Records on a subscription's plan: a Claude or ChatGPT provider's, and every Claude Code call |
| `no_price` | Records whose model has no price known |
| `free` | Priced records whose model is free: its price is 0 in every part |
| `on_plan_tokens`, `no_price_tokens`, `free_tokens` | The tokens, in and out, of the records on a plan, with no price, and free |
| `priced_as_not_cached` | Tokens in priced at the input price because their records do not report the cache, where the model has a lower cached price |

A model's price comes from the provider's model list when the list gives one, as OpenRouter's and Nous Portal's do (`pricing`, in US dollars per token). OpenAI's own list, Anthropic's and OpenCode Zen's give none: the owner sets one.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/model-prices` | Owner or reader | The prices model usage costs calls at | None | `{"prices":[{provider, model, price, source}]}`. `price` is `{input, cached_input, output}`, in US dollars per million tokens (`cached_input` `null`: the input price); `source` is `list` (the provider's list) or `owner` |
| `POST /v1/model-prices` | Owner | Sets the owner's price for a provider's model whose list gives none, or removes it. Every call of the model is costed at it, the earlier ones too. Control writes `model_price_set` or `model_price_cleared` to its audit log | `{provider, model, input, output, cached_input?}`, in US dollars per million tokens, 0 to 1,000,000; or `{provider, model, clear: true}` | `{provider, model, price, said}`, such as `said`: `small-model of lab costs 1 USD per million tokens in and 2 USD out. Model usage prices all its calls at it.` 404 `Providers has no provider <name>.` or `<provider> has no model <model>: add it to the provider in Providers first.` 409 `<provider> is a subscription: its calls are on its plan, with no price per token.` or `<provider>'s model list gives <model> its price, and model usage uses that one.` 400 `Give input and output, in US dollars per million tokens, or clear: true.`, `Give clear: true alone, or a price.` or the field that does not read |

### The agents' roles

Every agent role Thermite runs, from control's own build: see [Agent roles](agent-roles.md). What a run's agents were sent is under [the run](#runs).

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/agents` | Owner | Every role, as [`agent_roles`](mcp-tools.md#agent_roles) lists them | Query: `texts` (`true`: each role's fixed texts whole) | `{roles}`. Each role: `{id, name, what, runs_in, model, programs, messages, render, texts}`; `render` is the function that puts its prompt together for a run, and each text `{id, what, chars}`, with `text` when asked |
| `GET /v1/agents/<role>` | Owner | One role, with its fixed texts whole | None | The role, each text with `text`. 404 `{"error":"no role <role>"}` |

### The agents' model

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/rigs/<rig>/model` | Owner | Each of the rig's agents' models on control, as section **2 · The agents** on **Edit rig** shows them, and what the rig's advisors file sets up for each advisor, as its supervisor reports it | None | `{rig, agents, advisors_file}`, as MCP's [`rig_models`](mcp-tools.md#rig_models) returns it. `advisors_file` is `null` until the supervisor has reported it. 404 `{"error":"no rig <rig>"}` |
| `POST /v1/rigs/<rig>/model` | Owner | Gives one of the rig's agents a model from a provider in **Providers**, or sends it back to its default, as its row on **Edit rig** does, through the dashboard's own code. The other agents keep their models | `{agent?, provider?, model?, clear?, harness?, effort?, context_window?, compact_at?, second_model?, merged_by?}`, below | `{rig, agent, model, context_window, compact_at, said, agents}`. 400 or 404 `{"error":"<why>"}`, below |

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | `workers`, `planner`, `teachers`, `auditor`, `review_panel`, `synthesizer` or `final_writer` | `workers` | Whose model. `synthesizer` and `final_writer` are a research run's writers of its answer cards and of its paper. For the teachers, `provider` and `model` give the first teacher's model, and `harness`, `effort`, `context_window` and `compact_at` are that model's. The names `combiner` and `panel` of v0.1.0 are refused |
| `provider` | string | | The model provider's name in **Providers**. Needed unless `clear` is true, or the request gives the teachers only `second_model` or `merged_by` |
| `model` | string | | A model id from the provider's list. Needed with `provider` |
| `clear` | boolean | false | `true`: the agent goes back to its default: the workers to the rig's own settings, the planner to the workers' model, the synthesizer and the final writer to the first teacher's model, another advisor to the one in the rig's advisors file (off when the file names none). Send it with `agent` alone. For the teachers it clears their second and merged by models too |
| `harness` | `pi`, `opencode`, `claude-code` or `codex` | what the model needs: `claude-code` for a Claude subscription, `opencode` for OpenCode's free models, else `pi` | Any agent. The [harness](glossary.md) it runs in. Each request sets it anew. A harness that can't run the model is refused, as below. The advisors run in the supervisor whatever the harness |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max` | none | How long the model thinks, as **Effort** on **Edit rig** |
| `context_window` | whole number, 4,096 to 100,000,000 | none: the provider's window | Any agent. A cap on its model's [context window](glossary.md), in tokens. The agent's route carries the cap when it is lower than the window the provider lists, else the provider's window. With a provider that lists no window, the cap as given. Each request sets the agent's cap anew: a request without it removes a cap the agent had |
| `compact_at` | whole number, 50 to 95 | none: 80 | Any agent. The share of the context window, in percent, at which the agent's conversation is [compacted](limits-and-pacing.md#compaction) and goes on. The agent's route carries it when it is set. Each request sets it anew: a request without it goes back to 80 A harness older than this setting refuses a route with it: set it only on rigs on images that have it |
| `second_model` | `{provider, model, harness?, effort?, context_window?, compact_at?}` or `null` | as it is | The teachers only. A second teacher, with its own model; each field as for the first teacher's. `null`: one teacher only. A second teacher needs a first: in the same request, or one the teachers have |
| `merged_by` | the same shape, or `null` | as it is | The teachers only. The model that merges the advice of two teachers into one set. `null`: back to the rig's advisors file. With one teacher it is not called; two teachers without one give the first review that comes back as the set |

Control checks every model of a request before it saves any: a refusal changes nothing.

The workers' and the planner's cap and point go to the rig in its model route; each advisor's in its advisor route. A planner with no model of its own uses the workers' route, so their cap and point. A campaign may set its own window and point for its runs ([below](#a-campaigns-context-settings)): each agent's window is then the lower of the two.

In the answer, `agent` is the agent as sent, an old name too. `model` is the model given to the agent itself (for the teachers, the first teacher's), or `null` after `clear` or when the request gave the teachers only `second_model` or `merged_by`. `context_window` is the window that model's route carries, as above. It is `null` when the provider lists none and no cap is set, after `clear`, or when the request gave no such model. `compact_at` is that model's compaction point, or `null` for the default (80), after `clear`, or when the request gave no such model. `agents` is each agent's model after the change, each with its `harness`, `context_cap` and `compact_at`, as [`rig_models`](mcp-tools.md#rig_models) gives them: `teachers` is `{models, merged_by}`. `said` is the dashboard's words, such as `rig-1 takes my-model from "my-litellm" under Pi within a minute, and checks it. Its context window: 131,072 tokens (capped; the provider allows 204,800).` for the workers, or `Control sent a model for the auditor to rig-1. The rig takes the change in less than one minute.` for another agent. The sentence on the cap comes only when a cap is lower than the provider's window, or the provider lists none; `Its conversations are compacted at 70% of the window.` follows when `compact_at` is given. With several models in one request, each one's sentences name it, such as `The second teacher's context window: …`. MCP's [`set_rig_model`](mcp-tools.md#set_rig_model) lists each answer and the agents an advisor's model can come from.

For example, to give a rig's auditor a ChatGPT subscription's model in the Codex CLI and send its planner back to the workers' model:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" \
  -d '{"agent":"auditor","provider":"chatgpt-pro","model":"gpt-pro","harness":"codex","effort":"high"}' \
  "https://control.example.com/v1/rigs/rig-1/model"
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" -d '{"agent":"planner","clear":true}' \
  "https://control.example.com/v1/rigs/rig-1/model"
```

To give the rig two teachers on two subscriptions, merged by a model with an API key:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" \
  -d '{"agent":"teachers","provider":"claude-max","model":"opus-5.5","second_model":{"provider":"chatgpt-pro","model":"gpt-pro"},"merged_by":{"provider":"my-litellm","model":"my-model"}}' \
  "https://control.example.com/v1/rigs/rig-1/model"
```

| Status | Error |
| --- | --- |
| 404 | `no rig <rig>` |
| 400 | `bad request: <field>: <message>`: a body that does not have these fields, or has others, or an unknown `agent` |
| 400 | `Give a provider and a model, or clear: true.` (for the teachers: `Give a provider and a model, second_model or merged_by, or clear: true.`) and `Give clear alone, or a provider and a model.` |
| 400 | `second_model and merged_by are for the teachers only: give agent teachers.` |
| 400 | `The teachers have no model of their own yet: give a provider and a model for the first teacher too.`: a second teacher, and no first |
| 400 | `A Claude subscription runs only in Claude Code: choose Claude Code for <who>, or another model.`, `Claude Code runs only with a Claude subscription here: …`, `Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: …` and `OpenCode's free models run only in OpenCode: choose OpenCode v2 for <who>, or another model.`: a `harness` that can't run the model |
| 400 | `<model> takes at most <n> tokens.`: a cap above the provider's window |
| 400 | `A context window is a whole number of tokens from 4,096 to 100,000,000.` |
| 400 | `The compaction point is a whole percent of the context window, from 50 to 95.` |
| 400 | `That provider does not list that model.` (or with the agent in brackets), and the other refusals of [`set_rig_model`](mcp-tools.md#set_rig_model) |

Each refusal is in the [audit log](#audit-log-actions) as `refused`, with the route's path and why. A model given to the workers, or cleared, is `rig_model_given`, by `owner:api`, with `context_cap` (the cap, or `null`) and `compact_at` (the compaction point, or `null`). One given to another agent, or cleared, is `agent_model_given`, by `owner:api`, with `role` and, for a model given, its `harness`, `context_cap` and `compact_at`: one record for each model the request changes. `role` is `planner`, `teachers` (the first teacher's model), `second_teacher`, `merged_by`, `auditor`, `review_panel`, `synthesizer` or `final_writer`. MCP's [`set_rig_model`](mcp-tools.md#set_rig_model) does the same. [Cap the model's context window](../how-to/models/connect-a-provider.md#cap-the-models-context-window) says when to use the cap, and [Set when a conversation is compacted](../how-to/models/connect-a-provider.md#set-when-a-conversation-is-compacted) the compaction point.

### A rig's settings

The rest of **Edit rig**: the rig's parts, workers at a time, its limits, how its agent programs run, its promotion rule and its GPU split.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/rigs/<rig>/settings` | Owner | The settings the rig reports, and its GPU split, as its **Edit rig** page shows them | None | `{rig, settings, gpu_split}`, as MCP's [`rig_settings`](mcp-tools.md#rig_settings) returns it. `settings` is `null` for a rig whose harness is older and reports none; `gpu_split` is `{set, judge}`, or `null` for a rig with no GPU set to split. 404 `{"error":"no rig <rig>"}` |
| `POST /v1/rigs/<rig>/settings` | Owner | Changes the rig's settings as **Save changes** on **Edit rig** does, through the same checks: only the fields that differ from what the rig reports go to the rig, as one [`rig_settings`](signed-commands.md#rig_settings) command issued by `owner:api` | Any of `{judge, workers, planner, teachers, auditor, review, exports, lanes, trial_minutes, max_turns, quiet_minutes, program_mode, promotion, judge_gpus}`, below | `{rig, id, sent, restarts, said}`, below. 400, 404 or 409 `{"error":"<why>"}`, below |

| Field | Type | Meaning |
| --- | --- | --- |
| `judge`, `workers`, `planner`, `teachers`, `auditor`, `review`, `exports` | boolean | Each part on or off, as its switch in **1 · Parts of the rig**. `review` is the review panel. A part turned off keeps all its data |
| `lanes` | whole number, 1 to 16 | **Workers at a time** |
| `trial_minutes` | whole number, 1 to 1440, or `null` | **One trial lasts (minutes)**, for a campaign whose contract sets no `trial_minutes`. `null`: no limit; a trial lasts until its worker submits or stops |
| `max_turns` | whole number, 1 to 100000, or `null` | **Turns per trial**. `null`: no limit |
| `quiet_minutes` | whole number, 1 to 1440, or `null` | **Ask me after a quiet spell of (minutes)**: a trial with no line for this long asks the owner under **Needs you**. `null`: never |
| `program_mode` | `terminal` or `headless` | **Agent programs run**, under **Advanced** in **2 · The agents**: `terminal` (**In their own terminal**) or `headless` (**Headless**, the default). The next trial takes it |
| `promotion` | `auto` or `owner_approval` | **3 · When a change becomes the champion**: **Automatically** or **Ask me for each change**. A campaign's own rule comes first for its runs |
| `judge_gpus` | whole number, or `null` | **GPUs for the judge**, on a rig set up with its set of GPUs: from 1 to the lower of 8 and one less than the set, with at most 8 left for the agents. `null`: the rig's default split. A new split restarts the rig's harness to regroup the GPUs: running trials and judge jobs start again |

Every field is optional, and one left out stays as the rig has it. Control compares each field given with what the rig last reported (`judge_gpus` with the judge's share now, or, for `null`, with the share the rig keeps) and sends only those that differ, so a script may send back what `GET` read with one field changed. Nothing differing sends nothing.

In the answer, `id` is the `rig_settings` command's id, for [`GET /v1/commands/<id>`](#signed-commands), or `null` when nothing was sent. `sent` is the fields sent, in the command's order, or `{}`. `restarts` is `true` when `sent` has `judge_gpus`. `said` is **Edit rig**'s words: `Control sent 2 settings to rig-1. The rig takes the change in less than one minute.` (`1 setting` for one), followed by `A new split restarts the rig's harness to regroup the GPUs: running trials and judge jobs start again.` when `restarts` is `true`; or `Nothing changed.`. The rig takes the change within a minute, and the run at work on it shows it in its **History**. For example, to give a rig three workers at a time and switch its review panel off:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" -d '{"lanes":3,"review":false}' \
  "https://control.example.com/v1/rigs/rig-1/settings"
```

```json
{"rig":"rig-1","id":"…","sent":{"lanes":3,"review":false},"restarts":false,"said":"Control sent 2 settings to rig-1. The rig takes the change in less than one minute."}
```

| Status | Error |
| --- | --- |
| 404 | `no rig <rig>` |
| 409 | `<rig>'s harness is older: it does not report its settings and cannot take them. They work after its next roll.` |
| 409 | `Control sends no commands to <rig>.` and the reason, for a rig control [refuses](#when-control-refuses-a-rig) |
| 400 | `Not saved: with <n> GPUs the judge takes 1 to <m> of them, and the agents at most 8.` |
| 400 | `Not saved: <rig> has no GPU set to split: its GPUs are set where it is deployed.`: a number for `judge_gpus` |
| 400 | `Not saved: <field>: <problem>`: a value the `rig_settings` command refuses, such as `Not saved: lanes: at most 16: a rig has users for lanes 1 to 16 only` or `Not saved: trial_minutes: Too small: expected number to be >=1` |
| 400 | `bad request: <field>: <message>`: a body that is not these fields, has others, or has a value of the wrong type |

Each refusal is in the [audit log](#audit-log-actions) as `refused`, with the route's path and why; the command sent is `command_issued`, by `owner:api`. MCP's [`set_rig_settings`](mcp-tools.md#set_rig_settings) does the same with the owner's or the operator's token; the operator's may not change `promotion` or `judge_gpus`.

### A cluster rig's GPUs, CPUs and memory

**Edit rig**'s **GPUs**, **CPUs** and **Memory (GiB)** for a rig control set up on a Kubernetes cluster ([Change the rig's GPUs, CPUs and memory](../how-to/install/rig-on-a-cluster.md#change-the-rigs-gpus-cpus-and-memory)).

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/cluster/resources` | Owner | Changes how many GPUs the rig's harness pod asks for, and its CPUs and memory, with the checks of **Add a rig** and the slot's quota read again, then applies its two deployments again with the new size, draining a rig at work first | Any of `{gpus, judge_gpus, cpus, memory_gib, wait, drain_minutes}`, as MCP's [`set_cluster_rig_resources`](mcp-tools.md#set_cluster_rig_resources) takes them | `{rig, said}`. 400, 404 or 409 `{"error":"<why>"}` |

Give only what changes: a field left out stays. `gpus` is 1 to 16 for a rig on GPUs, and a rig on the CPU stays at none. `judge_gpus` goes only with a new number of GPUs; without it, the judge gets half of them, rounded up. `cpus` (at least 1.5) and `memory_gib` (at least 6) are numbers, or `null` for both for the namespace's defaults. `wait` is `true` by default: a rig at work drains first; `false` restarts its pods now. `drain_minutes`, 1 to 10,080, is how long that drain waits before it asks you under **Needs you** ([At its deadline](rig-page.md#at-its-deadline)); left out, the rig's `THERMITE_DRAIN_MINUTES`. MCP's tool gives the answers and the errors word for word. For example, to move a rig from 3 GPUs and the namespace's defaults to 4 GPUs, 16 CPUs and 52 GiB:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" -d '{"gpus":4,"cpus":16,"memory_gib":52}' \
  "https://control.example.com/v1/rigs/rig-1/cluster/resources"
```

```json
{"rig":"rig-1","said":"rig-1's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory."}
```

| Status | Error |
| --- | --- |
| 404 | `Control didn't set <rig> up on a cluster.` |
| 409 | `<rig> is still being set up.`, `<rig> is being updated: …`, `<rig> is starting: …`, `<rig> is draining for an image update: …`, `The cluster <cluster> is no longer in Providers.`, `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): …`, or kubectl's error when the apply failed |
| 400 | A size that the checks refuse, such as `The slot thermite-slot-1 allows 4 GPUs.`, `rig-1 measures on GPUs, and can't move to none: …` or `a rig needs at least 1.5 CPUs and 6 GiB of memory` |
| 400 | `bad request: <field>: <message>`: a body that is not these fields, has others, or has a value of the wrong type |

Each refusal is in the [audit log](#audit-log-actions) as `refused`, with the route's path and why; the change is `cluster_rig_resources`, by `owner:api`. Follow the rig with MCP's [`rig_setup`](mcp-tools.md#rig_setup) or on its page.

### Signed commands

[Signed commands](signed-commands.md) lists every kind and its payload.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/commands` | Owner | Signs a command and queues it for a rig. Control records `owner:api` as its issuer | `{rig?, kind, payload, ttl_minutes}`. `kind` is any kind except `wipe_state`. `rig` may be left out for a kind about one run, below. `ttl_minutes` is 1 to 10080, default 60 | 201 `{"id":"<id>","status":"pending"}`, with `woke` too, in words, when control started the rig's stopped pod first (below). 409 `Not sent: control could not start <rig>'s pod on RunPod for it.` and the reason. 409 for an `assign_campaign` while control's disk is at its floor: `Control's disk is at its floor of 5 GiB: …. No new run starts until there is room: …`. 400 `wipe_state is issued only by a full reset`, `bad <kind> payload: <field>: <message>`, `the <kind> command is too large to deliver`, for an `assign_campaign` whose contract asks for more than 16 lanes `This contract asks for <n> lanes. A rig runs 16 at most: it has users for lanes 1 to 16 only. Set lanes.count to 16 or fewer.`, or, for a `message_agent`, `Write a message first.` or why nothing on the rig would read it, such as `The planner is off on this rig (Edit rig), so nothing would read it.` or `This run has no goal the review panel reviews, so nothing would read it.` ([`message_agent`](signed-commands.md#message_agent) lists them). 404 `unknown rig <rig>`. 400 `Control sends no commands to <rig>.` and the reason, for a rig control [refuses](#rig-versions). 400 for the rig of a run, below |
| `GET /v1/commands` | Owner | The newest commands, with their status and outcome | `limit`, default 100 | `{"commands":[{id, rig, kind, issued_by, issued_at, status, acked_at, outcome}]}`, newest first |
| `GET /v1/commands/<id>` | Owner | One command's status and outcome | None | `{"status":"…","outcome":…}`: the rig's answer is `outcome.result`, and `outcome.source` is `harness` once the rig's signed report confirmed it. 404 `{"error":"not found"}` |
| `POST /v1/commands/<id>/cancel` | Owner | Withdraws a command that is still pending. With the message bus, control also takes it off the rig's subject there, so the rig's supervisor never takes it | None | `{"cancelled":true}`. 404 `{"error":"no such pending command"}` |
| `POST /v1/propagate` | Owner | Sends one run's published champion to another run of the same campaign on another rig, as a `propagate` command that lasts 24 hours. Control knows the rig each run is on | `{run, to_run}`: the run whose champion goes, and the run that tests it | 201 `{"id":"<command id>","seq":<champion seq>}`. 409 with the reason, listed below |

**A run on a stopped RunPod pod.** An `assign_campaign` or a `resume_run` for a [rig launched on RunPod](#rigs-on-a-gpu-cloud) whose pod is stopped starts the pod first, then queues the command, which waits until the pod runs and the rig fetches it. Control checks and signs the command before it starts anything, so a command it refuses never starts a pod. `woke` then says `<rig>'s pod was stopped: control started it. The run starts once the pod runs.`, and the rig's history has the start, with what it was for (`asked by owner:api to assign run <run>`). When the pod can't start, nothing is queued, and the answer is 409 with the start's refusal: no GPU free at RunPod, the spend limit reached, or a stop or terminate under way (`a stop of <rig>'s pod is under way: wait until it has stopped, then start the run again (control then starts the pod first)`). Other kinds, a pod that runs or one already starting, start nothing, and the answer has no `woke`. The dashboard's **Start a run** and its twins ([`POST /v1/campaigns/<campaign>/runs`](#campaigns), MCP's `start_run` and `thermite run start`), a run's **Resume** and MCP's `issue_command` with the owner's token do the same; MCP refuses another token's command or `start_run` for a stopped pod, as only the owner starts a pod.

**A command about one run.** Each kind whose payload names a `run`, except `assign_campaign`, is about that run: `pause_run`, `resume_run`, `close_run`, `redirect`, `reset_workers`, `message_agent`, `unkeep_message`, the `queue_*` kinds, `drop_directive`, `hypothesis_status`, `propagate`, `stop_trial`, `approve_promotion`, `decline_promotion`, `accept_review` and `conclude`. Control sends it to the rig the run is on, so `rig` may be left out. A `rig` given must be one the run's name is used on. Control refuses, with 400:

- `Run <run> is on <rig>, not on <rig>.`
- `Control knows no run <run>: name a run a rig reported.`, with no `rig`
- `Run <run> is an earlier run: <rig> is retired, so it takes no commands.`
- `Run <run> is an earlier run: it ran on <rig> before the rig's full reset, so it takes no commands.`
- `A <kind> command names its rig: give the rig.`, for any other kind with no `rig`

`POST /v1/commands` takes the owner's commands for a run's experiment queue like any other kind: `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive`. It also takes `close_run`, `{"run": "run-1", "reason": "another run finished the work"}`, which ends a run for good: [`close_run`](signed-commands.md#close_run) says what the rig does, and refuses a run already closed. A reason of spaces alone is refused: `400 {"error":"bad close_run payload: reason: …"}`. It takes [`invalidate_evidence`](signed-commands.md#invalidate_evidence) too, which withdraws bad evidence in two steps: first `{"run": "run-1", "attempt": "a-0123abcd4567ef89", "reason": "…", "preview": true}`, then, once `GET /v1/commands/<id>` shows the rig's answer (its `outcome.source` is `harness`), the same payload with `"reach"` set to the `sha` in `outcome.result` and no `preview`. A withdrawal without `reach` is refused before it is signed: `400 {"error":"bad invalidate_evidence payload: reach: send a preview first (preview: true), then the sha it gave as reach"}`. [Withdraw bad evidence](../how-to/campaigns/withdraw-bad-evidence.md) shows it. A command's status is `pending`, `delivered`, `rejected`, `failed` or `expired`; [Statuses](signed-commands.md#statuses) says what each means and what its outcome holds. A cancelled command shows `failed`, with the outcome `{"cancelled_by":"owner:api"}`. [Cancel a pending command](../how-to/operate/cancel-a-command.md) gives the steps.

`POST /v1/propagate` refuses with one of these:

- `no run <run>`, for either run
- `<run> and <to_run> are on one rig: propagate between two rigs`
- `the source run has no champion beyond its seed`
- `champion seq <n> is not published yet (it is published with the rig's next export)`
- `<to_run> runs <campaign>, not <campaign>`
- `the target works on <repo>, the champion is in <repo>`
- `Control sends no commands to <rig>.` and the reason, when control [refuses](#rig-versions) the receiving rig

[Run a campaign on several rigs](../how-to/campaigns/several-rigs.md) says when to propagate.

### Campaigns

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/campaigns/<campaign>/runs` | Owner | Starts a run of a campaign control keeps, as **Start a run** on the campaign's page does, through the dashboard's own code. Control records `owner:api` as the command's issuer | `{rig, agents?, agents_model?, promotion?, ask_owner?, judge_gpus?, queue_from?, past?}`, below | 201 `{started: true, campaign, rig, run, command, status: "pending", woke?, notes?, agents_context?}`. 202 `{started: false, said}` when control gave the rig a model first. 400, 404 or 409 `{"error":"<why>"}`, below |
| `POST /v1/campaigns/<campaign>/context` | Owner | Sets the campaign's own context window and compaction point for all its runs' agents: a new version of its contract. Control records `owner:api` as who saved it | `{context_window?, compact_at?}`, [below](#a-campaigns-context-settings). `{}` removes them | 201 `{campaign, version, contract_sha, agents_context, said}` for a new version, 200 when the newest has them already. 400 or 404 `{"error":"<why>"}` |
| `POST /v1/campaigns/<campaign>/additions` | Owner | Sets your additions to the campaign's agent roles: a new version of its contract. Control records `owner:api` as who saved it | `{additions?}`, [below](#the-owners-additions-to-a-campaigns-roles). `{}` removes them | 201 `{campaign, version, contract_sha, role_additions, said}` for a new version, 200 when the newest has them already. 400 or 404 `{"error":"<why>"}` |

`<campaign>` is a campaign saved on control from the **New campaign** page, or one assigned before over the API, MCP or the command line. For a saved one, control signs an assignment of its latest version, as the rig fetches the project and the kit from where the campaign says. For one assigned before, control assigns its newest `assign_campaign` again, with the same contract, starting point and imports, as a new run ([`assign_campaign`](signed-commands.md#assign_campaign)).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `rig` | string | | The rig the run starts on. A rig runs one run at a time: the run at work there pauses when this one starts |
| `agents` | boolean | `true` | `false`: a try, with no agents. The judge alone measures the starting point: a hill climb's [baseline](contract.md#the-baseline), or a goal campaign's check of every goal. The run is named `<campaign>-try-<n>` |
| `agents_model` | `{provider, model}` | none | For a rig with no model for its agents: a model from a provider in **Providers**. Control gives it to the rig, with the harness the model needs (the rig's own when control gave it this model already), and answers 202 without starting the run. Send the request again, without the field, once the rig runs the model |
| `promotion` | `auto` or `owner_approval` | the rig's default | When a change is confirmed better: keep it at once, or wait for the owner |
| `ask_owner` | `{above_gain?, declared_flaws?, reviews?, not_possible?}` | nothing | **Ask me first about**. `above_gain`, a fraction: a confirmed gain above it waits for the owner (0.15 is 15%); `declared_flaws`, `true`: a win whose worker declared flaws waits; `reviews`, `true`: a review panel's pass waits for the owner's acceptance; `not_possible`, `true`: a "not possible" proposal waits. See [Decide what waits for you](../how-to/campaigns/decide-what-waits.md#choose-what-waits) |
| `judge_gpus` | whole number | the rig's current split | For a rig with several GPUs: how many the judge measures on. Control sends the rig a `rig_settings` with the new split after the run's command, and the rig's harness restarts to apply it |
| `queue_from` | string | none | Another run of this campaign, by its name: any run of it, one of a retired rig or from before a full reset too. Its untried experiments start the new run's queue: up next in their order, then its lanes' ideas, each with its words and author from control's records |
| `past` | array of whole numbers | none | Items of Thermite's knowledge base by id, from folders the campaign may read. MCP's [`kb_search`](mcp-tools.md#kb_search) gives the ids. Experiments join the queue after the copied ones, each with what became of it in its run; findings, claims, notes and reports become the run's `briefing`, with the knowledge base's words |

The queue holds at most 500 experiments. In the 201 answer, `run` is the new run's name and `command` its `assign_campaign` command's id, for `GET /v1/commands/<id>`. `woke` is there when control started the rig's stopped RunPod pod first, as [below](#signed-commands) for `POST /v1/commands`. `notes` is there when there is more to know, such as `sort-speed-1 is at work on rig-1, and pauses when this run starts (a rig runs one run at a time).` or `sort-speed-1 has no untried experiments: the new run's queue starts empty.` `agents_context` is there when the campaign sets its own context settings and the run has agents: what each agent works with on the rig, as MCP's [`start_run`](mcp-tools.md#start_run) says, and a note says it in words. In the 202 answer, `said` is `<rig> takes <model> within a minute; Settings › Providers shows it taking the model until then. Then start the run again.`

Control refuses, in the words of **Start a run**, and signs nothing:

| Status | Error |
| --- | --- |
| 404 | `Control has no saved version or earlier assignment of this campaign.` |
| 404 | `No rig is called <rig>. Choose a rig.` |
| 404 | `<campaign> has no run <run>: copy from a run of this campaign.` (`queue_from`) |
| 400 | `bad request: <field>: <message>`: a body that does not have these fields, or has others |
| 400 | `A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.` |
| 400 | `An item from past research is not one this campaign may read and start from: search again.` |
| 400 | `That provider does not list that model.`, and the other refusals of a model on **Edit rig** |
| 400 | `<rig> has no GPU set to split: its GPUs are set where it is deployed.` or `With <n> GPUs the judge takes 1 to <m> of them, and the agents at most 8.` |
| 409 | `<rig> has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.` |
| 409 | `<rig> has not taken <model> yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.` |
| 409 | `<rig> measures on <type>, and this campaign's kit measures on <type>: choose a rig with that hardware` |
| 409 | `<model> is one of OpenCode's free models, which work only inside OpenCode, and <rig>'s agents would run in Pi: a research run there could not work. …`, for a research campaign |
| 409 | `This campaign sets a context window of <n> tokens. <model>, the model of the <agent> on <rig>, takes at most <m> tokens. Set the campaign's window to <m> or less, or give that agent another model.`: the campaign's window is above what a provider lists for the model control gives one of the rig's agents |
| 409 | `Not sent: control could not start <rig>'s pod on RunPod for it.` and the reason |
| 409 | `Control sends no commands to <rig>.` and the reason, for a rig control [refuses](#rig-versions) |

Each refusal is in the [audit log](#audit-log-actions) as `refused`, with the route's path and why. MCP's [`start_run`](mcp-tools.md#start_run) and [`thermite run start`](command-line.md#run-start) do the same; [Start a run from a script or an agent](../how-to/campaigns/start-from-dashboard.md#start-a-run-from-a-script-or-an-agent) shows them side by side.

#### Copy a campaign

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/campaigns/<campaign>/copy` | Owner | Saves a new campaign with another name, the same contract and the same kit as `<campaign>`, as **Copy** on the campaign's page does. Control records `owner:api` as who copied it | `{name, mcp_servers?, agents_context?, notes?, links?, ideas?, hypotheses?}`: the copy's name and, for a research campaign, its MCP servers, its own context settings, and its own brief. At most 4 MiB | 201 `{campaign, version, contract_sha, from, agents_context?}`. 400, 404 or 409 `{"error":"<why>"}`, below |

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" -d '{"name":"sort-speed-b"}' \
  "https://control.example.com/v1/campaigns/sort-speed/copy"
```

```json
{"campaign":"sort-speed-b","version":1,"contract_sha":"<sha256>","from":{"campaign":"sort-speed","version":2}}
```

The copy is the campaign's newest saved version or, for a campaign only assigned before, its newest `assign_campaign`: the same contract, starting point, imports and kit. Control saves it as the copy's version 1, approved by the owner:

- **Its name.** The contract's `campaign` is the copy's name, and its `version` is 1. So `contract_sha`, the contract's SHA-256, is the copy's own.
- **Its folder.** The copy has its own folder in [Thermite's knowledge base](knowledge-base.md), which starts empty. It reads no other folder, and no other campaign reads it, until someone [grants](knowledge-base.md#grants) it.
- **No runs.** Start one with [`POST /v1/campaigns/<copy>/runs`](#campaigns), MCP's `start_run`, `thermite run start` or **Start a run** on the copy's page.
- **Where it came from.** `from` is `{campaign, version}` for a saved version, or `{campaign, rig, run}` for an assignment. The [audit log](#audit-log-actions) has `campaign_copied`, with the copy, `from` and `sha`, and `campaign_version_created`. The copy's page says `Copied from <campaign> version <n> by you, <time> ago. Its folder in the knowledge base started empty.`, with `just now` in its first minute: the dashboard is the owner's, so the owner's copy, over any route, is `you`, and one made with the operator's token over MCP is `the operator`.
- **What it leaves out.** An assignment's run options stay with that run: its run name, agents on or off, promotion, what it asks you first (`ask_owner`), queue and briefing.
- **Its MCP servers.** A research campaign keeps its agents' MCP servers in its contract. `mcp_servers` gives the copy others, in place of the source's: a list of `{name, agents, tools?}`, as the contract's [`mcp_servers`](kit-manifest.md) has it, with `agents` among `workers` and `advisors` (a research run's planner takes no servers). `[]` names none. Control checks it as the **New campaign** page does: each server is in Settings, and each tool named is one the server lists. The copy's `contract_sha` changes with the list. When the list differs from the source's, `from` has `"other_mcp_servers": true`, `campaign_copied` has the copy's `mcp_servers`, and the copy's page adds `Its agents use other MCP servers than its source's: <servers>.`, or `Its agents use no MCP server. Its source's agents use some.` A hill-climb or goal campaign names its servers in its kit's kit.json, which a copy does not change: control refuses `mcp_servers` for it.
- **Its context settings.** The copy keeps the source's [context settings](#a-campaigns-context-settings), if any. `agents_context`, `{context_window?, compact_at?}`, gives the copy its own in place of them; `null` or `{}` gives it none. The copy's `contract_sha` changes with them, `campaign_copied` has the copy's `agents_context`, and the answer has `agents_context` when the copy has any.
- **Its brief.** The copy keeps the source's [brief](contract.md#the-campaigns-brief): its additional information, starting links, ideas to try and hypotheses. `notes` (text, in Markdown), `links`, `ideas` and `hypotheses` (lists of text) each give the copy its own part in place of the source's; a research copy's `links` are its `seeds`; `""`, `null` or `[]` gives it none. Entries are trimmed, and empty ones are left out. The copy's `contract_sha` changes with them, and `campaign_copied` has `own_brief`, the parts given, such as `["notes", "ideas"]`.

Control refuses, and saves nothing:

| Status | Error |
| --- | --- |
| 404 | `Control has no saved version or earlier assignment of <campaign>. There is nothing to copy.` |
| 400 | `<campaign> is a rig check's campaign. A rig check cannot be copied.` |
| 400 | `A campaign's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit.` |
| 400 | `A name that starts with rig-check- is for rig checks. Choose another name.` |
| 400 | `bad request: <field>: <message>`: a body without `name`, with other fields, or with an `mcp_servers` that is not a list of servers |
| 400 | `This campaign's MCP servers are in its kit's kit.json: change them on the New campaign page.`: `mcp_servers` for a hill-climb or goal campaign |
| 400 | `Settings has no MCP server named <server>. Add it in Settings › MCP servers, or take it out of mcp_servers.` |
| 400 | `<server> has no tool named <tool>. Its tools are <tools>.` |
| 400 | `Control has not read the tools of <server> yet. Read them in Settings › MCP servers, or give the <kind> all its tools.` |
| 400 | `A research run's planner takes no MCP server: it plans from the run's own records. Give <server> to the workers or the advisors.` |
| 400 | `A context window is a whole number of tokens from 4,096 to 100,000,000.` or `The compaction point is a whole percent of the context window, from 50 to 95.`: `agents_context` out of range |
| 409 | `There is a campaign named <name> already. Choose another name.`: a campaign control keeps, one a rig reported, a folder in the knowledge base, or a name in a grant |
| 409 | `The contract of <campaign> is not valid, so control cannot copy it:` and the contract's errors, for an assignment whose contract the contract check refuses; `The copy's own brief is not valid:` and the errors, for a copy whose own brief (for example a `links` entry that is not a web address) makes its contract invalid |
| 400 | `Ideas to try are for hill-climb and goal campaigns. A research campaign has questions and hypotheses.`, for `ideas` with a research campaign |

Each refusal is in the audit log as `refused`, with the route's path and why. MCP's [`copy_campaign`](mcp-tools.md#copy_campaign) and [`thermite campaign copy`](command-line.md#campaign-copy) do the same. [Compare two models from zero](../how-to/campaigns/start-from-dashboard.md#compare-two-models-from-zero) says when to copy.

#### A campaign's context settings

`POST /v1/campaigns/<campaign>/context` sets the context window and the compaction point that every agent of the campaign's runs works with: the workers, the planner and the advisors, as **Agents' context** on the campaign's page does. The rig sets the defaults, with each agent's model ([above](#the-agents-model)); a campaign may set its own.

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" -d '{"context_window":131072,"compact_at":70}' \
  "https://control.example.com/v1/campaigns/sort-speed/context"
```

```json
{"campaign":"sort-speed","version":3,"contract_sha":"<sha256>","agents_context":{"context_window":131072,"compact_at":70},"said":"Version 3 of sort-speed is saved. Its runs' agents: a context window of 131,072 tokens, compaction at 70% of the window. Runs started from now take it."}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `context_window` | whole number, 4,096 to 100,000,000 | none: each agent's own | The most tokens of context window each agent works with. Each agent's window is the lower of this and its own: its provider's window, or the rig's cap on it |
| `compact_at` | whole number, 50 to 95 | none: each agent's own, else 80 | The share of the window, in percent, at which each agent's conversation is [compacted](limits-and-pacing.md#compaction), in place of the rig's point |

- **A new version.** Control saves the campaign's contract again as its next version, approved by the owner, with the settings in its [`agents_context`](contract.md#agents-context) and the sources of its newest version. A request with neither field removes them. When the newest version has the same settings already, control saves nothing and answers 200. A campaign control knows only by an assignment gets its first saved version, from that assignment, numbered after the assignment's contract: a rig's harness takes only a newer version.
- **Runs started from then.** Each run keeps the version it started with, so its settings never change under it. [`POST /v1/campaigns/<campaign>/runs`](#campaigns) then says what applies to each agent, and refuses a window above what a provider lists for one of the rig's agents' models; above a rig's cap, the lower wins.
- **Older rigs.** A rig whose harness is older than this change refuses a contract with `agents_context`: set it only for runs on rigs on these images.

| Status | Error |
| --- | --- |
| 404 | `Control has no saved version or earlier assignment of <campaign>. Save it on the New campaign page first.` |
| 400 | `bad request: <field>: <message>`: a body with other fields, or a value that is not a number |
| 400 | `<campaign> is a rig check's campaign. Its agents keep the rig's settings.` |
| 400 | `A context window is a whole number of tokens from 4,096 to 100,000,000.` |
| 400 | `The compaction point is a whole percent of the context window, from 50 to 95.` |
| 409 | `The contract of <campaign> is not valid, so control cannot save a new version:` and the contract's errors |

Each refusal is in the audit log as `refused`, with the route's path and why; a new version is `campaign_context_set` and `campaign_version_created`, by `owner:api`. MCP's [`set_campaign_context`](mcp-tools.md#set_campaign_context) and [`thermite campaign context`](command-line.md#campaign-context) do the same.

#### The owner's additions to a campaign's roles

`POST /v1/campaigns/<campaign>/additions` sets your additions to the campaign's agent roles: your own words added to a role's instructions in every prompt of that role in the campaign's runs, as **Your additions to the agents' roles** on the campaign's page does. They go in the contract's [`role_additions`](contract.md#your-additions-to-the-agents-roles).

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  -H "content-type: application/json" \
  -d '{"additions":{"worker":"Keep each change small enough to read in one sitting."}}' \
  "https://control.example.com/v1/campaigns/sort-speed/additions"
```

```json
{"campaign":"sort-speed","version":4,"contract_sha":"<sha256>","role_additions":{"worker":"Keep each change small enough to read in one sitting."},"said":"Version 4 of sort-speed is saved, with additions for worker. Runs started from now take it."}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `additions` | object: a role's id and its text | none | Each role's addition, by its id: `worker`, `planner`, `teacher`, `merged-by`, `auditor` or `reviewer` for a hill-climb or goal campaign; `research-worker`, `research-planner`, `research-teacher`, `research-merged-by`, `research-reviewer`, `synthesizer` or `final-writer` for a research campaign. Each text at most 20,000 characters; an empty one leaves its role out |

- **Set anew.** Each request sets them anew: a role it leaves out has none in the new version, and a request with none removes them all. When the newest version has the same additions already, control saves nothing and answers 200. As for the context settings, a campaign control knows only by an assignment gets its first saved version from it.
- **Runs started from then.** Each run keeps the version it started with. Every prompt of a role carries its addition as a section of its own, after the role's text, labelled as yours ([Agent roles](agent-roles.md#your-additions-to-a-role)).
- **Older rigs.** A rig whose harness is older than this change refuses a contract with `role_additions`.

| Status | Error |
| --- | --- |
| 404 | `Control has no saved version or earlier assignment of <campaign>. Save it on the New campaign page first.` |
| 400 | `bad request: <field>: <message>`: a body with other fields, or a text that is not a string |
| 400 | `<campaign> is a hill climb campaign: it runs no research-worker. Its roles are worker, planner, teacher, merged-by, auditor, reviewer.`: a role the campaign's mode never runs |
| 400 | `<campaign> is a rig check's campaign. Its agents keep their roles' own texts.` |
| 409 | `The contract of <campaign> is not valid, so control cannot save a new version:` and the contract's errors, such as `role_additions.worker: an addition has at most 20,000 characters` |

Each refusal is in the audit log as `refused`, with the route's path and why; a new version is `campaign_additions_set` (the campaign, its new version and `sha`, and the `roles` it has additions for) and `campaign_version_created`, by `owner:api`. MCP's [`set_campaign_additions`](mcp-tools.md#set_campaign_additions) and [`thermite campaign additions`](command-line.md#campaign-additions) do the same.

#### Archive a campaign, and folders

An archived campaign is out of the dashboard's left navigation, **Needs you** and the Overview's lists; **Campaigns › Archived** lists it. Its runs, results, kits and folder in the knowledge base stay. Folders group campaigns in the left navigation, and nothing else: they are not the campaigns' folders in the knowledge base. These routes do what **Archive**, **Unarchive** and **Move to folder** on a campaign's page and the navigation's folders do, with the same refusals ([Archive campaigns and sort them into folders](../how-to/campaigns/archive-and-folders.md)).

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/campaigns/<campaign>/archive` | Owner | Archives the campaign. It keeps its folder: the navigation neither shows nor counts it there while it is archived | None | `{campaign, archived: true, at, by, folder, changed}`. `folder` is the folder it keeps, or `null`. `changed` is `false` when it was archived already. 404 or 409 `{"error":"<why>"}`, below |
| `POST /v1/campaigns/<campaign>/unarchive` | Owner | Unarchives it: it comes back to the navigation, in the folder it kept, and its runs may start again | None | `{campaign, archived: false, at: null, by: null, folder, changed}`. `folder` is the folder it is back in, or `null`. `changed` is `false` when it was not archived. 404 |
| `POST /v1/campaigns/<campaign>/folder` | Owner | Puts the campaign in a folder, or in none. An archived campaign may move too: it comes back into its new folder when it is unarchived | `{folder}`: the folder's name, whatever its case, or `null` for none | `{campaign, folder, changed}`: `folder` is the folder's name, or `null`. 400 or 404 |
| `GET /v1/campaign-folders` | Owner | The folders, by name, and the archived campaigns, the newest first | None | `{"folders":[{name, campaigns, created_at, created_by}], "archived":[{campaign, at, by, folder}]}`. `campaigns` lists the campaigns in the folder, by name, archived ones too. An archived campaign's `folder` is the folder it keeps, or `null` |
| `POST /v1/campaign-folders` | Owner | Makes a folder | `{name}` | 201 `{"folder":{name, campaigns, created_at, created_by}}`. 400 or 409 |
| `POST /v1/campaign-folders/<folder>/rename` | Owner | Renames a folder; its campaigns stay in it | `{name}`: the new name | `{folder: {name, campaigns, created_at, created_by}, was, changed}`. 400, 404 or 409 |
| `POST /v1/campaign-folders/<folder>/delete` | Owner | Deletes a folder with no campaign in it, archived ones included | None | `{deleted}`: its name. 404 or 409 |

`<folder>` is the folder's name, URL-encoded, whatever its case. A folder's name is one line of at most 40 characters, trimmed, and two folders can't have the same name, whatever its case.

While a campaign is archived, control refuses `assign_campaign` and `resume_run` for it, on every path that signs them ([`POST /v1/commands`](#signed-commands), [`POST /v1/campaigns/<campaign>/runs`](#campaigns), MCP and the command line), with `<campaign> is archived. Unarchive it first.`

| Status | Error |
| --- | --- |
| 404 | `Control has no campaign named <campaign>.` |
| 409 | `Pause or close its runs first.`, then each run that is at work, `<run> is at work on <rig>.`, or that waits to start, `<run> waits to start on <rig>.`, at most three, then `And <n> more.` A run waits to start when control has sent its rig an `assign_campaign` or a `resume_run` that the rig has not taken yet, or the rig took an assignment in the last ten minutes and has not reported its run yet |
| 404 | `There is no folder named <folder>.` |
| 400 | `Give the folder a name.`, `A folder's name is at most 40 characters.` or `A folder's name is one line of text.` |
| 409 | `There is a folder named <name> already.` |
| 409 | `<folder> is not empty. Move its campaign out first: <campaign>.`, or `Move its <n> campaigns out first:` and the first five. An archived campaign is named `<campaign> (archived)`: the navigation does not show it, but it is in the folder |
| 400 | `bad request: <field>: <message>`: a body with other fields, or a value of the wrong type |

Each refusal is in the audit log as `refused`, with the route's path and why. Each change is there too, by `owner:api`: `campaign_archived`, `campaign_unarchived`, `campaign_moved`, `campaign_folder_created`, `campaign_folder_renamed` and `campaign_folder_deleted` ([Audit log actions](#audit-log-actions)). MCP's [`archive_campaign`](mcp-tools.md#archive_campaign) and the tools after it do the same.

### Kits control keeps

Control keeps kits as git repositories: those the **New campaign** page writes, and kit repositories written elsewhere that the owner gives it as a [git bundle](https://git-scm.com/docs/git-bundle). Control keeps every commit of a bundle with its id, and a rig fetches the kit from control, by commit, with `{"control": "kits/<name>"}` as the [import's source](signed-commands.md#imports). [Give control a kit you wrote elsewhere](../how-to/campaigns/write-a-kit.md#give-control-a-kit-you-wrote-elsewhere) shows the steps.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/kits/<name>` | Owner | Takes a git bundle of a kit repository. Control checks it in a repository of its own (`git bundle verify`; a bundle that builds on the kit's commits may leave them out), keeps every commit it holds, and makes the kit's head the bundle's `HEAD`, its only branch, or `ref`. That commit must have a `kit.json` at its top that the harness takes. A kit control keeps already moves only to a commit that descends from its head, unless `force`; the old head's commits stay even then. Control records `owner:api` | The bundle's bytes, up to 64 MiB (`application/octet-stream`). `?ref=<ref>`: a branch or a tag the bundle has (`main`, `refs/heads/main`, `v1`), or a full commit id in it. `?force=true` | 201 for a new kit, else 200: `{name, head, previous, commits, kit, forced, refs, size, said}`, below. 400, 404, 409 or 413 `{"error":"<why>"}`, below |
| `GET /v1/kits` | Owner, reader | The kits control keeps, by name | None | `{"kits":[{name, head, commits, kit}]}`: each kit's head commit, the number of commits in the head's history and `kit.json`'s `{name, target}`. `kit` is `null`, with `kit_error`, when the head's `kit.json` is not one the harness takes. 404 `this control keeps no kits` |
| `GET /v1/kits/<name>` | Owner, reader | One kit, and its newest commits | None | `{name, head, commits, kit, history}`: `kit` is `{name, target, cells, metrics, verifiers, mcp_servers}` (or `null`, with `kit_error`), and `history` is `[{commit, at, subject}]`, the newest 20 commits of the head's history. 404 `control keeps no kit <name>` |

`<name>` is the kit's name in control: lowercase letters, digits, dots, dashes and underscores, at most 64, starting with a letter or a digit. Give a kit the name the contract's `project.kit.repo` has, as the **New campaign** page does for the kits it writes.

In the answer to `POST /v1/kits/<name>`, `head` is the kit's head now and `previous` the head before (`null` for a new kit). `commits` is the number of commits in the head's history. `kit` is `kit.json`'s `{name, target}`. `forced` is `true` when the head was replaced by a commit that does not descend from it. `refs` lists the bundle's refs as `[{ref, commit}]`, and `size` its bytes. `said` is the same in words, such as `Control keeps the kit lab-kit at 5f0c1d2e3a4b (12 commits). Rigs fetch it with the source {"control": "kits/lab-kit"}.`, `The kit lab-kit at 9a8b7c6d5e4f (13 commits) follows the head 5f0c1d2e3a4b.`, or, for the same bundle again, `… is already its head: nothing changed.`

| Status | Error |
| --- | --- |
| 400 | `not a kit name: "<name>" (lowercase letters, digits, dots, dashes and underscores, at most 64, starting with a letter or digit)` |
| 400 | `the bundle is empty` |
| 400 | `not a git bundle control can take: ` and git's words, such as `'the bundle' does not look like a v2 or v3 bundle file`, or `Repository lacks these prerequisite commits: <commit>` for a bundle that builds on commits control does not have |
| 400 | `the bundle has no HEAD and <n> branches (<names>): name the one to use with ref` |
| 400 | `the bundle has no ref <ref>: it has <names>`, or `the bundle has no commit <commit>` |
| 400 | `the bundle's head <commit> has no kit.json at its top` |
| 400 | `kit.json at <commit> is not JSON`, or `kit.json at <commit>: ` and each problem as `<field>: <message>`, as the harness would refuse it |
| 400 | `force is true or false` |
| 404 | `this control keeps no kits` |
| 409 | `the bundle's head <commit> does not descend from the kit's head <commit>: give force to make it the head (control keeps the old head's commits)` |
| 409 | `the kit <name> changed while control took the bundle: send it again` |
| 413 | `the bundle is above the 67108864 bytes (64 MiB) control takes` |

Each refusal is in the audit log as `refused`, with the route's path and why; each kit taken is there as `kit_added`, by `owner:api`, with the kit's `name`, `head`, `previous`, `commits`, `forced`, `size` and `by`. MCP's [`kit_add`](mcp-tools.md#kit_add) does the same with the owner's or an operator's token, for a bundle of at most 3,000,000 bytes, and [`kits`](mcp-tools.md#kits) reads. [`thermite kit add`](command-line.md#kit-add) sends a bundle file to this route.

### Rig keys, enrollment and retirement

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/key/accept` | Owner | Accepts the report key a rig is waiting with, if its fingerprint matches | `fingerprint` in the query: the first 16 hexadecimal characters of the SHA-256 of the key's PEM text | `{"accepted":true}`. 404 `{"error":"no pending key"}`, also for a wrong fingerprint |
| `POST /v1/rigs` | Owner | Enrolls a rig: control makes its token, returns it once and keeps only its SHA-256. A retired rig enrolled again comes back | `{"rig":"<name>"}` and nothing else. A name is 2 to 40 characters of `a-z`, `0-9` and `-`, and starts and ends with a letter or digit | 201 `{rig, token, control_public_key, control_fingerprint, bus}`: `bus` is `{url, ca}`, the message bus's address for rigs and the certificate of control's authority for it, or `null` when control runs no bus for rigs. 409 `rig <rig> is already enrolled` or `rig <rig> has its token in control's rig tokens file; change it there`. 400 `invalid request` for a bad name |
| `POST /v1/rigs/<rig>/token` | Owner | Gives an enrolled rig a new token. The old one stops working at once | None | `{rig, token}`. 409 for a rig in the rig tokens file. 404 `rig <rig> is not enrolled` |
| `POST /v1/rigs/<rig>/retire` | Owner | Retires any rig: enrolled, in the rig tokens file, or one that only reported. It leaves the lists, its reports are refused and a token control made ends. Nothing stops on the machine | None | `{rig, retired:true}`, plus `note: "its token is in control's rig tokens file: remove it there too"` for a rig in that file. 404 `no rig <rig>` |
| `POST /v1/rigs/<rig>/bring-back` | Owner | Brings a retired rig back into the lists. A token control made stays ended | None | `{rig, retired:false}`. 404 `rig <rig> is not retired` |

[Accept a rig's key](../how-to/operate/accept-a-rig-key.md) and [Make and change tokens](../how-to/operate/tokens.md) give the steps.

### Restart and full reset

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/restart` | Owner | Restarts the rig's containers through the deployment driver that `THERMITE_LIFECYCLE` names. A rig launched on RunPod needs no setting: its pod stops and starts again through RunPod's API ([Stop, start, restart and terminate](#stop-start-restart-and-terminate)) | `{"components":["harness","supervisor"]}`, or no body for both. On RunPod, both parts restart together | `{"restarted":[…]}`; on RunPod, `{"restarted":["pod <pod>: it stops, then starts again"]}`. 409 `{"error":"no deployment driver is configured"}`; on RunPod, 409 with the reason, such as `a rig on RunPod runs its harness and its supervisor in one container: they restart together`. 500 with the driver's error |
| `POST /v1/rigs/<rig>/reset` | Owner | Starts a full reset: pause, export, verify the push, wait for the owner, wipe, restart | `{"confirm":"reset <rig>"}` | 201 `{"reset":<id>}`. 400 `confirm with "reset <rig>"`. 409, for a rig on RunPod, `<rig>'s pod is stopped: start it first, so its results can leave it before the wipe`, or `a stop of <rig> is under way: wait until it ends` (likewise a start, a restart or a terminate), and `a reset of <rig> is already in progress` |
| `GET /v1/resets` | Owner | The newest 20 resets | None | `{"resets":[{id, rig, state, requested_by, command, export_name, through_event, detail, created_at, updated_at}]}` |
| `POST /v1/resets/<id>/confirm` | Owner | Confirms the wipe of a reset that waits for the owner | None | `{"ok":true}`. 409 `no reset <id>` or `reset <id> is <state>, not waiting for confirmation` |
| `POST /v1/resets/<id>/cancel` | Owner | Cancels a reset before its wipe. The rig's campaigns stay paused | None | `{"ok":true}`. 409 `no reset <id>`, or `reset <id> is <state>` once it is wiping or has ended |

A reset moves through these states. Control moves open resets on every 10 seconds; a step that takes longer than its limit fails the reset, and the rig's campaigns stay paused.

| State | What happens | Limit |
| --- | --- | --- |
| `start` | Control pauses the rig's running runs | |
| `quiescing` | Waits until the judge has no queued or running jobs and no command is pending | 1 hour |
| `exporting` | A full export, until the harness reports it | 30 minutes |
| `verifying` | Waits until the supervisor reports the export pushed to the results repository, or, for a rig without one, until control holds every file of it. On RunPod, also until no other export or champion's patch waits on the pod. Fails at once if the rig has nowhere to send it | 1 hour |
| `awaiting_owner` | Waits for the owner to check the pushed commit and confirm | 24 hours |
| `confirmed` | Control sends the signed wipe | |
| `wiping` | Waits for the harness to report the wipe, then restarts the rig | 30 minutes |
| `done`, `failed`, `cancelled` | Ended. `detail` says why | |

The commands a reset sends last 30 minutes and carry the owner who asked as their issuer. [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md) gives the steps.

On a rig launched on RunPod, a reset starts only while its pod runs and no stop, start, restart or terminate is under way; one asked for otherwise (from the dashboard, say) fails at its `start` state with the same reason. At `wiping`, the pod and its GPU stay: the harness and the supervisor restart themselves in it, and `detail` says `wiped; the pod and its GPU stay: the harness and the supervisor restarted themselves in it`. Its steps are in the rig's history (`reset_requested`, `reset_done`, `reset_failed`, `reset_cancelled`).

### Audit log

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/audit` | Owner | One page of control's audit log, newest first, MCP calls included | `limit`, default 200. `before`: only entries older than this cursor. `after`: only entries newer than it, the page just after the cursor | `{"audit":[{id, at, actor, action, body}], "older", "newer"}`. 400 `before and after are whole numbers`, or `give before or after, not both` |

To page through the whole log, give `older` as `before` for the next older page, and `newer` as `after` for the next newer one. Each is `null` when no entry is left that way. For example, `GET /v1/audit?limit=500` answers the newest 500 entries and `"older":3512`; then `GET /v1/audit?limit=500&before=3512` answers the 500 before them. [Audit log actions](#audit-log-actions) lists the actions. [Tokens and roles](tokens.md#in-the-audit-log) lists the actors.

### GPU-cloud test pods

These test whether a rig can run on a RunPod GPU. [Test a GPU on RunPod](../how-to/install/runpod-test.md) gives the steps.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/gpu-clouds/<name>/tests` | Owner | The tests on one GPU cloud from **Providers**, newest first, at most 20 | None | `[test]`. A cloud with no tests, or no such cloud, gives `[]` |
| `POST /v1/gpu-clouds/<name>/tests` | Owner | **Spends money.** Starts one test pod of the CUDA harness image or the one-container rig image. One test runs on a cloud at a time | `{gpu, cloud_type, image, disk_gb, restart, stop_after_minutes}`, all optional, nothing else. Defaults: the cheapest GPU in stock, `SECURE`, `THERMITE_RUNPOD_TEST_IMAGE`, a 40 GB disk, a stop and start after the first report (`restart: true`), and no time limit | 201 `test`. 409 with the reason |
| `GET /v1/gpu-cloud-tests/<id>` | Owner | One test | None | `test`. 404 `{"error":"not found"}` |
| `POST /v1/gpu-cloud-tests/<id>/end` | Owner | Ends a test now. Control removes its pod | None | `test`. 404 `no test <id>` |

A `test` has `id`, `cloud`, `active`, `created_by`, `phase`, `phase_words`, `cost_usd`, `findings` (what it found, in words) and `outcome` (`running`, `passed`, `failed` or `ended`), with the GPU, price, image, times and the probe's reports.

Starting a test refuses with one of these:

- `no GPU cloud "<name>"`
- `test <id> is still running on "<cloud>": end it first, or wait for it`
- `no image: give one, or set THERMITE_RUNPOD_TEST_IMAGE on control (an image RunPod can pull)`
- `the disk is 10 to 2000 GB`
- `a limit is 5 minutes or more`
- `RunPod lists no GPU type "<gpu>"`
- `RunPod has no GPU type in stock on Secure cloud` (or `Community cloud`)

### Rigs on a GPU cloud

The owner launches rigs on RunPod with these routes, the MCP tool [`runpod_launch`](mcp-tools.md#runpod_launch) or [`thermite runpod launch`](command-line.md#runpod-launch), and stops, starts, restarts and terminates them with the routes in [Stop, start, restart and terminate](#stop-start-restart-and-terminate). Only the owner's token may launch a rig, change its limits or change its pod: an operator's, an agent's or a reader's token gets 401. A rig runs the [one-container rig image](harness-image.md#the-one-container-rig-image) in [pull mode](../explanation/trust.md#rigs-in-pull-mode). Control enrolls it once its pod runs, and follows its pod every 30 seconds.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/gpu-clouds/<name>/rigs` | Owner | **Spends money.** Launches a rig on the GPU cloud `<name>` from **Providers**: one pod, billed by the hour from now until it is stopped or removed | `{gpu, gpu_count, cloud_type, datacenter, image, container_disk_gb, volume_gb, rig, enroll_within_minutes, settings, spend_limit_usd, idle_stop_minutes}`. Only `gpu` is required, nothing else is taken. See below | 201 `runpod rig`. 409 with the reason. 400 `invalid request` for a field of the wrong type or a field it does not take |
| `GET /v1/gpu-clouds/<name>/rigs` | Owner | The rigs launched on one GPU cloud, newest first | None | `[runpod rig]`. No such cloud gives `[]` |
| `GET /v1/rigs/<rig>/runpod` | Owner | One rig launched on a GPU cloud, with its history | None | `runpod rig` and `history`: `[{at, step, ok, detail, words}]`, oldest first. The steps are those the MCP tool [`rig_setup`](mcp-tools.md#rig_setup) lists; `words` says a RunPod step in words, such as `Pod stopped: its GPU is no longer billed, and its volume stays`, and is `null` for another step, such as a model download. 404 `{"error":"not found"}` |
| `POST /v1/rigs/<rig>/runpod/limits` | Owner | Sets or clears the rig's spend limit and idle stop | `{spend_limit_usd, idle_stop_minutes}`: a number sets one, `null` clears it, and one left out stays | `runpod rig`. 404 `no rig <rig> on a GPU cloud`. 400 with the reason |
| `GET /v1/rigs/<rig>/runpod/logs` | Owner | Reads the pod's log now from RunPod's API, with the GPU cloud's key: the newest lines, from the container and from RunPod's host. It spends nothing. See [A pod's log](#a-pods-log) | Query: `tail`, `source` | `{rig, pod, lines: [{source, ts, line}], read_at}`. 404 `{"error":"not found"}` for a rig not launched on a GPU cloud. 400 for a wrong `tail` or `source`. 502 with RunPod's refusal in words |

What a launch takes:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gpu` | string | required | A GPU type's id or name from RunPod's list (**Providers**, or the MCP tool `providers`) |
| `gpu_count` | 1 to 8 | `1` | GPUs in the pod |
| `cloud_type` | `SECURE` | `SECURE` | Secure cloud on demand. `COMMUNITY` is refused: Community cloud comes in a later version. The GPU type must be offered on Secure cloud |
| `datacenter` | string | any: RunPod chooses | A data center's id from RunPod's list |
| `image` | string | control's `THERMITE_RUNPOD_RIG_IMAGE` | The one-container rig image (CUDA), at a registry RunPod can pull from |
| `container_disk_gb` | 10 to 2000 | `40` | The container's own disk, which RunPod empties when the pod stops. The rig works on it: its state, model files and builds among it, and scratch |
| `volume_gb` | 10 to 10000 | `100` | The pod's volume at `/workspace`, which keeps a snapshot of the rig's state, inbox and outbox when the pod stops ([Where the state lives](harness-image.md#where-the-state-lives)). Model files need about twice their size free on the container's disk, and twice on the volume: the snapshot holds the inbox's copy and the harness's |
| `rig` | string | `rp-` and 8 hexadecimal characters | The rig's name: 2 to 40 characters of a-z, 0-9 and -, a name no other rig has |
| `enroll_within_minutes` | number above 0 | none: the code does not expire | The one-time enrollment code expires this long after the launch |
| `settings` | object | `{"THERMITE_TARGET":"cuda-gpu","THERMITE_GPUS":"0,…"}`, one index for each GPU | The rig's [settings](settings.md) at enrollment, over the defaults. Only `THERMITE_TARGET`, `THERMITE_TARGET_CLASS`, `THERMITE_GPUS`, `THERMITE_GPU_INDEX`, `THERMITE_DEV_GPU_INDEX`, `THERMITE_JUDGE_GPUS`, `THERMITE_MAX_TRIALS`, `THERMITE_TRIAL_MINUTES` and `THERMITE_PROMOTION`, with values of letters, digits and `. _ , : -` |
| `spend_limit_usd` | number above 0 | none | Control stops the pod once it has cost this much |
| `idle_stop_minutes` | 5 or more, or `null` | none | Control stops the pod once no run has been [at work](#when-a-rig-is-idle) on the rig for this long, counted from its enrollment, its last start, or the setting of the stop, whichever is latest. `null`: no idle stop. Left out: control's default, which is none. The dashboard's launch form fills in 30 minutes, which the owner can change or clear |

The pod's environment holds only pull mode's [launch values](settings.md#pull-mode): public material, the one-time code, and a new key for each pod that seals its [state snapshot](harness-image.md#where-the-state-lives) (`THERMITE_STATE_SNAPSHOT_KEY`), of which control keeps no copy. Control's RunPod key, its tokens and every other secret stay on control. A launch that fails starts nothing, or removes the pod it started, and leaves no rig: its code can never enroll.

A `runpod rig` has `rig`, `cloud`, `pod`, `active` (control still follows the pod), `created_by`, what it was launched with (`image`, `gpu`, `gpu_name`, `gpu_count`, `cloud_type`, `datacenter`, `container_disk_gb`, `volume_gb`), `status` (the pod's status at RunPod, as control last read it, such as `RUNNING` or `EXITED`), `status_at`, `launched_at`, `price_per_hr` (USD per hour for the whole pod: RunPod's price for it, or the GPU's list price before RunPod gives one), `spend_usd` (what it has cost so far, at the prices control saw, to the cent; `null` without a price), `spend_limit_usd`, `idle_stop_minutes`, `idle_since` (since when the idle stop counts; `null` while a run is at work), `at_work` (a run was at work at control's last check), `enrolled_at`, `stopped_at` and `stopped_by` (`spend_limit` or `idle_stop` when control stopped the pod at a limit, `owner` when the owner stopped it), `ended_at` (when RunPod no longer had the pod), `refusal` (why the last terminate was refused, such as `Not terminated: …`; it stays until the owner's next stop, start, restart or terminate, or a newer step in the rig's history, such as a full reset; else `null`), `error` (what control's last read of the pod found, which goes at its next good read; else the `refusal`) and `notes`, in words. While a stop, start, restart or terminate is under way, `op` is `{kind, by, why, phase, at, phase_at, command, export, paused}` and `op_words` says it in words, such as `stopping: waiting for its results to leave the pod`; otherwise both are `null`. `paused_runs` lists the runs the last stop paused, which the next start resumes. `last_export` is the export the last stop made, and `last_export_left` says whether it, and every result with it, had left the pod when the pod stopped.

`spend_usd` counts the time the pod ran, as control saw it, at its price per hour. It leaves out what RunPod bills for a stopped pod's volume. **Providers** shows the account's whole spend from RunPod's billing.

Neither limit has a default. A pod that reaches a limit that is set is stopped as the owner's stop is: its runs paused, its results sent out first, then the pod stopped. Its GPU is no longer billed, and its volume stays; it is never removed. A start is refused while the pod has cost its spend limit, and a pod started again in RunPod's console is stopped again at the next check, until the owner raises or clears the limit.

A launch refuses with one of these, as 409 `{"error": ...}`:

- `no GPU cloud "<name>"`
- `name a GPU type: its id or name in RunPod's list`
- `RunPod lists no GPU type "<gpu>"`
- `<gpu> is not offered on Secure cloud`
- `Community cloud comes in a later version: rigs launch on Secure cloud, on demand`
- `RunPod lists no data center "<datacenter>"`
- `a pod has 1 to 8 GPUs`
- `the container's disk is 10 to 2000 GB`, `the volume is 10 to 10000 GB`
- `the time to enroll is a number of minutes above 0`
- `a spend limit is a number of US dollars above 0`, `an idle stop is 5 minutes or more`
- `no image: give one, or set THERMITE_RUNPOD_RIG_IMAGE on control (the one-container rig image, at a registry RunPod can pull from)`
- `the rig's settings take only <names>, with values of letters, digits and . _ , : -`
- `a rig's name is 2 to 40 characters of a-z, 0-9 and -, starting and ending with a letter or digit`, `rig <rig> exists already`
- RunPod has none of that GPU free: `RunPod has no <n> × <GPU> free on <Secure|Community> cloud[ in <data center>] now: <RunPod's answer>. No pod was started and nothing is billed. Choose another GPU[ or any data center], or try again in a few minutes.`
- what RunPod answered otherwise, such as `RunPod refused the key for this: a read-only key can't start or stop pods`

RunPod's own words in a refusal have what looks like a credential taken out first, as in [a pod's log](#a-pods-log), and never hold the launch's snapshot key, enrollment code or path: control puts `***` in their place.

#### A pod's log

`GET /v1/rigs/<rig>/runpod/logs` reads the pod's log from RunPod (`GET /v2/pods/<pod>/logs`, Server-Sent Events). RunPod sends the last `tail` lines first, then new ones as the pod prints them; control reads what came and stops once `tail` lines came, once no line came for 2 seconds, or after 10 seconds in all. It is the one place that says why a pod runs but never enrolls: before enrollment, control sees nothing else of the rig. The MCP tool [`runpod_rig_logs`](mcp-tools.md#runpod_rig_logs) reads the same.

| Query | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tail` | whole number, 1 or more | `200` | The lines to read, the newest. Above 2000: 2000 |
| `source` | `container` or `system` | both | `container`: what the rig image printed. `system`: RunPod's own steps, such as the image pull |

```json title="GET /v1/rigs/rp-1a2b3c4d/runpod/logs?tail=3"
{
  "rig": "rp-1a2b3c4d",
  "pod": "abc123xyz",
  "lines": [
    { "source": "system", "ts": "2026-06-01T12:02:01Z", "line": "Pulling image ghcr.io/example/thermite-rig:0.1.0-cuda" },
    { "source": "system", "ts": "2026-06-01T12:02:40Z", "line": "Container started" },
    { "source": "container", "ts": "2026-06-01T12:02:43Z", "line": "{\"at\":\"2026-06-01T12:02:43.120Z\",\"component\":\"broker\",\"msg\":\"waiting for enrollment: the harness starts once control has enrolled the pod\"}" }
  ],
  "read_at": "2026-06-01T12:05:10.512Z"
}
```

`lines` are oldest first; `ts` is when RunPod logged each one. Before a line leaves control, what looks like a credential is taken out of it, as in control's own log: a URL's user and password, a bearer token, keys with a known prefix, such as `hf_…`, which becomes `hf_***`, and the value of a `THERMITE_` or `RUNPOD_` variable whose name ends in `KEY`, `CODE`, `TOKEN`, `SECRET` or `PREFIX`, as `NAME=value` or as `"NAME":"value"` in JSON (`THERMITE_STATE_SNAPSHOT_KEY=***`). A terminal's colour codes are taken out too, and a line is cut at 2,000 characters. A line that is not RunPod's JSON is left out.

When RunPod refuses, the 502 says why, never with the key: `RunPod refused to show pod <pod>'s log with this key: the key may not read pod logs. A key with read access to pods can` (403), `RunPod refused the key: it is wrong or was revoked. Check it in Settings › Providers` (401), `RunPod has no pod <pod>: it was removed, or it is not this key's account's` (404), `RunPod is limiting calls to its API: try again in 30 s` (429), `RunPod answered <status> for pod <pod>'s log (…)` for another status, `RunPod did not answer for pod <pod>'s log within 10 s`, `control lost RunPod's stream of pod <pod>'s log: …`, `the GPU cloud "<cloud>" was deleted, so control can't read pod <pod>'s log`, or `control could not reach RunPod: …`. A bad `tail` or `source` is a 400: `tail is a whole number of lines, 1 or more` or `source is container or system`. Control keeps each rig's last read, or why it failed, in memory for the rig's page ([Pod log](rig-page.md#pod-log)), and writes no line to its store.

#### When a rig is idle

The idle stop counts the time no run is at work on the rig: no campaign runs, or every run is paused, blocked or finished. A run is at work while its status is `running` and something is under way for it: a lane's trial in progress, or a judge job queued for it. A judge job that runs counts as work whatever its run. Between trials, while nothing is under way, a running run's newest event counts as its last work, so the planner's short gap between two trials is not idle time. A running run with nothing under way and no new event, such as one whose lanes all wait for the owner's decision, is idle. A paused run's queued judge jobs wait for its resume, and are not work. Control reads this from the rig's signed reports every 30 seconds, and `idle_since` says since when the rig counts as idle. While a run is at work, `idle_since` is `null` and no idle time counts: the rig's page then says `a run is at work`.

The stop then pauses the runs that still run, the blocked ones too, and the next start resumes them. Assigning or resuming a run on the stopped pod starts it again (see [Signed commands](#signed-commands)).

#### Stop, start, restart and terminate

These change a rig's pod through RunPod's API, the owner's alone, as the MCP tool [`runpod_rig`](mcp-tools.md#runpod_rig) and [`thermite runpod stop`](command-line.md#runpod-stop-start-restart-terminate), `start`, `restart` and `terminate` do. A restart uses the route every rig has, `POST /v1/rigs/<rig>/restart`, and a full reset `POST /v1/rigs/<rig>/reset` ([Restart and full reset](#restart-and-full-reset)). Control moves a stop or a terminate on every 30 seconds, as it follows the pod.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/runpod/stop` | Owner | Begins a stop: pauses the rig's running runs and asks for an export. Once that export and every result waiting with it have left the pod, or after 15 minutes, RunPod stops the pod | None | `runpod rig`, with `op` |
| `POST /v1/rigs/<rig>/runpod/start` | Owner | Starts a stopped pod now. Once it runs, the runs the last stop paused are resumed | None | `runpod rig` |
| `POST /v1/rigs/<rig>/runpod/terminate` | Owner | Begins a terminate: pauses the runs, waits until no judge job and no command waits on the rig, asks for a full export, and removes the pod and its volume only once every result has left it. Then it retires the rig | `{"confirm":"terminate <rig>"}` | `runpod rig`, with `op`. 400 `confirm with "terminate <rig>"` |

Each answers 404 `{"error":"no rig <rig> on a GPU cloud"}` for a rig not launched on a GPU cloud, and 409 `{"error": ...}` with the reason for a refusal:

- `<rig>'s pod is gone: RunPod no longer has it`
- `a stop of <rig> is under way: wait until it ends` (likewise a start, a restart or a terminate)
- `a full reset of <rig> is under way (<state>): cancel it, or wait until it ends`
- for a stop: `<rig>'s pod is stopped already`
- for a start: `<rig>'s pod is not stopped: RunPod says it is <status>`, or `<rig> has cost <spent>, which is at its spend limit (<limit>): raise or clear the limit first`
- for a start, when RunPod has no GPU free for the pod: `RunPod has no free GPU for pod <pod> now, so the pod stays stopped (<RunPod's answer>). Its volume stays. Try again later, or terminate it and launch a new rig`; for any other refusal by RunPod, `RunPod would not start pod <pod>: <RunPod's answer>. It stays stopped, with its volume`
- for a restart: `<rig>'s pod is stopped: start it instead of restarting it`
- for a terminate of a stopped pod: `<rig>'s pod is stopped, and results may wait on its volume (<why>): start it, so they can leave, then terminate it`

How each one goes:

| | Stop | Start | Restart | Terminate |
| --- | --- | --- | --- | --- |
| Runs | Pauses the running runs, with the reason `the owner stops the rig's pod` | Resumes the runs the last stop paused | Leaves them: they go on after the restart | Pauses the running runs, with the reason `the owner terminates the rig's pod` |
| Results | An export (`export_now`); the pod stops once it and every export and champion's patch waiting on the rig have left, or after 15 minutes, when what did not leave stays on the volume | | None: the volume keeps them | First no judge job and no command may wait (1 hour at most), then a full export (30 minutes at most), then every result must leave (1 hour at most) |
| RunPod | Stops the pod: its GPU is no longer billed, its volume stays | Starts the pod | Stops the pod, then starts it once RunPod says it stopped | Removes the pod and its volume |
| When it can't | It stops all the same, and its history says what stayed on the volume | Refused, in words; the pod stays stopped | The start is refused: the pod stays stopped, and its history says why | Refused: the pod keeps running, with its runs paused, `error` says why, and its history has `runpod_terminate_refused` |

A rig whose harness never reported holds no result: a stop or a terminate then acts on the pod at once. A stopped pod is terminated at once only when its last stop's export and every result with it had left the pod. A stop, start or restart may give the pod a different GPU, or none: RunPod keeps a stopped pod's GPU for no one, and a start says so when it has none free. When the pod runs with fewer GPUs than it was launched with, its history says so.

Each change is a step in the rig's history (`GET /v1/rigs/<rig>/runpod`, or [`rig_setup`](mcp-tools.md#rig_setup), which lists the steps), and in control's audit log: see [Audit log actions](#audit-log-actions).

### MCP servers

The MCP servers that campaigns' kits name for their agents, as **Settings › Providers › MCP servers** keeps them ([Manage MCP servers](../how-to/operate/mcp-servers.md)). Only the owner's token may use these routes; MCP has the same as [`mcp_server_add`](mcp-tools.md#mcp_server_add) and its sisters, and the command line the [`mcp` commands](command-line.md#mcp). No answer holds a secret: a key or a client secret shows only as its last four characters, `secret_hint`.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/mcp-servers` | Owner | Every server, by name | None | `{"servers":[server]}` |
| `POST /v1/mcp-servers` | Owner | Adds a server. Control seals its secrets. An OAuth server answers with the address of its sign-in page; any other has its tools read at once | `{name, url, auth, header, secret, client_id, client_secret, scope}`, up to 64 KiB. See below | 201 `{server, sign_in_url}` (OAuth), `{server, error}` (OAuth, when its sign-in could not start), or `{server, check_error}` when its tools could not be read (the server is kept). 400 with the reason, such as `Use https. Over http, the sign-in or key crosses the network in plain text, so control refuses it (http only for localhost).`. 409 `There is a server named <name> already: change it instead.` |
| `PUT /v1/mcp-servers/<name>` | Owner | Changes a server, then reads its tools again. A field left out keeps its value; a secret left out is kept, except with another address or another `auth`, which need it again | The fields of a new server, all optional but none other | `{server, check_error}` or, for an OAuth server whose address or client changed, `{server, "sign_in":"needed"}`. 400 with the reason, such as `Another address or sign-in needs the key again: paste its value.`. 404 `Settings has no server of that name.` |
| `POST /v1/mcp-servers/<name>/check` | Owner | Reads the server's tools again with its sign-in. It calls no tool | None | `{server, check_error}`. 404 as above |
| `POST /v1/mcp-servers/<name>/sign-in` | Owner | Starts an OAuth sign-in: the address of the server's sign-in page, good for 15 minutes | None | `{url}`. 404 `Settings has no server of that name.` 409 with the reason, such as `notion does not sign in with OAuth.` or `The server does not register clients by itself. Register Thermite on the server, then give its client ID here.` |
| `DELETE /v1/mcp-servers/<name>` | Owner | Forgets the server and its secrets. Nothing changes on the server | None | `{"deleted":true}`. 404 as above. 409 `<kit> names it. Take it out of that kit first.` (for several: `<kit> and <kit> name it. Take it out of those kits first.`), with `named_by` |
| `GET /v1/mcp-oauth/callback` | None: the sign-in's own state | Where the server's sign-in page sends the browser back. Control exchanges the code for the sign-in (a state is good once, for 15 minutes), seals it, and reads the server's tools | `?state=<state>&code=<code>`, or `?state=<state>&error=<error>` | 303 to **Settings**, which says `Signed in to <name>. Control sealed the sign-in and renews it. It read <n> tools, and called none of them.`, or **Not done.** and why, such as `This sign-in is not known, or was used already. Start it again.` |

What a new server takes:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text | required | How kits name it: lowercase letters, digits and dashes, up to 64 characters |
| `url` | text | required | Its MCP address, streamable HTTP or SSE. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only; no user, password or fragment, and no query parameter whose name holds `token`, `key`, `secret`, `password`, `auth` or `sig` |
| `auth` | `oauth`, `key`, `client` or `none` | required | How the server signs Thermite in |
| `header` | text | `Authorization` | `key`: the header the key goes in |
| `secret` | text | none | `key`: the header's whole value, such as `Bearer` and the token. Required for a new server |
| `client_id` | text | none | `client`: required. `oauth`: only when the server does not register clients by itself |
| `client_secret` | text | none | `client`: required for a new server. `oauth`: when the server gave Thermite a client with a secret |
| `scope` | text | none | The scopes to ask for, separated by spaces |

A `server` is `{name, url, auth, header, client_id, scope, secret_hint, signed_in, status, last_error, tools, tools_at, checked_at, migrated_from, created_at, created_by, updated_at, named_by}`. `status` is `ok`, `failing`, `needs_sign_in` or `unchecked`. `tools` is `[{name, description, reads}]` as last read, or `null` before the first read; `reads` is true when the server says the tool only reads. `migrated_from` is `outside_kb` for a server made from an outside knowledge base at the update to 0.1.0. `named_by` lists the kits that name it.

### Metrics

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /metrics` | Owner or reader | Control's figures in Prometheus's text format | None | `text/plain; version=0.0.4`. [Metrics series](#metrics-series) lists them |

### The message bus

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/bus` | Owner or reader | The [message bus](../explanation/how-the-parts-talk.md#the-buss-state) as control sees it now. MCP's `bus_state` answers the same | None | `{on, server, reachable, error, streams, events, live, config}`, as below, `on` being `true` |

The answer holds:

| Field | Meaning |
| --- | --- |
| `server` | The bus's server, its host and port |
| `reachable`, `error` | Whether control reached the server just now, and why not in words, such as `no answer within 5 seconds`, or `null` |
| `streams` | Each stream control makes and the server has, in this order: `REPORTS`, `EVENTS`, `COMMANDS`, `LIVE`, `CONFIG`. Each is `{name, messages, bytes, subjects, first_at, last_at, consumers, consumers_left_out}`: the messages and bytes it keeps, how many subjects hold them, when its oldest and newest came (`null` while it holds none), and each consumer as `{name, pending, ack_pending, redelivered}`: the messages it has not been handed yet, those it was handed and has not acked, and those it was handed more than once. At most 200 consumers of a stream; `consumers_left_out` counts the rest. Empty when the server was not reached |
| `events` | The writer of the `EVENTS` stream, where control keeps every rig's events ([Control's events on the message bus](../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)): `{stream, since, published, moved, later, waiting, apply}`. `published` is the events of the reports control took since it started, at `since`; `moved`, the rows of an older store's events table control moved to the stream as it started, 0 for a store with none ([A store from before](../explanation/how-the-parts-talk.md#a-store-from-before-its-events-table-moved-once)); `later`, the reports control refused for now since it started, because the bus did not take their events, it had not applied them in time, or too many waited; `waiting`, why it refused the last, such as `the bus's store is full: insufficient resources`, or `null` once it took one. `apply`, the apply of the stream, which writes what control derives from the events, `{place, last_place, behind, applied, refused, waiting, stopped}`: `place`, the stream's place control's store applied through (0 before its first message); `last_place`, the stream's last place, as the server has it, `null` when the server was not reached; `behind`, the messages between them (`null` with `last_place`); `applied` and `refused`, the messages applied, and passed over as not events, since control started; `waiting`, why it waits now, or `null`; `stopped`, `null`, or why control's store is past the stream's end, as control stops then |
| `live.kept` | How much the `LIVE` stream keeps: `{seconds, messages_per_subject, bytes, message_bytes}`, `message_bytes` being the largest message |
| `live.taken` | What control took from the `LIVE` stream since it started: `{since, messages, lines, left_out, refused}`. `lines` counts the lines it added to its live view, a line it had already not again; `left_out`, the lines of a kind or source it does not know, or of another subject; `refused`, the messages it refused, by why: `not a live subject`, `no rig named`, `no such rig: control has no token for it`, `this rig is retired in control`, `a run control does not give this rig`, `not a live message`, `rig mismatch`, `the rig's report key is not accepted yet`, `live lines must be signed with the rig's pinned key`, `bad live signature` or `unsigned lines must be the supervisor's own` |
| `live.rigs` | Each rig with live lines on the bus: `{rig, taken, supervisor}`, `taken` being the lines control added from the bus since it started, and `supervisor` the rig's supervisor's own figures since it started, `{published, dropped, subjects, at}` (`null` before its first figures with them): the lines it published and dropped, in all, and by subject for the 100 subjects it used last, each `{published, dropped}`, and when control had those figures |
| `config.keys`, `config.message_bytes` | The keys control writes for each rig in the `CONFIG` stream, `model-route`, `advisor-routes` and `mcp-servers`, and the largest message ([Config over the message bus](../explanation/how-the-parts-talk.md#config-over-the-message-bus)) |
| `config.written` | What control wrote to the `CONFIG` stream since it started: `{since, values, failed, too_large, not_made}`. `values` counts the values written, by key; `failed`, the writes and reads back the bus did not answer, tried again at the next look; `too_large`, the values larger than a message, not written; `not_made`, the looks at a value control could not make, such as one whose provider's key does not open, not written |
| `config.rigs` | Each rig on the bus, or with config figures: `{rig, sealed, written, supervisor}`. `sealed` says whether it registered its seal key (without one, control writes it nothing), `written` counts the values control wrote it since control started, and `supervisor` is the rig's supervisor's own figures since it started, `{taken, refused, subjects, at}` (`null` before its first figures with them): the updates it took and the messages it refused, in all and by subject, each `{taken, refused}`, and when control had those figures. Values, revisions and keys are never shown |

## Join commands

A join command is what the owner copies from **Add a rig** (under "Or run it yourself, where control can't connect") or from **Make a new join command** on a rig's page. It calls one of these routes with its join token. A join token works once, within one hour. [Join a rig yourself](../how-to/install/join-a-rig.md) gives the steps.

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/join/<rig>/script` | The rig's join token | For a rig on a machine: control makes the rig's token now and returns a shell script that checks the machine, then writes the rig's files and Podman Quadlet units | `uid`: `0` means the script runs as root. The join command sends `uid=$(id -u)` | 200, the script as `text/plain` |
| `GET /v1/join/<rig>/manifest` | The rig's join token | For a rig in a Kubernetes namespace: the same, as a Kubernetes manifest for `kubectl apply` | None | 200, the manifest |

The last part of the path must match the join's form, `script` for a machine and `manifest` for a namespace. Errors are plain text:

| Status | Text |
| --- | --- |
| 404 | `thermite: no such join command` |
| 409 | `thermite: control's address for rigs is not set` |
| 401 | `thermite: this join command does not work: it was used, revoked or expired. Make a new one on the rig's page in Thermite.` |

## Routes used by rigs

Each rig's supervisor calls these with the rig's own token, for its own rig only. Scripts do not call them. [Trust between control and rigs](../explanation/trust.md) explains the signatures they check. Each call carries the supervisor's build in headers, and each answers 409 with the reason while control refuses the rig: see [Rig versions](#rig-versions). A rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode) has no token: its supervisor makes the same calls, and control answers them in-process, through its connection to the pod, on these routes only. From the network, these routes always need a rig's token. With the message bus, a supervisor does not call `model-route`, `advisor-routes` or `mcp-servers`: control writes the same answers to the rig's [config on the bus](../explanation/how-the-parts-talk.md#config-over-the-message-bus), and the routes stay for rigs without it.

| Route | What it does | Request | Answer |
| --- | --- | --- | --- |
| `POST /v1/rigs/<rig>/ingest` | Takes the harness's signed report: new events and the rig's summary. Control keeps the rig's report key at first contact, or holds it for the owner. Then it publishes the events after the last one it holds of the report's ledger to its message bus's `EVENTS` stream, where it keeps every rig's events, and applies what it derives from them: a command's outcome as the harness gave it, the model calls' usage and [the knowledge base](knowledge-base.md#how-control-keeps-it-current). It answers once they are applied, one report at a time ([Control's events on the message bus](../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)) | `{rig, ledger_id, cursor, next, events, summary, generated_at, latest_event, rig_pubkey, signature}`, up to 32 MiB | `{"added":<n>}`, the events new to control. The refusals are listed below |
| `GET /v1/rigs/<rig>/commands/pending` | The rig's pending commands, oldest first. With the message bus, the supervisor takes them from there as they are issued, and asks here only every 3 minutes. A command past its expiry is marked `expired` here and not returned. A command the supervisor holds already comes back as its id alone, under `held`. One whose content the supervisor is still fetching is signed again with a later expiry before its own comes, and sent whole ([Expiry and cancelling](signed-commands.md#expiry-and-cancelling)) | `?have=<id>,<id>&staging=<id>,<id>`, both optional: the commands the supervisor holds, and those of them whose content it is still fetching | `{"commands":[<signed command>], "held":[<id>]}` |
| `POST /v1/rigs/<rig>/commands/<id>/ack` | Reports a command's delivery and outcome | `{status, outcome}`, `status` being `delivered`, `rejected` or `failed`; up to 256 KiB | `{"ok":true}`. 404 `no such pending command` |
| `POST /v1/rigs/<rig>/supervisor` | The supervisor's own figures: its relay position, where its exports go and what of them waits, its push or send state, its [model downloads](model-files.md#the-supervisors-report), and advisor counts and spending. Not signed. Control records each model download that starts or ends in the rig's history. With the message bus, `bus_key` is the public part of the rig's own key on the bus: control records it, gives it a user on the bus, and answers once the bus's server has reloaded its users; a new key for the rig is `rig_bus_key_changed` in the audit log and a step in the rig's history ([Who may use the message bus](../explanation/how-the-parts-talk.md#who-may-use-the-message-bus)). Control keeps the key apart from the figures. With the bus, `live` counts the live lines the supervisor published there and dropped since it started: `{published, dropped, subjects}`, `subjects` naming the 100 subjects it used last, each `{published, dropped}`; [`GET /v1/bus`](#the-message-bus) shows them. A malformed `live` is dropped, not the figures. With the bus, `bus_seal_key` is the public part of the rig's seal key, an X25519 key, which control seals the rig's config on the bus to; it comes only with `bus_key`. Control records it beside the rig's key, and writes the rig's config at once for a new one; a new one is `rig_seal_key_changed` in the audit log and a step in the rig's history. `config` counts the config updates the supervisor took from the bus and the messages it refused there since it started: `{taken, refused, subjects}`, by subject, each `{taken, refused}`. A malformed `config` is dropped, not the figures | Numbers and short strings only, at most 20 downloads; up to 256 KiB. A `bus_key` that is not a NATS user key's public part is refused whole with 400 `bus_key is not a NATS user key's public part: 56 characters of A-Z and 2-7, starting with U`; a `bus_seal_key` that is not a seal key with 400 `bus_seal_key is not an X25519 public key: base64 of its DER form, on one line`, and one without `bus_key` with 400 `bus_seal_key comes only with bus_key, the rig's key on the bus` | `{"ok":true, "reports":{"ledger_id":"<ledger>","cursor":<n>}}`: where control is in the rig's events, the ledger it holds them of and the cursor after the last one, `{"ledger_id":null,"cursor":0}` before its first report. A supervisor on the message bus goes back there when control is still behind what it had sent a round before ([Reports over the message bus](../explanation/how-the-parts-talk.md#reports-over-the-message-bus)) |
| `POST /v1/rigs/<rig>/live` | Live-log lines: the harness's batch, signed with the rig's accepted key, and the supervisor's own lines, which are not signed. A supervisor on the message bus publishes them there instead, and control takes them from there with the same checks ([Live lines over the message bus](../explanation/how-the-parts-talk.md#live-lines-over-the-message-bus)) | `{batch, supervisor}`; up to 4 MiB | `{"added":<n>, "left_out":{"<what>":<n>}}`: a line of a kind or source control does not know, from a newer rig, is left out and counted under `left_out`, and the rest are kept; the supervisor logs `control left out live lines it does not know` once for each. 403 `rig mismatch` or `bad live signature`. 409 `the rig's report key is not accepted yet` or `live lines must be signed with the rig's pinned key` |
| `GET /v1/rigs/<rig>/git/kits/<repo>.git/…` | A kit kept on control, written on the **New campaign** page or given to control as a git bundle ([Kits control keeps](#kits-control-keeps)), served as plain HTTP Git for the supervisor to fetch by commit | Git's file paths | The file. 404 `not found` |
| `GET /v1/rigs/<rig>/git-access/<name>` | The secret of a Git access from **Providers**, only for a rig whose assigned campaign uses it. Written to the audit log as `git_access_handed` | None | `{"kind":"ssh","private_key":…}` or `{"kind":"token","token":…,"username":…}`. 404 `no such Git access for this rig`. 500 `the Git access could not be unsealed (control's secrets key?)` |
| `GET /v1/rigs/<rig>/model-route` | The model route of the rig's agents, with its key, and the planner's | None | `{route, planner}`, each `null` or a route. A route's `harness` is the [worker harness](glossary.md) its agents run in: `pi`, `opencode`, `claude-code` (a Claude subscription's route, and only that) or `codex` (a ChatGPT subscription's or an OpenAI-compatible provider's route, when the owner chose Codex). The planner's route's `harness` is where a planner with a model of its own runs. Its `context_window` is the window the provider lists for the model, or the owner's [cap](#the-agents-model) when that is lower (`0`: unknown). Its `compact_at`, only when the owner set one, is the share of the window, in percent, at which the agents' conversations are compacted; without it the harness compacts at 80%. The planner's route has the planner's own cap and point. 409 `the ChatGPT login could not be renewed: sign in again on the Providers page` or `the provider's key cannot be opened: enter it again` |
| `GET /v1/rigs/<rig>/advisor-routes` | The advisors' model routes, by role, where the owner gave them models | None | `{teacher_models, merged_by, auditor, review_panel, synthesizer, final_writer}`: `teacher_models` is a list of one route, or two for two teachers (empty when the owner gave the teachers none); each other role is `null` or a route. With `synthesizer` or `final_writer` `null`, the supervisor runs that advisor on the first teacher's model. A route's `harness` is where the supervisor runs that advisor: `pi`, `opencode`, `claude-code` or `codex`. Each has the role's own `context_window` and, when the owner set one, its `compact_at`, as above |
| `GET /v1/rigs/<rig>/mcp-servers` | The [MCP servers](#mcp-servers) the kits of the runs control assigned this rig name, each with its sign-in as headers (an OAuth or client sign-in renewed first when less than five minutes are left), and the kinds of agent any of those runs gives it to. A server no run of the rig names is never in it. When the servers a rig gets change, control writes `mcp_servers_handed` to its audit log, with their names only. It compares with the newest such entry for the rig, so a restart of control writes no entry of its own | None | `{servers, unavailable}`: `servers` is `[{name, url, headers, revision, agents}]`; `unavailable` is `[{name, why}]` for a server a run names that control can't give, with `Settings has no MCP server of that name now` or `control can't sign in to it: <why>` |
| `GET /v1/rigs/<rig>/kb` | The [past research](knowledge-base.md#a-runs-knowledge-folder) for one of the rig's runs (the supervisor asks for each running run): the items of the folders its campaign may read, changed after `after`, oldest change first, without the run's own items. Only for a run control assigned to this rig, of the campaign it assigned | `?run=<run>&after=<seq>`, `after` a whole number from 0 (default 0) | `{campaign, folders, items, next, more}`: at most 500 items; `next` is the cursor for the next call, and `more` is true while more wait. 400 `run is required` or `after is a whole number from 0`. 404 `{"error":"control did not assign run <run> to this rig","code":"not_assigned"}`, which the supervisor leaves alone for an hour, or `this rig has no run <run>`, which it asks about again at its next sync. 409 `run <run> is not of the campaign control assigned` |
| `POST /v1/rigs/<rig>/champions/<run>/<seq>/patch` | Uploads a published champion's patch, one of the rig's own runs'. Control keeps it only if its SHA-256 matches the rig's signed `champion_published` event. The owner downloads it under the run: [`GET /v1/runs/<run>/champions/<seq>/patch`](#runs) | The patch, up to 64 MiB | 201 `{"stored":true}`. 400 `bad seq`. 409 `control has no champion_published event for it yet`. 422 `the patch is not the one the rig published` |
| `POST /v1/rigs/<rig>/exports/<name>` | Starts an [export](exports.md#how-an-export-is-sent) the rig sends to control, because it has no results repository, or says what control has of it | `{manifest, files}`: the export's manifest as the harness wrote it, and the size of each file the rig sends. They must be every file of the manifest, `ledger.sqlite` aside unless the export is full. Up to 8 MiB | `{"received":{"<path>":<bytes>}, "done":["<path>"], "complete":<bool>}`. 400 `not an export's name`, `the manifest names another rig`, `the export leaves out <paths>` or `the manifest does not list <paths>`. 409 `control has another export named <name> from this rig`. 503 `control keeps no exports: it has no folder for them` |
| `POST /v1/rigs/<rig>/exports/<name>/file` | One piece of one file of an export. Control checks the file's SHA-256 against the manifest when its last byte arrives, and keeps it only if they match | `?path=<path>&offset=<bytes>`, the place control has; the bytes, up to 16 MiB | `{"received":<bytes>, "done":<bool>, "complete":<bool>}`. 400 `<path> is not a file this export sends`, `offset is a whole number from 0` or `<path> has <n> bytes; this piece would go past its end`. 404 `no export <name>: start it first`. 409 `control has <n> bytes of <path>, not <offset>` or `<path> is being checked`, each with `received`. 422 `the SHA-256 of <path> is <sha256>, not the manifest's <sha256>: send it again`, with `"received":0`. 503 as above |
| `POST /v1/rigs/<rig>/reports` | The supervisor's daily report | `{"kind":"daily","body":"<Markdown>"}`, the body 1 to 200,000 characters (the supervisor cuts a longer report to that, and says so at its end); up to 1 MiB | 201 `{"id":<n>}` |

`POST /v1/rigs/<rig>/ingest` refuses a report with one of these:

| Status | Error |
| --- | --- |
| 403 | `rig mismatch` |
| 400 | `unsigned report` |
| 403 | `bad report signature` |
| 409 | `event <id> (<kind>) is too large for the message bus: it is <n> bytes, more than a message on the bus holds (8388608 bytes with its headers)`, or `event <id> (<kind>) can't go on the message bus: …` for a kind or a ledger a subject or a header can't hold. Control keeps every event on the message bus, so it takes nothing of such a page, the rig's key included, bus or no bus ([Control's events on the message bus](../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)) |
| 409 | `the rig's key waits for the owner's acceptance` |
| 409 | `rig key changed: the owner must accept the new key` |
| 409 | `a report from a ledger the rig has left` |
| 409 | `a new ledger's events start at 0`, with `expected_cursor` 0: a ledger control holds no event of |
| 409 | `a gap in the event stream`, with `expected_cursor`: the cursor after the last event control holds of the ledger |
| 409 | `a report older than the newest one taken` |
| 409 | `report from the future` (more than 5 minutes ahead of control's clock) |
| 409 | `Control cannot work with this rig: …`, when the harness's build in the report, or the supervisor's, has a protocol control cannot work with ([Rig versions](#rig-versions)) |
| 503 | `the message bus did not take this report's events: <why>. Control takes the report once the bus does: send it again`, while the bus is away or its store is full, with `retry-after: 5`. A refusal for now: control keeps nothing of the report but what the bus took, and the supervisor sends it again from the same cursor |
| 503 | `control has not applied its events stream to its end within 20 seconds: send the report again`, with `retry-after: 5` |
| 503 | `<n> reports wait to go on control's message bus: send this one again`, with `retry-after: 5`, when 32 reports wait for control's turn |

With `THERMITE_NATS_URL` set, the supervisor publishes the same reports to the message bus instead, and control takes them from there with these checks too, and these words in its log: see [Reports over the message bus](../explanation/how-the-parts-talk.md#reports-over-the-message-bus). No refusal goes back to the supervisor there: control's answer to `POST /v1/rigs/<rig>/supervisor` names where control is, and the supervisor sends again from there. The route still takes reports from rigs that are not on the bus.

## Rig versions

Control, each rig's harness and each rig's supervisor report their builds, and control compares the rig's with its own. A build is Thermite's version (from `package.json`), the source commit the image was built from, and the protocol: the version of the contract between control and a rig. This release speaks protocol 1.

- **The harness** puts its build in its signed report's summary, as `build`: `{version, commit, protocol, oldest_protocol}`.
- **The supervisor** sends its build in headers on every call to control:

| Header | Value |
| --- | --- |
| `x-thermite-version` | Thermite's version, such as `0.1.0` |
| `x-thermite-commit` | The source commit, when the image was built with `THERMITE_COMMIT` ([build arguments](settings.md#build-arguments)). Left out otherwise |
| `x-thermite-protocol` | The protocol it speaks |
| `x-thermite-oldest-protocol` | The oldest protocol of the other side it works with |

A part that sends no build is from before version checks: its build is unknown. For the supervisor, that is a report, a supervisor-figures call or a command fetch without the headers. A malformed value counts as not sent. Control records each part's build when it changes, with `since`, the time it first saw it.

`GET /v1/rigs`, `GET /v1/rigs/<rig>/view`, the MCP tool [`list_rigs`](mcp-tools.md#list_rigs) and [`thermite rig list`](command-line.md#rig-list) give each rig's `version`:

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | string | `current`, `behind`, `ahead`, `unknown` or `refused`, as below |
| `notice` | string or null | What to know and do, in plain words. Null when the rig runs control's version |
| `refused` | `{reason, since, calls, last_at}` or null | Why control refuses the rig, and since when; how many of the rig's calls control refused since then, and when the last one came (`null` when none did) |
| `control` | `{version, commit, protocol, oldest_protocol}` | Control's own build. `commit` is null when control's image was built without one |
| `harness`, `supervisor` | `{version, commit, protocol, oldest_protocol, since}` or null | What each part last reported. Null when it reports no build. A part it did not send, or sent malformed, is null |

| `state` | When | `notice` |
| --- | --- | --- |
| `current` | Both parts run control's version. Their commits may differ | Null |
| `behind` | A part runs an older version than control, and control works with it | `This rig runs an older Thermite than control: harness 0.1.0, supervisor 0.1.0. Control runs 0.2.0. Control still works with it. Update the rig's images.` |
| `unknown` | A part sends no version, or one that is not a semantic version | `The rig's harness and supervisor send no version. Their images are older than version checks. Control still works with it.` |
| `ahead` | A part runs a newer version than control, and control works with it | `This rig runs a newer Thermite than control: … Control still works with it. Update control.` |
| `refused` | A part's protocol and control's do not meet | The reason, as below |

Versions compare as semantic versions: `0.2.0` is after `0.1.9`, and `0.2.0-rc.1` is before `0.2.0`. When the parts differ, `refused` comes first, then `behind`, `unknown`, `ahead` and `current`.

### When control refuses a rig

Control refuses a rig only when it knows both protocols and they do not meet. A build with no protocol is never refused. A part's protocol does not meet control's when:

- it is older than the oldest protocol control works with: `Control cannot work with this rig: its supervisor speaks protocol 1, and control works with protocols 2 to 3. Update the rig's images.`;
- or the oldest protocol it works with is newer than control's: `Control cannot work with this rig: its harness works with protocol 4 or later, and control speaks protocol 3. Update control.`

While control refuses a rig:

- every route the rig calls answers 409 with the reason, so control takes none of its reports and it fetches no commands. Its supervisor's log has the reason in its `relay error` and `command relay error` lines;
- `POST /v1/commands`, `POST /v1/propagate`, the MCP tools that issue commands and the dashboard refuse commands for it with `Control sends no commands to <rig>.` and the reason;
- the rig is in `GET /v1/rigs` even if it never reported (then its `state` is `offline`);
- control counts each call it refuses, in `refused.calls` and `refused.last_at`: a rig that still calls still runs. The rig's page shows them ([A rig's page](rig-page.md#the-version-banner)).

Control writes `rig_refused` to its audit log when it starts to refuse a rig, or refuses it for another reason, with the reason and the builds of control and of each part; and `rig_refusal_ended` when the rig reports a build it works with. When control starts, it checks each refused rig again against its own build.

A new release keeps working with the protocol before its own, so an update of control never cuts off the rigs that still run the release before it.

### Fields control does not know

A rig on a newer build may send fields that control does not know. Where nothing depends on the exact shape, control drops such a field, at any level, and takes the rest. The fields it knows keep their checks. This holds for:

- the supervisor's figures, `POST /v1/rigs/<rig>/supervisor`: control stores and shows only the fields it knows;
- the daily report, `POST /v1/rigs/<rig>/reports`;
- a command's acknowledgement, `POST /v1/rigs/<rig>/commands/<id>/ack`;
- the start of an export, `POST /v1/rigs/<rig>/exports/<name>`. Each file is still checked against the manifest's SHA-256;
- the supervisor's own lines in `POST /v1/rigs/<rig>/live`;
- the parts of the harness's report and live batch that are outside the signature.

These stay exact, because a signature or a key exchange depends on them:

- **The harness's signed report and live batches.** Control drops what it does not know, then checks the signature over what is left. A field that a newer harness signs in the report or in an event fails the check, with 403 `bad report signature` (`bad live signature` for live lines). A field that the supervisor adds is dropped, and the report is taken. New data from the harness goes in an event's `body` or in the report's `summary`, which control keeps as they came. A change to the signed fields is a new protocol.
- **A pod's enrollment answer** in [pull mode](../explanation/trust.md#rigs-in-pull-mode), which hands control the pod's keys: an answer with a field control does not know is refused, and the pod is not enrolled.

### Reporting, stale and offline

A rig's `state` says whether it reports: `reporting` after a report within `THERMITE_CONTROL_STALE_SECONDS` (180 s by default), `stale` after that, and `offline` after `THERMITE_CONTROL_OFFLINE_SECONDS` (900 s by default) without a report. A rig that never sent a report is `offline`. See [Settings](settings.md#address-and-state).

## The harness's API for proposers

Each rig's harness has an API of its own on `THERMITE_LISTEN`, by default `0.0.0.0:8700`. The rig's supervisor calls it; the local compose file publishes no port for it. A person or script submits changes from inside the harness container, at `http://127.0.0.1:8700`, with the proposer token from `THERMITE_PROPOSER_TOKEN_FILE`. `thermite submit` and `thermite status` call these routes; see the [command line](command-line.md) and [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md).

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `GET /v1/health` | None | Says the harness is well: each of its loops with its age, and 503 while one is late ([Health](#health)), its rig, and its free disk | None | `{"ok":true,"loops":{"judge:0":{"age_seconds":0,"limit_seconds":1800,"late":false,"busy":"job 12"},"scheduler":{…},"exports":{…}},"rig":"<rig>","disk":{"floor_gib":5,"low":false,"since":null,"checked_at":"…","places":[{"name":"state","free_gib":40.2,"total_gib":100},…]}}` |
| `POST /v1/attempts` | Proposer | Submits a change as an attempt for the judge | `{run, lane, patch_base64, parent, hypothesis, claim, known_flaws}`. `patch_base64` is the base64 of `git add -A && git diff --cached --binary` against the parent. `parent` is 7 to 64 hexadecimal characters, default the champion. `hypothesis` is 1 to 4,000 characters, `claim` up to 4,000, `known_flaws` up to 50 lines of up to 1,000. Up to 32 MiB | 201 `{attempt, lifecycle, commit, violations, duplicate_of}`, `lifecycle` being `queued`, `rejected_v0` or `duplicate`; `duplicate_of` is there only for a `duplicate` |
| `GET /v1/attempts/<id>` | Proposer or supervisor | An attempt's state and verdict | None | `{attempt, run, lane, lifecycle, commit, v0, violations, verdict, held_out}`. `violations` lists every violation of a change the static checks refused (`[]` otherwise), as `v0` holds them. `held_out` is `null`, or, when its newest confirmation failed on held-out cells, the kinds in words, such as `a held-out check timed out` ([Held-out failures](verdicts.md#held-out-failures)). `verdict` is `null` or `{"verdict":"<verdict>"}`. 404 `no attempt <id>`. A worker's trial reads any attempt of its own campaign on the rig this way, its lane's or not; another campaign's is 404 `no attempt <id> in this campaign` |

`POST /v1/attempts` refuses with 400 `run <run> is <status>`, `research campaigns take claims, not patches`, `unknown parent <commit>` or Git's message when the patch does not apply, and with 404 `no run <run>`. The harness's other routes serve its supervisor and the agents' trials, and are not for scripts. [Verdicts and states](verdicts.md) explains each lifecycle and verdict.

The supervisor's token also reads the prompts a run's agents were sent, whole, on the rig, and keeps its advisors' there (goal 166; [Agent roles](agent-roles.md#what-a-runs-agents-were-sent)):

| Route | Token | What it does | Request | Answer |
| --- | --- | --- | --- | --- |
| `POST /v1/prompts` | Supervisor | Keeps an advisor's prompt with its run, as the supervisor sent it | `{run, role, program, turn, lane, trial, call, sections}`; `role` one of the advisors' (`teacher`, `research-teacher`, `merged-by`, `research-merged-by`, `auditor`, `reviewer`, `research-reviewer`, `synthesizer`, `final-writer`), `turn` its place in its call (0, the default, for the first message; 1 for the first later turn), each section `{id, source, part, text, sep}`, at most 4,000,000 characters in all. Up to 16 MiB | 201 `{id}`. 400 for another role or a bad body. 404 `{"error":"no run <run>"}` |
| `GET /v1/runs/<run>/prompts` | Supervisor | The run's prompts, oldest first, without their text: each call's first message and its later turns | None | `{prompts}`, each `{id, run, role, program, turn, lane, trial, call, version, at, chars, bytes}`; `bytes` is its size compressed |
| `GET /v1/runs/<run>/prompts/<id>` | Supervisor | One prompt, whole | None | The prompt as listed, with `sections`, each `{id, source, part, text, sep}`. 404 `{"error":"no prompt <id> in <run>"}` |
| `GET /v1/runs/<run>/prompt-preview` | Supervisor | The prompt a role would be sent next, rendered now with no side effect: nothing is kept, no message is marked as given, no file is written | Query: `role` (`worker`, the default, or `planner`); for the worker, `lane` (`lane-1`) and `experiment` (default: the first one up next) | `{role, program, sections}`. 400 for another role, and `a research run's prompts are not previewed yet`. 404 for no such run or experiment. 409 `this rig runs no agents, so it renders no prompt`. Control's own preview waits for the message bus's request and reply ([goal 168](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/168-message-bus.goal)) |

## Metrics series

`GET /metrics` covers every rig that has reported and is not retired. Labels are only rigs, runs, campaigns, verdicts, job states and the direction of model tokens, so the number of series stays small.

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `thermite_rig_up` | gauge | `rig` | 1 when the rig reported within the stale window, else 0 |
| `thermite_rig_report_age_seconds` | gauge | `rig` | Seconds since the rig's last report |
| `thermite_rig_jobs` | gauge | `rig`, `state` | The judge's jobs, by state |
| `thermite_run_champion_seq` | gauge | `rig`, `run`, `campaign` | The current champion's number. 1 is the starting point |
| `thermite_run_champion_gain` | gauge | `rig`, `run`, `campaign` | The champion's relative gain over the run's baseline |
| `thermite_run_attempts` | gauge | `rig`, `run`, `campaign`, `verdict` | Attempts by verdict, or by lifecycle when not judged |
| `thermite_planner_valid_ratio` | none given | `rig`, `run`, `campaign` | The planner's valid plans per epoch a planner could plan. Only for runs with such epochs: a research run's rounds that its research plan set with the planner off count in neither ratio |
| `thermite_planner_fallback_ratio` | none given | `rig`, `run`, `campaign` | Fallback plans per epoch a planner could plan: rounds in which the lanes took queued experiments by fixed rules, not from the planner's model. Only for runs with such epochs |
| `thermite_duplicate_ratio` | none given | `rig`, `run`, `campaign` | Duplicate attempts per attempt. Only for runs with attempts |
| `thermite_trials_total` | none given | `rig`, `run`, `campaign` | Agent trials |
| `thermite_tokens_total` | none given | `rig`, `run`, `campaign`, `direction` | Model tokens, `in` or `out` |
| `thermite_research_sources`, `thermite_research_domains`, `thermite_research_verified`, `thermite_research_drafts`, `thermite_research_hypotheses` | none given | `rig`, `run`, `campaign` | Research runs only: sources, domains, verified claims, drafts and hypotheses |

The series marked "none given" have no `# HELP` or `# TYPE` line, so Prometheus treats them as untyped.

Health's series follow, the ones an operator alerts on with **Needs you** (goal 173). Their labels are only the part, its loop's name, the rig and the place on its disk; control's own disk series appear once control has looked at its disk:

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `thermite_loop_age_seconds`, `thermite_loop_limit_seconds` | gauge | `part`, `rig`, `loop` | Seconds since the loop last came around, and its limit ([Health](#health)): control's own loops (`part="control"`, no `rig`), and each rig's harness and supervisor loops as its last report and figures gave them |
| `thermite_loop_late` | gauge | `part`, `rig`, `loop` | 1 when the loop is past its limit |
| `thermite_control_disk_free_bytes` | gauge | `place` | Free space on each place control writes to: `state`, its state folder, and `bus store`, the room the bus's store has left under its limit |
| `thermite_control_disk_floor_bytes` | gauge | none | The free space control keeps on each place (`THERMITE_DISK_FLOOR_GIB`) |
| `thermite_control_disk_low` | gauge | none | 1 while control holds new runs for its disk floor |
| `thermite_rig_disk_free_bytes` | gauge | `rig`, `place` | Free space on each place the rig writes to (`state`, `scratch`, `outbox`), from its last report |
| `thermite_rig_disk_floor_bytes` | gauge | `rig` | The free space the rig keeps on each place (`THERMITE_DISK_FLOOR_GIB`) |
| `thermite_rig_disk_low` | gauge | `rig` | 1 while the rig holds new work for its disk floor |
| `thermite_rig_drain_age_seconds` | gauge | `rig` | Seconds since the rig began to drain; only while it drains |
| `thermite_rig_drain_overdue` | gauge | `rig` | 1 when its drain passed its deadline and waits for the owner's choice; only while it drains |

The [message bus](#the-message-bus)'s series follow. Their labels are only the bus's streams and consumers (two consumers for each rig at most), rigs, config keys, and the fixed reasons for a refusal, so their number stays small too:

| Series | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `thermite_bus_up` | gauge | none | 1 when control reached the bus's server just now, else 0 |
| `thermite_bus_stream_messages`, `thermite_bus_stream_bytes` | gauge | `stream` | The messages and bytes each stream keeps |
| `thermite_bus_consumer_pending`, `thermite_bus_consumer_ack_pending` | gauge | `stream`, `consumer` | The messages a consumer has not been handed yet, and those it was handed and has not acked |
| `thermite_events_published_total` | counter | none | Events of the reports control took, published to the `EVENTS` stream, since control started |
| `thermite_events_moved_total` | counter | none | Rows of an older store's events table control moved to the `EVENTS` stream as it started |
| `thermite_events_later_total` | counter | none | Reports control refused for now, since control started: the bus did not take their events, they were not applied in time, or too many waited |
| `thermite_events_applied_place`, `thermite_events_unapplied` | gauge | none | The `EVENTS` stream's place control's store applied through, and how many messages of the stream come after it. The second is left out when the server was not reached |
| `thermite_events_applied_total`, `thermite_events_apply_refused_total` | counter | none | Events control applied from the `EVENTS` stream, and messages there it passed over as not events, since control started |
| `thermite_live_lines_taken_total` | counter | `rig` | Live lines control added to its live view from the bus, since control started |
| `thermite_live_lines_left_out_total` | counter | none | Live lines control left out of a message: of a kind or source it does not know, or of another subject |
| `thermite_live_messages_refused_total` | counter | `reason` | Live messages control refused, by why: the words `GET /v1/bus` lists under `live.taken.refused` |
| `thermite_live_lines_published_total`, `thermite_live_lines_dropped_total` | counter | `rig` | Live lines the rig's supervisor published to the bus and dropped there, since it started, from its figures |
| `thermite_config_values_written_total` | counter | `key` | Config values control wrote to the `CONFIG` stream, by key, since control started |
| `thermite_config_writes_failed_total` | counter | none | Config writes and reads back the bus did not answer, since control started; each is tried again at the next look |
| `thermite_config_updates_taken_total`, `thermite_config_updates_refused_total` | counter | `rig` | Config updates the rig's supervisor took from the bus and messages it refused there, since it started, from its figures |

## Audit log actions

Control writes one entry for each of these to its audit log. `GET /v1/audit`, the MCP tool `control_log` and the dashboard's **Audit log** page read it. Control never deletes entries.

| Group | Actions |
| --- | --- |
| Requests | `failed` (a request that ended in an error), `refused` (a dashboard action control turned down, with the page's path and why, including a message to the agents that control refused before signing it, which the page shows as **Not sent.**; an MCP call it turned down, with `tool: "mcp:<tool>"` and why, a refused message included; a `POST /v1/commands` it refused, with `path`, `kind` and why; or a `POST /v1/campaigns/<campaign>/runs`, `POST /v1/campaigns/<campaign>/copy`, `POST /v1/campaigns/<campaign>/context`, `POST /v1/campaigns/<campaign>/additions`, `POST /v1/rigs/<rig>/settings`, `POST /v1/rigs/<rig>/cluster/resources` or `POST /v1/kits/<name>`, or a route that archives a campaign or changes a folder, it refused, with `path` and why), `mcp:<tool>` (every MCP tool call, with its inputs) |
| Sign-in | `login`, `login_throttled` |
| Commands | `command_issued`, `command_acked`, `command_expired`, `command_cancelled` |
| Needs you | `trial_left` (the owner pressed **Leave it running** on a stuck trial's card: `rig`, `run`, `trial`, `kind`, which is `quiet`, `repeating` or `refused`, and `since`) |
| Rigs and keys | `rig_enrolled`, `rig_token_rotated`, `rig_retired`, `rig_brought_back`, `rig_key_pinned`, `rig_key_changed`, `rig_key_accepted`, `rig_bus_key_registered` and `rig_bus_key_changed` (by `rig:<rig>`: the rig's first key on the message bus, or a new one, by its `fingerprint`, and the `previous` one's), `rig_seal_key_registered` and `rig_seal_key_changed` (the same, for the rig's seal key), `report_rejected`, `report_refused`, `rig_refused` and `rig_refusal_ended` (by `rig:<rig>`: control started or stopped refusing the rig for its protocol, with the reason and the builds; see [Rig versions](#rig-versions)), `git_access_handed` |
| Joins | `joined_rig_added`, `join_command_made`, `join_command_revoked`, `join_command_used` |
| Restart and reset | `restart`, `reset_requested`, `reset_step` |
| Providers | `model_provider_added`, `model_provider_changed`, `model_provider_deleted`, `model_provider_model_added`, `model_price_set`, `model_price_cleared`, `rig_model_given`, `agent_model_given`, `git_access_added`, `git_access_deleted`, `git_access_token_replaced`, `gpu_cloud_added`, `gpu_cloud_deleted`, `gpu_cloud_key_replaced` |
| Machines and clusters | `machine_added`, `machine_deleted`, `machine_host_key_trusted`, `machine_install_approved`, `machine_install_finished`, `machine_rig_created`, `machine_rig_stop`, `machine_rig_start`, `machine_rig_restart`, `machine_rig_remove`, `cluster_added`, `cluster_deleted`, `cluster_slots_set`, `cluster_rig_created`, `cluster_rig_stop`, `cluster_rig_start`, `cluster_rig_restart`, `cluster_rig_remove`, `cluster_rig_drain` (a cluster rig at work asked to drain before it moves onto new images or takes a new number of GPUs, CPUs or memory: the rig, and the images it will get or the change of size in words), `cluster_rig_images` (a cluster rig moved onto control's images, with the old and the new), `cluster_rig_resources` (a cluster rig given a new size, `from` and `to`, each `{gpus, judgeGpus, resources: {cpus, memoryGi}}`, with `resources` left out for the namespace's defaults), `machine_rig_images` (a machine rig moved onto control's images, with the old and the new), `rig_update` (the owner pressed **Update to** control's version on a rig's page, with the version), `rig_check_place` (control checked where a rig it set up runs, and whether it found it running: by the owner with **Check again** on the rig's page, or by `control` when the rig turned stale or offline) |
| Test pods | `runpod_test_started`, `runpod_test_ended`, `runpod_test_done` |
| Pull mode and rigs on RunPod | `tunnel_rig_added` (a rig minted for a pod), `tunnel_rig_pod` (its pod named), `tunnel_rig_enrolled`, `tunnel_refusals` (the requests a pod refused since its last exchange), `tunnel_rig_dropped` (a minted rig whose launch failed), `runpod_rig_launched` (by the owner: the cloud, pod, GPU and count, cloud type, data center, price, image and limits), `runpod_rig_limits` (the limits now), `runpod_rig_stop`, `runpod_rig_start`, `runpod_rig_restart` and `runpod_rig_terminate` (by the owner, as asked), `runpod_rig_stopped` (the pod stopped, why, `spend_limit`, `idle_stop` or `owner`, and the spend: by `control` at a limit, by the owner otherwise), `runpod_rig_started` (by `control`: the pod runs again, its GPUs and the runs resumed), `runpod_rig_start_refused` (by `control`: why, such as no GPU free), `runpod_rig_terminated` (by the owner: the pod removed, and the spend), `runpod_rig_terminate_refused` (by `control`: why a result could not leave) |
| Campaigns | `campaign_version_created`, `campaign_copied` (a campaign copied: the copy, `from`, which is the source campaign with its version or its assignment's rig and run, and the copy's contract `sha`; for a research copy that names other MCP servers, also the copy's `mcp_servers`; for a copy given its own context settings, its `agents_context`; for a copy given its own brief, `own_brief`, the parts given), `campaign_context_set` (a campaign's own [context settings](#a-campaigns-context-settings) saved: the campaign, its new version and `sha`, and `agents_context`, or `null` when they were removed), `campaign_additions_set` (the owner's [additions to a campaign's roles](#the-owners-additions-to-a-campaigns-roles) saved: the campaign, its new version and `sha`, and the `roles` with one), `campaign_archived` and `campaign_unarchived` (the campaign, and the folder it keeps or comes back into, or `null`), `campaign_moved` (the campaign, its `folder` and the folder it came `from`, each a name or `null`), `campaign_folder_created`, `campaign_folder_renamed` (the folder's old name and its new `name`) and `campaign_folder_deleted` ([Archive a campaign, and folders](#archive-a-campaign-and-folders)) |
| Exports | `export_downloaded` (the owner downloaded a complete export as one archive, with **Download** on the **Exports** page or with [`GET /v1/rigs/<rig>/exports/<name>/archive`](#rigs-and-their-history): the rig, the export and how many of its files the archive holds) |
| Kits | `kit_added` (a kit repository given to control as a git bundle: the kit's `name`, its `head` now and the `previous` one, the head's `commits`, whether the head was replaced (`forced`), the bundle's `size` in bytes, and `by`; see [Kits control keeps](#kits-control-keeps)) |
| Knowledge base | `kb_grant`, `kb_revoke` (a campaign's agents may, or may no longer, read another campaign's folder), `kb_failed` (adding a rig's event to the knowledge base failed) |
| MCP servers | `mcp_server_added` and `mcp_server_changed` (which name a secret only as `set (<hint>)`, `replaced (<hint>)`, `kept` or `none`), `mcp_server_deleted`, `mcp_server_sign_in_started`, `mcp_server_signed_in`, `mcp_servers_handed` (by `rig:<rig>`: the servers a rig's supervisor was handed, and those it could not be, by name, when they changed), `mcp_moved_note_read` (**Got it** on the note about the outside knowledge base), `outside_kb_migrated` (by `control`, once at the update to 0.1.0: an outside knowledge base became an MCP server, with its old and new names, whether its token was kept, and the campaigns whose copies stopped and whose grants went). An MCP call that takes a secret logs it in `mcp:<tool>` as `given (<hint>)` |

## Not in the API yet

The dashboard does some things no route does yet: **New campaign**, **Settings › Providers** (its MCP servers aside, which have [routes](#mcp-servers)), join commands, **Add a rig**, the **Knowledge** page and a campaign's **Knowledge** section, and the buttons on the page of a rig control set up on a machine or a cluster: stop, start, restart and remove it, update it to control's version, check where it runs, and, on a cluster, update its images. Adding a rig on a cluster, a cluster's slots, a rig's setup steps, stopping, starting and restarting a cluster rig, and updating its images are also on [MCP](mcp-tools.md) (`add_cluster_rig`, `set_cluster_slots`, `rig_setup`, `cluster_rig`, `update_rig_images`), and so are the knowledge base's folders, search and grants (`kb_folders`, `kb_search`, `kb_grant`, `kb_revoke`). There is no OpenAPI file. Both are planned in [goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal).
