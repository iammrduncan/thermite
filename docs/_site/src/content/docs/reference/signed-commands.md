---
title: "Signed commands"
description: "Every command control sends to rigs: its fields, who may issue it, how it expires or is cancelled, and what the harness does with it."
type: reference
sidebar:
  order: 8
---

Control tells a [rig](glossary.md) what to do only through **signed commands**. Control signs each command with its own Ed25519 key. The rig's [supervisor](glossary.md) carries the command to the [harness](glossary.md), which checks the signature, the rig's name and the time before it does anything. The supervisor can carry a command, but it cannot make one or change one.

```json title="A signed command"
{
  "envelope": {
    "v": 1,
    "id": "3f6c2a8e-5b1d-4c7a-9e2f-0a1b2c3d4e5f",
    "rig": "rig-1",
    "kind": "pause_run",
    "issued_by": "owner:api",
    "issued_at": "2026-10-19T09:00:00.000Z",
    "expires_at": "2026-10-19T10:00:00.000Z",
    "payload": { "run": "run-1", "reason": "checking the kit" }
  },
  "signature": "<base64 Ed25519 signature>"
}
```

Commands come from the dashboard, the [REST API](rest-api.md), the [command line](command-line.md) and the [MCP tools](mcp-tools.md). All of them go through the same code in control, so a command is checked and signed the same way wherever it comes from. For the reasons behind this design, see [Trust between control and rigs](../explanation/trust.md).

## The command

