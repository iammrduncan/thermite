---
title: "Decide what waits for you"
description: "Choose what waits for you, and approve or decline the promotions, audits, reviews and \"not possible\" endings that do."
type: how-to
sidebar:
  order: 11
---

Thermite is hands-off by default. A change the judge confirms becomes the new best with no step of yours, after the rig's auditor clears it when an audit is called for. A review panel's pass is accepted, whether of a goal or of a research run's answers, and a goal campaign the evidence shows is not possible ends. Only what you ask to decide waits for you, and what goes wrong: an auditor's block, agents the model provider stopped, a rig's new key, a full reset you started, a rig that stopped reporting, a rig whose disk is at its floor and a drain past its deadline. This page shows how to choose what waits, where it waits and what each button does. Campaigns go on while a decision waits: agents keep working from the current [champion](../../reference/glossary.md).

![The Overview: under Needs you, a decision on a run that asks you about every change, with what the judge measured and the buttons Make it the champion and Reject it, and a rig that stopped reporting, with Open the rig](../../../../assets/screenshots/overview.webp)

## Find what waits

Open **Overview**, the first page in the sidebar on the left. Its **Needs you** block lists every decision across every rig, grouped by kind, oldest first. When nothing waits, it says `Nothing waits for you. The campaigns go on by themselves.`

The count also shows beside **Overview** in the sidebar, and as **Needs you** in the status bar, the line along the bottom of every page. The **Campaigns** list, under **Waiting for you**, and each campaign's page say how many decisions wait in each run, such as `2 decisions wait for you`, with a **Review** button. It opens the run's page, whose **Overview** tab lists that run's decisions under **Needs you**. A change's own page has a **Your decision** box.

