---
title: "Tokens and roles"
description: "Each kind of token, what it may do, and how it is made, changed and ended."
type: reference
sidebar:
  order: 9
---

Control knows people and programs by **tokens**: long random strings sent as `Authorization: Bearer <token>`. Each token has one role. Control keeps only a token's SHA-256 hash wherever it can, so the machine control runs on holds nothing that signs in.

## People and agents

| Role | Setting | Dashboard | REST API | MCP |
| --- | --- | --- | --- | --- |
| **Owner** | `THERMITE_CONTROL_ADMIN_TOKEN_SHA256` or `THERMITE_CONTROL_ADMIN_TOKEN_FILE` (required) | Signs in. The only token that can | Every route | Every tool. Commands up to approving and declining promotions and closing a run (`close_run`) |
| **Operator** | `THERMITE_CONTROL_OPERATOR_TOKEN_SHA256` or `_FILE` (optional) | No | No | Reads; steers; messages a run's agents and removes messages kept in force; ends a run's wait for its provider's limit (`end_wait`); changes a run's [experiment queue](signed-commands.md#queue_add) and removes its rules; searches [the knowledge base](knowledge-base.md) (`kb_collections`, `kb_search`) and proposes that a campaign's agents read another campaign's collection, which waits for the owner (`kb_grant`), but never grants or removes one; lists the MCP servers in **Settings** (`mcp_servers`), but never adds, changes or deletes one; adds cluster rigs, sets a cluster's slots, stops, starts and restarts cluster rigs, and moves them onto control's images; gives each of a rig's agents a model, and reads them (`set_rig_model`, `rig_models`); changes a rig's other settings as **Edit rig** does, its parts, workers at a time and limits, but never its promotion rule or its GPU split, and reads them (`set_rig_settings`, `rig_settings`); starts runs of campaigns control keeps (`start_run`), as **Start a run** does, but never changes a rig's GPU split or starts a stopped RunPod pod there; copies a campaign control keeps under a new name (`copy_campaign`); gives control a kit repository written elsewhere as a bundle, and lists the kits control keeps (`kit_add`, `kits`): a kit is an input, not a secret; archives and unarchives campaigns, and sorts them into the dashboard navigation's folders (`archive_campaign`, `unarchive_campaign`, `create_campaign_folder`, `rename_campaign_folder`, `delete_campaign_folder`, `move_campaign`); starts and ends RunPod tests, lists the rigs launched on RunPod and reads a RunPod rig's pod log (`runpod_rig_logs`), but never launches, stops, starts, restarts, terminates or resets one; reads control's log, providers and how control set a rig up, with each step's details |
| **Agent** | `THERMITE_CONTROL_AGENT_TOKEN_SHA256` or `_FILE` (optional) | No | No | Reads and steers. Reads a held-out check only as its kinds of failure, as the run's agents do, and no held-out case's name, values, threshold or time limit (`get_run`, `recent_events`). No `start_run` or `copy_campaign`, no kits (`kits`, `kit_add`), no archive or folders, no changes to a run's experiment queue, no knowledge base tools, no control log, no providers, no MCP servers, no rig setup steps, no RunPod, no tools that set rigs up. Refused during a full reset |
| **Reader** | `THERMITE_CONTROL_READ_TOKEN_SHA256` or `_FILE` (optional) | No | `/metrics`, `GET /v1/usage`, `GET /v1/model-prices`, `GET /v1/rigs/<rig>/live`, `GET /v1/kits` and `GET /v1/kits/<name>` only | Read tools (not the knowledge base's), control's log, providers, the kits control keeps (`kits`), the MCP servers in **Settings** (`mcp_servers`), the rigs launched on RunPod (`runpod_rigs`, without their logs), each agent's model on a rig, a rig's settings, how control set a rig up (without each step's details), the navigation's folders and the archived campaigns (`campaign_folders`) and RunPod tests (read only). Not a RunPod rig's pod log |

"Reads" means the [MCP](mcp-tools.md) read tools, which every token has: the rigs, a run and its attempts, a run's experiment queue, rules, the planner's hand-outs and the owner's messages to its agents, with who read them (`run_queue`), events, the leaderboard, daily reports and commands. How control set a rig up (`rig_setup`), each agent's model on a rig (`rig_models`), a rig's settings (`rig_settings`) and the navigation's folders with the archived campaigns (`campaign_folders`) are for the owner, the operator and the reader, not the agent. The knowledge base's collections and search (`kb_collections`, `kb_search`) are for the owner and the operator only: the agent's and the reader's tokens see no collection.

"Steers" means these [signed commands](signed-commands.md): assign a campaign, pause and resume a run, redirect it, reset its workers, export now and run a rig check, plus sending a champion to another rig. The operator may also message the agents (`message_agent`), remove a message kept in force (`unkeep_message`), change a run's experiment queue (`queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept`) and remove a rule (`drop_directive`). Only the owner approves or declines a promotion, and closes a run for good (`close_run`).

A rig's settings change over MCP with `set_rig_settings`, through **Edit rig**'s checks: the owner's token changes all of them, the operator's all but the promotion rule, which decides whether a confirmed change waits for the owner, and the GPU split, which restarts the rig's harness. Some things no token can do over MCP: accepting a rig's key, accepting a review or a "not possible" ending, and wiping a rig. The owner does them on the dashboard, and a wipe only as part of a full reset. Only the owner's token adds, changes, signs in to or deletes an [MCP server](mcp-tools.md#mcp_server_add).

### Rules

- `_SHA256` holds the token's SHA-256 as 64 hexadecimal characters. `_FILE` names a file that holds the token itself, which is meant for local development.
- Set one of the two for a role, not both. Control stops at start if both are set.
- The owner's credential is required. Without it control does not start.
- The four tokens must all be different. Control stops at start if two are the same.
- A `_FILE` setting whose file is missing or empty counts as not set.

## Rigs and the join command

| Token | Where it is kept | What it may do |
| --- | --- | --- |
| **Rig token** | Enrolled rigs: its SHA-256 in control's store. Rigs listed in `THERMITE_CONTROL_RIG_TOKENS_FILE`: the token itself, in that file | The rig-facing routes for its own rig only: send reports, fetch commands, fetch its model route, its kits and its Git access, its advisors' models, the [MCP servers](rest-api.md#mcp-servers) the runs control assigned it name, with their sign-in, and the past research of the runs control assigned it. A retired rig is refused whatever token it holds |
| **Join token** | Its SHA-256 in control's store | Fetch one rig's join script or manifest, once, within one hour |

## Inside a rig

The harness and the supervisor have tokens of their own, which never reach control:

| Token | Setting | Used by |
| --- | --- | --- |
| Supervisor token | `THERMITE_SUPERVISOR_TOKEN_FILE` on the harness, `THERMITE_HARNESS_TOKEN_FILE` on the supervisor (required) | The supervisor, to talk to its harness |
| Proposer token | `THERMITE_PROPOSER_TOKEN_FILE` on the harness (optional) | A person or script submitting changes with `thermite submit` |
| Trial token | Made by the harness for each trial | One worker's tools during one trial, such as submitting its change, proposing an idea for the run's experiment queue, or calling the MCP servers the run's kit gives the workers, through the harness's gateway. It stops working when the trial ends |
| Planner's gateway token | Made by the harness for one planner call in OpenCode, Claude Code or Codex | That call's use of the MCP servers the run's kit gives the planner, through the harness's gateway. It lasts 15 minutes |
| An advisor's local token | Made by the supervisor for one call of an advisor in Claude Code | That call's use of the knowledge base's tools and the MCP servers the supervisor serves on `127.0.0.1`. It stops working when the call ends |

## Making, changing and ending tokens

| Token | Make | Change | End |
| --- | --- | --- | --- |
| Owner, operator, agent, reader | `thermite token new --out FILE` on your own computer: it writes the token to the file and prints its SHA-256 for control's setting. Locally, the `init` container of the compose stack (`thermite local init`), or `npm run dev:init` in a checkout, writes an owner and an operator token to `.dev/secrets/` | Make a new token, change the setting, restart control. A new owner token signs every browser out of the dashboard | Remove the setting and restart control |
| Rig token (enrolled) | `thermite rig add`, `POST /v1/rigs`, **Add a rig** on the dashboard, or a used join command | `thermite rig token`, or `POST /v1/rigs/<rig>/token`. The old token stops working at once | Retire the rig: `thermite rig retire`, `POST /v1/rigs/<rig>/retire`, the MCP tool `retire_rig`, or the rig's page. Bringing a rig back does not bring its token back |
| Rig token (in the tokens file) | Add the rig to `THERMITE_CONTROL_RIG_TOKENS_FILE` and restart control | Edit the file and restart control | Retire the rig, then remove it from the file |
| Join token | **Add a rig** › run it yourself, or **Make a new join command** on the rig's page. It is shown once | **Make a new join command** (the earlier one stops working) | **Revoke it** while it is unused, or retire the rig |

[Make and change tokens](../how-to/operate/tokens.md) gives the steps.

## In the audit log

Control's audit log names who did each thing:

| Actor | Who |
| --- | --- |
| `owner:ui` | The owner, on the dashboard |
| `owner:api` | The owner, over the REST API or the command line |
| `owner:mcp` | The owner's token, over MCP |
| `owner:operator` | The operator's token, over MCP |
| `agent:mcp` | The agent's token, over MCP |
| `reader:mcp` | The reader's token, over MCP |
| `rig:<rig>` | A rig, with its own token |
| `control` | Control itself |
