---
title: "Remove what Thermite keeps, with retention policies"
description: "Design a policy that removes one kind of what Thermite keeps, where and when you say: see what it would remove first, turn it on, run it by hand, and read what it removed."
type: how-to
sidebar:
  order: 10
---

Thermite keeps everything, everywhere, until you decide otherwise. A **retention policy** removes one kind of what Thermite keeps, such as the judge's builds on your rigs or old entries of control's audit log, where you say, by a rule you set, on the days you choose. No policy exists until you make one, each starts off, and each shows what it would remove before it removes anything. This page makes a policy, turns it on, runs it by hand, and reads what it removed.

## Before you start

- Sign in to the dashboard with the owner's token. Only the owner makes, changes, runs or deletes a policy. An operator's token reads them over MCP, and nothing more.
- Look at **Settings › Space** first. It lists what Thermite keeps by kind, where each is kept (**Kept on**), the space it takes, and what removes it (**Removed by**): a policy, **By hand, on Exports**, or **Kept for good**.

## What a policy can remove

| Kind | Kept on | What it is | It can always keep |
| --- | --- | --- | --- |
| **Rigs' events (control's copy)** | Control | Control's copy of every event its rigs reported, in the message bus's `EVENTS` stream. Each rig's own ledger keeps them all the same. Control builds the dashboard's history from these at each start: removed events leave it then, and can't be shown again; what the knowledge base already read of them stays. A policy of them still says **Where**, by rig, and removes whole days, oldest first (below) | Events of runs still open |
| **Judge's builds** | Rigs | The builds the judge made of each candidate, on each rig's volume. A build removed is made again if it is ever needed: its commit and its kit stay, and so does its record in the rig's ledger. A build whose commit a judge's job is waiting for or measuring is never removed | Each lane's champion builds; builds of runs still open |
| **Trials' session logs** | Rigs | Each trial's full session log, as its agent program wrote it (Pi's conversation, or Claude Code's, Codex's or OpenCode's own log or output), kept in the harness's state by run and trial when the trial ends, where no agent can reach it. Its summary and its events stay. At the rig's disk floor a log that would take the disk below it is not kept, and the harness's log says so. A log is as large as what the program wrote in its trial: at most the trial's own disk (**Disk per agent** on New campaign, 2 GiB unless set) | Logs of runs still open |
| **Advisors' records** | Supervisors | The records of each round of the auditor, the teachers, the review panel and the paper's writers, and their conversations kept before each compaction, in each rig's supervisor's home. Their decisions stay in the rig's ledger | Records of runs still open |
| **Older versions of knowledge-base items** | Control | Versions of an item that a newer version replaced. The newest version of each item always stays | |
| **Copies of control's store** | Control | `control.db` as it was before each update that changed its tables, kept beside it so an update can be undone. Control keeps the two newest itself, until a policy for this kind is on: from then on it keeps every copy, and the policy decides. A policy that is off changes nothing. **Space** says which applies: `Control keeps the two newest, until a policy for this kind is on.`, or the policy's name | The newest copy |
| **Audit log** | Control | Who did what, and when, on control. Entries removed can't be shown again. Each removal by a policy is itself written to the audit log, and that entry is never removed | |

Each "can always keep" is ticked when you make a policy: untick it to let the rule remove those too.

## What no policy removes

