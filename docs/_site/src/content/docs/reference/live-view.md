---
title: "The Live view"
description: "Every part of the dashboard's Live view: a run's stream with its filters and message box, a rig's sessions, and a trial's terminal with the owner's console."
type: reference
sidebar:
  order: 23
---

**Live** shows what a run's agents, its judge and its advisors do as they work. It is a view, never a record: what happened is in the rig's signed events, and the run's page reads those. Control pushes each new line to the page as it gets it from the message bus, where the rig's supervisor publishes it, so the page needs no reload. Only the owner signs in to the dashboard, so only the owner sees Live; the reader's token gets the same lines over REST, `GET /v1/rigs/<rig>/live`, but never a terminal.

The rig masks its own credentials in each line before the line leaves it, wherever an agent printed them: a trial's token, the model proxy's and the MCP gateway's show as `trial.***`, `proxy.***` and `mcp.***`, and the value of any `THERMITE_*_AUTH` setting as `***`. Each line is masked before it is cut to 8,000 characters ([Limits and pacing](limits-and-pacing.md#the-rig-and-control)).

Live has three pages: one run at a time, a rig's sessions, and one trial's session, which has the trial's terminal.

## One run at a time

**Live** in the sidebar opens `/ui/live`, which shows the first run at work. A run's own Live is at `/ui/campaigns/<campaign>/runs/<run>/live`, and **Live** in a run's header opens it.

| Part | What it shows |
| --- | --- |
| The list of runs, on the left | **At work**: each running run, with its rig, its mode, how many of its lanes work, and how many decisions wait for you. **Idle rigs**: rigs with no run at work. **Ended in the last day**: runs that paused or finished lately. On a narrow screen, **☰** shows and hides it |
| The header | The run, its state, its rig, its round and its progress, **Open the run**, and, while it runs, **Pause** and **⋯** (with **Restart the lanes**), or **Resume** for a paused run |
| The filters | **Everyone**, each lane (a green dot while it works; a lane that starts while the page is open gets one too), **Planner**, **Judge** (not in a research run), **Advisors** and **You**: your messages and who read them |
| **⌨ Terminals** | While the run is running on a rig that runs its agent programs in their own terminal, each lane at work, with its direction: `lane-1's terminal` opens that trial's page, with its [terminal](#a-trials-terminal) |
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
| **Terminal** | The section, open; press it to fold it away. Beside it, what the screen is: `Waiting for the rig to send its screen…`; `Live, read only` and the screen's time; `Its last screen, kept when the trial ended` and its time; or `This trial has no terminal: its program runs headless, it has not started yet, or the rig restarted since it ended.`, and then neither the screen nor the console shows. While inputs wait for a usage window's reset, it adds how many |
| The screen | The program's screen at the size of the agent's terminal, drawn by xterm.js, with its scrollback. Read only: a key pressed on it goes nowhere, and a link in it opens nothing |
| The usage window | Only while the trial waits for its usage window, which the program's log shows, or for a rate limit the model proxy saw, until the log shows the program at work again: `The program waits for its usage window to reset at <time> UTC.`, the time when the program or the proxy gave one, and the choice for the next input: **waits for the reset** (the default) or **goes in now (the program may start its wait again)**. The trial waits in its terminal, with nothing typed into the program by the rig ([Limits and pacing](limits-and-pacing.md#the-model-provider)) |
| The field and **Send** | Text for the program, up to 4,000 characters: typed in, then Enter |
| **Follow-up: give my words when the agent would stop (a reply that calls no tool), not before its next model call** | Only for a worker in Pi's view: ticked, the words go to the agent as a follow-up (`follow_up` in [`terminal_input`](signed-commands.md#terminal_input)). Under it, the view's commands: `The Pi view: words steer the agent; Esc stops its reply; its commands are /status, /compact, /mcp, /mcp reconnect [server] and /skill:NAME.` |
| **Confirm an input that starts with !…** | Shown while the text starts with `!` or runs `/login`, `/logout`, `/config` or `/permissions`: such text is sent only when it is ticked |
| The keys | **Enter**, **Esc**, **Tab**, **↑**, **↓**, **←**, **→**, **PgUp**, **PgDn** and **0** to **9**: each press sends that key |
| Your inputs | Your 30 newest inputs to this trial, newest first, each with its time and what became of it: `sent, waiting for the rig`, `typed`, `typed, as a follow-up`, `waits for the usage window's reset (<time> UTC)`, `typed after the usage window's reset`, `dropped: <why>`, `not typed: <why>` or `expired before the rig took it`. Before the first: `Nothing typed yet. Each input is a signed command, recorded word for word with what became of it.` |

Once the trial has ended, the console says `The trial has ended: its terminal takes no more input.`

### How the screen reaches the page

- The page tells control it watches the trial. Every 5 seconds the rig's supervisor asks control which of its trials are watched; while one is, it asks its harness for their screens, and sends them to control, every second. Nobody watching, no screen leaves the rig.
- The screens go on the message bus as a request with its one answer, on the rig's own subject (`thermite.rig.<rig>.ask.screens`): no stream keeps them, where the bus's `LIVE` stream would keep them on disk for an hour ([A rig's asks](../explanation/how-the-parts-talk.md#a-rigs-asks-on-the-message-bus)). A rig off the bus sends none. Control keeps the newest screen of each watched trial in memory, and lets it go when the last page watching it closes. No screen is written down anywhere: not in the rig's ledger, its exports or control's records.
- At most 4 of a rig's trials are watched at once. A page for a fifth says `4 of <rig>'s terminals are watched already: close one of their pages, then load this one again.`
- A trial's last screen is the one the harness kept just before it ended the program, with up to 500 lines above it, at most 262,144 characters; a worker in Pi's is the one its view showed as the trial ended, kept when the worker said it was ending. The harness keeps those of its 20 most recently ended trials, in memory.
- The screen is what the agent's program drew, as untrusted as anything the agent prints: nothing decides from it.