A closed run is finished, and nothing in it waits for you: what waited in it when it closed is not in **Needs you** or in any count, and the rig refuses a decision on it. See [Close a run](steer-a-run.md#close-a-run).

## Decide

1. Open a row. It says what is asked, why it waits, and where: the campaign, run, rig and lane. For a change, **What the judge found** has the judge's evidence and **Problems that the agent wrote** lists flaws the agent declared.
2. Read what each choice does, then press its button.

   The item leaves **Needs you** at once, and the count drops. A line at the top of the page says `Sent to …`, then `Done.` once the rig has reported it, with no refresh. The change's own page keeps a **Your decision** box that says `You selected …` and, once the rig has done it (in less than 10 seconds), what the rig did. While you look at that page, it changes by itself.
3. If the rig refuses your choice, the item comes back to **Needs you** with the cause, and its buttons. It also comes back if it needs you again, for example when the champion changed and the judge measured the change again.

## What each decision asks

| Label | The question | It appears when | Buttons |
| --- | --- | --- | --- |
| **Your decision** | Make this change the new champion? | The run asks you about this change (see [Choose what waits](#choose-what-waits)), the auditor sent it to you, or an audit holds it on a rig whose supervisor has not said yet that it has no auditor | **Make it the champion**, **Reject it** |
| **Blocked** | Overrule the auditor and make this change the champion? | The rig's auditor blocked the change | **Overrule the auditor**, **Reject it** |
| **Review** | Accept the goal "…" as met? | The rig's review panel passed a subjective goal, and the run asks you about reviews | **Accept**, **Reject** |
| **Review** | Accept that every question is answered? | The rig's review panel's decisions give every question of a research run an end and every required hypothesis a verdict, and the run asks you about reviews | **Accept**, **Reject** |
| **Not possible?** | End this campaign as not possible? | The [harness](../../reference/glossary.md), the rig's container that holds the judge, proposes that a goal campaign's goals can't be reached, and the run asks you about it | **End it: not possible**, **Keep going** |
| **New key** | Accept this rig's new report key? | A rig reports with a key control has not pinned | **Accept this key** |
| **Wipe** | Wipe this rig's state? | A full reset you started is ready for its last step | **Confirm the wipe**, **Cancel the reset** |
| **Agents stopped** | The agents of this run cannot work | The model provider refused a trial (no credits, a refused key, a model it does not serve on the key), no model call worked for 30 minutes, or the workers' model check fails. No trial or plan starts until a check passes | **Check the model now**, **Edit rig** |
| **Stuck?** | Stop lane-2's trial, or leave it running? | A trial has sent no line for longer than the rig's **Ask me after a quiet spell of (minutes)** on **Edit rig**. The setting is empty by default, and then this never asks | **Stop this trial…**, **Leave it running** |
| **Repeats** | Stop lane-1's trial, or leave it running? | A trial made the same tool call with the same answer 10 times in a row, or asked 10 times for a page the run refused before for a reason that lasts | **Stop this trial…**, **Leave it running** |
| **Not reporting** | This rig stopped reporting, or, for a rig that never reported, This rig has not reported yet | A rig has sent no report for a while. A new rig whose first key waits for you shows under **New key** instead. A rig on RunPod whose pod is stopped shows no card: it can't report while stopped | **Open the rig** |
| **Disk full** | Make room on this rig's disk | A place the rig writes to has less free space than its floor, `THERMITE_DISK_FLOOR_GIB` (5 GiB by default): it starts no new trial, judge's job or export | **Open the rig** |
| **Disk full** | Make room on control's disk | Control's state folder, or the room left in the message bus's store, is below control's floor, `THERMITE_DISK_FLOOR_GIB` (5 GiB by default): no new run starts, and the runs under way go on ([Troubleshoot](../operate/troubleshoot.md#controls-disk-is-at-its-floor)) | None: the card says where to make room, and it goes once there is |
| **Proposal** | Approve the additions to its roles of sort-speed that owner:operator proposes? (or which roles write in its collection) | The operator changed a campaign's [additions to its roles](start-from-dashboard.md#add-your-words-to-the-agents-roles) or which roles write in its collection: the change waits for you. The card shows the setting now and as proposed | **Approve**, **Decline** |
| **Drain** | Go ahead now, or end the drain? | A rig's drain passed its deadline, 60 minutes by default, with work still under way: it starts nothing new until you choose | **Update it now** (or **Change its size now**, or **Stop what still runs**), **End the drain** |

### Choose what waits

When the judge confirms that a change is better, the run's rule decides what happens:

- **always keep it** (`auto`): it becomes the champion with no step of yours. When an audit is called for and the rig has an auditor, the auditor's clear comes first.
- **ask me every time** (`owner_approval`): it waits for you as **Your decision**.
- **the rig's default**: the rule on the rig's **Edit rig** page, under **3 · When a change becomes the champion**: **Automatically** unless changed, or **Ask me for each change**. A script or an agent with the owner's token changes it with `promotion` in `POST /v1/rigs/<rig>/settings` or MCP's `set_rig_settings`; an operator's token can't.

You choose a run's rule with **When a change is confirmed better**, on the **New campaign** page or under **More options** in a campaign's **Start a run** panel, or with `--promotion` on `thermite assign` or `thermite run start` (`promotion` over REST and MCP's `start_run`).

Next to it, **Ask me first about** chooses what else waits for you. All of it is off by default:

| Choice | What waits for you | `--ask` | `ask_owner` over REST and MCP |
| --- | --- | --- | --- |
| **a gain above this %** | A confirmed change whose gain over the champion is above it, such as 15 | `gain:15` | `"above_gain": 0.15` |
| **a change whose agent declared flaws** | A confirmed change whose agent wrote problems it knows the change has. Without it, the promotion accepts them, and the record says so | `flaws` | `"declared_flaws": true` |
| **a review panel's pass of a goal or of a research run's questions** | A subjective goal the review panel passed, or a research run's questions it found answered: see [Reviews](#reviews) | `reviews` | `"reviews": true` |
| **ending a goal campaign as not possible** | A "not possible" proposal: see [Not possible endings](#not-possible-endings) | `not-possible` | `"not_possible": true` |

A run keeps the choices it started with. A run started with **ask me every time** keeps asking, and so does a run with no rule of its own on a rig whose **Edit rig** says **Ask me for each change**.

The run's **Overview** tab shows the rule in force, in the block **The run**, as **Promotion**: `Automatic when the judge confirms, after the auditor's clear when an audit is called for`, `Only with your approval`, or `The rig's default (automatic unless it was set to ask you)`, and then what else it asks you about, such as `. It asks you about a gain above 15%, a change with declared flaws`.

### Promotions

A change waits for you as **Your decision** only for a cause the row says, after `It waits for you because`: `you asked to decide every change (promotion: owner approval)`, `you asked to decide gains above 15.0%: this one is 21.3%`, or `you asked to decide changes with declared flaws: this one declares 2`. A row that says `The auditor sent this change to you` comes from the auditor's `needs_owner`.

**Make it the champion** makes the change the next champion: agents start their next work from it. If the champion changed while the change waited, the judge first tests it again against the new champion. If the agent declared flaws, approving accepts them, and the record shows your name. **Reject it** keeps the change from becoming the champion, and the record shows that you rejected it.

### Audits

When the rig has an auditor, an audit holds a confirmed change before it becomes the champion when:

- the agent declared flaws in it;
- in a hill climb, its gain is above the contract's `acceptance.audit.absolute` (0.15, that is 15%), or above `acceptance.audit.ratio_to_median` (3) times the median of the run's earlier wins, once it has three;
- in a goal campaign, the contract has an `adversarial_checklist`: then every change is audited.

The rig's auditor, one of its [advisors](../operate/advisors.md), answers each audit: it clears the change, blocks it, or sends it to you. Its clear is the last step: the change becomes the champion, also with declared flaws or a gain above `absolute`, unless the run asks you about it (see [Choose what waits](#choose-what-waits)). Its block stops the change, and the **Blocked** row gives the auditor's reasons. An audit the auditor will decide is not in **Needs you**: the change's own page shows it as held for an audit.

A rig with no auditor, or with its **Auditor** switched off on **Edit rig**, has no audits: the change becomes the champion, or waits where the run asks you. Its record says why, with the event `audit_skipped`: `had no audit: this rig has no auditor`. The rig's supervisor tells the harness which advisors it has at each round, and again every minute. Until it first says so after a start, an audit holds the change; once it says the rig has no auditor, the held changes go on by the run's rules. A supervisor of an earlier version never says it: then an audit waits for you, with `This rig has no auditor, thus you must make the decision.`

An auditor that fails to answer an audit is tried up to five times in all, 30 minutes apart. After the last try, the change waits for you as **Your decision**, with the auditor's error. Each audit counts its own tries: a new audit of the same change, after a new confirmation, starts again at one. If the hand-off to you does not reach the rig, the supervisor tries it again every 30 minutes until the change is in **Needs you**.

**Make it the champion** decides in place of the auditor. **Overrule the auditor**, on a **Blocked** row, makes a blocked change the champion anyway.

### Reviews

A goal checked by `review` counts as met when the rig's review panel passes it: at least two reviewers, each of whom passes it. The pass is accepted with no step of yours, and the record says `the review panel passed it, and it was accepted with no owner step`. A run that asks you about reviews waits for your word instead. A review panel chosen on **Edit rig** is three reviewers with the same model; one in the rig's advisors file has two to five. A rig with no review panel leaves such goals unmet.

:::note[A switch that is on is not an advisor]
On **Edit rig**, the **Auditor**, **Teachers** and **Review panel** switches are on by default, also on a rig that has no such advisor. A switch only lets an advisor work once it has a model. The rig's page shows what it has: its **Advisors** row says `none configured` when it has none. See [Configure advisors](../operate/advisors.md).
:::

**Accept** makes the goal met; the judge then checks the champion's goals again, and if every required goal is met, the campaign completes. **Reject** keeps the goal unmet.

A research run asks the review panel, after its minimum duration, to decide each question and each hypothesis that needs a verdict; a review passes when its decisions give every question an end, answered or the best that sources allow, and every required hypothesis a verdict, where `undecided` counts only with claims behind it ([When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends)). Its pass is accepted with no step of yours, and the run's journal says `hands-off: the review panel passed it, and the run does not ask the owner`. A run that asks you about reviews waits as **Review**, `Accept that every question is answered?`, with the answers of the questions that review decided under **The answers**, and under **The review** a link to the review on the run's **Reviews** tab, with each reviewer's answers and the decision on each item ([The Reviews tab](../../explanation/campaign-modes.md#the-reviews-tab)); the run's journal has every decision. **Accept** ends the run: no new trial starts, the rig's final writer writes the run's [research paper](../../explanation/campaign-modes.md#the-research-paper), and once the paper is in and the trials running finish, it writes its final report, the paper first and then the decisions, and closes as **Completed**. Nothing about the paper waits for you: code checks it. **Reject** lets it go on, with your note in its journal; the decisions stand, and the review panel is asked again when a question's answer card changes. The progress rule never ends a run that waits for your word. A rig with no review panel keeps such a run researching: its **Answer check** says so.

### "Not possible" endings

The harness proposes ending a goal campaign as not possible only when its contract allows it (`infeasibility.allowed`), and once `min_refuted_approaches` approaches have each had at least three changes judged with no progress. Campaigns made on the **New campaign** page don't allow it. No agent can end a campaign.

By default the evidence ends the campaign: the run closes with `not possible: the evidence holds, and the run does not ask the owner`. A run that asks you about it waits for your word. **End it: not possible** closes the run: its agents stop, and nothing more is judged. **Keep going** dismisses the proposal. A later proposal needs a newly refuted approach.

### Keys, resets and silent rigs

- **New key**: work out the rig's own fingerprint on the rig, as [Accept a rig's key](../operate/accept-a-rig-key.md#2-work-out-the-rigs-own-fingerprint) shows: the first 16 hexadecimal characters of the SHA-256 of its public key. Nothing prints it when a rig is set up. If it matches the one on the row, press **Accept this key**. Until you do, control refuses the rig's reports.
- **Wipe**: check that the export it names is in the results repository, then press **Confirm the wipe**, which deletes the rig's ledger, builds and workspaces for good. **Cancel the reset** wipes nothing; the rig stays paused until you resume its run. Only a rig with a results repository can be fully reset, and rigs that control sets up have none yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). See [Stop, restart, remove and fully reset a rig](../operate/rig-lifecycle.md).
- **Not reporting**: **Open the rig** shows its last known state and what you can do.
- **Disk full**: the card says which place is short and how much is free, such as `its outbox has 3.1 GiB free`, and where room can come from: exports that wait to leave the rig, and the lanes' build caches. Make room on the machine; the rig goes back to work by itself once each place has 1 GiB more than its floor, and the card goes away. The work under way ends as it would: the judge's job in flight still writes its verdict. See [A rig's disk is at its floor](../operate/troubleshoot.md#a-rigs-disk-is-at-its-floor).
- **Drain**: the card says why the rig drains, since when, and what it still waits for. Nothing is chosen for you. **Update it now** (a cluster rig's update; **Change its size now** for a new size) restarts its pods now: a trial in progress stops, and its task goes back to its run's queue. On a rig whose change is not control's, **Stop what still runs** stops each trial the drain waits for, and the rig still drains for your change. **End the drain** sends the rig back to work, and calls a cluster rig's change off. **Leave it** keeps it draining: the card stays. See [At its deadline](../../reference/rig-page.md#at-its-deadline).
- **Agents stopped**: the card shows the provider's own words and what to check: credits at the provider, the key in **Settings › Providers**, whether the provider is up (`The model's calls keep failing`), or the model. Fix the cause, then press **Check the model now**; or give the rig another model on **Edit rig**. Thermite also checks the model again by itself, after a minute and then less often (at most every 30 minutes). Once a check passes, or the rig has another model, the agents go on and the card goes away. See [The agents stopped: the provider refuses](../operate/troubleshoot.md#the-agents-stopped-the-provider-refuses).

### Stuck trials

A trial has no time limit unless someone set one, and nothing ends a trial because it is quiet or repeats itself. So a stuck trial asks you:

- **Stuck?**: `lane-2's trial has sent nothing for 4 h 24 min`. Behind the card: how long it has run, what it last did in **Live**, and for a Pi worker its open model call: since when, and how many characters of text, thinking and tool-call arguments the model has sent so far. A reply that keeps streaming one very long tool call can hold a trial for hours.
- **Repeats**: `lane-1's trial repeats the same tool calls: 812 since 19:04 UTC`. Behind the card: how many times, how many different calls, and the most repeated ones. A Pi worker gets a short answer for each copy, so its conversation stays small. A trial that asks again and again for a page the run refused, such as a file larger than the run's `fetch_policy.max_bytes`, shows the same way from its 10th ask: `lane-3's trial asks again and again for a page the run refused: 12 times`, with the page, why it was refused and how many times the run asked for it. The harness answers each ask at once, with no download.

Both show the trial's work so far. Its lane's row, on the run's page, the home page and the rig's page, has a chip that leads to the card: `quiet for 4 h 24 min`, `repeats the same calls` or `repeats a refused request`.

- **Stop this trial…** opens the card. Its foot asks `Stop lane-2's trial now?`; **Stop the trial** sends [`stop_trial`](../../reference/signed-commands.md#stop_trial). The trial ends as interrupted, with its sources, claims and counters, and its task goes back to the top of the run's queue. The stop records why, such as `stopped from Needs you: it was quiet`. The card leaves at once.
- **Leave it running** hides the card. A quiet trial's card comes back if the trial sends a line and is then quiet again for as long; a repeating trial's comes back with a new streak, or with asks for another refused page.

To be asked about quiet trials, type the minutes in **Ask me after a quiet spell of (minutes)** on the rig's **Edit rig** page. Its ⓘ says: "When a trial sends no line for this long, its lane is marked quiet and the trial waits for you under Needs you. Empty: never. Nothing ends the trial." On a rig whose harness is too old to take it, the field is off and reads `update the rig first`.

## Decide without the dashboard

All of these take the owner's token, except `rig_check`, which every token but the reader's may send. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

| Decision | REST API | MCP |
| --- | --- | --- |
| Make a change the champion, or reject it | `POST /v1/commands`, kind `approve_promotion` or `decline_promotion`, payload `{"run": …, "attempt": …}` | `issue_command`, with the owner's token |
| Accept or reject a review | kind `accept_review`, payload `{"run": …, "review": <n>, "accept": true}` | no |
| End a campaign as not possible, or keep going | kind `conclude`, payload `{"run": …, "proposal": <n>, "accept": true}` | no |
| Accept a rig's key | `POST /v1/rigs/<rig>/key/accept?fingerprint=<fingerprint>` | no |
| Check the model now, for a run whose agents are stopped | `POST /v1/commands`, kind `rig_check`, payload `{"check": "model"}` | `issue_command` |

The `review` and `proposal` numbers are on the run, in `GET /v1/runs/<run>` or the MCP tool `get_run`: each item of its `reviews` has a `review`, and each item of its `conclusions` a `proposal`. A closed run's `pending_promotions` is empty, and the rig refuses `approve_promotion`, `decline_promotion`, `accept_review` and `conclude` for it, such as `run sort-speed-1 is closed: none of its changes can become the champion` ([Signed commands](../../reference/signed-commands.md#close_run) has each refusal). An attempt's id shows at the top of its page on the dashboard, after **attempt**, such as `a-0123456789abcdef`.

`thermite command` sends the same kinds. Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)):

```sh
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind approve_promotion --payload '{"run":"sort-speed-1","attempt":"a-0123456789abcdef"}'
```

The operator's and agent's MCP tokens can't issue any of these kinds except `rig_check`, which every token but the reader's may send.
