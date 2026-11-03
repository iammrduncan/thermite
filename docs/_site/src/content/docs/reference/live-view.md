---
title: "The Live view"
description: "Every part of the dashboard's Live view: a run's stream with its filters and message box, a rig's sessions, and a trial's, the planner's or an advisor's terminal with the owner's console."
type: reference
sidebar:
  order: 23
---

**Live** shows what a run's agents, its judge and its advisors do as they work. It is a view, never a record: what happened is in the rig's signed events, and the run's page reads those. Control pushes each new line to the page as it gets it from the message bus, where the rig's supervisor publishes it, so the page needs no reload. Only the owner signs in to the dashboard, so only the owner sees Live; the reader's token gets the same lines over REST, `GET /v1/rigs/<rig>/live`, but never a terminal.

The rig masks its own credentials in each line before the line leaves it, wherever an agent printed them: a trial's token, a planner's call's in its own terminal, the model proxy's and the MCP gateway's show as `trial.***`, `call.***`, `proxy.***` and `mcp.***`, and the value of any `THERMITE_*_AUTH` setting as `***`. Each line is masked before it is cut to 8,000 characters ([Limits and pacing](limits-and-pacing.md#the-rig-and-control)).

Live has three pages: one run at a time, a rig's sessions, and one session: a trial's, which has the trial's terminal; the planner's, which has its call's terminal while it plans in one; or the supervisor's, which has an advisor's call's terminal while one works in its own.

## One run at a time

**Live** in the sidebar opens `/ui/live`, which shows the first run at work. A run's own Live is at `/ui/campaigns/<campaign>/runs/<run>/live`, and **Live** in a run's header opens it.

On a rig that runs its agent programs in their own terminal, the run's Live has three tabs under its header, and opens on **Terminals** while one of the run's agents works in its terminal:

- **Terminals** (`?view=terminals`): a tab for each lane's trial at work and the planner's call, while it plans the run, named such as `lane-1 · shared memory tiling` or `planner`, and **Side by side**, which shows them all. The chosen terminal fills the pane, as [a trial's terminal](#a-trials-terminal) does, with its own bar. **Side by side** puts them in a grid as near square as their number allows (two columns for four), each screen scaled to fit its part; on a narrow window, one under another. A terminal keeps its trial: when the lane's trial ends, it shows its last screen. With none at work: `No agent of this run is at work in its terminal now.`
- **Lines** (`?view=lines`): the stream of lines, with its filters, as below. A filter's link opens Lines.
- **Advisors** (`?view=advisors`): the advisors' terminals while they work on the run, each marked `(advisor)`.

A run on a rig that runs its programs headless, an earlier run, and a run with no agent in a terminal open on Lines.

| Part | What it shows |
| --- | --- |
| The list of runs, on the left | **At work**: each running run, with its rig, its mode, how many of its lanes work, and how many decisions wait for you. **Idle rigs**: rigs with no run at work. **Ended in the last day**: runs that paused or finished lately. On a narrow screen, **☰** shows and hides it |
| The header | The run, its state, its rig, its round and its progress, **Open the run**, and, while it runs, **Pause** and **⋯** (with **Restart the lanes**), or **Resume** for a paused run |
| The filters | **Everyone**, each lane (a green dot while it works; a lane that starts while the page is open gets one too), **Planner**, **Judge** (not in a research run), **Advisors** and **You**: your messages and who read them |
| **📌 &lt;n&gt; kept** | Your messages kept in force, each with **Remove** |
| **↓ Follow** | On: the stream scrolls to each new line |
| The stream | The lines of the filter chosen: the agents' text, thinking, tool calls with their results, status lines, your messages and the advisors' answers. Empty: `No live lines yet. They appear here as the run's agents and judge work.` |
| The message box | **To** (everyone working, a lane, the planner, the advisors or one of them), the message, **📌** to keep it in force, and **Send**. A recipient that would read nothing is greyed out, with why. An earlier run says `This is an earlier run (…): its agents take no more messages.`, and a finished one `This run has finished: its agents take no more messages.` |

With no run at work, the page says `No run is at work. Pick one from the list to see its lines.`, or `No run to watch yet. Runs show here as soon as a rig reports one.` when there is none. [Steer a run](../how-to/campaigns/steer-a-run.md#send-the-agents-a-message) says when each agent reads a message.

## A rig's sessions

**Live** on a rig's page opens `/ui/rigs/<rig>/live`: every session on the rig, over all its runs.

| Part | What it shows |
| --- | --- |
| **Sessions** | **Everything**, all sessions interleaved; then each source: the planner, the judge, the supervisor and each trial, with its task and how long ago it last did something. A trial says **working** while the rig has it at work, else **ended** |
| The head | For **Everything**: **Agents**, the program and model the rig's agents run in, and **Last activity**. For a trial: **Agent**, **Task**, **Started** and **Last activity** |
| The stream | The session's lines, with who wrote each under **Everything** |
| The foot | `To message an agent, open its run's Live:` and a link to each run on the rig that is not closed; `No run on this rig to message.` when there is none |

## A trial's terminal

A trial's page, `/ui/rigs/<rig>/live?source=trial:<trial>`, has the trial's terminal at its top, above the head. A worker in Pi's terminal shows its Pi view, which Thermite draws of the worker's own session ([The Pi view](../explanation/agents-lanes-planner.md#the-pi-view)). [Watch and steer an agent in its terminal](../how-to/campaigns/agent-terminal.md) shows how to use it.

| Part | What it shows |
| --- | --- |
| The bar | Its name, and what the screen is: `Waiting for the rig to send its screen…`; `Live · click it and type` (a trial's) or `Live, read only`, and the screen's time; `Its last screen, kept when the trial ended` and its time; or `This trial has no terminal: its program runs headless, it has not started yet, or the rig restarted since it ended.`, and then no screen shows. While inputs wait for a usage window's reset, it adds how many, and while the program waits for its window, `it waits for its usage window`. **↓ Newest**, while you have scrolled back. The menu of your inputs (below) |
| `Enter held: …` | A line typed into a trial's terminal that starts with `!` or runs `/login`, `/logout`, `/config` or `/permissions`, whose Enter is held: a second Enter sends it |
| The screen | The program's screen at the size of the agent's terminal, drawn by xterm.js and scaled so all its columns and rows fit the pane, with the 300 lines above it to scroll back through; a new screen keeps your place. A trial's takes keys: click it and type, and each key goes to the program as you press it; each line is recorded at its Enter, as a `terminal_input` event with `command: "live"`. A link in it opens nothing |
| The usage window | Only while the trial waits for its usage window, which the program's log shows, or for a rate limit the model proxy saw, until the log shows the program at work again: `The program waits for its usage window to reset at <time> UTC.`, the time when the program or the proxy gave one. The trial waits in its terminal, with nothing typed into the program by the rig ([Limits and pacing](limits-and-pacing.md#the-model-provider)) |
| The field, **Send** and **Keys ▾** | One line under the screen, only for the planner's and an advisor's terminals, and a Pi view (a trial's terminal takes keys itself and has none): text for the program, up to 4,000 characters, typed in, then Enter, as a signed [`terminal_input`](signed-commands.md#terminal_input). **Keys ▾** opens **Enter**, **Esc**, **Tab**, **↑**, **↓**, **←**, **→**, **PgUp**, **PgDn** and **0** to **9**: each press sends that key |
| **Follow-up: give my words when the agent would stop (a reply that calls no tool), not before its next model call** | Only for a worker in Pi's view: ticked, the words go to the agent as a follow-up (`follow_up` in [`terminal_input`](signed-commands.md#terminal_input)). Under it, the view's commands: `The Pi view: words steer the agent; Esc stops its reply; its commands are /status, /compact, /mcp, /mcp reconnect [server] and /skill:NAME.` |
| **Send it: this line runs a shell command…** | Shows under the field only while its line starts with `!` or runs `/login`, `/logout`, `/config` or `/permissions`: such a line is sent only when it is ticked |
| Your inputs | A menu in the bar, such as **3 inputs ▾**: your 30 newest inputs to this terminal, newest first, each with its time and what became of it: `typed on Live`, `sent, waiting for the rig`, `typed`, `typed, as a follow-up`, `waits for the usage window's reset (<time> UTC)`, `typed after the usage window's reset`, `dropped: <why>`, `not typed: <why>` or `expired before the rig took it`. Before the first: `Nothing typed yet. Each input is a signed command, recorded word for word with what became of it.` |

The keys a trial's terminal takes go with the screens: control keeps them in memory until the rig's supervisor next asks which screens are watched, and hands them over with its answer; the supervisor gives them to the harness, which writes them to the program's terminal. While you type, control's answer asks the supervisor to come back within a fifth of a second, so the program's echo comes back quickly. Control takes keys only for a terminal a page watches, and at most 64 pieces of 4,096 characters wait for one rig.

Once the trial has ended, its terminal takes no more input.

## The planner's terminal

The planner's page, `/ui/rigs/<rig>/live?source=planner`, has its call's terminal at its top while the planner plans a round in its own terminal: Claude Code's, Codex's or OpenCode's, or, in Pi, its Pi view ([The Pi view](../explanation/agents-lanes-planner.md#the-pi-view)). It has the same parts as a trial's, for the call named `planner-<run>-<round>`. The rig's report lists the call while it runs (`work.terminals` in its summary), and the page shows the terminal from it; once the round's plan is in, the page shows none. The planner's stream shows its session, read from its program's log as a trial's is, or sent by its process in Pi: its text, its tools and their results, and your inputs' outcomes.

## An advisor's terminal

The supervisor's page, `/ui/rigs/<rig>/live?source=supervisor`, has an advisor's call's terminal at its top while the teachers, the auditor or a reviewer of the review panel works in its program's own terminal (Claude Code's, Codex's or OpenCode's), or in its own Pi view in Pi, in the supervisor: the call `call=<id>` names, such as `&call=advisor-auditor-matmul-1-4`, else the first that runs. It has the same parts as a trial's, for the call named `advisor-<advisor>-<run>-<n>`. The supervisor tells its harness which of its advisors' calls run in their terminals, so the rig's report lists them (`work.terminals`, with the advisor's name as `role`), and the page shows the terminal from it; once the advisor answers, the page shows none. Your input goes to the rig's harness, which checks and records it as for a trial's, then hands it to the supervisor, which types it into the advisor's program. An advisor in Pi's screen is its Pi view: the console then shows the view's commands and the **Follow-up** box, as for a worker in Pi, and the supervisor hands each input to the advisor's process as one call in its session. The supervisor's stream shows the advisor's session, each line with the advisor's name, and your inputs' outcomes.

### How the screen reaches the page

- The page tells control it watches the trial. Every 5 seconds the rig's supervisor asks control which of its trials are watched; while one is, it asks its harness for their screens, takes its own advisors' from its own consoles, and sends them to control, every second, and every fifth of a second while you type into one. A running trial's screen comes with the 300 lines above it. Nobody watching, no screen leaves the rig.
- The screens go on the message bus as a request with its one answer, on the rig's own subject (`thermite.rig.<rig>.ask.screens`): no stream keeps them, where the bus's `LIVE` stream would keep them on disk for an hour ([A rig's asks](../explanation/how-the-parts-talk.md#a-rigs-asks-on-the-message-bus)). A rig off the bus sends none. Control keeps the newest screen of each watched trial in memory, and lets it go when the last page watching it closes. No screen is written down anywhere: not in the rig's ledger, its exports or control's records.
- At most 4 of a rig's terminals, its trials', its planner's and its advisors', are watched at once. A page for a fifth says `4 of <rig>'s terminals are watched already: close one of their pages, then load this one again.`
- A trial's last screen is the one the harness kept just before it ended the program, with up to 500 lines above it, at most 262,144 characters; a worker in Pi's is the one its view showed as the trial ended, kept when the worker said it was ending. The harness keeps those of its 20 most recently ended trials and planner's calls, and the supervisor those of its 20 most recently ended advisors' calls, in memory.
- The screen is what the agent's program drew, as untrusted as anything the agent prints: nothing decides from it.
