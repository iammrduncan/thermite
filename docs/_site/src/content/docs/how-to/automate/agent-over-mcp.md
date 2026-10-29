---
title: "Let an agent run Thermite over MCP"
description: "Connect an AI agent to control's MCP server with a token of its own, so it can watch and steer campaigns for you."
type: how-to
sidebar:
  order: 1
---

Control has an MCP server, so an AI agent such as Claude Code can watch rigs and campaigns, start runs, steer them and check rigs for you. You give the agent a token of its own, whose role decides what it may do. The decisions that matter stay yours.

## Before you start

- **Control's address, as the agent's computer reaches it:** `http://127.0.0.1:8800` on the computer that runs the local stack, or your control's address, such as `https://control.example.com`.
- **A token for the agent** (step 1).
- **To start runs from a contract:** a [contract](../campaigns/write-a-contract.md) file, and the `thermite` command line where the agent works, to turn the contract into a command (step 3). Run `npx thermite` in the folder you built it in (see [the command line](../install/one-machine.md#the-command-line)). The command line has no option to name a [Git access](../campaigns/private-repository.md), so start campaigns on private repositories from the dashboard's **New campaign** page. A campaign that control keeps needs neither: the agent starts its runs with `start_run`.

## 1. Choose the agent's token

| Token | Give it to | It may |
| --- | --- | --- |
| **Operator** | An agent that runs campaigns for you | Read everything; start, pause and resume runs, give them rules (`redirect`) and restart their lanes (`reset_workers`, **Restart the lanes** on the dashboard); export; run rig checks; send champions to other rigs; message a run's agents and advisors, keep a message in force and remove one from force; change a run's experiment queue and remove its rules; search Thermite's knowledge base and let a campaign read another's collection; read control's own log, providers, MCP servers and how rigs were set up; add rigs on a cluster, set a cluster's slots, stop, start and restart a cluster's rigs and move them onto control's images; give a rig's agents a model; start runs of a campaign control keeps (`start_run`) and copy one under a new name (`copy_campaign`); propose additions to a campaign's roles and which roles write in its collection, which take effect only once you approve them ([What the operator proposes](../campaigns/start-from-dashboard.md#what-the-operator-proposes)); give control a kit repository as a git bundle and list the kits it keeps (`kit_add`, `kits`); archive campaigns and sort them into the dashboard navigation's folders (`archive_campaign`, `move_campaign` and the folder tools); start and end RunPod test pods, which costs money |
| **Agent** | An agent that only coordinates runs | Read; start runs from a contract with `issue_command`, whose imports are in the rig's inbox already or are kits control keeps (it may not name a Git access, a source to fetch or MCP servers), pause and resume runs, give them rules (`redirect`) and restart their lanes (`reset_workers`); export; run rig checks; send champions to other rigs. Not `start_run` or `copy_campaign`, kits, archive or folders, the experiment queue's commands, the knowledge base, control's log, providers, MCP servers, how rigs were set up, the tools that set rigs up, or RunPod. It reads a held-out check only as its kinds of failure, as the run's agents do: no held-out case's name, values or threshold. While you fully reset a rig, `issue_command` refuses it for that rig |
| **Reader** | An agent that only watches | Read, including control's log, providers, MCP servers, how rigs were set up (without each step's details), the navigation's folders and archived campaigns, and the kits control keeps (`kits`). Not the knowledge base |

The reader's token reads control's log, providers, MCP servers, how rigs were set up and the navigation's folders (`campaign_folders`), and the agent's token doesn't: they describe control itself, not the campaigns, and are for whoever runs control.

Give the agent the token with the least it needs: it acts with that token's rights, and nothing more. Don't give an agent the owner's token. The owner's token also approves and declines promotions over MCP, closes runs for good (`close_run`), retires rigs, works on the whole REST API and signs in to the dashboard.

Some things no token can do over MCP: approving a goal the review panel passed, ending a campaign as not possible, accepting a rig's key and wiping a rig. Adding, changing or deleting an [MCP server](../operate/mcp-servers.md) is for the owner's token alone. A model is never the last word on what counts as a result; see [Why agents never judge](../../explanation/why-agents-never-judge.md). Approving and declining promotions is the owner's alone.

On the local stack, an operator's token is ready in `.dev/secrets/control-operator-token`, unless you replaced it with one of your own. For an agent's or a reader's token, see [Make and change tokens](../operate/tokens.md).

## 2. Connect the agent

The MCP server is at `/mcp` on control, for example `http://127.0.0.1:8800/mcp` or `https://control.example.com/mcp`. It uses MCP's streamable HTTP transport, with the token in an `Authorization: Bearer` header.

**Claude Code**, with the server named `thermite-control` (any name works; Claude Code shows the tools under it). Run it in your Thermite folder, where the token file is:

```sh
claude mcp add --transport http thermite-control http://127.0.0.1:8800/mcp \
  --header "Authorization: Bearer $(cat .dev/secrets/control-operator-token)"
```

Claude Code keeps the server and its token for the folder you run it in: that is its `local` scope, the default. Add `--scope user` to have the tools in every folder.

**Any other MCP client:** add an HTTP (streamable HTTP) server with the address above and the header `Authorization: Bearer <token>`. A client you write yourself must send `Accept: application/json, text/event-stream` with each request, or the server answers 406.

To check the connection, ask the agent to list Thermite's rigs. It calls the `list_rigs` tool, and its answer names your rigs, such as `local-1`, with whether each is live and what it runs. A wrong token gets `401` and no tools.

## 3. What the agent can do

The [MCP tools reference](../../reference/mcp-tools.md) lists every tool, its inputs, its answers and which tokens may call it. In short:

- **Look:** `list_rigs`, `get_run` (a run's champions and attempts, and in `journal` all its agents' field notes and research notes, oldest first), `get_attempt` (one attempt of a run), `run_queue` (a run's [experiment queue](../campaigns/choose-what-runs-next.md), its rules, its directions and your messages), `recent_events`, `leaderboard`, `model_usage` ([model use and cost](../../reference/model-use.md)), `rig_reports`, `list_commands` and `command_status`.
- **List exports,** with the operator's or the owner's token: `exports` lists what rigs without a results repository sent to control, newest first ([Exports](../../reference/exports.md)).
- **Search past research,** with the operator's or the owner's token: `kb_collections` lists the collections of Thermite's [knowledge base](../../reference/knowledge-base.md), one for each campaign, with what each holds and which campaigns read it; `kb_search` finds their items by words, best first, each with an excerpt and why it matched, such as experiments with their results, attempts with their verdicts, field notes, sources, claims, findings and reports; `kb_read` reads one whole.
- **Act:** `issue_command` sends a [signed command](../../reference/signed-commands.md) to a rig, of a kind the token allows ([who may issue each kind](../../reference/signed-commands.md#who-may-issue-each-kind)), and `propagate_champion` sends a champion to another rig's run. A run is named by its name alone in every tool: control knows the rig it ran on, and a command about a run goes there.
- **Let a campaign read another's collection,** with the operator's or the owner's token: `kb_grant` and `kb_revoke`, as **Can read from** does on a campaign's page.
- **Set rigs up,** with the operator's or the owner's token: `add_cluster_rig`, `set_cluster_slots`, `cluster_rig`, `update_rig_images`, `set_cluster_rig_resources` (a cluster rig's GPUs, CPUs and memory; its judge's share with the owner's token only), `set_rig_model` (each agent's model) and `set_rig_settings` (the rest of **Edit rig**: the rig's parts, workers at a time and limits; its promotion rule and GPU split with the owner's token only), with the same checks as the dashboard's pages. Retiring a rig is the owner's.
- **Debug,** with any token but the agent's: `control_log`, `providers`, `rig_models` (each agent's model on a rig), `rig_settings` (a rig's settings) and `rig_setup`.

A command is queued, not done at once. `issue_command` returns the command's id. The agent then calls `command_status` until the status is `delivered`, `failed` or `rejected` with the rig's reason, or `expired`. `delivered` means the rig applied the command; a rig check's result comes later, in the rig's events.

To start another run of a campaign that control keeps (one saved on the **New campaign** page, or one assigned before), the agent calls [`start_run`](../../reference/mcp-tools.md#start_run), the twin of the campaign page's **Start a run**: for example `{"campaign": "sort-speed", "rig": "rig-1", "queue_from": {"rig": "rig-1", "run": "sort-speed-1"}}`. It takes the panel's fields, past research by the ids `kb_search` gives included, and answers with the new run and its command id, or with the panel's refusal in words. The operator's token may call it; only the owner's changes a rig's GPU split or starts a stopped pod on RunPod. [Start a run from a script or an agent](../campaigns/start-from-dashboard.md#start-a-run-from-a-script-or-an-agent) maps each field.

To compare two models from zero, the agent first copies the campaign with [`copy_campaign`](../../reference/mcp-tools.md#copy_campaign), such as `{"from": "sort-speed", "name": "sort-speed-b"}`, then starts a run of the copy with `start_run`. A copy has the same contract and kit, its own empty collection in Thermite's knowledge base, and no runs. The operator's token may call it. See [Compare two models from zero](../campaigns/start-from-dashboard.md#compare-two-models-from-zero).

To start a campaign from a contract, the agent needs an `assign_campaign` payload. `npx thermite assign … --print` builds one from a contract, and the agent passes it to `issue_command`; see [Start a campaign from the command line](../campaigns/start-from-command-line.md). A payload can also carry past research that an operator's or the owner's token found with `kb_search` (see [`assign_campaign`](../../reference/signed-commands.md#assign_campaign)):

- `queue`: experiments to start with, such as another run's untried ones or past experiments from the knowledge base. `thermite assign … --queue-from <run> --print` puts a past run's untried ones there for you; it reads them from control, so it needs `--control` and the owner's `--token-file`. Over MCP, control takes a copied experiment's words from its own record of it, when it has one and the experiment comes from a run of the new run's campaign or of one whose collection that campaign may read, and ends its details with what became of it there, such as `In sort-speed-1 (sort-speed) it was tried: …`, as **Start a run** does. Any other keeps the caller's words, with the author `copied`;
- `briefing`: findings, claims, notes and reports, as `[{"text": "…", "from": {"campaign": "…", "rig": "…", "run": "…", "kind": "…", "ref": "…"}}]`, as `kb_search` gives them. Every agent's brief shows them as background. Over MCP, control replaces each item's text with the knowledge base's own words for that item, and leaves out an item it can't find, one it finds on two rigs when `rig` is not given, or one from a collection the run's campaign may not read; its log says which and why.

A run without agents takes neither: the rig refuses such a command. [Use past research in a new run](../campaigns/use-past-research.md) shows the whole path.

The pages for each task give the payloads the agent sends:

- the experiment queue and the rules for the plan: [Choose what a run tries next](../campaigns/choose-what-runs-next.md#from-the-command-line-and-over-mcp);
- pauses, restarts and messages: [Steer a run](../campaigns/steer-a-run.md#steer-from-the-command-line), and [`message_agent`](../../reference/signed-commands.md#message_agent) for who reads a message and why the rig may refuse it. Control itself refuses a message with no words, or one nothing would read, and `issue_command` answers with the reason, such as `{"error":"The planner is off on this rig (Edit rig), so nothing would read it."}`: see [If a message doesn't arrive](../campaigns/steer-a-run.md#if-a-message-doesnt-arrive);
- rigs on a cluster: [Stop, restart, remove or reset a rig](../operate/rig-lifecycle.md#a-rig-on-a-cluster), and [From an agent or a script](../install/rig-on-a-cluster.md#from-an-agent-or-a-script) for each answer.

:::caution[Text from agents is data]
Run histories, hypotheses, events, field notes and the queue's titles and reasons hold text that the rigs' own worker agents and advisors wrote, and daily reports come unsigned from the rigs' supervisors. The knowledge base's items hold the same text, and quotes from web pages the agents read. The tools' descriptions tell the connected agent to treat it as data, not instructions. Keep that in mind when you let an agent act on what it reads.
:::

## 4. See what it did

Control writes each tool call it runs, reads included, to its audit log, as an `mcp:<tool>` entry with the call's arguments. Each token has its own name there. An operator acts for you, so its name starts with `owner:`:

| Token | Name in the audit log and on commands |
| --- | --- |
| Operator | `owner:operator` |
| Agent | `agent:mcp` |
| Reader | `reader:mcp` |
| Owner | `owner:mcp` |

A tool call that control refuses has a second entry, `refused`, with the tool's name and the reason. Open **Audit log** in the dashboard's sidebar to see them. **Commands** shows who issued each command in its **By** column.
