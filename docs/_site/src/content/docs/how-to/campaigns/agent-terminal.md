---
title: "Watch and steer an agent in its terminal"
description: "Open a trial's terminal on Live, watch its agent program's screen as it works, and type into it: words, a slash command, a skill or a key."
type: how-to
sidebar:
  order: 18
---

A worker in Claude Code, Codex or OpenCode works in that program's own terminal, as a person would use it, when its rig runs its agent programs in their own terminal ([Agents in their own terminal](../../explanation/agents-lanes-planner.md#agents-in-their-own-terminal)). A worker in Pi draws Thermite's Pi view there instead ([The Pi view](../../explanation/agents-lanes-planner.md#the-pi-view)). You can watch that terminal from the dashboard and type into it: words for the agent, a slash command such as `/compact`, a skill, or a key for one of the program's menus. Each input is a signed command, [`terminal_input`](../../reference/signed-commands.md#terminal_input), that only you can send, and the rig records it word for word with what became of it.

To tell the agents something without typing into a program, send a message instead: every agent reads one ([Send the agents a message](steer-a-run.md#send-the-agents-a-message)).

## What you need

- The dashboard, signed in as the owner. No other token sees an agent's terminal or types into one: not the operator's, an agent's or the reader's.
- A run at work on a rig whose **Agent programs run** setting is **In their own terminal**, the default (**Edit rig**, under **Advanced** in **2 · The agents**). Its workers may be in Claude Code, Codex, OpenCode or Pi. A trial that started while the rig ran its programs **Headless** has no terminal.

## 1. Open the trial's terminal

1. Open **Live** in the sidebar, and choose the run in the list on the left.
2. Press **⌨ Terminals**, above the stream, and choose the lane, such as `lane-1's terminal`.

   You can also open the rig's page, press **Live**, and choose the trial under **Sessions**.

The trial's page opens, at `/ui/rigs/<rig>/live?source=trial:<trial>`. At its top, **Terminal** says `Waiting for the rig to send its screen…`, then shows the program's screen, at the size of the agent's terminal, with `Live, read only` and the time of the screen beside **Terminal**. The screen follows the program about once a second: the rig's supervisor sends it to control on the message bus while a page watches the trial, and no screen is kept ([Live view](../../reference/live-view.md#a-trials-terminal)). It is only a view: a key you press on it goes nowhere, and a link in it opens nothing.

## 2. Type into it

1. Write in the field under the screen: words, a slash command such as `/compact` or `/mcp`, or a skill's command.
2. Press **Send**, or Enter.

The rig types the text into the program, then presses Enter there, as you would. A line that starts with `!` runs a shell command in Claude Code and Codex, and `/login`, `/logout`, `/config` and `/permissions` change the program's sign-in or settings: for these, tick **Confirm an input that starts with !…** under the field first, or the dashboard says `Not sent: Confirm it first: …`.

To answer one of the program's menus, press the keys under the field: **Enter**, **Esc**, **Tab**, the arrows, **PgUp**, **PgDn** and the digits. Each press is one input. There is no Ctrl+C: to stop the agent, [stop its trial](decide-what-waits.md#stuck-trials) or [pause the run](steer-a-run.md).

## 3. See what became of each input

Under the keys, the list of your inputs shows each one, newest first, with its outcome:

| It says | What happened |
| --- | --- |
| `sent, waiting for the rig` | Control signed it; the rig's report with its outcome has not reached control yet, which takes up to a minute by default |
| `typed` | The rig typed it into the program |
| `waits for the usage window's reset (14:00 UTC)` | The program waits for its usage window, and the input waits with it: see below |
| `typed after the usage window's reset` | It waited, and went in once the reset had come and the program was at work again |
| `dropped: the trial ended before the program's usage window reset` | It waited, and the trial ended first |
| `not typed: <why>` | The rig refused it, such as `trial <trial> has ended: nothing more goes into its terminal` |

The trial's stream says `the owner's input went into its terminal`, and the run's **History** tab records each input in words, such as `You typed “/compact” into lane-1's terminal (trial t-0123456789abcdef).`.

## A worker in Pi: the Pi view

A worker in Pi has no program of its own to type into: its screen is the Pi view, which Thermite draws of the worker's own session. Its first line says `Thermite's view of a worker in Pi`, with the trial, the lane and the model, and its last line is the status: `● at work`, `● the model is replying`, `◷ waiting for the provider until <time> UTC` or `■ the trial ended`, with the trial's turns, tool calls, tokens, compactions and time left. Under the field, the console then shows the view's commands and a **Follow-up** box. Nothing is typed into a terminal: each input is one call in the trial's own loop, and the view says what it did.

| You send | What the worker does |
| --- | --- |
| Words | Steers the agent: your words go into its conversation before its next model call, as a message from you |
| Words, with **Follow-up: give my words when the agent would stop…** ticked | Your words wait until the agent ends a reply that calls no tool, and go in then, instead of its stopping |
| **Esc** | Stops the agent's reply. A tool call under way finishes first. The trial goes on at once with your words that wait, or with its nudge to keep working: your stop is not the agent's, and counts as none of its nudges |
| `/compact` | Compacts the conversation before the agent's next model call, as the harness does near the model's window, kept and recorded the same way |
| `/mcp` | Shows the trial's MCP tools, server by server, and the servers that failed |
| `/mcp reconnect`, or `/mcp reconnect <server>` | Lists the tools of every server, or of one, again from the servers, and gives the agent the new list from its next turn |
| `/status` | Shows the trial's model, turns, tool calls, tokens, compactions and time left |
| `/skill:NAME` | Says `this run's kit carries no skills, so /skill:NAME has nothing to load`: kits carry no agent skills yet |

Anything else is refused, and the list says why: another key (`the Pi view takes one key, Esc, which interrupts the agent's reply: it has no menu for other keys`), a command the view has not, such as `/model` (`/model is not a command of the Pi view: …`), words after `/status` or `/compact`, a follow-up that is a command, Esc while no reply is under way (`the agent has no reply under way to stop: …`), and words after the trial submitted its change. A follow-up shows in the list as `typed, as a follow-up`. The usage window's choice does not apply: a worker in Pi waits for its provider in its own loop, and your words go in at its next model call after the wait.

## While the program waits for its usage window

When the program's own log shows that its usage window is full, the trial waits for the reset in the program's terminal, and the rig types nothing into it meanwhile: Claude Code waits and goes on by itself; Codex and OpenCode stop their turn, and the rig types the trial's continuation into them after the reset. The same holds while the rig waits out a rate limit that the model proxy saw. The console says `The program waits for its usage window to reset at 2026-10-30 14:00 UTC.`, with the time when the program or the proxy gave one, and offers a choice for your next input:

- **waits for the reset**, the default: the input goes in, in order with any others that wait, once the reset has come and the program is at work again. The list then says `typed after the usage window's reset`.
- **goes in now**: it is typed at once. The program may start its wait again, and an input that waits still waits for the reset.

An input still waiting when the trial ends is dropped, and the list says so. The trial ends without waiting when the reset is more than a day away (a weekly window), when it comes after the trial's own end, or when the program gives no time it resets: the rig types nothing of its own into a program whose screen may show a menu that waits for a key. [Use a Claude subscription](../models/claude-subscription.md#watch-the-usage-windows) and [Limits and pacing](../../reference/limits-and-pacing.md#the-model-provider) say more.

## After the trial ends

The page keeps the program's last screen, with the lines above it, and says `Its last screen, kept when the trial ended`. The console takes no more input. The rig's harness keeps the last screens of its 20 most recently ended trials, in memory only; after it restarts, the page says the trial has no terminal.

## How to tell that it worked

- Your input shows `typed` in the list under the console, and the program's screen shows what it did with it. In the Pi view, your words show as `owner ›`, then, once in the conversation, as `→ A message from the campaign's owner…`; a command's answer shows as a line of the view's own.
- `GET /v1/commands/<id>` with the owner's token, or MCP's `command_status`, gives the command's outcome, such as `"result": {"outcome": "typed"}`.

The same input goes over the REST API (`POST /v1/commands` with `"kind": "terminal_input"`) and MCP (`issue_command`), with the owner's token only. [Signed commands](../../reference/signed-commands.md#terminal_input) lists every field and refusal, and [The Live view](../../reference/live-view.md#a-trials-terminal) every part of the page.