- **A rig's ledger.** Each event's hash holds the one before it, and the judge's verdicts are checked against the chain: removing any event would break it.
- **A results repository.** It is your project's own Git repository. Thermite pushes to it and never removes from it.
- **Exports.** You remove them by hand, on the **Exports** page ([Get a rig's results from control](exports-on-control.md#4-delete-exports-you-no-longer-need)).

The knowledge base's files (see [How long control keeps a file](../../reference/knowledge-base.md#how-long-control-keeps-a-file) for orphans), the kits and control's store itself are kept for good too: **Space** says **Kept for good** beside each.

## 1. Start a policy

Open **Settings › Retention policies**: the cog at the foot of the sidebar, then **Retention policies** in Settings' navigation. With no policy, it says `No policy. Thermite keeps everything, everywhere.` Press **New policy**. The form opens under the list, headed **New policy**. Every label has an ⓘ: hover over it, or focus it, for what the field means.

## 2. Design it

1. **Name**: a name for you, such as `Old builds`. It shows in the list, the **Space** table and the audit log. **Save** stays off until the policy has one.
2. **What it removes**: one kind, grouped by where it is kept, each with the space it takes now. The box under it says what the kind is, where it is kept, and how many there are now. The **Audit log** shows its warning here.
3. **Where**, for a kind kept on rigs: **Every rig**, **These rigs** (tick them) or **These campaigns**, which means every rig that ran one of them. A kind kept on control says `Control only.`
4. **Rule**:
   - **Older than**: removes what is older than a number of days, weeks or months (a month is 30 days).
   - **Beyond the newest**: keeps the newest number, **per rig**, **per run** or **in all**, and removes the rest.
   - **Over a size**: keeps under a number of GiB, in all; the oldest go first.
5. **Always keep**: what this policy never removes, even when the rule covers it. On by default.
6. **When**: **Every day** at a time, **Every week** on a day at a time, or **Only by hand**. Times are UTC.

**If it ran now** says what the policy would remove as you change it, for example `It would remove 412 builds on 2 rigs, 18.40 GiB, from 2026-08-03 to 2026-09-28.`, and what would stay. Nothing is removed until the policy is on and its time comes, or you press **Run now**. For a kind kept on rigs, it counts what each rig last said it keeps: a rig's supervisor tells control every 10 minutes, and after each removal. A rig that has not told control yet is named, and its items are not counted.

## 3. Save it

Press **Save, off** to keep the policy without running it, or **Save and turn on**. The line beside the buttons says when it first runs, such as `Turned on, it first runs tomorrow at 03:00 UTC.` The page comes back with `Saved “Old builds”, off.` (or `and turned it on`), and the policy is in the list with its **Where**, **Rule** (and what it keeps), **When**, and under **Runs** its last run and what it `would remove now`. **Space** shows its name beside its kind, with `(off)` while it is off.

A policy runs once at each of its times while it is on. It never runs for a time before you turned it on, so one turned on at 10:00 that runs every day at 03:00 first runs the next day. After control was stopped across some of its times, it runs once, for the latest it missed. **Only by hand** never runs by itself.

## 4. Turn it on or off

Each policy's switch, in the **On** column, turns it on or off at once. Off, it removes nothing. **Edit** opens the form with the policy's design; saving it keeps the time it last ran for, so it does not run again for that time.

## 5. Run it now

Press **Run now** in the policy's row. The page asks first, under the row, and says exactly what it removes: `Run “Old builds” now?` `It removes 412 builds on 2 rigs, 18.40 GiB, from 2026-08-03 to 2026-09-28, as its rigs last said; each rig removes what the policy covers when the command reaches it. This can't be undone.` Press **Remove now**, or **Cancel**. **Run now** works whether the policy is on or off.

- A kind kept on control is removed at once, and the page says what went: `“Old audit” removed 1,204 entries, 3.1 MiB, from 2026-06-01 to 2026-09-30 from control.`
- Control's copy of the rigs' events goes by the message bus's purge: for each run's subjects, and each rig's own, whole days from the oldest, up to the first day the policy keeps. A run's subjects hold the events of every rig that used the run's name. Where a day the policy removes and another rig's day it keeps lie among each other there, as under a policy of one rig, neither goes, nor any later day of that run; what the run says it removed leaves them out. Control keeps each rig ledger's *floor*, its last event removed on purpose: it never asks the rig for those events again, nor takes them back if the rig sends them, as after a restore of an older store. `GET /v1/rigs/<rig>/events` lists the floors as `removed`.
- A kind kept on rigs is sent to each rig the policy covers as a signed command, [`retention_run`](../../reference/signed-commands.md#retention_run): `Sent “Old builds” to rig-1 and rig-2: on each, it removes what the policy covers there, and says what went under What policies removed.` On each rig, the harness removes the judge's builds; the advisors' records are removed by the rig's supervisor once its harness has taken the command. Each rig works out what goes from what it holds when the command arrives, with the same rule as the preview. A rig that is away gets the command when it comes back, within a day; after that the command expires, and the policy's next run covers it.

## 6. Read what it removed

**What policies removed**, at the end of the page, lists each removal, newest first: when, the policy, what it removed and where (`on control`, or the rig), the space freed, and who started it (`its schedule`, or `you, Run now`). Each one is in the audit log as `retention_removed`, and each change to a policy is there too: `retention_policy_created`, `retention_policy_changed`, `retention_policy_on`, `retention_policy_off` and `retention_policy_deleted`, and `retention_run_sent` when control sends a policy to its rigs. **Delete** removes a policy; what it removed stays in the list and the audit log.

## From the command line, REST or MCP

The same operations, with the owner's token:

```sh
thermite retention preview --name "Old builds" --kind builds --rule newest --newest 20 --per rig \
  --control https://control.example.com --token-file ~/.thermite/owner-token
thermite retention create --name "Old builds" --kind builds --rule newest --newest 20 --per rig \
  --when weekly --day sunday --time 03:00 \
  --control https://control.example.com --token-file ~/.thermite/owner-token
thermite retention on 1 --control https://control.example.com --token-file ~/.thermite/owner-token
thermite retention removals --control https://control.example.com --token-file ~/.thermite/owner-token
```

[The command line](../../reference/command-line.md#retention) has every option, [the REST API](../../reference/rest-api.md#retention-policies) every route, and [MCP tools](../../reference/mcp-tools.md#retention_policies) the tools: `retention_policies`, `retention_preview` and `retention_removals` for the owner and an operator, and `create_retention_policy`, `update_retention_policy`, `set_retention_policy_on`, `delete_retention_policy` and `run_retention_policy` for the owner.

## How to tell it worked

- The policy's row says when it last ran and what it removed, and **would remove now** drops to what is left.
- For control's copy of the rigs' events, control's log says `a retention policy purged control's copy of events` for each subject, and the rig's history on the dashboard no longer shows them after control's next start.
- **What policies removed** has its removal, and the audit log has `retention_removed`.
- **Space** shows less for the kind; a rig's kind shows less once the rig tells control again, within 10 minutes.
