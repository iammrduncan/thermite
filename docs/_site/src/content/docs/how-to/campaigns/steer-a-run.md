---
title: "Steer a run"
description: "Pause, resume or close a run, restart its lanes, end its wait for the provider, change its agents' model, and send its agents messages."
type: how-to
sidebar:
  order: 8
---

You can steer a running campaign without touching its judge: pause or resume it, start its lanes afresh, send its agents a message, or close it for good. To choose what the lanes try next, and to make rules for the planner, see [Choose what a run tries next](choose-what-runs-next.md). Nothing you do here changes a verdict.

| Action | Where on the dashboard | What it does |
| --- | --- | --- |
| **Pause** | The run's header, Live's header, or the run's card under **At work now** | The agents' running [trials](../../reference/glossary.md) stop, and no new ones start. A stopped trial's work that it had not submitted is thrown away; changes already submitted stay. Each stopped trial's experiment goes back to the top of the run's [queue](choose-what-runs-next.md). The judge finishes the job it is on; the run's other queued jobs wait until you resume |
| **Resume** | The run's header; Live's header, where a paused run is listed under **Ended in the last day**, marked `paused`; or the run's row under **Earlier runs** | New trials start again, in the round the run was in: a trial that the pause stopped still counts in it. The planner plans the next round when this one's trials are done. If the model provider stopped the run's agents, the model is checked again at once ([limits and pacing](../../reference/limits-and-pacing.md#the-model-provider)). Any other running run on that rig is paused: a rig runs one run at a time |
| **Resume now** | The run's header, while its agents wait for the provider's limit | Ends the wait now: new trials and plans of the run start at once. See [End a wait for the provider](#end-a-wait-for-the-provider) |
| **Restart the lanes** | **⋯** in the run's header or in Live's header, while a run with agents is running | Ends the running trials and the current round at once, with no question first. Their experiments go back to the top of the queue. The planner plans the next round straight away, and every lane starts again from the champion. Nothing the judge decided is lost |
| **Close run** | **⋯** in the run's header, while the run is running or paused | Ends the run for good, with your reason: as for **Pause**, its running trials stop and nothing new starts, and its jobs waiting for the judge never run. It can't be resumed. Its experiments, attempts, champion and journal stay. See [Close a run](#close-a-run) |
| A message | The message box in **Live**, or **Tell the planner** on the **Planner** tab | Text for everyone working, one lane, the planner or the [advisors](../../reference/glossary.md). A message to everyone or to a lane can stay in force for every new trial. The planner makes rules from what you tell it |
| Typing into an agent's terminal | The console under a trial's terminal on its Live page: **⌨ Terminals** in the run's **Live** | Words, a slash command, a skill or a key, typed into one worker's program as you would type them. Only you can. See [Watch and steer an agent in its terminal](agent-terminal.md) |
| The experiment queue and the rules | The run's **Experiments** and **Planner** tabs | See [Choose what a run tries next](choose-what-runs-next.md) |

A trial is one worker's session in a [lane](../../reference/glossary.md): it ends when it submits a change, when its time runs out, or when it stops. [Agents, lanes and the planner](../../explanation/agents-lanes-planner.md) explains lanes, trials and the planner.

## Before you start

- A run that is running or paused. A finished run can't be resumed: `run <id> is closed`.
- The owner's sign-in on the dashboard, the owner's token for the command line, or an MCP token that may steer: see [Who may do what](#who-may-do-what).

## Pause, resume or restart the lanes

1. Open **Campaigns** in the sidebar. A running run has a card under **At work now**, on the Campaigns page and on its campaign's page: press its name, shown as `<campaign> › <run>`. A paused run is on its campaign's page, under **Earlier runs**, which lists the paused, completed and finished runs: press the campaign in the table under **All campaigns**, then the run. The run's page opens.
2. In the run's header:
   - To pause, press **Pause**. A small menu opens. It says `The lanes' running trials stop and no new ones start. Its jobs waiting for the judge wait until you resume, so the judge's time goes to running runs. Resume picks up from the same champion.` You may say why in **why (optional)**, up to 500 characters. Press **Pause the run**.
   - To resume a paused run, press **Resume**.
   - To restart the lanes, press **⋯**, then **Restart the lanes**. The menu says what it does; the button sends the command at once. **Restart the lanes** shows only while the run is running, and never on a run without agents, such as a [try](../../reference/glossary.md): it has no lanes to restart. Live's header, beside **Pause**, has a **⋯** with **Restart the lanes** too.

   The menu closes, and a line at the top of the page follows the command: `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`, then `rig-1 took it at 03:41 UTC. This page shows the change when the rig next reports.`, with your rig's name. See [Signed commands](../../reference/signed-commands.md#on-the-dashboard).
3. Stay on the page: it changes by itself. Once the rig has reported, within a minute, the line says `Done. rig-1 took it at 03:41 UTC.`, and the line under the run's name ends `· Paused` or `· Running`, with **Resume** or **Pause** beside it. A paused run reads `Paused` even while a change or a decision waits for you: what waits shows under **Needs you** on the run's **Overview**. The run's **History** tab shows `Run sort-speed-1 paused: checking the kit.`, with the reason you gave, or `Run sort-speed-1 resumed.`, or, after a restart, `You restarted the lanes: their trials ended, and every lane starts again from the champion.` A trial that the pause or the restart stopped shows in **History** as `lane-1's trial on loop-tiling ended without a submission (interrupted).`, and its experiment's return to the top of the queue as, for example, `"…" went back to the top of the queue: its trial on lane-1 was interrupted (its trial was stopped).` After **Restart the lanes**, the planner's next round follows in **History** within a few minutes.

With **why (optional)** left empty, the reason is `paused from the dashboard`. The reason also shows in the run's **Now** block, and under **Why it stopped** in the campaign's **Earlier runs**.

To stop one trial, not the whole run: a trial that repeats the same calls, or one quiet for longer than the rig's **Ask me after a quiet spell of (minutes)**, asks you under **Needs you**, and its lane under **Now** has a chip that leads to the card. Press **Stop this trial…**, then **Stop the trial** in the card's foot. See [Stuck trials](decide-what-waits.md#stuck-trials). Over MCP or REST, [`stop_trial`](../../reference/signed-commands.md#stop_trial) stops any running trial.

## End a wait for the provider

When a model call meets the provider's rate limit or a full subscription window, the run waits: no new trial or plan of it starts until the time the provider gave, at most one trial's length from when it was asked, 24 hours when neither the campaign nor the rig sets one ([The model provider](../../reference/limits-and-pacing.md#the-model-provider)). The rig's other runs go on. To end the wait early, for example once you raised the provider's limit:

1. Open the run's page. While it waits, its **Overview** says `Its agents wait for the provider's limit until 2026-10-22 03:14 UTC: no new trial or plan starts before then. Resume now ends the wait.`, and its header has **Resume now**.
2. Press **Resume now**. A small menu opens with the time the wait lasts until, the provider's words, and what ending it does. Press **End the wait now**.
3. Once the rig has reported, **Resume now** is gone, new trials start, and the run's **History** says `You ended the agents' wait for the provider's limit, which was to last until 2026-10-22 03:14 UTC: new trials and plans start again.` If the limit still holds, the next trial meets it and the run waits again. A trial that waits in its own conversation goes on at its own time.

Over REST or MCP, send [`end_wait`](../../reference/signed-commands.md#end_wait) `{"run": "<run>"}`. MCP's `get_run` gives the wait as `agents_wait`.

## Close a run

Close a run you no longer want, such as a paused run whose work another run finished. A closed run ends for good, as a goal run that met its goals does: it can't be resumed. To stop it for a while, pause it instead.

1. Open the run's page, as in [Pause, resume or restart the lanes](#pause-resume-or-restart-the-lanes). The run is running or paused.
2. In the run's header, press **⋯**. The menu has **Close run**, below **Restart the lanes** on a running run with agents. It says `The run ends for good: nothing more starts, and it can't be resumed. Its results stay.`
3. In **Why**, say why you close it, such as `another run finished the work`, up to 500 characters. The run keeps it.
4. In the box below, type `close` and the run's name, such as `close sort-speed-1`. **Close the run** waits until the words match. Press it.

   The menu closes, and a line at the top of the page follows the command, as for **Pause**. Without a reason or the typed words, control refuses it: `Not sent: Write why you close the run first.` or `Not sent: Type close sort-speed-1 to confirm.`
5. Once the rig has reported, the line under the run's name ends `· Finished`, and the header has no **Pause**, **Resume** or **⋯**. The run's **Overview** says `This run is closed: another run finished the work. It is finished.`, and its **History** tab `Run sort-speed-1 closed: another run finished the work.`

What happens on the rig:

- The run's running trials stop, as for a pause, and its planner call is cancelled. No new round or trial starts.
- Its jobs waiting for the judge are cancelled: they never run, and the rig's page no longer counts them as queued. A change that waited for one shows `not judged: its run closed first`. A job the judge was already measuring finishes, and its verdict is recorded.
- A research run's final report is written once its last trial has ended.
- Its experiments, attempts, champion and journal stay, and the rig's next export carries the close.
- Nothing in it waits for you any more. A decision that waited in it, such as a change waiting for approval, an audit, a review or a "not possible" proposal, leaves **Needs you** and every count of it once the rig has reported the close. A win the judge confirms after the close, from a job it was already measuring, is held the same way. Such a change shows **Run closed** in the run's attempts, and its own page says `The run closed while this change waited for a decision. It does not become the champion, and the rig refuses a decision on it.`, with no buttons. The run's **Overview** adds how many there were, such as `When it closed, 1 change waited for a decision.`
- The rig refuses a decision on it in words, such as one sent from a page opened before the close: `run sort-speed-1 is closed: none of its changes can become the champion`. [Signed commands](../../reference/signed-commands.md#close_run) lists each refusal. The rig's auditor gets none of its audits.
- **Resume** and **Pause** no longer work on it: the rig refuses them with `run sort-speed-1 is closed`. Closing it again is refused too: `run sort-speed-1 is already closed (another run finished the work): there is nothing to close`.

## Change the agents' model

A run uses the models of its rig, so you switch a running campaign to another model on the rig's **Edit rig** page. The run goes on, with nothing paused or lost: the workers use the new model from their next trial, the planner from its next round, and the advisors from their next round. See [Change the model during a run](../models/model-per-agent.md#change-the-model-during-a-run).

## Send the agents a message

![Live for one run: the runs at work on the left; the run's header, its filters (Everyone, lane-1, lane-2, Planner, Judge, Advisors, You) and lane-1's stream of thinking, tool calls and text; the message box at the foot, set to To lane-1, with 📌 and Send beside it](../../../../assets/screenshots/live.webp)

1. Press **Message** in the run's header, or on the run's card under **At work now**. **Live** opens on that run, with the cursor in the message box at the foot of the page. (**Live** in the sidebar opens the first run at work; the list on its left holds the others. With no run at work, it says `No run is at work. Pick one from the list to see its lines.`: the list's **Ended in the last day** holds the runs that paused or finished lately.) A run without agents, such as a try, has no **Message** button: it has no lanes or planner to read one. On its **Live**, you can still write to its advisors.
2. In the **To** list, choose who gets it:
   - **To everyone working**, the default: every lane at work, and the planner of a hill climb or goal run. The lanes at work are the contract's lanes, or fewer when a `lane_count` rule says so;
   - **To lane-1**, **To lane-2** and so on: that lane's running trial, or its next one;
   - **To the planner**: at its next plan;
   - under **Advisors**: **To all advisors**, **To the teachers**, **To the auditor** or **To the review panel**.

   A recipient that would never read it is greyed out. Hover over it to read why:
   - the auditor of a research run: `A research run has no attempts to audit.`;
   - everyone working, each lane and the planner of a run without agents, such as a try: `This run has no agents (the judge alone tries the kit), so nothing would read it.` On such a run the box starts on **To all advisors**;
   - the review panel of a run with no goal it reviews, a hill climb or a goal run with no goal checked by review: `This run has no goal the review panel reviews.` (A research run's review panel reads messages: it checks the run's questions.);
   - any role that is switched off on the rig's **Edit rig** page, such as `The auditor is off on this rig (Edit rig), so nothing would read it.`;
   - an advisor that the rig's supervisor has not set up, such as one switched on with no model: `This rig's supervisor has no teachers set up, so nothing would read it.` **To all advisors** is greyed out when the supervisor has none set up, or when no advisor would read it, which starts `No advisor would read it.`

   A message to such a recipient is refused however it is sent, by control or else by the rig: see [If a message doesn't arrive](#if-a-message-doesnt-arrive).

   Choosing a lane's chip above the stream, or **Planner** or **Advisors**, also chooses that recipient. A lane that starts after the page has loaded gets its own chip when its first line arrives; its **To** entry comes with the next **refresh**.
3. Write the message, up to 4,000 characters. A message of only spaces doesn't send: the box says `Write a message first.` The box's placeholder says when they will read it, then `· ⌘↩ sends`. It depends on the program the agents run in, such as `lane-1 (on loop-tiling) reads it at its next step` in Pi, `lane-1 (on loop-tiling) reads it when its current run ends, or in its next trial` in OpenCode, Claude Code or Codex, or `lane-1 reads it when it can (this rig hasn't said which program runs its agents)`. For everyone working, it says `Each agent reads it when its current run ends; the planner at its next plan`, and for the planner, `The planner reads it when it plans the next round`. To keep a message to everyone working or to a lane in force for every new trial, tick 📌, which shows only for those two (see [Keep a message in force](#keep-a-message-in-force)).
4. Press **Send**, or Ctrl+Enter (⌘+Enter on a Mac).

Within half a minute, once the rig has taken it, the stream shows your message, such as **To lane-1:** `Look at the cache misses first.`, or **To everyone working:** and the text. When an agent reads it, a receipt follows: `✓ lane-1 read your message: “Look at the cache misses first.”`, or `✓ planner read your message: …`. A receipt that comes less than a minute after you sent the message may show first as a plain line, `read the owner's message #3: …`; it becomes the receipt once the rig's next report reaches control. A message to one trial does the same. When a worker in Claude Code, Codex or OpenCode takes your message inside its turn, its stream also says how, such as `the owner's message #3 went in inside its turn, after a tool (Claude Code's PostToolUse hook)` or `the owner's message #4 went in at the end of its turn, and the agent went on with it (Codex's Stop hook)`. An advisor also answers, such as **the teachers (teacher-a) answered you:** and its answer. A line that only looks like one of these, such as one a worker printed, stays a plain line of that worker: Live trusts only the lines the rig's harness signed. The filter **You**, above the stream, shows only your messages, their receipts, the answers, and the lines that say you removed a kept message. The judge takes no messages: it is code, and nothing anyone writes may change a measurement.

As they work, the agents keep [field notes](use-past-research.md#read-a-runs-journal): short notes of an observation, a decision and why, a surprise, a question or a lesson. A note can be about your message. **Live** shows each note as it is written, such as `noted (decision): …`, and the run's **Journal** tab lists them; there, a note about your message shows `your message “…”`.

You can also write to the planner of a hill climb or goal run from its run's **Planner** tab: write in **Tell the planner** and press **Send to the planner**. There, typing `:` opens a list of the run's directions to name one exactly. The box empties and a line under it follows the message, from `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.` to `Done. rig-1 took it at 03:41 UTC.`; after a **refresh**, your message waits under the box until the planner's next round, when its answer shows: the rules it made and the directions they name. With the planner switched off on **Edit rig**, the tab has no form, only a note that the planner reads no messages. From what you say, the planner can change the run's experiment queue and make rules: see [Make a rule: tell the planner](choose-what-runs-next.md#make-a-rule-tell-the-planner).

### When each agent reads it

A receipt means the agent has the text. For a message in a new trial's brief, that is once the trial's agent is at work: its first line, or its first turn or tokens. A trial that fails before then leaves the message for the lane's next trial. Each reader reads a message once, except a message kept in force, which each new trial reads again.

| Reader | When it reads your message |
| --- | --- |
| A worker in Pi | At its next step, before its next model call |
| A worker in Claude Code or Codex | Inside its turn: after the next command or other tool it runs, or, when the model stops, as the reason to go on. One message at a time. If the turn has already ended, when the rig continues the session. If the trial submits or ends first, the lane's next trial reads it at its start |
| A worker in OpenCode | Inside its turn, after the next tool it starts. If its run has already ended, when the rig continues the session. If the trial submits or ends first, the lane's next trial reads it at its start |
| A worker that has submitted, or a lane with no trial running | In the brief of the lane's next trial, once its agent is at work |
| The planner | At its next plan that uses its model's answer. When its model can't be reached, or code refuses the model's plan on both tries, the fixed rules plan the round and the message waits for the next plan: **History** then says `(by the fixed rules: the model gave no usable plan, because …)`, and no receipt comes yet |
| The teachers | While the run is running, in a review round of the teachers' own (not the planner's round) that starts at once, after any review round already under way. For a paused run, the message waits until it runs again. If someone set the advisors a daily spending limit and it is reached, the message waits for the first review round after midnight UTC, and **Live** says so once |
| The auditor, the review panel | With their next audit or review, once it is posted: if it fails, the next try reads the message again. An audit or review comes only when the judge holds a change for audit, a goal waits for review, or a research run's questions are checked, after its minimum duration |

[Supervision](../../explanation/supervision.md#the-owners-messages) says how the advisors read and answer your messages.

### Keep a message in force

A message kept in force goes into the brief of every new trial until you remove it: every lane's new trials, for a message to everyone working, or one lane's, for a message to that lane. Only those two can be kept, so 📌 shows only for them.

- In the stream, a kept message shows `📌 kept in force`, and each trial that reads it shows `✓ lane-1 read your message (in force): …`.
- **📌 2 kept**, above the stream, lists your kept messages, such as **To everyone:** and the text, under `Every new trial gets these, until you remove them.` It shows once the rig's report with the message reaches control, within a minute. To end one, press **Remove** beside it. A line at the top of the page says `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`; within seconds the stream says `📌 You removed your kept message: “…”. New trials no longer get it.`, under **You** and, for a message to a lane, under that lane's filter. After the rig's next report the message leaves the list, with no refresh. A trial that had already read it keeps it; new trials don't get it.

### Write to one trial

Live writes to a lane, not to one trial. To write to one trial, send `message_agent` with `"to": "trial:<id>"` from the [command line](#steer-from-the-command-line), the REST API or MCP. Live shows the start of a trial's id beside its lines, such as `t-4f1c9a2e`. The whole id is in the run's `at_work`, from the MCP tool `run_queue`, or from the REST API with the owner's token:

```sh
curl -s -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/rigs/local-1/view
```

In its answer, find the run in `runs`: its `at_work` holds each lane's trial, such as `"lane-1": {"trial": "t-4f1c9a2e5b7d4c10", …}`. If the trial ends before it reads the message, the lane's next trial reads it, and is told so.

The rig's own live view, **Live** on the rig's page, has no message box: it says `To message an agent, open its run's Live:` and links each run.

### If a message doesn't arrive

Control refuses a message with no words, or one that nothing would read, before it signs it, however you send it: from **Live**, the **Planner** tab, the command line, the REST API or MCP. Its reasons are the words **Live** shows on a greyed-out recipient:

- `Write a message first.`, for a message with no words, or only spaces;
- `This run has no agents (the judge alone tries the kit), so nothing would read it.`, for everyone working, a lane, the planner or one trial of a run without agents, such as a try: write to its advisors, or start a run with agents;
- `The planner is off on this rig (Edit rig), so nothing would read it.`, and the same words for the auditor or the review panel when its switch is off, or `The teachers are off on this rig (Edit rig), so nothing would read it.`;
- `A research run has no attempts to audit.`;
- `This rig's supervisor has no auditor set up, so nothing would read it.`, with the teachers or the review panel in its place, for an advisor the rig's supervisor hasn't set up, such as one with no model;
- for **To all advisors**, `This rig's supervisor has no advisors set up, so nothing would read it.` when it has none, and `No advisor would read it.` with each advisor's reason when none of them would.

In **Live** and on the **Planner** tab, a line under the box says `Not sent:` and control's reason at once, and your text stays in the box. Over MCP, `issue_command` answers `{"error":"…"}` with the reason. The REST API and `thermite command` get an answer of **400** with `{"error":"…"}`. Nothing reaches **Commands**. Every refusal, from **Live**, the **Planner** tab, MCP, the REST API or `thermite command`, is in the **Audit log**, as `refused`.

Control knows which advisors a rig has set up only once the rig's supervisor has reported them. Until then, it sends a message to an advisor that is switched on, and nothing reads it until the advisor has a model. See [Configure advisors](../operate/advisors.md).

The rig refuses the messages that control can't check, and says why, within seconds, with no refresh: the line under the box says `rig-1 refused it:` and the reason, and in **Live**, above the message box, a strip reads **Not sent.** `The rig refused your last message:` and the reason, such as `run sort-speed-1 has 1 lane` for a lane the run doesn't have. It stays until you send that run a newer message. A refused message to the planner shows on the **Planner** tab too, above **Tell the planner**, as **Not sent.** `The rig refused your last message to the planner:` and the reason. **Commands** in the sidebar also has the rig's refusal: the newest **message agent** row is **failed**, with the reason under **Outcome**. [`message_agent`](../../reference/signed-commands.md#message_agent) lists every reason the rig gives.

## Steer from the command line

`thermite command` sends the same commands, with the owner's token. Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
  --rig local-1 --kind pause_run --payload '{"run":"sort-speed-1","reason":"checking the kit"}'
```

It prints the command's id and `"status":"pending"`. In each payload, `run` is the run's name as the dashboard shows it, such as `sort-speed-1`. The payloads:

| Kind | Payload |
| --- | --- |
| `pause_run` | `{"run":"sort-speed-1","reason":"checking the kit"}` |
| `resume_run` | `{"run":"sort-speed-1"}` |
| `close_run` (**Close run**; the owner's token only) | `{"run":"sort-speed-1","reason":"another run finished the work"}` |
| `reset_workers` (**Restart the lanes**) | `{"run":"sort-speed-1"}` |
| `redirect`, added to the rules in force | `{"run":"sort-speed-1","directives":[{"kind":"avoid","family":"loop-tiling","rationale":"three trials regressed"}],"replace":false}` |
| `redirect`, a direction in plain words or `:name:`, added to the rules in force | `{"run":"sort-speed-1","directives":[{"kind":"try","family":":vector loads:","rationale":"twice the bandwidth"}],"replace":false}` |
| `redirect`, replacing the rules you sent before this way | `{"run":"sort-speed-1","directives":[{"kind":"avoid","family":"loop-tiling","rationale":"three trials regressed"}]}` |
| `drop_directive` (**Remove** on a rule) | `{"run":"sort-speed-1","id":7}` |
| `message_agent` | `{"run":"sort-speed-1","to":"lane-2","text":"Look at the cache misses first."}` |
| `message_agent`, kept in force | `{"run":"sort-speed-1","to":"all","text":"Keep the public API unchanged.","keep":true}` |
| `unkeep_message` | `{"run":"sort-speed-1","message":3}` |

The changes to the experiment queue, `queue_add`, `queue_move`, `queue_edit`, `queue_drop` and `queue_accept`, are in [Choose what a run tries next](choose-what-runs-next.md#from-the-command-line-and-over-mcp).

A `redirect` takes up to 40 directives, each with a `kind`, a `rationale`, and, where the kind needs one, a `family` (its direction, in plain words or as `:name:`) or a `value`:

| `kind` | What it does |
| --- | --- |
| `avoid` | No lane is given that direction |
| `try` | Puts the waiting experiments in that direction first when there is a choice. It adds none (**Try** on the dashboard) |
| `mandate` | Every plan gives that direction a lane (**Always** on the dashboard) |
| `priority` | Ranks a direction for the planner |
| `lane_count` | `value`: how many lanes to plan, up to the contract's `lanes.count` |
| `trial_minutes` | `value`: how long one trial lasts, in minutes, a whole number from 1 to 1440. It comes before the contract's `lanes.limits.trial_minutes` and the rig's **One trial lasts (minutes)**, from the next trial on; a trial already at work keeps its length. The **Planner** tab shows it as `Trials last <n> minutes`. Otherwise refused: `a trial_minutes rule gives value: minutes, a whole number from 1 to 1440` |
| `keep_working` | `value`: `on` or `off`. On, the run's lanes keep working while the judge works: a lane's next trial starts as soon as its last one ends, and a round ends without waiting for verdicts. Off, they wait for the judge's verdicts. It comes before the contract's `lanes.keep_working`; drop it (`drop_directive`) to go back to the campaign's setting. The **Planner** tab shows it as `Lanes keep working while the judge works: on`. Otherwise refused: `a keep_working rule gives value: on or off` |
| `note` | Free text for the planner |

- Without `"replace": false`, a set replaces the rules sent earlier the same way, and only those. The command line and the REST API share one set. Over MCP, each token's role has its own: the owner's, the operator's and the agent's. The dashboard sends no `redirect`: its rules come from the planner, which adds them from your messages. Rules from elsewhere stay: remove them with `drop_directive`.
- Control sends each `family` as the direction's name: `:Vector loads:` goes as `vector-loads`. A direction the run doesn't have yet is taken, and the planner designs it at its next round: see [Directions](choose-what-runs-next.md#directions). A research run takes only its task kinds.
- A set that both avoids a direction and asks for it is refused: `the set both avoids and asks for <direction>`.
- A rule in words is refused: `bad redirect payload: directives.0: a rule no longer takes match: name its direction in family, in plain words or as :name:`. So is a `family` that can't be a direction's name: `… is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:`. An old rule in words, set before rules named directions, needs nothing from you: the planner converts it to a rule on a named direction at its next round, and the new rule keeps its place in your set ([Old rules in words](choose-what-runs-next.md#old-rules-in-words)).
- Only the planner sees rationales and notes; workers never do.
- Your directives come before any that the rig's advisors or the planner set on the same `family`.
- `drop_directive` removes one rule in force, whoever set it. Its `id` is the rule's number, from `run_queue`'s `rules`. A rule that is not in force is refused: `no rule 7 in force in run sort-speed-1`. In a finished run, `drop_directive` and `redirect` are both refused: `run sort-speed-1 is closed: its queue and rules no longer change`. Only you, or an operator, can set a removed rule again, with a `redirect`; the advisors, the planner and the agent's token can't: see [Remove a rule](choose-what-runs-next.md#remove-a-rule).

A `message_agent`'s `to` is `all` (everyone working), `planner`, `advisors` (all of them), `teachers`, `auditor`, `review_panel`, `lane-1` to `lane-16`, or `trial:` and a trial's id. The text may be up to 4000 characters; control trims the spaces around it, and refuses a message nothing would read as [above](#if-a-message-doesnt-arrive). `"keep": true` works only with `all` or a lane; with another `to`, control refuses it: `bad message_agent payload: keep: only a message to everyone working (all) or to a lane can be kept in force`.

The rig numbers each message, and `unkeep_message` takes that number as `message`. Find it in the rig's answer to the `message_agent` command, such as `{"accepted":true,"result":{"keep":true,"message":3,"readers":["lane-1","planner"],"to":"all"},"status":"applied"}`: in the **Outcome** column on **Commands**, or in `outcome` from `GET /v1/commands/<id>`. `readers` says who will read it. After the rig's next report the same answer shows with `"kind"` and `"source"` in place of `"status"`.

Over MCP, an agent sends the same kinds and payloads with the `issue_command` tool, then follows them with `command_status`; which kinds each token may send is in [Who may do what](#who-may-do-what). The tool `run_queue` reads a run's experiment queue, its rules, the planner's hand-outs, and your messages with who read each one, the planner's round that read it, the rules the planner made from it and the advisors' answers. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).

## Who may do what

| | Pause, resume, restart the lanes, add rules | Message the agents, remove a kept message, end a wait for the provider | Change the experiment queue, remove a rule | Close a run |
| --- | --- | --- | --- | --- |
| The owner: dashboard, REST API, command line, MCP | yes | yes | yes | yes |
| The operator's token over MCP | yes | yes | yes | no |
| The agent's token over MCP | yes | no | no | no |
| The reader's token | no | no | no | no |

Approving and rejecting changes is the owner's alone: see [Decide what waits for you](decide-what-waits.md). [Tokens and roles](../../reference/tokens.md#people-and-agents) has every role.
