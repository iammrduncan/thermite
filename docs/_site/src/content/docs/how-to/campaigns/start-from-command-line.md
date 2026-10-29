---
title: "Start a campaign from the command line"
description: "Validate a contract and assign a run to a rig with the thermite command."
type: how-to
sidebar:
  order: 2
---

Send a [contract](../../reference/glossary.md) to a rig with `thermite assign`. Use this when you keep contracts in files, or script your campaigns.

```sh
npx thermite contract validate contract.json
npx thermite assign --contract contract.json --run sort-speed-1 \
  --seed https://git.example.com/you/project.git@0123456789abcdef0123456789abcdef01234567 \
  --kit https://git.example.com/you/project-kit.git \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. They also use the local stack's address, `http://127.0.0.1:8800`, and its rig `local-1`: for a control on another computer, use its address, such as `https://control.example.com`.

## Before you start

- Thermite's command line, built from a clone of its source code with Node.js 22.19 or later ([the command line](../install/one-machine.md#the-command-line)). Thermite's images also have the command line, as `thermite`.
- A contract file. Its `mode` is the kind of campaign: `hill_climb`, `goal` or `research`. See [Choose a campaign mode](choose-a-mode.md) and [Write a contract](write-a-contract.md).
- For a hill climb or a goal campaign: the project and its [kit](../../reference/glossary.md) in git repositories the rig can fetch. The contract names each by a short name, and the kit by its full commit too; the addresses are given here, with `--seed` and `--kit`. See [Write a kit for your project](write-a-kit.md).

  ```json title="contract.json (part)"
  "project": {
    "repo": "project",
    "kit": { "repo": "project-kit", "commit": "89abcdef0123456789abcdef0123456789abcdef" }
  }
  ```