| Field | Type | Meaning |
| --- | --- | --- |
| `envelope.v` | `1` | The format's version |
| `envelope.id` | UUID | The command's id. Control makes it |
| `envelope.rig` | text | The one rig that may apply it. For a kind about one run, control sets it to the rig the run is on: see [A command about one run](#a-command-about-one-run) |
| `envelope.kind` | text | One of the [kinds](#every-kind) below |
| `envelope.issued_by` | text | Who issued it, as control knows them: `owner:ui`, `owner:api`, `owner:mcp`, `owner:operator`, `agent:mcp`, or the owner's actor for a full reset's steps. See [Tokens and roles](tokens.md#in-the-audit-log). The caller cannot choose it |
| `envelope.issued_at` | ISO 8601 time | When control signed it, by control's clock |
| `envelope.expires_at` | ISO 8601 time | When it stops being valid |
| `envelope.payload` | object | The kind's own fields, checked against the kind's schema before signing |
| `signature` | base64 | An Ed25519 signature over the envelope's canonical JSON |

Control's key pair is `control-signing.key` and `control-signing.pub` in control's data directory (`THERMITE_CONTROL_DIR`). Control makes the pair the first time it starts. `THERMITE_CONTROL_PUBKEY_EXPORT` copies the public key to a file for rigs, and the harness reads it from `THERMITE_CONTROL_PUBKEY_FILE`.

## How a command travels

| Step | Where | What happens |
| --- | --- | --- |
| 1. Issue | Control | For a kind about one run, control finds the rig the run is on ([below](#a-command-about-one-run)). Control checks that it knows the rig (it has reported and is not retired, is enrolled, or is in the rig tokens file), checks the payload against the kind's schema, signs the envelope and stores the command as `pending`. For a `message_agent`, it first trims the text and refuses a message that nothing on the rig would read (see [`message_agent`](#message_agent)). A signed command larger than 3.5 MiB is refused: `the <kind> command is too large to deliver` |
| 2. Fetch | Supervisor | The supervisor asks control for its rig's pending commands, oldest first, every `THERMITE_COMMAND_POLL_SECONDS` seconds (default 5). With the [message bus](../explanation/how-the-parts-talk.md#commands-over-the-message-bus), control also publishes the command to the rig's subject, and the supervisor takes it from there at once; it then asks control only every 3 minutes |
| 3. Stage | Supervisor | If the command names content to fetch (a project, a kit, a model or another rig's champion), the supervisor fetches it into the rig's inbox first. The command stays `pending` while it waits |
| 4. Apply | Harness | The supervisor posts the command to the harness, which checks it and applies it once |
| 5. Acknowledge | Supervisor | The supervisor tells control the status and the harness's answer, which become the command's status and outcome |
| 6. Confirm | Control | The harness records each command it applied in its ledger. When the rig's next signed report brings that record, control takes the status and outcome from it, in place of the supervisor's |

`GET /v1/commands/<id>`, the MCP tool `command_status` and the dashboard's **Commands** page, which lists the newest 200 commands, show a command's status and outcome.

### A command about one run

A kind whose payload names a `run` is about that run, except `assign_campaign`, which starts a new run on the rig it names: `pause_run`, `resume_run`, `close_run`, `redirect`, `reset_workers`, `message_agent`, `unkeep_message`, `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept`, `drop_directive`, `hypothesis_status`, `propagate`, `stop_trial`, `approve_promotion`, `decline_promotion`, `accept_review`, `conclude` and `invalidate_evidence`. A run's name is used once on control, so control knows the rig the run is on, and signs the command for that rig. `POST /v1/commands`, MCP's `issue_command` and `thermite command` may leave the rig out for these kinds; a rig given must be one the run's name is used on. Every other kind names its rig.

Control refuses, before it signs:

| Words | When |
| --- | --- |
| `Run <run> is on <rig>, not on <rig>.` | The rig given is not the run's |
| `Control knows no run <run>: name a run a rig reported.` | No rig given, and no rig created the run or has its assignment on the way |
| `Run <run> is an earlier run: <rig> is retired, so it takes no commands.` | The run's rig is retired |
| `Run <run> is an earlier run: it ran on <rig> before the rig's full reset, so it takes no commands.` | The run is of a ledger the rig's full reset left behind |
| `A <kind> command names its rig: give the rig.` | Any other kind, with no rig |

### On the dashboard

A dashboard button that sends a command shows at once that the click took, then follows the command to its outcome. You do not need to refresh the page:

1. The button turns into **Sending…**, which you cannot press again.
2. When control has queued the command, the button says **Sent**, and a line says `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`
3. When the rig has applied it (step 5 above), the line says `rig-1 took it at 03:41 UTC. This page shows the change when the rig next reports.`
4. When the rig's report with it reaches control (step 6), the line says `Done. rig-1 took it at 03:41 UTC.`, and the button comes back.

At each step the page draws again the parts that the command changes: the header with the run's state and its **Pause** or **Resume**, the blocks of the run, the rig or the overview, and the status bar. A part you are typing in, or that has a menu open, waits until you leave it. The line shows under a form, or at the top of the page for a button in the page's header or in a row. A rig's checks show their own state in their rows instead: see [Rig checks](rig-checks.md#where-results-show).

When control refuses the command, the line says why, such as `Not sent: Unknown rig rig-9.`, and the button comes back. When the rig refuses it, the line says `rig-1 refused it:` and the rig's reason. When the rig does not take it in time, the line says `rig-1 did not take it before 04:41 UTC, so it expired.`

The page asks control how the command stands every 2 seconds, and every 5 seconds after two minutes. Without the page's script, the button posts a plain form, and the page it lands on says `Sent to rig-1 at 03:41 UTC.`

## Statuses

| Status | Meaning | Outcome |
| --- | --- | --- |
| `pending` | Waiting for the rig's supervisor to take it, or for the content it names to arrive | None |
| `delivered` | The harness applied it | The harness's answer: `{"status": "applied", "accepted": true, "result": …}`, or `"replayed"` with the first answer |
| `rejected` | The harness refused it before applying it (HTTP 403): signature, rig, time, payload, or issued before the rig's state was wiped | `{"status": "rejected", "reason": "…"}` |
| `failed` | The harness applied it but it did not succeed, or the harness answered with another error, or its content could not be fetched, or the owner cancelled it | `{"status": "applied", "accepted": false, "result": {"error": "…"}}`; `{"http": <status>, "error": "…"}`; `{"error": "staging: …"}`; or `{"cancelled_by": "owner:api"}` |
| `expired` | It was still `pending` after `expires_at` | None |

Once control has the harness's own record of an applied command (step 6), the outcome is `{"source": "harness", "kind": …, "accepted": …, "result": …}`, and the status is `delivered` if `accepted` is true, else `failed`.

`delivered` means the harness carried the command out, not that what it started went well. A `rig_check`, for example, is `delivered` as soon as the check starts; its finding comes later, as a `rig_check_finished` event.

## Expiry and cancelling

| | Value |
| --- | --- |
| Time to live, set by the issuer (`ttl_minutes`, `--ttl`) | 1 to 10080 minutes (7 days). Default 60 |
| `propagate`, built by control (`POST /v1/propagate`, `propagate_champion`, **Send champion**) | 24 hours, because the champion may still be on its way to the results repository. A `propagate` sent through `POST /v1/commands` takes its `ttl_minutes` like any other kind |
| Every other command the dashboard sends | 60 minutes |
| A full reset's steps (`pause_run`, `export_now`, `wipe_state`) | 30 minutes each |
| Clock difference the harness allows between control and the rig | 5 minutes |

- **Expiry at control.** When the supervisor next asks for commands, control marks each pending command past its `expires_at` as `expired` and does not hand it over.
- **Kept alive while its content is fetched.** While the supervisor fetches a command's content (a repository bundle, a kit, a model download), it tells control so with each request. Within 10 minutes of the command's `expires_at`, control signs it again with an `expires_at` an hour later, and the audit log records `command_renewed`. It does so at most 24 hours after `issued_at`: a fetch that takes longer lets the command expire.
- **Each command's content crosses once.** The supervisor names the commands it holds already, and control answers those with their ids alone. A command signed again is sent whole once more.
- **Expiry at the harness.** The harness refuses a command whose `expires_at` has passed by the rig's clock (`expired`), or whose `issued_at` is more than 5 minutes ahead of it (`issued in the future`).
- **Cancelling.** The owner can cancel a command while it is `pending`, with `POST /v1/commands/<id>/cancel` and the owner's token. The command becomes `failed` with the outcome `{"cancelled_by": "owner:api"}`. A command that is not pending gives `404 {"error":"no such pending command"}`. With the message bus, control also takes the cancelled command off the rig's subject. The dashboard, the command line and MCP have no way to cancel. See [Cancel a pending command](../how-to/operate/cancel-a-command.md).

## What the harness checks

The harness checks every command in this order. A command that fails a check marked `rejected` is not applied: the harness answers with HTTP 403 and records a `command_rejected` event in the rig's ledger.

| Check | Reason given | Status at control |
| --- | --- | --- |
| The command has the right shape | `malformed command` | `rejected` |
| Control's public key can be read | `control public key unusable` | `rejected` |
| The signature matches control's public key | `bad signature` | `rejected` |
| The command names this rig | `command is for rig <rig>` | `rejected` |
| It was not applied before | None: a command already applied answers `replayed` with its first answer, even if it has expired since | As the first answer |
| It is not more than 5 minutes in the future | `issued in the future` | `rejected` |
| It has not expired | `expired` | `rejected` |
| The payload fits the kind | `bad payload: <field>: <problem>` | `rejected` |
| It was issued after the rig's state was last wiped | `issued before this rig's state was wiped` | `rejected` |
| It is not being applied right now | None: the harness answers `in_progress`, and the supervisor asks again later | Stays `pending` |
| An owner-only kind was issued by the owner (`issued_by` is `owner` or starts with `owner:`) | `<kind> is the owner's to issue, not <issuer>'s` | `failed` |

The owner-only kinds are `approve_promotion`, `decline_promotion`, `accept_review`, `conclude`, `close_run`, `wipe_state`, `message_agent`, `unkeep_message`, `rig_settings`, the six kinds that change a run's experiment queue and its rules: `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive`, `hypothesis_status`, which changes a research run's hypothesis, `stop_trial`, which stops one trial, and `invalidate_evidence`, which withdraws bad evidence. The owner-only check is the first step of applying a command, so a command it refuses is recorded like any applied command, as not accepted. Every applied command is recorded in the ledger with the actor `control:<issued_by>`.

A command that passes these checks and that the harness then refuses is `failed`, with the reason, such as `run <run> is closed`, `not now: …`, `trial <trial> has ended already` or `invalid contract: …`. The harness records it as applied and not accepted, and answers the supervisor `{"status":"applied","accepted":false,"result":{"error":"<why>"}}`.

## Who may issue each kind

| Kind | Dashboard (`owner:ui`) | REST and `thermite` (`owner:api`) | MCP owner (`owner:mcp`) | MCP operator (`owner:operator`) | MCP agent (`agent:mcp`) | Owner only |
| --- | --- | --- | --- | --- | --- | --- |
| `assign_campaign` | **New campaign**; **Start the run** in the **Start a run** panel of a campaign's page | Yes; `thermite assign` | Yes | Yes | Yes | |
| `rig_check` | **Run it** in a rig's **Checks**; **Check** on **Settings** | Yes | Yes | Yes | Yes | |
| `pause_run` | **Pause**, then **Pause the run** in its menu, in a run's header, in the header of the run's **Live**, and on the run's card under **At work now** | Yes | Yes | Yes | Yes | |
| `resume_run` | **Resume** in a run's header, in the header of the run's **Live**, and on a paused run's row under **Earlier runs** | Yes | Yes | Yes | Yes | |
| `close_run` | **⋯**, then **Close the run**, in the header of a run's page, while the run is running or paused | Yes | Yes | No | No | Yes |
| `redirect` | None: on the dashboard, rules come from **Tell the planner**, a `message_agent` to the planner, which makes them | Yes | Yes | Yes | Yes | |
| `reset_workers` | **Restart the lanes**, under **⋯** in the header of a running run with agents, on its page and in Live | Yes | Yes | Yes | Yes | |
| `export_now` | **Export** in the header of a rig's page or a run's page, with **What changed** (`full: false`) or **Full export** (`full: true`), or, on a run's page, **This run** (`run`) | Yes | Yes | Yes | Yes | |
| `drain_rig` | **Update to these images**, **Try the update again** and **Give it control's new address** on the page of a rig at work set up on a cluster, and **Call the update off**; **Save changes** on **Edit rig** with a new number of GPUs, CPUs or memory for such a rig, and **Call the change off**; control issues it as the caller. **End the drain** in the [drain card](rig-page.md#the-drain-card) of a draining rig's page | Yes (`POST /v1/commands`): the rig drains, but its page shows no update waiting, and it stays drained until `drain: false` or a restart; `POST /v1/rigs/<rig>/cluster/resources` | `update_rig_images`, `set_cluster_rig_resources` | `update_rig_images`, `set_cluster_rig_resources` | No | |
| `stop_trial` | **Stop this trial…**, then **Stop the trial**, in a stuck trial's card under **Needs you** ([Stuck trials](../how-to/campaigns/decide-what-waits.md#stuck-trials)), and under a trial a draining rig waits for, on the rig's page ([The trials it waits for](rig-page.md#the-trials-it-waits-for)) | Yes | Yes | Yes | No | Yes |
| `message_agent` | **Send** in the message box of a run's **Live**; **Send to the planner** on a run's **Planner** tab, while the planner is on | Yes | Yes | Yes | No | Yes |
| `unkeep_message` | **Remove** in the **📌 &lt;n&gt; kept** list of a run's **Live** | Yes | Yes | Yes | No | Yes |
| `queue_add` | **Add** under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_move` | **↑ Top**, or dragging an experiment, under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_edit` | **Edit**, then **Save**, on an experiment under **Up next** on a run's **Experiments** tab | Yes | Yes | Yes | No | Yes |
| `queue_drop` | **Drop**, then **Drop it**, on an experiment under **Up next**; **Drop** on a lane's idea under **Ideas from the lanes** | Yes | Yes | Yes | No | Yes |
| `queue_accept` | **Queue it** on a lane's idea under **Ideas from the lanes** | Yes | Yes | Yes | No | Yes |
| `drop_directive` | **Remove** on a rule on a run's **Planner** tab | Yes | Yes | Yes | No | Yes |
| `propagate` | **Send champion #&lt;n&gt;** on a run's **Planner** tab, under **Other rigs** | `POST /v1/propagate`, or `POST /v1/commands` | `propagate_champion` | `propagate_champion` | `propagate_champion` | |
| `approve_promotion` | **Needs you**: **Make it the champion**, **Overrule the auditor** | Yes | Yes | No | No | Yes |
| `decline_promotion` | **Needs you**: **Reject it** | Yes | Yes | No | No | Yes |
| `accept_review` | **Needs you**: **Accept**, **Reject** | Yes | No | No | No | Yes |
| `conclude` | **Needs you**: **End it: not possible**, **Keep going** | Yes | No | No | No | Yes |
| `hypothesis_status` | **Promote**, **Return to pool** or **Retire**, then its button, on a hypothesis on a research run's **Hypotheses** tab | Yes | Yes | No | No | Yes |
| `invalidate_evidence` | **Withdraw its evidence…**, then **See what it reaches**, then **Withdraw the evidence**, on an attempt's page | Yes; `thermite invalidate` | Yes | No | No | Yes |
| `rig_settings` | **Save changes** on **Edit rig**; **GPUs for the judge** on **New campaign** and in the **Start a run** panel | `POST /v1/rigs/<rig>/settings`, or `POST /v1/commands`; `POST /v1/rigs/<rig>/cluster/resources` with a new number of GPUs | `set_rig_settings`; `start_run` with `judge_gpus`; `set_cluster_rig_resources` with a new number of GPUs | `set_rig_settings`, but not `promotion` or `judge_gpus`; `set_cluster_rig_resources` with a new number of GPUs, which sends the new default share only | No | Yes |
| `wipe_state` | Only as a step of a full reset | No: `wipe_state is issued only by a full reset` | No | No | No | Yes |

Control's own lists decide what each MCP role may issue; the harness's owner-only check is a second gate behind them. The operator acts for the owner, so its `owner:operator` passes that gate for `message_agent`, `unkeep_message`, the six queue kinds and the `rig_settings` that `set_rig_settings` sends. The operator's list has no `close_run`, `approve_promotion`, `decline_promotion`, `hypothesis_status` or `invalidate_evidence`. For `invalidate_evidence` the harness refuses `owner:operator` itself too: `invalidate_evidence is the owner's own to issue, not owner:operator's`. During the owner's full reset of a rig, MCP's `issue_command` refuses an agent's token for that rig: `<rig> is being reset by the owner`. [Tokens and roles](tokens.md) describes each token.

On the dashboard, only an experiment up next has **Edit**: a lane's idea's words change only over the REST API, the command line or MCP. [Choose what runs next](../how-to/campaigns/choose-what-runs-next.md) walks through the **Experiments** and **Planner** tabs.

## Every kind

Ids such as `run` are lowercase ids: letters `a`–`z`, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. Commits are full commit ids, 40 or 64 hexadecimal characters. A run that does not exist gives `no run <run>`.

Except where a section says control refuses, the refusals listed under each kind come while the harness applies the command. Such a command is `failed`, and its outcome's `result` is `{"error": "<the refusal>"}`.

### `assign_campaign`

Starts a run of a campaign on the rig. On a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) whose pod is stopped, control starts the pod first, then queues the command, which waits until the pod runs ([A run on a stopped RunPod pod](rest-api.md#signed-commands)). Only the owner's token starts a pod.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The new run's id |
| `contract` | object | required | The whole [contract](contract.md) |
| `contract_sha` | 64 hexadecimal characters | required | The contract's SHA-256, as `thermite contract validate` prints it |
| `seed` | `{repo, commit}` | none | The repository (a lowercase id) and the commit the run starts from. Required for hill climb and goal campaigns; research campaigns have none. When the contract names a `project.folder`, `commit` is the whole repository's commit, and the run starts from that folder of it |
| `direction` | text | none | The run's note, recorded with the run (`thermite assign --note`). The field keeps its old name; it is not one of the run's directions |
| `imports` | list of [imports](#imports) | `[]` | What the rig must take in first: the project, the kit, models |
| `agents` | boolean | worker agents run | `false`: a judge-only run |
| `promotion` | `auto` or `owner_approval` | the rig's own setting | The run's promotion rule |
| `ask_owner` | `{above_gain?, declared_flaws?, reviews?, not_possible?}` | nothing: hands-off | What else the run asks the owner about. `above_gain`, a fraction above 0, at most 100: a confirmed gain above it waits for the owner (0.15 is 15%); `declared_flaws`, `true`: a win whose worker declared flaws waits; `reviews`, `true`: a review panel's pass waits for the owner's acceptance; `not_possible`, `true`: a "not possible" proposal waits. See [Decide what waits for you](../how-to/campaigns/decide-what-waits.md#choose-what-waits) |
| `queue` | up to 500 experiments, each as below | none | Experiments to start the new run's [experiment queue](#queue_add) with, in order: usually another run's untried ones |
| `briefing` | up to 200 items, each as below | none | Background from past research for every agent's brief, in order: findings, claims, notes and reports from [the knowledge base](knowledge-base.md#briefings) |
| `mcp_servers` | the kit's [`mcp_servers`](kit-manifest.md#mcp-servers) list | none | The MCP servers the run's kit names (a research contract's, for a research run), with the agents that get each. Control fills it in from a kit it keeps, from the page's reading of a kit in a repository, or from a research contract, and refuses a server **Settings** lacks. The harness refuses the run when it differs from what the kit names. Control gives the rig only the servers its runs name. For a research run, leave it out: control takes the contract's list, and refuses another with `The assignment names the MCP servers <list>, and the contract names <list>. Leave mcp_servers out: control takes the contract's.` |

Each experiment in `queue` has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `title` | text, 1 to 200 characters | What to try |
| `details` | text up to 4000 characters | Optional. More about it |
| `family` | text, 1 to 80 characters | Optional. Its direction, in words or as a direction family's name |
| `why` | text up to 2000 characters | Optional. Why it is worth trying |
| `by` | text, 1 to 80 characters | Who added it in the first place, such as `owner`, `planner`, `teacher` or `lane-2`. The new run keeps it as the experiment's author. Over MCP, control replaces it, as below |
| `state` | `queued` or `proposed` | `queued`: up next. `proposed`: a lane's idea, which stays an idea in the new run |
| `from` | `{run, id}` | The run and the experiment it was copied from |

Over MCP, control does not keep the caller's words for a copied experiment that it can take from its own record. It takes `title`, `details`, `family`, `why` and `by` from its record of the experiment that `from` names: the rigs' signed events, with every edit applied. A field that the record does not have is left out. It does this only when the run that `from` names is [filed](knowledge-base.md#which-collection-a-run-goes-in) in the collection of the new run's campaign (`contract.campaign`), or of a campaign whose collection that campaign may read ([Grants](knowledge-base.md#grants)). Any other experiment keeps the caller's words, and its `by` is `copied`: one that control has no record of (no rig reported it, or more than one did), and one from a run in any other collection, or in none. To an experiment taken from its record, control adds the line `In <run> (<campaign>) it was <result>.` after the details when the experiment's item in the [knowledge base](knowledge-base.md#items) has a result, as **Start a run** does, and cuts `details` to 4,000 characters.

Each item in `briefing` has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | text, 1 to 4000 characters, trimmed | The item's words |
| `from` | `{campaign, rig?, run, kind, ref}` | Where it came from: the campaign's collection (1 to 200 characters), the rig the run ran on (1 to 200 characters; control always gives it, since a run's name is unique on its rig only), the run (a lowercase id), the item's kind (1 to 40 characters, such as `finding`) and its `ref` in that run (1 to 200 characters) |

Over MCP, control does not keep the caller's words for a briefing either. It looks up the knowledge base's item that `from` names and puts that item's words in `text`. It leaves out an item it cannot find, one it finds more than once (run names are unique on one rig only), and one from a collection the new run's campaign may not read. With none left, it sends no `briefing`. It does this before it looks up the copied experiments. The REST API (`POST /v1/commands`) and `thermite command` send `briefing` and `queue` as given: control looks nothing up. `thermite assign` has no option for a briefing. Its `--queue-from` fills `queue` with a past run's untried experiments, as **Start a run** does below, and takes them from control first (`GET /v1/rigs/<rig>/runs/<run>/untried`), with the words and authors control's records hold, as over MCP. See [the command line](command-line.md#copy-a-past-runs-untried-experiments).

**Start a run** on a campaign's page also works for a campaign that was assigned over the REST API, MCP or the command line, with no version saved on control. Control then signs again the campaign's newest `assign_campaign` whose status is `pending` or `delivered`, as a new run: the same `contract`, `seed`, `imports` and `direction` (the run's note), with a new `run`, and `agents`, `promotion` and `ask_owner` from the panel. With **Agents** on and **Copy the untried experiments of** ticked, the panel also sends `queue`: the chosen run's experiments still up next, in their order, then its lanes' ideas, at most 500 of them. Its help says "They join the new run's queue in the same order, up to 500." With **Agents** off, the panel hides that field, and control sends no `queue` even when the form has it: a run without agents has no queue. Its **From past research** sends the ticked past experiments in `queue`, after the copied ones (at most 500 in all), and the ticked findings, claims, notes and reports in `briefing`, each looked up again in control's knowledge base. With **Agents** off, the panel hides **From past research** too and sends none of it. If ticked items reach control all the same (the page shown without its script), control leaves them out, starts the try, and says "A try (agents off) takes no experiments and no background: what you ticked was left out." [Use past research in a new run](../how-to/campaigns/use-past-research.md) gives the steps. Start a run's twins, `POST /v1/campaigns/<campaign>/runs`, MCP's `start_run` and `thermite run start`, run the panel's code and send the same `assign_campaign`; they refuse a run to copy from, a model or past research for a try instead of leaving them out.

The harness creates the run only after every check passes. In order, it refuses:

| Message | When |
| --- | --- |
| `invalid contract: …` | The contract does not pass its schema |
| `contract hash does not match contract_sha` | The hash differs |
| `run <run> already exists` | The run id is taken on this rig |
| `a run without agents has no queue: leave out the experiments to copy` | `"agents": false` with experiments in `queue` |
| `queue experiment <n>: <the first problem>` | An experiment in `queue` whose `title` or `family` is only spaces. `<n>` counts from 1 |
| `a run without agents has no briefs: leave out the background from past research` | `"agents": false` with items in `briefing` |
| `contract <campaign> v<version> exists with other content` | The rig has this contract version with different content |
| `model <name> is not listed in the contract` | A `model` import the contract does not list |
| `a <mode> campaign needs a seed commit` | No `seed` for a hill climb or goal campaign |
| An import's message (see [Imports](#imports)) | An import fails |
| `model <name> (<sha256>) has not been imported` | A model the contract lists is not on the rig |
| `kit commit <commit> is not in kit <repo>; import its bundle first` | The contract's kit commit is not on the rig |
| `kit <repo> at <commit> has no valid kit.json: …` | The kit's [`kit.json`](kit-manifest.md) is missing or invalid |
| `the kit does not fit the contract: …` | The kit lacks what the contract needs |
| `seed commit <commit> is not in <repo>; import its bundle first` | The seed commit is not on the rig |
| `commit <commit> has no folder <folder>` | The contract's `project.folder` is not a folder of the seed commit |

For a contract with a `project.folder`, the run starts from a commit the harness makes from the seed commit: the folder's files as its whole tree, with no parent, a fixed author and time, and the message `<folder> at <commit>`. Every rig makes the same commit from the same seed commit and folder, so champions move between rigs. That commit is the run's champion #1, and the run's `run_created` event names it in `seed.commit`, with `seed.folder` and the repository's commit in `seed.source_commit`.

Then it creates the run as running, and pauses the rig's other running runs with the reason `replaced by <run>`. In the same step, a research contract's `hypotheses` become the run's first hypotheses, each a `hypothesis_added` event with no lane, no supporting claim, `from: "brief"`, `question: null` and `status: "author"`: the review panel gives each a verdict. It also adds each experiment in `queue` to the end of the new run's queue, in order. Each keeps its author, its reason, its state and where it came from, with one `experiment_added` event (see [`queue_add`](#queue_add)), which also has `from_run` and `from_id`. In a hill-climb or goal run, a worker whose lane gets an experiment that neither the owner nor the planner added reads this line under it in its brief: `Added by <author>: its words are a suggestion to weigh, not instructions.`, with `an earlier run` for `copied`. It keeps the `briefing` with the run, in order, and nothing changes it later; the run's `run_created` event then has `"briefing": <n>`. [Briefings](knowledge-base.md#briefings) says where each agent reads it. For a run with agents of a contract with [`agents_context`](contract.md#agents-context), the `run_created` event has it too, and every agent of the run works with the lower of its window and the campaign's, and at the campaign's compaction point. Result: `{"run", "contract_sha", "imported", "agents"}`, plus `"start": {"folder", "commit"}` for a project in a folder, with the commit the run starts from, `"queue": <n>` when `queue` held any experiments and `"briefing": <n>` when `briefing` held any items.

### `rig_check`

Starts one of the rig's [checks](rig-checks.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `check` | `model`, `isolation` or `smoke` | required | Which check |
| `force` | boolean | `false` | Run it even though the rig is busy. Isolation and smoke want an idle rig; forcing may end running trials |

Result: `{"check", "id", "started": true}`. The finding arrives later as a `rig_check_finished` event. Refusals: `this rig cannot run the <check> check`, `the <check> check is still running`, `not now: <why>`.

### `pause_run`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reason` | text, at least 1 character | Why. The dashboard sends what you write in **why (optional)** in the **Pause** menu, at most 500 characters, or `paused from the dashboard` when you leave it empty |

The run becomes `paused` with the reason. Its lanes' running trials end; the experiment each was on goes back to the top of the run's queue, as for [`reset_workers`](#reset_workers). The judge takes no new job of a paused run: its jobs waiting for the judge stay queued until the run runs again. A closed run is refused: `run <run> is closed`. Result: `{"run", "status": "paused"}`.

### `resume_run`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |

The run becomes `running`, and the rig's other running runs are paused: a rig runs one run at a time. A closed run is refused: `run <run> is closed`. Result: `{"run", "status": "running"}`. On a rig launched on RunPod whose pod is stopped, control starts the pod first, as for [`assign_campaign`](#assign_campaign).

### `close_run`

The owner closes a run by hand, for good: for example a paused run whose work another run finished. Owner only.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reason` | text, 1 to 2000 characters after spaces at either end are taken off | Why. The dashboard sends what you write in **Why** in **Close run**, at most 500 characters |

The run becomes `closed` with the reason, as a goal run that met its goals does, and its `run_status` event is `{"status": "closed", "reason"}`. A running or a paused run may be closed:

- its lanes' running trials end, as for [`pause_run`](#pause_run), and its planner call is cancelled; no new round or trial starts;
- the judge takes no job of a closed run, so its jobs waiting for the judge never run. A job the judge was already measuring finishes, and its verdict is recorded, but a win it confirms does not become the champion: it is held as **Run closed**; if that job would close the run as complete, the run keeps your reason;
- a research run's final report is written once its last trial has ended, as at the end of its time;
- it can't be resumed or paused again: [`resume_run`](#resume_run) and [`pause_run`](#pause_run) refuse it with `run <run> is closed`. Its queue and rules no longer change, and it takes no new message: `run <run> is closed: nothing will read this message`. A message kept in force can still be removed with [`unkeep_message`](#unkeep_message);
- nothing in it waits for a decision any more. A change waiting for approval or held for an audit, a review the review panel passed and a "not possible" proposal stay as they were when it closed: control leaves them out of **Needs you**, the harness refuses [`approve_promotion`](#approve_promotion), [`decline_promotion`](#decline_promotion), [`accept_review`](#accept_review) and [`conclude`](#conclude) for the run, and the rig's auditor gets none of its audits. None of its changes becomes the champion by a decision.

Its experiments, attempts, champion and journal stay, and the rig's next export carries the close, as after a run that met its goals. Refusals: `no run <run>`, and `run <run> is already closed (<its reason>): there is nothing to close`, without the reason in brackets when the run closed with none. Result: `{"run", "status": "closed", "was": "running"}`, with `"paused"` for a run that was paused.

On the dashboard, **Close run** is under **⋯** in the header of a running or paused run's page. It says `The run ends for good: nothing more starts, and it can't be resumed. Its results stay.`, takes the reason in **Why**, and sends only once you type `close <run>` in the box below it. Control refuses it before signing, in words, without them: `Not sent: Write why you close the run first.` or `Not sent: Type close <run> to confirm.`

### `redirect`

A set of directives for the run's planner. See [Steer a run](../how-to/campaigns/steer-a-run.md).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `directives` | 1 to 40 directives | required | The set |
| `replace` | boolean | `true` | Replace the set this issuer gave before. `false` adds to it |

Each directive has only these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `avoid`, `try`, `mandate`, `priority`, `lane_count`, `trial_minutes`, `keep_working` or `note` | `avoid`, `try` and `mandate` (**Always** on the dashboard) name a direction; `priority` ranks one; `lane_count` sets how many lanes work, up to the contract's count; `trial_minutes` sets how long one trial lasts, in minutes (`value`, a whole number from 1 to 1440), over the contract's and the rig's; `keep_working`, `on` or `off` (`value`), whether the run's lanes keep working while the judge works, over the contract's; `note` is text for the planner only |
| `family` | letters, digits, spaces and dashes, plain or as `:name:`, that make a name of 2 to 41 characters | The direction it is about, when the kind needs one. Control signs it as the direction's name: its words in lowercase, joined by dashes, so `:Shared memory tiling:` becomes `shared-memory-tiling` |
| `value` | text up to 1000 characters, or a number | The value, when the kind needs one. A research run's `try` or `mandate` may give a question's number here instead of a `family` |
| `rationale` | text, 1 to 2000 characters | Why. The planner sees it; workers never do |
| `citations` | up to 20 texts of 1 to 500 characters | Sources. Default `[]` |

Control refuses a directive that breaks these rules before signing, with `bad redirect payload: directives.<i>[.<field>]: <message>`, `<i>` counting from 0:

| Field and message | When |
| --- | --- |
| `a rule no longer takes match: name its direction in family, in plain words or as :name:` | The directive has `match`, a rule in words |
| `family: "<text>" is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:` | Other characters in `family` |
| `family: "<text>" is too long for a direction's name: use at most 41 letters, digits, spaces and dashes` | A name over 41 characters |
| `family: an avoid, try or mandate rule names a direction (family)` | An `avoid`, `try` or `mandate` with no `family` (and, for `try` and `mandate`, no `value`) |

A `family` may name a direction the run doesn't have yet. The rig takes it, and the planner's model designs the direction at its next round: it says what the direction means, in its own words, and the run then has it ([Directions](../how-to/campaigns/choose-what-runs-next.md#directions)). A research run's planner designs no direction: control and the rig refuse there any direction but a task kind, `A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:. Its planner designs no new direction, so a rule for :<name>: would do nothing. Name a task kind.`

A set that both avoids a direction and tries or mandates it is refused: `the set both avoids and asks for <directions>`. A closed run is refused: `run <run> is closed: its queue and rules no longer change`. Result: `{"run", "directives": [<ids>]}`, with `"new_directions": [<names>]` when the set names directions the run doesn't have yet.

A rule in words (`match`) set before rules named directions stays in force, marked legacy, until the planner's next round with its model converts it. No command converts it: the rig does, at the planner's round, with new records, and no signed command or earlier record changes. The new directive has the old one's author, `kind`, `rationale`, `citations` and `from_message`, the `family` the planner named, and `"converted_from": {"rule": <id>, "words": "<the old words>"}`; its `directive` event is its author's. The old directive leaves force as converted, with the event `directive_converted` by the planner: `{"id": <old id>, "to": <new id>, "kind", "family", "words"}`. Until then, only the planner's model reads it. The fixed rules that give out work without the model (no model, a model answer that code refused, the planner switched off, and a research run's gap-driven plan) keep only the directives that name a `family`; a research run's planner converts no rule in words, so one there is never converted ([Old rules in words](../how-to/campaigns/choose-what-runs-next.md#old-rules-in-words)).

`redirect` is not the only source of rules. The teachers' set (a teacher's recommendations, or the merged by model's directives: see [What each role must answer](advisors-file.md#what-each-role-must-answer)) and a rule that the planner adds because an owner's message asked for it name a direction the same way.

The owner's `redirect`, or an operator's for the owner, can set again a rule that was removed with [`drop_directive`](#drop_directive). An agent token's `redirect`, the teachers' set and the planner's cannot.

The dashboard calls directives **rules**. It sends no `redirect`: on a run's **Planner** tab, **Tell the planner** sends a [`message_agent`](#message_agent) to the planner, and the planner adds the rules the message asks for at its next round, each with `from_message` set to the message. **Remove** sends [`drop_directive`](#drop_directive), which removes one rule. Control's own command form refuses a `redirect`: `this command is not available from the dashboard`.

### `reset_workers`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `reseed_commit` | commit | Accepted by the schema, but the harness refuses it: `re-seeding lanes is not available in this version; reset without it` |

The run's running trials end, along with the current [epoch](glossary.md) (a round, on the dashboard), and every lane starts again from the champion. The experiment each ended trial was on goes back to the top of the run's queue, the same experiment with its author and its why, and counts the return (`returns`) with its cause; its `experiment_returned` event has `{id, lane, trial, result: "interrupted", cause, returns, position: "top"}`. Result: `{"run", "reset": true}`.

The run page's **History** says "You restarted the lanes: their trials ended, and every lane starts again from the champion." (with the issuer's name in place of "You" for the agent's token), and, for each experiment, `"<title>" went back to the top of the queue: its trial on <lane> was interrupted (<cause>).` The dashboard offers **Restart the lanes** only on a running run with agents: a run without agents (a try, a rig check) has no lanes.

### `message_agent`

The owner's message to the run's agents. The judge is code and takes no messages.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `to` | one of the recipients below | required | Who gets it |
| `text` | text, 1 to 4000 characters | required | The message. Control trims it before it signs it |
| `keep` | boolean | `false` | `true` keeps the message in force: it goes into the brief of every new trial it is for, until an [`unkeep_message`](#unkeep_message) removes it. Only for `all` or a lane |

| `to` | Who reads it |
| --- | --- |
| `all` | Everyone working: each lane at work, and the planner while it is on, a research run's too. The lanes at work are the contract's `lanes.count`, or fewer when the newest `lane_count` rule in force says so, the owner's before an advisor's, as the scheduler counts them |
| `lane-1` to `lane-16` | That [lane](glossary.md) |
| `trial:t-` and 16 hexadecimal characters, a trial's ID | That trial. If it ends before it reads the message, its lane's next trial reads it, with a note that it was sent to an earlier trial |
| `planner` | The planner, at its next plan that is used, a research run's too |
| `advisors` | The teachers, the auditor and the review panel, each once, except those that a refusal below names |
| `teachers` | The teachers |
| `auditor` | The auditor |
| `review_panel` | The review panel |

Each reader reads a message once: each lane, the planner and each advisor role. Only a message kept in force is given again, to each new trial. A read is recorded when the reader works with the message, not when the text is only fetched or put in a brief. When each one reads it:

| Reader | When |
| --- | --- |
| A lane with no trial at work | In the brief of its next trial, once that trial's agent is at work: its first session line, or a model turn or tokens counted. If the trial fails before that, the lane's next trial gets the message. A message in a trial's brief is not given to it again during the trial |
| A worker in Pi | At its next step: after its model's current turn |
| A worker in OpenCode, Claude Code or Codex | When its current run ends without a submission. The harness then continues the session with the message |
| A worker that has submitted | It does not read it: a submission ends the trial, and the lane's next trial reads the message in its brief |
| The planner | At its next plan whose model's plan is used. While the planner is off, its model can't be reached, or code refuses its plan on both tries (the fixed rules give out the round's work), the message waits for the next plan |
| The teachers | In their next round, once at least one teacher has given its review. For a running run, a message starts that round: between rounds the supervisor looks for one every 5 seconds, and a round under way finishes first. When the advisors have reached the day's [spending limit](advisors-file.md#spending), a message starts no round; the run's live view says once `the advisors reached the day's spending limit (<limit> USD): the teachers read your message after midnight UTC` |
| The auditor | With its next audit, once the audit is posted to the harness |
| The review panel | With its next review, once the review is posted. If a reviewer gives no answer, the review is not posted, and its next try gives every reviewer the message again |

An advisor's brief or package puts the owner's messages first, and they are never cut when it is shortened. The teachers, the auditor and the review panel are asked to answer each message they are given, in one or two sentences, and the harness records each answer. An answer with no text is left out, and one malformed answer does not lose the advisor's others. A message kept in force goes into every new trial's brief under `# Messages from the campaign's owner, in force`; the others go under `# Messages from the campaign's owner`.

Control checks every message before it signs it, wherever it comes from: a run's **Live** or **Planner** tab, the REST API, `thermite command` or MCP. It trims the text, and refuses a message with no words in it, or one that nothing on the rig would read. It judges that from what the rig last reported: the run, the rig's settings (**Edit rig**) and the advisor roles its supervisor has set up. While the rig has not reported the run, or its supervisor has not reported its roles, control does not refuse for that reason, and the harness decides, as below. Control refuses with these messages:

| Message | When |
| --- | --- |
| `Write a message first.` | `text` is empty, or only spaces |
| `This run has no agents (the judge alone tries the kit), so nothing would read it.` | `all`, `planner`, a lane or a trial, in a run started without agents |
| `The planner is off on this rig (Edit rig), so nothing would read it.` | `planner`, with the planner switched off on **Edit rig** |
| `A research run has no attempts to audit.` | `auditor`, in a research run |
| `The teachers are off on this rig (Edit rig), so nothing would read it.`, and `The auditor is off …` or `The review panel is off …` | `teachers`, `auditor` or `review_panel`, with that role switched off on **Edit rig** |
| `This rig's supervisor has no teachers set up, so nothing would read it.`, and the same with `auditor` or `review panel` | `teachers`, `auditor` or `review_panel`, when the rig's supervisor reports that it has no such role |
| `This run has no goal the review panel reviews, so nothing would read it.` | `review_panel`, when the run's contract has no goal checked by review and is not a research contract (the review panel checks a research run's questions) |
| `This rig's supervisor has no advisors set up, so nothing would read it.` | `advisors`, when the supervisor reports none of the three roles |
| `No advisor would read it.`, followed by the reason for each role, in the order teachers, auditor, review panel | `advisors`, when each of the three roles has one of the reasons above |

`panel`, the review panel's name in v0.1.0, is refused.

Over the REST API and `thermite command`, a refusal is `400 {"error":"<message>"}`, written as `refused`. Over MCP, `issue_command` answers `{"error":"<message>"}` with `isError: true`, written as `refused`. On the dashboard it shows under the message box as `Not sent:` and the message (below), written as `refused`. A run's **Live** also greys out each recipient that control would refuse, with the same words when you point at it (on a run without agents that includes everyone working and the lanes, and the box starts on the advisors), and its message box asks for words before it sends: "Write a message first."

Control refuses `keep` with any other `to` before signing: `bad message_agent payload: keep: only a message to everyone working (all) or to a lane can be kept in force`. The harness checks again when it applies the command. It refuses a message in these cases, and records no message:

| Message | When |
| --- | --- |
| `run <run> is closed: nothing will read this message` | The run is closed |
| `run <run> has no agents (the judge alone tries the kit): nothing would read this message` | `all`, `planner`, a lane or a trial, in a run started without agents |
| `the planner is off on this rig (Edit rig), so nothing would read this message` | `planner`, with the planner switched off on **Edit rig** |
| `the teachers are off on this rig (Edit rig), so nothing would read this message` | `teachers`, with the teachers switched off |
| `the auditor is off on this rig (Edit rig), so nothing would read this message` | `auditor`, with the auditor switched off |
| `a research run has no audits, so the auditor would never read this message` | `auditor`, in a research run |
| `the review panel is off on this rig (Edit rig), so nothing would read this message` | `review_panel`, with the review panel switched off |
| `this run has no goal the review panel reviews, so the review panel would never read this message` | `review_panel`, in a hill-climb run, or a goal run with no goal checked by review |
| `none of the advisors would read this message: <each reason, joined by "; ">` | `advisors`, when no role would read it |
| `run <run> has <n> lanes`, or `… has 1 lane` | A lane beyond the contract's number of lanes. A lane within it, but above the number a `lane_count` rule leaves at work, is accepted |
| `no trial t-… in run <run>` | A trial the run does not have |

The run's **Live** shows the rig's refusal of the newest message to the run, from wherever it was sent, as **Not sent.** `The rig refused your last message: <reason>` above its message box. The run's **Planner** tab does the same for the newest message to the planner, above **Tell the planner**: **Not sent.** `The rig refused your last message to the planner: <reason>`. A message sent from the page is followed as any command is ([On the dashboard](#on-the-dashboard)): the line under the box says `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`, then `Done. rig-1 took it at 03:41 UTC.`, or `rig-1 refused it:` and the reason, with no refresh. On **Live**, the strip above the box then shows the rig's refusal too. A message that control refuses before it signs it shows under the box at once, as `Not sent:` and control's reason, and what you wrote stays in the box. Without the page's script, it shows above the box as **Not sent.** and control's reason. Control's audit log records that refusal as `refused`, with the page's path and the reason ([Audit log actions](rest-api.md#audit-log-actions)). While the planner is off on **Edit rig**, the **Planner** tab has no form under **Tell the planner**, only "The planner is off on this rig, so it reads no messages. The lanes take the queue in order and keep to the rules. Switch it on in Edit rig to tell it something.", with **Switch it on in Edit rig** as a link to the rig's **Edit rig** page.

The harness writes the live line `Owner to <to> (#<id>): <text>`, with `, kept in force` after the id for a kept message. A run's **Live** shows a signed line as **To** the recipient and the text. A line for everyone working, a lane, the planner or the advisors shows so at once, in its own words. A line for a trial shows as a plain line until the run's `agent_message` event, below, reaches control with the rig's report; **Live** then draws it again in place, with the event's words. Result: `{"message": <id>, "to", "keep", "readers", "note"}`. `readers` lists who will read it: lanes, `planner`, `teachers`, `auditor` or `review_panel`. `note` is there only for a trial that has ended: `trial t-… has ended; lane-<n>'s next trial reads this`.

The run's ledger records the message with its text (`agent_message`), each reader's first read (`agent_message_read`, `{message, by}`, with `trial` for a lane's read, `how` for how that trial's agent was given it (`brief`; `next-call`, in Pi, before its next model call; `after-tool` or `turn-end`, inside its turn through its program's hook or Thermite's plugin; or `continuation`, when the harness continued its session), and `round` for the planner's: the round whose plan read it) and each advisor's answer (`advisor_answer`). A rule the planner makes from the message is a `directive` whose body has `from_message`. The run's **Planner** tab shows a message to the planner, or to everyone working, under **Tell the planner**: waiting until the planner's round reads it, then with the planner's answer, made from these records: the rules it made from the message, the directions it designed for them, any rules it left out because the owner had removed them, and the round's notes. The run's **Live** shows the message, each read and each answer only from the harness's signed live lines; an unsigned line that looks like one shows as a plain line. A lane's read, like a message to a trial, shows plainly until the run's `agent_message` event reaches control.

### `unkeep_message`

Removes a message from force: new trials' briefs no longer carry it, and no reader that has not read it yet is given it.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `message` | positive whole number | The message's id: `message` in the result of its `message_agent` |

The harness refuses: `no message <id> in run <run>`, `message <id> is not kept in force`, and `message <id> was already removed from force at <time>`. The harness writes the live line `the owner's message #<id> is no longer in force`, and the ledger records `agent_message_unkept`. A run's **Live** shows that line, when the harness signed it, under **You** (and the message's lane, for a message to a lane) as `📌 You removed your kept message: “<text>”. New trials no longer get it.`, the text cut to 120 characters, or with `(#<id>)` in place of the text when control does not have the message. Result: `{"message": <id>, "unkept": true}`.

### `queue_add`

Adds an experiment to the run's **experiment queue**. Each run has its own queue: the [experiments](glossary.md) still to try, in order (**Up next**), the lanes' ideas that wait for a decision, and every experiment tried, with what became of it. At the start of each round the planner gives the experiments at the top to free lanes, never the same one to two lanes. [Choose what runs next](../how-to/campaigns/choose-what-runs-next.md) shows the queue on the dashboard.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `title` | text, 1 to 200 characters, trimmed | required | What to try |
| `details` | text up to 4000 characters | none | More about it |
| `family` | text, 1 to 80 characters, trimmed | none | Its direction: in your own words, or a direction's name. Written as `:name:`, it is kept without the colons |
| `why` | text up to 2000 characters | none | Why it is worth trying. The planner reads it, and so does the worker whose lane gets the experiment |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | `"end"` | Where it goes among the queued experiments |

The dashboard's **Add** sends **Add an experiment** as `title`, and **Direction**, **Why** and **Details** as `family`, `why` and `details` when they are not empty. It puts the experiment at the top, unless **Where** says **at the end**. Over the REST API, the command line and MCP it goes to the end unless `position` says otherwise.

These rules hold for the five queue kinds:

- An experiment's id is `x-` and 12 hexadecimal characters, such as `x-3f6c2a8e5b1d`. Control refuses another before signing: `bad <kind> payload: id: an experiment id (x-...)`.
- An experiment's place is its index among the queued experiments, 0 first. A number puts it at that index among the others; a number past the last puts it at the end.
- The harness refuses a run it doesn't have (`no run <run>`), a closed run (`run <run> is closed: its queue and rules no longer change`), and an experiment the run doesn't have (`no experiment <id> in run <run>`).
- The harness writes the experiment and one event in one step. The event's actor is `control:<issued_by>`, such as `control:owner:ui`, and its `by` is `owner`, whoever issued the command.

The new experiment is up next, with `owner` as its author. Result: `{"experiment": "x-…", "state": "queued", "position": <n>}`, `position` being its place now. Event: `experiment_added`, `{id, title, details?, family?, why?, question?, by, state, position}`. In a research run, a title labelled `Question <n> (index <i>)` names that question, when the run has it, and the task keeps it as `question`.

### `queue_move`

Moves an experiment that is up next to another place.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | Its new place |

**↑ Top** on the dashboard sends `"top"`; dragging an experiment sends its new index. The harness refuses an experiment that is not up next: `experiment <id> is <state>: only queued experiments move`. Result as for `queue_add`. Event: `experiment_moved`, `{id, by, position}`.

### `queue_edit`

Changes the words of an experiment that still waits: one up next, or a lane's idea.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `title`, `details`, `family`, `why` | as for `queue_add` | The new words. Give at least one; the others stay as they are |

An empty `details` or `why` clears it; `title` and `family` cannot be empty.

**Edit** on an experiment under **Up next** opens a form with its words: **What to try** (`title`), **Details**, **Direction** (`family`) and **Why**. **Save** always sends `details` and `why`, so a field you empty is cleared. It sends `title` and `family` only when they are not empty, so an emptied one keeps its old words. A lane's idea has no **Edit** on the dashboard.

Control refuses an edit with none before signing: `bad queue_edit payload: payload: change at least one of title, details, family and why`. The harness refuses an experiment that no longer waits: `experiment <id> is <state>: only proposed or queued experiments can be edited`. Result as for `queue_add`; `position` is `null` for a lane's idea. Event: `experiment_edited`, `{id, by}` and the fields that changed.

### `queue_drop`

Drops an experiment that still waits, so no lane tries it. It stays in the run's record as dropped, with who dropped it and why.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | experiment id | The experiment |
| `why` | text, 1 to 2000 characters, trimmed | Why. Required |

**Drop it** on the dashboard sends what you write in its **why** field. **Drop** on a lane's idea sends `the owner dropped this idea`. The harness refuses an experiment that no longer waits: `experiment <id> is <state>: only proposed or queued experiments can be dropped`. Result: `{"experiment": "x-…", "state": "dropped", "position": null}`. Event: `experiment_dropped`, `{id, by, why}`.

### `queue_accept`

Queues a lane's idea: an experiment a worker proposed (with `thermite-trial idea` or Pi's `idea` tool) goes up next. The planner's model also queues or drops ideas as it plans. Under **Ideas from the lanes**, the **Experiments** tab says: "The planner's model queues or drops these at its next hand-out, and you can decide first. When up next holds fewer than the campaign's Ideas kept ready, the planner queues the distinct ones, oldest first, even without its model. In a research run they wait for you."

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `run` | lowercase id | required | The run |
| `id` | experiment id | required | The idea |
| `position` | `"top"`, `"end"`, or a whole number from 0 to 100000 | the end | Where it goes |

**Queue it** on the dashboard sends no position, so the idea goes to the end. The harness refuses anything but an idea: `experiment <id> is <state>, not a proposed idea`. Result as for `queue_add`. Event: `experiment_accepted`, `{id, by, position?}`.

### `drop_directive`

Removes one [directive](#redirect), a rule for the plan, whoever set it: the owner, the teachers or the planner.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `id` | positive whole number | The directive's id: one of `directives` in its `redirect`'s result, or `id` in the run's `rules` ([`run_queue`](mcp-tools.md#run_queue)) |

The harness refuses: `no run <run>`, a closed run (`run <run> is closed: its queue and rules no longer change`), and `no rule <id> in force in run <run>`. The directive stays in the record with the status `dropped`, and the ledger records `directive_dropped`, `{id}`. Result: `{"run", "dropped": <id>}`.

**A removed rule does not come back from the advisors, the planner or an agent's token.** The teachers' next set of directives replaces their earlier set, the planner adds rules when an owner's message asks for one, and an agent token may send a `redirect`. Before the harness records such a set, it leaves out each rule that matches a rule removed from the run with `drop_directive`: the same kind, and the same `family` or `match` words, ignoring case and spaces at the ends. A rule that names neither matches every removed rule of its kind that names neither. The harness records the left-out rules in one event, `directives_left_out`, `{rules, why: "the owner removed these rules"}`, whose actor is `supervisor`, `planner` or `control:agent:mcp`, and records the rest of the set. Only a `redirect` issued by the owner, or by an operator for the owner, sets a removed rule again: its author is `control:owner:…`, such as `control:owner:api` for the owner's REST API or `control:owner:operator`.

### `hypothesis_status`

Changes the status of one of a research run's hypotheses. The author's hypotheses, from the campaign's brief, need a verdict from the review panel; the workers' go to the run's pool, and need none ([Hypotheses](../explanation/campaign-modes.md#research)). This command promotes one of the pool, so the review panel must give it a verdict too, returns a promoted one to the pool, or retires one. The run's [planner](../explanation/agents-lanes-planner.md#research-campaigns) promotes and retires hypotheses through the same step in the harness, within its own bounds.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The research run |
| `id` | text, 1–64 characters | The hypothesis's id, `h-…` |
| `status` | `"promoted"`, `"pool"` or `"retired"` | Its new status |
| `reason` | text, 1–2,000 characters, not spaces alone | Why |

```json
{"run": "survey-1", "id": "h-3f2a9c41d0b7", "status": "promoted", "reason": "the second question turns on it"}
```

Control refuses a run its rig reports as not a research run, before it signs anything: `Run <run> is not a research run: only a research run has hypotheses to promote or retire.` The harness refuses: `no run <run>`, a closed run (`run <run> is closed: its queue and rules no longer change`), the same for a run that is not a research run (`run <run> is not a research run: only a research run has hypotheses to promote or retire`), `no hypothesis <id> in run <run>`, one of the author's (`hypothesis <id> is one of the author's: it needs a verdict already, and only the campaign's brief changes it`), a merged one (`hypothesis <id> was merged into <other>: change <other> instead`), and a retired one whose words now repeat a live hypothesis of the run (`hypothesis <id>'s words repeat <other> (in the pool): change <other> instead`).

On the dashboard, control refuses a change with no reason before it signs it: `write why you change the hypothesis first`.

Result: `{"run", "hypothesis", "status", "from", "changed"}`, where `from` is the status it had. The same status again changes nothing: `changed` is `false`, with a `note` such as `hypothesis <id> is in the pool already: nothing changed`, and no event. Each change is the event `hypothesis_status`, `{hypothesis, status, from, by, reason, question, text}`, with `by` the issuer, such as `control:owner:api`; the run's research folder, its next workers' briefs, its next review package and the campaign's collection in the [knowledge base](knowledge-base.md) follow it.

### `propagate`

Another rig's published champion, sent as a candidate for this rig's judge. Control builds it from the source rig's signed report. See [Run a campaign on several rigs](../how-to/campaigns/several-rigs.md).

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run on this rig |
| `source_rig` | text | The rig the champion comes from |
| `source_run` | lowercase id | Its run |
| `source_seq` | positive whole number | The champion's number in that run |
| `import` | a `champion_patch` [import](#imports) | The champion as a patch, with its path `propagate/<rig>/<run>/<seq>.patch` |

Control builds it from two runs, each named alone: the run whose champion goes and the run that tests it (`{run, to_run}` over REST and MCP); it knows the rig each ran on, and fills in `source_rig`. Control refuses to build one: `no run <run>`, `<run> and <to_run> are on one rig: propagate between two rigs`, `the source run has no champion beyond its seed`, `champion seq <n> is not published yet (it is published with the rig's next export)`, `<run> runs <campaign>, not <campaign>`, `the target works on <repo>, the champion is in <repo>`.

The supervisor takes the patch from the [results repository](../how-to/operate/results-repository.md), and waits while it is not there yet. The harness then refuses: `research campaigns do not take propagations`, `propagate takes a champion_patch import (a published champion)`, `the champion is in <repo>; this run works on <repo>`, `base commit <commit> is not in this rig's repository`, `the champion patch does not apply to the base: …`, `tree mismatch: the signed tree is <tree>, the patch gives <tree>`. If this rig's champion already has the same files, the result is `{"identical": true, "note": "this rig's champion already has the same tree"}`. Otherwise the patch becomes an attempt that this rig's judge measures against its own champion. Result: `{"attempt", "lifecycle", "tree"}`.

### `export_now`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `full` | boolean | `false` | `true` also writes the research archive, a snapshot of the ledger, and the research folder of every run that has one, finished or not ([Normal and full exports](exports.md#normal-and-full-exports)). A full reset and a RunPod pod's terminate ask for a full export, and so does **Full export** under **Export** on the dashboard |
| `run` | run id, optional | | An export of that run alone, from its start ([A run's export](exports.md#a-runs-export)), as **This run** on a run's page asks for. It is outside the rig's chain of exports: the result's `export_id` is `0`, and the next export starts where the last of the chain ended |

The harness writes an export to its outbox for the supervisor to push. Result: `{"export", "export_id", "through_event", "attempts", "events"}`. At the rig's [disk floor](settings.md#places-exports-and-the-broker) it is refused, since an export copies the whole ledger: `an export waits: the rig's disk is at its floor of 5 GiB (its outbox has 3.1 GiB free): no new trial, judge's job or export starts until there is room again` (`a full export waits: …` for a full one).

### `drain_rig`

Control issues it before it moves a rig at work onto new images or a new address (**Update to these images** and the other buttons above, or [`update_rig_images`](mcp-tools.md#update_rig_images)), with the reason `its images are about to change`, and before it gives a rig at work a new number of GPUs, CPUs or memory (**Edit rig**, [`set_cluster_rig_resources`](mcp-tools.md#set_cluster_rig_resources) or [its REST twin](rest-api.md#a-cluster-rigs-gpus-cpus-and-memory)), with the reason `its GPUs, CPUs or memory are about to change`. It sends `drain: false` to call the update or the change off, or after a drained one that failed (`the update did not happen`). `POST /v1/commands` takes it too.

| Field | Type | Meaning |
| --- | --- | --- |
| `drain` | boolean | `true`: the rig drains; `false`: the drain ends |
| `reason` | text, 1 to 500 characters, optional | Why, as the event records it |
| `deadline_minutes` | whole minutes, 1 to 10,080, optional | How long the drain waits for the work under way before its deadline: an update's `drain_minutes`. Left out: the rig's [`THERMITE_DRAIN_MINUTES`](settings.md#places-exports-and-the-broker), 60 by default. A drain asked for again keeps the deadline it began with |

**End the drain** on a draining rig's page sends `drain: false` with the reason `the owner ended the drain`; on a rig control set up on a cluster it is **Call the update off**, which calls the change off too.

While a rig drains, its harness starts no new trial, plan or judge job, and those running end as they would; a plan that ends during the drain records its round and starts no trial. Its report's `work` says what still runs, `{trials, judge_jobs, draining, open}`, and control restarts its pods once nothing does. `draining` is `{since, reason, by, deadline, deadline_reached}`, where `by` is who asked, such as `control:owner:api`, `deadline` when the drain stops waiting by itself, and `deadline_reached` when it did (left out before), or `null` when the rig doesn't drain. While it drains, `open` lists each trial still running, oldest first, at most 16: `{trial, run, lane, started_at, task, question, turns, tool_calls, tokens_in, claims, refused_again}`, where `task` is its experiment's title, `question` a research task's question (from 0), the counters are what its worker last reported, `claims` counts the verified claims it recorded (`null` outside a research run), and `refused_again` is its newest ask for a page the run refused before for a reason that lasts, `{url, reason, asked, at, times}` (`times`: how many such asks this trial made), or `null`. The rig's page shows them ([The drain card](rig-page.md#the-drain-card)). `judge_jobs` counts only jobs under a lease still in force: a lease that ran out is taken back while the rig drains, queued again or `blocked` after its third lost lease, which starts nothing. A drain lasts until the harness restarts, which ends it. At its deadline it stops waiting by itself (goal 173): the event `rig_drain` records the step with `deadline_reached: true` and what still runs, the rig goes on starting nothing new, and the owner chooses under **Needs you** or on the rig's page to go ahead now or to end the drain ([At its deadline](rig-page.md#at-its-deadline)); nothing is chosen for the owner. The event `rig_drain` records each change with the same figures and the drain's `deadline`, without `open`; a harness that starts again after a drain records its end, with `drain: false` and the reason `the harness started again`. A research run's clock leaves out the time the rig drained ([Limits and pacing](limits-and-pacing.md#caps)). Result: `{"trials", "judge_jobs", "draining"}`.

### `stop_trial`

The owner stops one running trial, such as one a drain waits for. An operator's token may send it too, for the owner; an agent's may not.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The trial's run |
| `trial` | the trial's id: letters, digits, `-` and `_`, 1 to 64 | The trial, as a draining rig's report lists it under `open`, or as `run_queue` gives each lane's under `at_work` |
| `reason` | text, 1 to 500 characters, optional | Why, as the event records it. Without one: `stopped by <issuer>` |

The harness refuses a trial of another run (`run <run> has no trial <trial>`) and one that has ended (`trial <trial> has ended already`). Otherwise it records `trial_stop_asked` `{trial, lane, reason?}`, and the scheduler stops the trial within a second, as a restart would: the event `trial_stopped` `{lane, trial, reason}`, then the trial ends as `interrupted`, with the counters its worker last reported. Its sources and claims stay. Its experiment goes back to the top of the run's queue, as for [`reset_workers`](#reset_workers): during a drain, a lane takes it up again once the drain ends. Nothing else stops. A trial that ends before the scheduler gets to it is left as it ended. Result: `{"run", "trial", "lane", "stopping": true}`.

### `wipe_state`

Only control's full reset issues it, as the owner who asked for the reset, after the owner confirmed the wipe. See [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md).

| Field | Type | Meaning |
| --- | --- | --- |
| `confirm` | `"wipe"` | Must be exactly this |
| `export` | text, 1 to 100 characters | The full export that reached the results repository |
| `through_event` | whole number, 0 or more | The last event that export holds |

The harness refuses: `no export <export> in this rig`, `export <export> is not a full export`, `the export does not cover the events`, and `research was recorded after the export (<what>): export again`. Otherwise it pauses the running runs, and the rig's state is wiped when the harness next starts, a few seconds later. The rig keeps its own signing key. Result: `{"wiping": true, "export"}`.

### `approve_promotion`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `attempt` | text, 1 to 64 characters | The attempt |

Promotes a confirmed win that waits for the owner, or overrules an audit that is pending or that blocked it. The judge's verdict must still allow promotion, and approving an attempt with declared flaws accepts them. If the champion moved since the attempt was judged, it is measured again against the new champion. Refusals: `run <run> is closed: none of its changes can become the champion` (see [`close_run`](#close_run)), `attempt <attempt> is not in <run>`, `attempt <attempt> is <lifecycle>, not awaiting approval`, `no pending promotion for <attempt>`.

### `decline_promotion`

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `attempt` | text, 1 to 64 characters | The attempt |
| `note` | text up to 2000 characters | Optional. Why |

The attempt never becomes the champion and stays in the record as `declined`. Refusals: `run <run> is closed: its changes stay as they were when it closed`, `attempt <attempt> is not in <run>`, `attempt <attempt> is <lifecycle>: there is nothing to decline`. Result: `{"attempt", "declined": true, "was"}`.

### `rig_settings`

The rig's own settings, as on its **Edit rig** page. Only the fields that change are sent, and no other field is allowed. [`POST /v1/rigs/<rig>/settings`](rest-api.md#a-rigs-settings) and MCP's [`set_rig_settings`](mcp-tools.md#set_rig_settings) send it with **Edit rig**'s checks, and only the fields that differ from what the rig reports. Control also sends `{judge_gpus}` alone when it gives a rig on a cluster a new number of GPUs and the rig keeps a judge's share of its own that differs from the new one ([Change the rig's GPUs, CPUs and memory](../how-to/install/rig-on-a-cluster.md#change-the-rigs-gpus-cpus-and-memory)), issued as the caller who asked for the change.

| Field | Type | Meaning |
| --- | --- | --- |
| `judge` | boolean | The judge builds and measures. Off: changes wait in its queue |
| `workers` | boolean | Workers start trials. Off: no new trial starts |
| `lanes` | 1 to 16 | Trials at the same time. More is refused with `at most 16: a rig has users for lanes 1 to 16 only` |
| `planner` | boolean | The planner's model gives each lane its experiment at the start of each round. Off: lanes take the queued experiments in order, by fixed rules, with no model |
| `auditor` | boolean | The auditor runs in the supervisor, where configured |
| `teachers` | boolean | The teachers, and their merged by model, run in the supervisor, where configured |
| `review` | boolean | The review panel runs in the supervisor, where configured |
| `exports` | boolean | Hourly exports for the supervisor to push |
| `trial_minutes` | 1 to 1440, or `null` | A trial's length when its contract sets none. `null`: none |
| `max_turns` | 1 to 100000, or `null` | A limit on each trial's model turns. `null`: no limit |
| `quiet_minutes` | 1 to 1440, or `null` | After how many minutes without a line a trial asks the owner under **Needs you**. `null`: never. Nothing ends the trial |
| `program_mode` | `terminal` or `headless` | How a worker's trial runs Claude Code, Codex or OpenCode: `terminal` (the default), in the program's own terminal UI, which the harness's terminal host holds; `headless`, one headless run of the program for each turn. A trial keeps the mode it started with. A rig whose harness is older reports no mode and runs headless. Pi has no terminal and ignores it. See [Agents in their own terminal](../explanation/agents-lanes-planner.md#agents-in-their-own-terminal) |
| `promotion` | `auto` or `owner_approval` | The rig's promotion rule, for runs that set none |
| `judge_gpus` | 1 to 8, or `null` | On a rig given its set of GPUs, how many are the judge's. `null`: the rig's default. A change restarts the harness to regroup the cards |

The harness keeps the settings, applies them at once and reports them, with a `rig_settings_changed` event that holds the change and the settings after it. Result: `{"settings": <all the rig's settings>}`.

The **History** of the run at work at the time says what changed, such as "You changed the rig's settings: the planner off, 3 lanes, no turn limit." Each field reads as `the judge`, `the workers`, `the planner`, `the auditor`, `the teachers`, `the review panel` or `exports` with `on` or `off`; `<n> lanes` (`1 lane`); `trials of <n> min`; `at most <n> turns a trial` or `no turn limit`; `agent programs in their own terminal` or `agent programs headless`; `confirmed wins kept at once` or `confirmed wins wait for you`; and `<n> GPUs for the judge` (`1 GPU for the judge`) or `the judge's usual share of GPUs`.

### `accept_review`

The owner's final word on a goal that the review panel passed, or on a research run's questions that it found answered.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `review` | positive whole number | The review |
| `accept` | boolean | `true` accepts, `false` rejects |
| `note` | text up to 2000 characters | Optional |

For a goal, the judge then checks the champion's goals again. For a research run's review, `true` ends the run: no new trial starts, the rig's final writer writes its research paper, and once the paper is in (or at once, on a rig with no final writer) and the trials running end, it writes its final report and closes with `every question is answered`; `false` lets it go on: the review panel's decisions stand, and it is asked again when a question's answer card changes. Either way the run's journal records the owner's word and `note`. A closed run is refused: `run <run> is closed: its goals are not checked again`. So are a review the run does not have (`no review <review> in <run>`), one the review panel has not passed (`review <review> has not passed the review panel`) and one already decided, by the owner or hands-off (`review <review> is already decided`). Result: `{"review", "decision": "accepted"}` or `"rejected"`.

### `conclude`

The owner's answer to the harness's proposal that a goal campaign's goals cannot be reached.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `proposal` | positive whole number | The proposal |
| `accept` | boolean | `true` closes the run as not possible; `false` dismisses the proposal and the agents carry on |
| `note` | text up to 2000 characters | Optional |

A closed run is refused, whichever the answer: `run <run> is closed: it can't end as not possible or go on`.

### `invalidate_evidence`

The owner withdraws bad evidence: an attempt, for good, with every attempt built on it, or the measurements of one of the judge's jobs, whose attempts are judged again. Nothing is deleted: each step is a new record. It goes in two steps. A **preview** (`preview: true`) answers with what it would reach and changes nothing: the rig records only the command, as it records every command. The **withdrawal** names the preview's `sha` in `reach`: the harness works out the reach again and does exactly that, or refuses when it differs. [Withdraw bad evidence](../how-to/campaigns/withdraw-bad-evidence.md) shows the steps.

| Field | Type | Meaning |
| --- | --- | --- |
| `run` | lowercase id | The run |
| `attempt` | text, 1 to 64 characters | One of the two. An attempt of the run: withdrawn for good, with every attempt built on it |
| `job` | positive whole number | One of the two. A judge job of the run that finished: its measurements are withdrawn |
| `reason` | text, 1 to 2000 characters, not spaces alone | Why. The record keeps it, and every page that shows the withdrawal says it |
| `preview` | boolean | `true`: say what it would reach, and change nothing |
| `reach` | sha256, 64 hexadecimal characters | Without `preview`, required: the `sha` the preview answered |

Control refuses, before it signs: `name one attempt or one job` (both, or neither), and `send a preview first (preview: true), then the sha it gave as reach` (neither `preview` nor `reach`). The harness refuses: `invalidate_evidence is the owner's own to issue, not <issuer>'s` (an operator), `attempt <attempt> is not in <run>`, `attempt <attempt> was withdrawn already, for good: there is nothing more to withdraw`, `job <job> is not in <run>`, `job <job> is <state>: it has no measurements to withdraw yet` (a job still queued, leased or blocked), `no verdict rests on job <job>'s measurements now: there is nothing to withdraw`, and, for the withdrawal, `what it reaches changed since the preview: preview it again, and confirm what it reaches now`. A closed run's evidence can be withdrawn too: nothing in it is judged again.

What it reaches, from the subject: the attempt itself, or each attempt whose current verdict rests on the job, then every attempt built on one reached (the attempt whose commit it was made on), in turn.

- **Each attempt reached** gets an `invalidated` verdict that supersedes its current one (the verdict before stays in the record). An attempt withdrawn for good is marked so, never gets another verdict, and can't become the champion; a change submitted later on top of one is withdrawn as it arrives, with `lineage of invalidated evidence: built on <attempt>, which was withdrawn: <reason>`, and never judged. When a job's measurements are withdrawn, each attempt goes back to the judge's queue (`queued`, with a new job) to be measured again, unless its run is closed, it was never judged (`rejected_v0`, `duplicate`), or it was withdrawn for good before.
- **The judge's open jobs** for the attempts reached, queued or under way, are cancelled (`job_cancelled`). A judge measuring one can no longer record its outcome, as after a lost lease. An attempt that is not judged again and waited for the judge, an audit or the owner settles as `judged`.
- **Each champion** whose attempt is reached is reopened (`champion_reopened`). When the run's champion is among them, it moves back to the newest champion that stands, the starting point at least, with a `champion_moved_back` event; its git ref follows, new trials build on it, and a goal run's judge checks its goals again.
- **A champion already published** keeps its patch in the results repository and on control: nothing there is deleted or rewritten, and the next export carries the events that withdrew it. Control no longer offers it to download or to propagate.

The answer, to both steps: `{"sha", "reach", "words"}`, with `"preview": true` for a preview and `"invalidation": <id>` for the withdrawal. `words` says what it reaches in sentences, as the dashboard shows them. `reach` is `{run, subject: {kind, id}, for_good, attempts, attempts_total, superseded, jobs: {cancelled, cancelled_total, queued}, champions, champion}`: `attempts`, the first 200, each `{attempt, why: subject|evidence|lineage, parent, lifecycle, verdict, then: withdrawn|judged_again|stays_withdrawn}` as it is before; `superseded`, how many current verdicts an `invalidated` one supersedes; `champions`, each `{seq, attempt, published}`; `champion`, `{from, to, to_attempt, validate}` when the run's champion moves back, else `null`. The `sha` covers each attempt and what becomes of it, the verdicts superseded, the champions reopened and where the champion moves.

The withdrawal records, in one transaction: the `invalidation` event (`{id, run, kind, reason, attempts, verdicts, champions}`, its subject the attempt or the job), each `verdict` and `champion_reopened`, each `job_cancelled`, `job_queued` and `attempt_lifecycle`, and `champion_moved_back` (`{from, to, attempt, commit, invalidation, reason}`). Each reaches control, the exports and the knowledge base like any event.

## Imports

`assign_campaign` lists its imports in `imports`, and `propagate` carries one in `import`. Every `path` is relative to the rig's inbox and may not contain `..`. The harness copies each file into its own store, hashing it as it copies.

| Kind | Fields | Used in |
| --- | --- | --- |
| `repo_bundle` | `path`; `repo` (lowercase id); `commit`; `sha256` (optional: the bundle file's hash, checked as well as the commit); `source` (optional) | `assign_campaign`: the project |
| `kit_bundle` | The same fields | `assign_campaign`: the kit |
| `model` | `path`; `name`; `sha256` (required); `source` (optional) | `assign_campaign`: a model the contract lists |
| `champion_patch` | `path`; `repo`; `base_commit`; `tree`; `sha256` (all required) | `propagate` only. In `assign_campaign` it is refused: `a champion patch comes only with a propagate command` |

`source` tells the supervisor where to fetch the content before it relays the command:

| Source | For | Meaning |
| --- | --- | --- |
| `{"git": "<URL>"}` | `repo_bundle`, `kit_bundle` | A git repository that has the commit: an `https://`, `ssh://` or `git://` address, or `user@host:path`, up to 2000 characters. The supervisor fetches the commit with no key and writes it to `path` as a bundle. A `file://` address passes the schema, and the supervisor refuses it: `<path>: a file:// source is refused: a source is a repository on a host` |
| `{"git": "<URL>", "access": "<name>"}` | `repo_bundle`, `kit_bundle` | The same, with Git access that control keeps for a private repository, by name. The address must be on the access's host: control refuses the command otherwise, and the supervisor checks it again. See [Use a private repository](../how-to/campaigns/private-repository.md) |
| `{"control": "kits/<name>"}` | `kit_bundle` | A kit that control keeps: one the **New campaign** page wrote, or a kit repository written elsewhere that the owner gave control as a git bundle ([`POST /v1/kits/<name>`](rest-api.md#kits-control-keeps), MCP's [`kit_add`](mcp-tools.md#kit_add) or [`thermite kit add`](command-line.md#kit-add)). The supervisor fetches the commit from control, as the rig, and writes it to `path` as a bundle. Any commit of the kit's history fetches, and so does an old head that a forced replacement left |
| `{"url": "<URL>"}` | `model` | An `http://` or `https://` address on the internet, up to 4000 characters. The supervisor downloads the file and keeps it only with the import's `sha256`, reporting its progress. See [Model files on a rig](model-files.md) |

Only the owner's and the operator's tokens may name a source to fetch, a Git access or MCP servers in an `assign_campaign`; an agent's token may assign a campaign whose imports are in the rig's inbox already, or are kits control keeps. The supervisor fetches a command's sources only once its harness has checked control's signature on the command; a command the harness refuses is never staged, and goes on to the harness, which refuses it with its reason. A source that cannot be fetched makes the command `failed` with `{"error": "staging: <reason>"}`. Without a source, the file must already be in the inbox.

The harness refuses an import with: `path escapes inbox: <path>`, `not found in inbox: <path>`, `symlink escapes inbox: <path>`, `sha256 mismatch for <path>: expected <hash>, got <hash>`, or `bundle does not contain commit <commit>`.

## Older names

Commands signed before runs and rigs were renamed still verify. Their envelope names `unit` instead of `rig`; their payloads may name `instance`, `source_instance` and `source_unit`, read as `run`, `source_run` and `source_rig`; and the kinds `pause_instance` and `resume_instance` are read as `pause_run` and `resume_run`.
