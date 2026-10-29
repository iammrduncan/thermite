---
title: "Script Thermite with the REST API"
description: "Read rigs, runs and results, and issue commands, from your own scripts with control's REST API."
type: how-to
sidebar:
  order: 2
---

Control's REST API lets a script read rigs and runs, issue commands and follow them, and download results. This page shows the calls you'll use most, with `curl`. The [REST API reference](../../reference/rest-api.md) lists every route.

## Before you start

- **The address.** The API is on control, under `/v1`: `http://127.0.0.1:8800` on the local stack, or your control's address, such as `https://control.example.com`.
- **The owner's token.** Every route for people and scripts, except `/v1/health` and the dashboard's icons (`/favicon.svg`, `/favicon.ico` and `/apple-touch-icon.png`), needs it as `Authorization: Bearer <token>`. (The routes rigs use take each rig's own token.) Six read-only routes also take a reader's token: `/metrics`, `/v1/usage`, `/v1/model-prices`, `/v1/kits`, `/v1/kits/<name>` and a rig's live log (`/v1/rigs/<rig>/live`). Operator and agent tokens don't work on the API at all: they are for [MCP](agent-over-mcp.md).
- **What a script can't do yet.** **New campaign**, and adding, changing or deleting a provider on **Settings › Providers**, have no REST route (its model prices, each rig's model and its MCP servers have routes: see [The REST API](../../reference/rest-api.md#mcp-servers)), and neither has stopping, starting or restarting a rig on a cluster, moving it onto new images, or reading a rig's setup steps (MCP has `cluster_rig`, `update_rig_images` and `rig_setup`) ([goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal)). Thermite's knowledge base has no REST route for its search or for letting a campaign read another's collection (MCP has `kb_collections`, `kb_search`, `kb_grant` and `kb_revoke`, for the operator's and the owner's tokens). A script can start a campaign with `thermite assign` ([Start a campaign from the command line](../campaigns/start-from-command-line.md)), but not one whose kit is described on the dashboard, and the command line can't name a [Git access](../campaigns/private-repository.md) for a private repository. Start those from **New campaign**. Once control keeps a campaign, from **New campaign** or a script, a script can start further runs of it as **Start a run** does, or copy it: see [Start a run of a campaign](#start-a-run-of-a-campaign) and [Copy a campaign](#copy-a-campaign). A rig's **Edit rig** page has its routes too: see [Change a rig's settings](#change-a-rigs-settings).

Set the address and the token once in your shell. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. On the local stack:

```sh
CONTROL=http://127.0.0.1:8800
AUTH="Authorization: Bearer $(cat .dev/secrets/control-admin-token)"
curl -sS "$CONTROL/v1/health"
```

The last line prints `{"ok":true,"loops":{…},"bus":"connected"}`: control is up, each of its loops comes around ([Health](../../reference/rest-api.md#health)), and it holds its connection to the [message bus](../operate/message-bus.md). That route needs no token.

## List the rigs

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/rigs"
```

```text
{"control":{"version":"0.2.0","commit":"…","protocol":1,"oldest_protocol":1},"rigs":[{"id":"rig-1","last_seen":"…","last_cursor":120,"ledger_id":"…","summary":{…},"state":"reporting","version":{"state":"behind","notice":"This rig runs an older Thermite than control: …","refused":null,"control":{…},"harness":{…},"supervisor":{…}}}],"enrolled":[…]}
```

`control` is control's own build. `rigs` holds every rig that has reported, or that control refuses, and is not retired. Each rig's `state` is `reporting`, `stale` or `offline`, and its `version` compares its harness's and supervisor's builds with control's: `behind` with a `notice` when the rig should get newer images, `refused` with the reason when control can't work with it. [Rig versions](../../reference/rest-api.md#rig-versions) lists every field. `enrolled` holds the rigs control made tokens for, even those that haven't reported yet, and those retired since (with `retired_at` set).

To see only the rigs that need you, filter the answer, for example with `jq`:

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/rigs" \
  | jq -r '.rigs[] | select(.state != "reporting" or .version.notice != null) | "\(.id) \(.state) \(.version.state): \(.version.notice // "")"'
```

`thermite rig list` prints the same list as a table ([Command line](../../reference/command-line.md#rig-list)).

## Read one rig

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/rigs/rig-1/view"
```

The answer is the rig's whole page as JSON: `state` (`reporting`, `stale` or `offline`), `stale` (true when it stopped reporting), `version` (its builds against control's, as in the list), `hardware`, `judge`, `jobs`, `checks` with each check's result, `model`, `settings`, its `runs` with their champions, attempts and verdicts, and `recent`, its newest 50 events. Each run also has `queue`, every experiment in its [experiment queue](../campaigns/choose-what-runs-next.md) with its state (`proposed`, `queued`, `assigned`, `done` or `dropped`) and, for those up next, its place; `handouts`, what the planner gave each lane and why; `rules`, the rules for its plan in force; `messages`, your messages to its agents and advisors, with who read each one and the advisors' answers; and `journal`, all its agents' field notes and research notes, oldest first. Reading a rig that control doesn't know answers `404 {"error":"not found"}`; a command to such a rig answers `404 {"error":"unknown rig rig-9"}` instead ([Errors to expect](#errors-to-expect)). For all of a rig's events, page through `GET /v1/rigs/rig-1/events?after=<seq>&limit=500`.

## Issue a command and follow it

Commands are how anything changes on a rig. This one pauses the run `run-1`:

```sh
curl -sS -H "$AUTH" -H 'content-type: application/json' \
  -d '{"rig":"rig-1","kind":"pause_run","payload":{"run":"run-1","reason":"checking the kit"}}' \
  "$CONTROL/v1/commands"
```

It answers `{"id":"<command id>","status":"pending"}`: control has signed the command and queued it for the rig. Add `"ttl_minutes"` to change how long it may wait for the rig (60 minutes by default, 7 days at most). [Signed commands](../../reference/signed-commands.md) lists every kind and its payload. For example, `message_agent` with `{"run":"run-1","to":"all","text":"…"}` writes to everyone working in the run, and `unkeep_message` removes a message you kept in force; [Steer a run](../campaigns/steer-a-run.md) says who reads what. Control refuses a message with no words, or one that nothing would read, with `400` and the reason, such as `{"error":"Write a message first."}`: see [If a message doesn't arrive](../campaigns/steer-a-run.md#if-a-message-doesnt-arrive). `queue_add` with `{"run":"run-1","title":"Unroll the dequantize loop by 4","position":"top"}` puts an experiment at the top of the run's queue, and `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive` change it further; [Choose what a run tries next](../campaigns/choose-what-runs-next.md#from-the-command-line-and-over-mcp) gives a payload for each. `close_run` with `{"run":"run-1","reason":"another run finished the work"}` ends a run you no longer want, for good ([Close a run](../campaigns/steer-a-run.md#close-a-run)). An `assign_campaign` sent here keeps its copied experiments (`queue`) and its background from past research (`briefing`) as you give them; over MCP, control takes their words from its own records instead ([Use past research in a new run](../campaigns/use-past-research.md)). To copy a past run's untried experiments with control's own words, as **Start a run** does, first ask for them with `GET /v1/rigs/rig-1/runs/run-1/untried?campaign=<campaign>`, and put the answer's `queue` in the payload ([the route](../../reference/rest-api.md#rigs-and-their-history)). For a campaign control keeps, [Start a run of a campaign](#start-a-run-of-a-campaign) does all of this in one call.

Follow it with its id:

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/commands/<command id>"
```

Within seconds the status becomes `delivered`, and `outcome` holds the rig's answer. Other statuses are `rejected` or `failed`, with the rig's reason in `outcome`, and `expired`. `GET /v1/commands?limit=20` lists the newest commands of every rig. A command still `pending` can be [cancelled](../operate/cancel-a-command.md).

The `thermite` command line uses the same route. Run `npx thermite` in the folder you built it in (see [the command line](../install/one-machine.md#the-command-line)):

```sh
npx thermite command --control "$CONTROL" --token-file .dev/secrets/control-admin-token \
  --rig rig-1 --kind pause_run --payload '{"run":"run-1","reason":"checking the kit"}'
```

## Start a run of a campaign

For a campaign control keeps, one made on **New campaign** or assigned before, `POST /v1/campaigns/<campaign>/runs` does what **Start a run** on its page does. This starts a run of `sort-speed` on `rig-1`, with the untried experiments of `sort-speed-1`:

```sh
curl -sS -H "$AUTH" -H 'content-type: application/json' \
  -d '{"rig":"rig-1","queue_from":{"rig":"rig-1","run":"sort-speed-1"}}' \
  "$CONTROL/v1/campaigns/sort-speed/runs"
```

It answers `201` and `{"started":true,"campaign":"sort-speed","rig":"rig-1","run":"sort-speed-2","command":"<command id>","status":"pending"}`. Follow the command as above. The body takes the panel's other fields too: `"agents": false` for a try, `agents_model`, `promotion`, `ask_owner`, `judge_gpus` and `past`. [Start a run from a script or an agent](../campaigns/start-from-dashboard.md#start-a-run-from-a-script-or-an-agent) maps each one, and [Campaigns](../../reference/rest-api.md#campaigns) lists every answer and refusal. A refusal has the panel's words, such as `409` and `{"error":"rig-1 has no model for its agents, so they could not work: …"}`. `npx thermite run start` sends the same request.

## Copy a campaign

To give a second model the same campaign from zero, copy it under a new name. The copy has the same contract and kit, its own empty collection in Thermite's knowledge base and no runs:

```sh
curl -sS -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"sort-speed-b"}' \
  "$CONTROL/v1/campaigns/sort-speed/copy"
```

It answers `201` and `{"campaign":"sort-speed-b","version":1,"contract_sha":"<sha256>","from":{"campaign":"sort-speed","version":2}}`. Start a run of the copy as above. [Copy a campaign](../../reference/rest-api.md#copy-a-campaign) lists the refusals, and [Compare two models from zero](../campaigns/start-from-dashboard.md#compare-two-models-from-zero) gives the whole path. `npx thermite campaign copy` sends the same request.

## Change a rig's settings

`POST /v1/rigs/<rig>/settings` does what **Save changes** on a rig's **Edit rig** page does for its parts, **Workers at a time**, its limits, its promotion rule and **GPUs for the judge**. Send only what you want to change. This gives `rig-1` three workers at a time and switches its review panel off:

```sh
curl -sS -H "$AUTH" -H 'content-type: application/json' \
  -d '{"lanes":3,"review":false}' \
  "$CONTROL/v1/rigs/rig-1/settings"
```

It answers `{"rig":"rig-1","id":"<command id>","sent":{"lanes":3,"review":false},"restarts":false,"said":"Control sent 2 settings to rig-1. The rig takes the change in less than one minute."}`. Control sends only the fields that differ from what the rig reports, as one signed command; follow it as in [Issue a command and follow it](#issue-a-command-and-follow-it). A request that changes nothing answers `"said":"Nothing changed."`, with `id` `null`. `GET` on the same address reads the rig's settings and its GPU split. [A rig's settings](../../reference/rest-api.md#a-rigs-settings) lists every field and refusal, such as `400` and `{"error":"Not saved: with 4 GPUs the judge takes 1 to 3 of them, and the agents at most 8."}`. Each agent's model has its own route: [`POST /v1/rigs/<rig>/model`](../../reference/rest-api.md#the-agents-model).

## Read the leaderboard

```sh
curl -sS -H "$AUTH" "$CONTROL/v1/leaderboard"
```

```text
{"campaigns":{"my-campaign":[{"rig":"rig-1","run":"run-1","mode":"hill_climb","status":"running","champion_seq":2,"gain":0.67,"verified_by":[]}]}}
```

For each hill-climb campaign, best first: each run's champion, its `gain` over the run's own starting point, measured on its own rig (0.67 is 67%), and the other rigs whose judges confirmed it (`verified_by`).

## Download a champion

A run's champion is a patch from the run's starting commit. It reaches control with the rig's next export, which comes every hour. To export at once, send an `export_now` command (payload `{}`), or press **Export** on the rig's page, then **Export** under the choice; the patch is there within a minute. Then download it by run and champion number:

```sh
curl -sS -H "$AUTH" -D headers.txt -o run-1-champion-2.patch \
  "$CONTROL/v1/runs/run-1/champions/2/patch"
grep -i '^x-thermite' headers.txt
```

`x-thermite-base-commit` is the commit to apply the patch to, and `x-thermite-sha256` is the patch's SHA-256. Before the rig has published that champion, the answer is `404 {"error":"no patch for that champion"}`. [Take the result](../campaigns/take-the-result.md) says how to apply it.

## Errors to expect

| Answer | Why |
| --- | --- |
| `401 {"error":"unauthorized"}` | The token is missing or isn't the owner's |
| `400 {"error":"invalid request"}` | The JSON body has a missing or wrong field. The answer doesn't say which, but the `failed` entry in the audit log does (see below). The [reference](../../reference/rest-api.md) gives each route's fields |
| `404` | Control doesn't have what the route names: a rig, when you read its view; a command; a champion patch; a pending command to cancel; or a key waiting with that fingerprint |
| `409` | The action can't happen now, for example `{"error":"no deployment driver is configured"}` for a restart |
| `400` or `404` with a reason, for a command | Control refused the command before signing it, for example `{"error":"bad pause_run payload: …"}`, a message that nothing would read (`400`), or `{"error":"unknown rig rig-9"}` for a rig it doesn't know (`404`) |
| `500` with a reason | Control refused another action while doing it, for example a propagation it can't make |

Control also writes each `invalid request` and each `500` to its audit log, as a `failed` entry with the route and the reason. A command it refuses before signing it (`400` or `404` with a reason) is written as a `refused` entry, with the kind and the reason. `GET /v1/audit?limit=20` lists the newest entries.