- For a private project or kit: `thermite assign` has no option to name a [Git access](private-repository.md). See [If the repository is private](#if-the-repository-is-private).
- The owner's token in a file. No other token works with these commands. (Over MCP, an operator's or an agent's token can send the same payload: see [Send it from an agent over MCP](#send-it-from-an-agent-over-mcp).) See [Tokens and roles](../../reference/tokens.md).
- A rig that reports to control. For agents to work, it needs a model: see [Connect a model provider](../models/connect-a-provider.md). If the model uses a paid key, put a limit in the contract first: see [Set a budget or a stop time](budget-and-stop-time.md).
- A rig runs one run at a time: a new run pauses the run at work on that rig.

## 1. Validate the contract

```sh
npx thermite contract validate contract.json
```

A valid contract prints its mode, name, version and hash, such as `ok hill_climb sort-speed v1 sha256=5f0c…`. A hill climb or goal contract without `project.kit` also prints a warning that the judge can't measure it yet. A contract with mistakes prints each one as `<field>: <message>` and exits with status 1.

## 2. Assign a run

Run `thermite assign` as in the example at the top. Control signs the command and prints its id, such as `{"id":"3f6c1d2e-…","status":"pending"}`. The rig's [supervisor](../../reference/glossary.md) then fetches the two commits, and its [harness](../../reference/glossary.md), the rig's container that holds the judge and the agents, checks them and the kit before the run starts.

| Option | What it does |
| --- | --- |
| `--contract F` | The contract file. Required |
| `--run ID` | The new run's name: up to 64 lowercase letters, digits, dashes and underscores, starting with a letter or a digit. It must be new on control: a name used on any rig, also by a run from before a full reset, is refused. Required |
| `--seed GIT_URL@COMMIT` | Where the project comes from, and the full commit to start from. Without `@COMMIT`, the contract's `project.commit`. The rig keeps the project under the contract's `project.repo` name |
| `--seed-commit C` | Instead of `--seed`: a full commit already on the rig, such as an earlier run's champion |
| `--kit GIT_URL` | Where the kit comes from. Its commit comes from the contract. Leave it out when the rig already has that kit commit |
| `--kit control:NAME` | Instead: the kit `NAME` that control keeps. The rig fetches the contract's kit commit from control. See [Give control a kit you wrote elsewhere](write-a-kit.md#give-control-a-kit-you-wrote-elsewhere) |
| `--model NAME=URL` | A [model file](../../reference/glossary.md) the contract lists under `models`: a data file your project loads, such as a model's weights, with the address to fetch it from. Only a file with the contract's sha256 reaches the harness. Repeat for each model. For a large file, give the assignment time with `--ttl`: see [Bring a model's weights to a run](model-weights.md) |
| `--agents off` | A run with no agents: only the judge works. See [Test a kit with known candidates](test-a-kit.md) |
| `--promotion auto` or `owner` | `auto`: a confirmed win becomes the champion at once. `owner`: it waits for you. Unset: the rig's default |
| `--queue-from RUN` | Start the new run's queue with the untried experiments of an earlier run, by its name, on any rig. Off unless you give it. See [Start further runs](#start-further-runs) |
| `--mcp-servers JSON` or `@file` | The MCP servers the kit's `kit.json` names, as it names them. Needed when it names some: the rig refuses a run whose list differs. See [Give agents MCP tools](give-agents-mcp-tools.md#3-start-the-run) |
| `--control URL`, `--token-file F`, `--rig R` | Control's address, the owner's token file and the rig |
| `--ttl MIN` | How long the command may wait to be delivered, in minutes: 60 unless set, at most 10080 |
| `--print` | Print the payload instead of sending it |

With neither `--seed` nor `--seed-commit`, the contract's `project.commit` must already be on the rig. A research campaign needs neither `--seed` nor `--kit`. The [command-line reference](../../reference/command-line.md#assign) has every option.

## 3. Check that it started

- On the dashboard, open **Commands** in the sidebar. The **assign campaign** row shows **delivered** once the harness took it, or **failed** with the reason: see [If it is refused](#if-it-is-refused).
- Open **Campaigns**. The run shows under **At work now**, and the campaign in the list below, once the rig reports the run, usually within a minute. Press **refresh** in the status bar, the line along the bottom of the page: pages don't reload by themselves.
- From a script, ask control with the owner's token:

  ```sh
  curl -s -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
    http://127.0.0.1:8800/v1/commands/3f6c1d2e-…
  ```

  Its `status` is `pending`, `delivered`, `rejected`, `failed` or `expired`, and `outcome` holds the rig's answer. `rejected` means the rig refused the command before it tried it, for example because its signature or payload didn't pass the rig's checks; `failed` means the rig tried it and it didn't work, for example because a fetch failed. See [Statuses](../../reference/signed-commands.md#statuses).

## Start further runs

Assign each further run the same way, with a new `--run` name. To start its [experiment queue](choose-what-runs-next.md) with what an earlier run had not tried yet, add `--queue-from` and that run's name:

```sh
npx thermite assign --contract contract.json --run sort-speed-2 \
  --seed-commit 0123456789abcdef0123456789abcdef01234567 --queue-from sort-speed-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

The new run's queue starts with `sort-speed-1`'s experiments up next, in their order, then its lanes' ideas, at most 500, as **Start a run** copies them. The command reads them from control, with each one's words and author from control's records, so it needs `--control` and `--token-file` even with `--print`. Control knows the run by its name wherever it ran: on another rig, on a retired rig or before a full reset. A run without agents (`--agents off`) can't take them. Without `--queue-from`, the new run's queue starts empty and the planner fills it.

Or let control assign it again, as **Start a run** on the campaign's page does, with `thermite run start`:

```sh
npx thermite run start sort-speed --rig local-1 --queue-from sort-speed-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
```

It needs no contract and no commit: control reuses those of the campaign's newest assignment, and prints the new run's name and command id. [Start a run from a script or an agent](start-from-dashboard.md#start-a-run-from-a-script-or-an-agent) gives its other options.

Or open the campaign's page on the dashboard and press **Start a run**: choose the rig under **Where it runs**, **Agents** **On** or **Off: a try**, and press **Start the run**. The page is `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`. It opens once the **assign campaign** row on **Commands** is **pending** or **delivered**, even before the rig reports the run. Until the rig does, the **Campaigns** list doesn't show the campaign, and the page says `Assigned to a rig over the API, MCP or the CLI; no run of it reports now.` A campaign saved from the dashboard's **New campaign** page says `Saved on control, with no run yet.` instead.

Control assigns the campaign again as it assigned its newest run, with the same contract, starting commit and imports, as a new run named `<campaign>-<n>`, or `<campaign>-try-<n>` without agents, with the first number not yet used on that rig, such as `sort-speed-2`. **Agents**, and **When a change is confirmed better** under **More options**, come from the panel, not from the old assignment. With **Agents** **On**, **Experiments to start with** can copy another run's untried experiments into the new run's queue: see [Choose what a run tries next](choose-what-runs-next.md#start-a-run-from-another-runs-untried-experiments). **From past research** can add experiments, and background for the agents' briefs, from the collections the campaign may read in Thermite's knowledge base: see [Use past research in a new run](use-past-research.md#start-a-run-from-past-research). `thermite assign` has no option for past research: use `thermite run start --past`, or send a payload with `thermite command`, as that page shows. A run on another rig needs that rig to get the project and the kit the same way: see [Run a campaign on several rigs](several-rigs.md).

## Send it from an agent over MCP

`--print` builds the payload without the control options:

```sh
npx thermite assign --contract contract.json --run sort-speed-1 \
  --seed https://git.example.com/you/project.git@0123456789abcdef0123456789abcdef01234567 \
  --kit https://git.example.com/you/project-kit.git --print
```

The agent sends it with the `issue_command` tool, kind `assign_campaign`, then polls `command_status` with the id. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

## Start it when the rig can't fetch

For the kit, give control the kit's repository instead, and start the run with `--kit control:NAME`: control keeps the kit, and the rig fetches it from control. See [Give control a kit you wrote elsewhere](write-a-kit.md#give-control-a-kit-you-wrote-elsewhere).

Otherwise, put the project and the kit in the rig's inbox yourself, as git bundles that hold the commits. This works for a private repository too. The inbox is `/inbox` in the rig's containers, and `.dev/inbox` in your Thermite folder on the local stack:

```sh
mkdir -p .dev/inbox/repos
git -C ~/src/project bundle create "$PWD/.dev/inbox/repos/project.bundle" main
git -C ~/src/project-kit bundle create "$PWD/.dev/inbox/repos/project-kit.bundle" main
```

For a rig elsewhere, make the bundles the same way, then copy them into its supervisor's container:

```sh
# A rig on a machine: on that machine, as the user the rig runs as
podman exec thermite-rig-1-supervisor mkdir -p /inbox/repos
podman cp project.bundle thermite-rig-1-supervisor:/inbox/repos/project.bundle

# A rig on a Kubernetes cluster, in the rig's namespace
POD=$(kubectl get pod -n <namespace> -o name \
  -l app.kubernetes.io/instance=rig-1,app.kubernetes.io/component=supervisor | cut -d/ -f2)
kubectl cp -n <namespace> project.bundle "$POD":/inbox/repos/project.bundle
```

Copy the kit's bundle the same way.

Then `thermite assign-payload` names the bundles by their paths inside the inbox, and `thermite command` sends the payload. Use the contract's `project.repo` and `project.kit.repo` for `--seed-repo` and `--kit-repo`, and its `project.kit.commit` for `--kit-commit`: the harness looks for the kit's commit under that name.

```sh
npx thermite assign-payload --contract contract.json --run sort-speed-1 \
  --seed-repo project --seed-commit 0123456789abcdef0123456789abcdef01234567 --bundle repos/project.bundle \
  --kit-repo project-kit --kit-commit 89abcdef0123456789abcdef0123456789abcdef \
  --kit-bundle repos/project-kit.bundle > payload.json
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind assign_campaign --payload @payload.json
```

`assign-payload` has no `--promotion` option: such a run follows the rig's default.

## If the repository is private

`thermite assign` has no option to name a [Git access](private-repository.md): the **New campaign** page is the way made for it. From the command line, use one of:

- the bundles above, which need no access on the rig;
- a payload that names the Git access, sent with `thermite command`: see [Use a private repository](private-repository.md#from-the-command-line).

## If it is refused

The command line itself prints a refusal from its own checks or from control. A refusal from the rig shows on **Commands**, in the command's row.

| You see | Where | What to do |
| --- | --- | --- |
| `give --control, --token-file and --rig to issue it, or --print to show it` | The terminal | Add the three options, or `--print` |
| `the seed commit must be a full commit id (40 or 64 hexadecimal characters)` | The terminal | Give the whole commit after `@` |
| `--kit given, but the contract names no project.kit` | The terminal | Add `project.kit` to the contract |
| `a run without agents has no queue: leave out --queue-from` | The terminal | Leave out `--queue-from`, or `--agents off` |
| `-> 404 {"error":"no run sort-speed-1"}` | The terminal | Check the run's name on the campaign's page |
| `-> 401 {"error":"unauthorized"}` | The terminal | Use the owner's token |
| `bad assign_campaign payload: seed.repo: lowercase id` | The terminal | Make the contract's `project.repo` a lowercase name, such as `my-project` |
| `-> 400 {"error":"The kit names the MCP server paper-search, and Settings has no server of that name. …"}` | The terminal | Add the server in **Settings › Providers**, or take it out of the kit |
| `-> 400 {"error":"run sort-speed-1 was used already, on local-1: a run's name is used once on control, on every rig. Choose another, such as sort-speed-2"}` | The terminal | Use the name it suggests, or another new one |
| **failed**, `run <id> already exists` | **Commands** | Choose a new run name |
| **failed**, `contract <campaign> v<n> exists with other content` | **Commands** | You changed the contract: raise its `version` |
| **pending**, then **expired** | **Commands** | The rig's supervisor is down, or a large fetch took longer than the command may wait: send it again with a longer `--ttl` |
| **failed**, `staging: <address> has no commit <commit>`, or git's own error after `staging:` | **Commands** | The rig could not fetch the project or the kit. Check that the address works from the rig and that the commit is pushed there. For a private repository, see [If the repository is private](#if-the-repository-is-private). Then send the same command again: the run was never made |
| **failed**, `the kit does not fit the contract: …` | **Commands** | The kit lacks a cell, metric or verifier the contract names, a case the contract runs has no `work` parameter above zero for one of the kit's rate metrics, or the kit measures on another target: each problem is named, such as `cells names cell large, which the kit does not have`. Correct the contract, or commit the kit again and put its new commit in `project.kit`. Then send it again, with a new `version` if this version already ran on the rig |
| **failed**, `the kit names the MCP servers …, and the assignment names none: …` | **Commands** | Send the kit's list with `--mcp-servers`, as `kit.json` has it |
| **failed**, `kit <repo> at <commit> has no valid kit.json: …` | **Commands** | Fix `kit.json` as the message says, commit it, and put the new commit in `project.kit`. See [Write a kit for your project](write-a-kit.md) |
