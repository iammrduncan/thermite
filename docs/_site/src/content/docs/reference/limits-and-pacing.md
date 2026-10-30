---
title: "Limits and pacing"
description: "Every limit Thermite has, its default, what it bounds and whether it ends anything. Nothing ends research unless you set it."
type: reference
sidebar:
  order: 15
---

**Nothing ends research by default.** A hill climb runs until someone pauses or closes it. A goal campaign runs until its goals are met or the evidence shows they are not possible (the owner decides that where the run asks). A research campaign runs until the review panel finds its questions answered or its `max_duration` is over, or, without either, until someone stops it. Every cap that can stop a campaign, and every cap on a trial, is off until you set it.

Thermite's limits are of four kinds. Only a cap can stop a run's work, and only one you set:

| Kind | What it does | What it ends |
| --- | --- | --- |
| [Caps](#caps) | Limits you set: budgets, a research window, turns per trial, spending and size limits | Only what that cap names, such as pausing a run when its budget is spent. None is set by default |
| [Pacing](#pacing) | Spaces work out: waits after errors, how often things repeat | Nothing. Work waits, then goes on |
| [Back-pressure](#back-pressure) | Holds new work until earlier work settles | Nothing. Work waits, then goes on |
| [Per-process and per-trial limits](#per-process-and-per-trial-limits) | Bound one build, run, command, check or trial | That one process or trial. The lane goes on |

[The owner's messages](#the-owners-messages) lists how many messages and answers an agent gets, [The experiment queue](#the-experiment-queue) the sizes of a run's queue, [Field notes and the knowledge base](#field-notes-and-the-knowledge-base) the sizes of notes, briefings and searches, and [Control's own limits](#controls-own-limits) cover commands, requests and lists. [Why Thermite runs until the job is done](../explanation/runs-until-done.md) explains this design, and [Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md) shows how to set a cap. The [glossary](glossary.md) explains the terms.

## Caps

| Cap | Set in | Default | When it is reached |
| --- | --- | --- | --- |
| `budget.wall_hours` | The [contract](contract.md) | None | No new trial starts. Once the running trial ends, the run is paused: `the wall-time budget is spent`. Counted from the run's creation, paused time included |
| `budget.device_hours` | The contract | None | The same, when the judge's time on the run reaches it: `the device-hours budget is spent` |
| `budget.llm_usd` | The contract | None | The same, when the agents' token spending reaches it: `the model budget is spent ($<amount>)`. It counts only when the rig sets both `THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT` (prices per million tokens). A trial in OpenCode or Codex counts the tokens the provider's answers reported as the model proxy saw them; a trial in Pi or Claude Code, the tokens it reports |
| `max_duration` | A research contract | None | The research campaign closes after `max_duration` of running time, its questions answered or not: `the research window is over`. Paused time does not count, and neither does time its agents could not run: while they were [stopped](#the-model-provider), waited for the provider's rate limit, or waited for the run's MCP servers before its first plan or trial, or while the rig drained before an image update, when no trial or plan could start. Without it, the campaign runs until the review panel finds its questions answered, or until someone stops it. `min_duration` (required) is a floor, never a stop: it is what a worker's brief calls "at least". Other modes ignore both |
| `max_usd_per_day` | The [advisors file](advisors-file.md) | None | The advisors skip their work until the next day (UTC), and a message to the teachers starts no round until then. Research goes on. It counts only advisors with prices set |
| `THERMITE_RESEARCH_MAX_MB` | The harness's settings | None | A run's fetches are refused, in any mode: `the corpus is full (<n> MiB archived)`. Its other tools go on |
| Turns per trial (`max_turns`) | **Edit rig** (or its twins, `POST /v1/rigs/<rig>/settings` and MCP's `set_rig_settings`), or `THERMITE_MAX_TURNS` | None | One trial ends after that many model replies. The Codex CLI does not report its replies, so in Codex each message and each tool call counts as one. A code trial's brief gives the cap: `This trial lasts at most 40 turns (each model reply is one). Submit before it ends.` A code trial that reaches it ends with `the trial reached its limit of 40 turns before a submission`, and a research trial in OpenCode with `the trial reached its limit of 40 turns`. The lane's next trial starts afresh |
| A trial's length | A `trial_minutes` rule on the run ([Steer a run](../how-to/campaigns/steer-a-run.md#steer-from-the-command-line)), else the contract's `lanes.limits.trial_minutes` (1 to 1,440), else **Edit rig** › **One trial lasts (minutes)** (`trial_minutes` over REST and MCP), or `THERMITE_TRIAL_MINUTES` | None | One trial ends at that time. The worker's brief gives the time it ends, in UTC: `This trial lasts 120 minutes, to 20:38 UTC.` A Pi worker's tool results give the time left from 75% of it, and the worker is told when 85% of it is used ([Trials and lanes](#trials-and-lanes)). A Pi worker's command stops before the trial's end ([Lanes and agents](#lanes-and-agents)). At the end, a Pi worker's tool that still runs answers at once, the harness stops what the lane still runs, and the trial ends as `wall`, with its notes. Without it, a trial lasts until its worker submits, or stops and answers a nudge without any work. The lane's next trial starts afresh |
| Failed model calls in a row (`failures_in_a_row`) | The contract's `lanes.limits` | None | One trial ends after that many failed model calls in a row: a provider's 5xx, a broken connection, a stream that went silent or a request it refused. A rate limit's waits never count. The lane's next trial starts afresh |
| Replies cut off in a row (`cutoffs_in_a_row`) | The contract's `lanes.limits` | None | One trial ends after that many replies in a row cut off at the output limit without a tool call (Pi) |
| Field notes from one reply (`notes_per_turn`) | The contract's `lanes.limits` | None | A Pi worker's note past that many in one model reply is not recorded, and its answer says so. The trial goes on, and the next reply counts from 0. OpenCode, Claude Code and Codex are not counted |
| Nudges (`nudges`) | The contract's `lanes.limits` | None | A worker that stops without submitting is told to go on at most that many times; then its trial ends. `0`: never. Without it, the worker is told for as long as it keeps working |
| A RunPod test's stop time (`stop_after_minutes`) | **End it after (minutes)** on the test pod form, REST or MCP | None | The test pod is removed. At least 5 minutes. A test spends money: see [Test a GPU on RunPod](../how-to/install/runpod-test.md) |
| A RunPod rig's spend limit (`spend_limit_usd`) | **Launch on RunPod**, or **Change the spend limit or the idle stop** on the rig's page; or the launch and the rig's limits over REST, MCP or the command line | None | Control stops the pod, its results sent out first: its runs are paused, its GPU is no longer billed and its volume stays. A start is refused until the limit is raised or cleared. See [Rigs on a GPU cloud](rest-api.md#rigs-on-a-gpu-cloud) |
| A RunPod rig's idle stop (`idle_stop_minutes`) | The same | None | When no run has been at work on the rig for that many minutes (no run running, or every run paused, blocked or finished), control stops the pod as for the spend limit. At least 5 minutes. Assigning or resuming a run starts the pod again. The dashboard's launch form fills in 30 minutes, which the owner can change or clear; the REST API, MCP and the command line have no default. See [When a rig is idle](rest-api.md#when-a-rig-is-idle) |

- **A paused run waits.** The judge works only on running runs, so a paused run's queued judge jobs stay queued until it is resumed.
- **Contract budgets apply only to runs with agents and a model.** A judge-only run has no trials to stop.
- **A spent budget stays spent.** A resumed run whose budget is spent is paused again.

## Pacing

None of these ends research.

### Trials and lanes

| What | Default | Set by |
| --- | --- | --- |
| Trials at the same time on a rig | 1 | **Edit rig** › **Workers at a time** (1 to 16; `lanes` over REST and MCP), or `THERMITE_MAX_TRIALS` (0 to 16; 0: the rig starts no trials) |
| Lanes planned per epoch | 2 | The contract's `lanes.count` (1 to 16). A redirect's `lane_count` can lower it |
| Trials per lane per epoch | 3, at most: a lane still on a long trial doesn't hold the epoch, and joins the next | The contract's `lanes.trials_per_epoch` |
| Reminders to a Pi worker | From 75% of the trial's time, each tool result ends with the time left: `About 18 minutes are left in this trial.` When 85% of it is used, and 10 turns before a turn cap, when those [caps](#caps) are set: submit the best working change now, and, in a trial that measures rather than changes the code, record the numbers as notes before another measurement. None about the context window: a conversation that grows is compacted (below) | Fixed |
| Compaction of an agent's conversation | At 80% of the model's [context window](glossary.md). The conversation is kept as a document, summarized, and the agent goes on. It never ends a trial and never asks for a submission | **Compact at** in each agent's **Context** cell on **Edit rig**; `compact_at` (50 to 95) with each agent's model, over [`set_rig_model`](mcp-tools.md#set_rig_model) or [`POST /v1/rigs/<rig>/model`](rest-api.md#the-agents-model); the campaign's own `agents_context.compact_at`; or `THERMITE_MODEL_COMPACT_AT`. See [Compaction](#compaction) |
| Nudges when a worker stops without submitting | No number: the worker is told to go on for as long as it keeps working (a tool call since the last nudge). A nudge it answers without any work ends the trial: its own choice, not a cap. An OpenCode, Claude Code or Codex worker is also continued while the owner's messages wait for its trial and its last run made progress | The contract's `lanes.limits.nudges` sets a number (Pi, OpenCode, Claude Code and Codex) |
| Time to finish after a submission | 5 s after the submission is recorded, the lane's agent is stopped. Its closing reply is not waited for, and a note or idea it has not written by then is not recorded | Fixed (OpenCode, Claude Code and Codex; Pi stops at once: no tool call runs after its submission) |
| A failed model call in a trial | By the provider's error: see [The model provider](#the-model-provider). A full context is compacted, and the trial goes on | |
| A reply cut off at the output limit (Pi) | The worker is told to think less and make one tool call, and the trial goes on | `lanes.limits.cutoffs_in_a_row` sets a [cap](#caps) |
| A lane's wait after unproductive trials | 15 s, doubling for each one in a row, at most 10 minutes. Unproductive: an error, no submission, or an attempt that is `rejected_v0` or `duplicate` (research: an error) | Fixed |
| A full subscription usage window | Claude: no new trial or plan of the run until the window resets, at most one trial's length at a time (below). ChatGPT: 15 minutes, then try again | Fixed. Nothing buys more usage |
| A run's MCP servers, before its first plan or trial | No plan or trial starts until the rig holds every [MCP server](../how-to/campaigns/give-agents-mcp-tools.md#before-the-first-trial) the kit gives the workers or the planner, for up to 2 minutes; a server control says it can't give is not waited for. Then the run goes on without those still missing, and **Live** and **History** (`mcp_servers_wait`) say which and why. Again after a restart of the harness. A research run's clock does not count it | Fixed |

### The model provider

The provider decides when the agents can work. Each error a model call gets is sorted by its kind, from the provider's status, headers and words, and none of them ends research:

| The provider's error | What happens |
| --- | --- |
| A rate limit (429, `rate limit`, `RESOURCE_EXHAUSTED`, a full ChatGPT plan) | The trial waits for the time the provider gives: its `Retry-After` header, a rate-limit reset header (`x-ratelimit-reset-*`, `anthropic-ratelimit-*-reset`), or its words (`try again in 20s`). Without one: 15 minutes for a full ChatGPT plan, whose reset OpenAI does not give, and otherwise 30 s, doubling to 10 minutes. It then goes on in the same conversation. No new trial or plan of the run starts until that time (`agents_wait_for_limit`), and a research run's clock stops meanwhile. The rig's other runs go on. A wait holds the run for at most one trial's length from when it is asked: the run's trial length, else the rig's (`THERMITE_TRIAL_MINUTES`), else 24 hours, the longest a trial may be set to. A limit still in force then shows again in the next trial, and the run waits again. The owner, or the operator's token, can end a wait early: **Resume now** on the run's page, or [`end_wait`](signed-commands.md#end_wait) (`agents_wait_ended`). A 429 in a quota's words (`exceeded your current quota`) is a rate limit when it says `RESOURCE_EXHAUSTED` or gives a time to try again in its headers |
| A passing fault (a 5xx, an overloaded server, a broken connection) | The trial waits 5 s, doubling to 60 s, and goes on in the same conversation |
| A stream that goes silent: no data for 600 s (`THERMITE_MODEL_STALL_SECONDS`), while the call waits for its answer or for the answer's next part | The call is broken off and is a passing fault, as above: **Live** says `the model's stream went silent for 600 s: retried at 16:40:35 UTC, in the same conversation.` Keep-alive comment lines (`: OPENROUTER PROCESSING`) and pings are not data, so a gateway that keeps a connection open while its model sends nothing is caught too. Only the time spent waiting for the provider counts, and a call that keeps sending data is never cut, however long it lasts: this detects a silent connection, it is not a cap. Through the model proxy (OpenCode, Codex), a call with no answer yet gets a 504 with those words, and one under way has its connection broken off. A planner's call ends as the provider's error and is tried again; an advisor's call fails as for any passing fault. Claude Code on a subscription reaches Anthropic directly and is not watched. [`THERMITE_MODEL_STALL_SECONDS`](settings.md#the-rigs-own-model) sets another time; `0` turns it off |
| The model's own error (a request the provider refused) | The same: the worker is told the call failed, and goes on |
| Passing faults (silent streams among them) or the model's own errors with no call that worked for 30 minutes | The trial ends, and the run's agents stop as for no credits (below), with the newest error's words: **Needs you** says `The model's calls keep failing: no model call worked for 30 minutes (the provider failed for now)`, or `(the provider refused the request)` for the model's own errors. A rate limit between the failures does not start the count again; a call that worked does. The count goes on over the run's trials when each ends at its own time limit while its calls fail; a restart of the harness starts it again. When a model check passes, the agents go on, and that trial's lane starts a fresh trial, which also leaves behind a conversation the provider kept refusing. The 30 minutes are pacing, so that a failure that never clears shows in **Needs you**: they are not a cap, and nothing is set to change them |
| A conversation longer than the model's window | It is [compacted](#compaction), and the trial goes on |
| No credits (402, `insufficient credits`, OpenAI's `insufficient_quota`, or `exceeded your current quota` with nothing that marks a rate limit), a refused key (401, 403) or a model the provider does not serve on this key | The trial ends at once. The run's agents stop (`agents_stopped`): no new trial or plan starts, and the run shows in **Needs you** with the provider's words. The model is checked again after a minute, then after a pause that doubles to 30 minutes; at once when the owner resumes the run or presses **Check the model now**. A passing check, or another model for the rig, ends the stop (`agents_resumed`). A research run's clock stops meanwhile |
| The workers' model check fails | The same as no credits: no trial starts on a model that fails its check, until a check passes or the route changes |

- **Pi, OpenCode, Claude Code and Codex** answer the same way. OpenCode, Claude Code and Codex go on in the same session after a wait; the harness's model proxy tells their errors' kinds from the provider's answers.
- **Only the provider's own answers are sorted.** An error counts as the provider's only when it came from a call to the provider: Pi's model call, or a model call that OpenCode, Claude Code or Codex reports as failed, read with the error answer the model proxy saw. For OpenCode and Codex, whose calls go through the model proxy, no credits, a refused key and an unserved model come only from the provider's answer the proxy saw: a program's words alone never stop the agents, and count as the model's own error. A trial that failed on its own (a workspace that could not be set up, a worker process that gave no result, a program that exited) never stops the agents or makes them wait, whatever its words, such as `permission denied` or `timed out`. It tried its experiment, with how it ended as the cause.
- **A trial that never really tried its experiment** (it ended on the provider's error, or it was interrupted by a pause, a reset or a restart, before it submitted a change) gives the experiment back: the same row goes to the top of the [queue](glossary.md), with how many times and why (`experiment_returned`). It is the next one given out when the agents go on.
- **A trial interrupted by a restart** keeps the turns and tokens its worker last reported.

### Compaction

Near the model's [context window](glossary.md), an agent's conversation is compacted, and the agent goes on. Compaction is pacing, not a cap: it never ends a trial, and no agent is told to submit because its conversation grew. It applies to every agent: the workers, the planner and the advisors.

| What | Value |
| --- | --- |
| The window | The window the agent's route carries: the provider's window, or the owner's cap on that agent's model when that is lower. A campaign's own `agents_context.context_window` lowers it further: the lower wins |
| The compaction point | 80% of the window. `compact_at` sets it, from 50 to 95 percent, for each agent with its model; a campaign's own `agents_context.compact_at` replaces it for the campaign's runs |
| Why 80% | The summary is asked of the same model, with the conversation as its input. A fifth of the window is left for that call's answer and for the next reply |
| Before each compaction | The whole conversation is kept as Markdown, whichever program the agent runs in. A worker's and the planner's: in the run's research folder, `compactions/<trial>-<n>.md` for a trial, `compactions/planner-<id>-<n>.md` for a planner call; every agent of the run may read it, and none may change it. An advisor's: with the supervisor's records of the advisors' rounds, below. The summary names the file |
| What records it | A worker's or the planner's: a `context_compacted` event, in **History**; lines with the summary in the run's **Live** view, under the lane's filter or **Planner**; a document of the run on **Knowledge** with the kept conversation, cut to 20,000 characters; a trial's count of compactions in `trial_finished`. An advisor's: lines in the run's **Live** view, with the summary, and the round's record in the supervisor |

Who sets each agent's window and point:

| Agent | Its window and point | Where they come from |
| --- | --- | --- |
| Workers | The workers' model on **Edit rig**, or the rig's own settings | The workers' **Context** cell on **Edit rig**, or `context_window` and `compact_at` with the workers' model over MCP or REST, or `THERMITE_MODEL_CONTEXT_WINDOW` and `THERMITE_MODEL_COMPACT_AT` |
| Planner | Its own model, when it has one; else the workers' | The planner's **Context** cell on **Edit rig**, or `context_window` and `compact_at` with the planner's model |
| Teachers (each of their one or two models, and their merged by model), auditor, review panel | Each one's own model, when control gives it one; else the [advisors file](advisors-file.md)'s | The line's **Context** cell on **Edit rig**, or `context_window` and `compact_at` with the advisor's model, or the file's `context_window` and `compact_at` |
| All of a campaign's runs | The campaign's own, over each agent's | The contract's [`agents_context`](contract.md#agents-context): **Agents' context** on the campaign's page, on **New campaign** and in the **Copy** panel; `set_campaign_context`, `POST /v1/campaigns/<campaign>/context`, `thermite campaign context` |

Each harness compacts in its own way. Thermite sets what each one takes:

| Harness | Who compacts | The window Thermite sets | The point Thermite sets | The tokens recorded |
| --- | --- | --- | --- | --- |
| Pi (code and research workers, the planner, and the advisors that run in Pi) | Thermite, before the next model call, once the conversation reaches the point, or (a worker) when the provider says the context is full | None to set: Pi uses the route's window | The share, from `compact_at` | Before and after |
| OpenCode v2 (workers, the planner, and advisors) | OpenCode (`compaction.auto`) | `limit.context` of the rig's provider's model | `compaction.buffer`: the window less the point | None: OpenCode does not say them |
| Codex CLI (workers, the planner, and advisors) | Codex, always | `model_context_window`. Codex keeps it within what the model takes: 272,000 tokens for a model it does not know | `model_auto_compact_token_limit`. Codex compacts at the lower of it and 90% of the window | None: Codex does not say them |
| Claude Code (workers, the planner, and advisors) | Claude Code (on by default) | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Claude Code takes 100,000 to 1,000,000 tokens: a smaller window counts as 100,000 | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: a percent of Claude Code's window less the room it keeps for a reply (up to 20,000 tokens). It can only make Claude Code compact earlier than its own point | Before and after (an advisor's: before) |

How the conversation is kept, and how the summary is told to name it, with what each program offers:

| Harness | Before the compaction | After it |
| --- | --- | --- |
| Pi | Thermite keeps the conversation, then asks the same model for the summary, which names the file | Thermite records the compaction |
| OpenCode v2 | Thermite's plugin, which OpenCode loads from its own settings (`~/.config/opencode/plugins/thermite.js`, a link Thermite makes), keeps the session's messages in OpenCode's `compaction` hook and adds a line naming the file to the compaction's request: `Thermite keeps the whole conversation before this compaction in <path>. Name that file in your summary, …` | When OpenCode says the compaction ended, Thermite makes the kept messages Markdown, keeps them and records the compaction with OpenCode's summary. OpenCode's own JSON output does not report compactions; the plugin's record does |
| Codex CLI | Codex's compaction prompt (`compact_prompt`) is Thermite's own summary prompt, which names the folder and the file names. Codex reads it when it starts, so it names the newest `<trial>-<number>.md` in the folder | After the warning Codex gives for each compaction, Thermite reads Codex's own record of the thread (its rollout, under `$CODEX_HOME/sessions/`) up to that compaction, makes it Markdown, keeps it and records the compaction with Codex's summary |
| Claude Code | A PreCompact hook in Thermite's settings for the run (`--settings`, read whatever `--setting-sources` says) copies Claude Code's transcript and adds the same line to the compaction's instructions. Claude Code writes its transcript every 100 ms and not before the hook, so the hook first waits, up to 5 seconds, until the file has stopped growing: the copy holds the newest lines too, the last tool result among them. The hook is Thermite's own program, run by Node without a shell | A PostCompact hook, the same program, keeps the summary. When Claude Code reports the compaction, Thermite makes the copy Markdown, keeps it and records the compaction with the summary. Claude Code keeps its transcript readable by the agent's own user only, so the hooks' copies are what Thermite reads |

- **The hook and the plugin** run as the agent's own user, under the agent's limits. For a compaction, they read only the agent's own conversation, write only in a folder of the agent's own area (`claude-compactions/` or `opencode-compactions/` beside the workspace), and reach no network. In a trial, the plugin also writes OpenCode's events to the trial's signals file and asks the harness for the owner's messages, with the trial's token ([How the parts fit together](../explanation/how-it-fits-together.md#the-owners-messages)). Thermite's own code reads what they wrote, as plain files and never through a link, and keeps it where the agents read it.
- **Claude Code, with the window Thermite sets,** keeps the newest round of the conversation (its last reply and the tool results after it) whole, and summarizes the rounds before it. A conversation that has crossed the point in its first round is compacted only once it has a second, or when it reaches Claude Code's own limit near the window.
- **Where a program's own conversation cannot be read** (its hook or plugin did not run, or its files are not there), Thermite keeps the conversation as it saw it instead: every line the trial's **Live** view showed, until the compaction. The document's title says `as Thermite saw it`.
- **A planner call through OpenCode, Codex or Claude Code** keeps its compactions the same way, each call in a file of its own, `compactions/planner-<id>-<n>.md`. They are kept and recorded when the call ends. The summary names the file; the planner is not told to read it.

- **In Pi**, the conversation becomes the system prompt, the brief, one message with the summary and the kept conversation's path, and the most recent turns that fit: at most 6, within a quarter of the window. A tool call keeps its result. The summary is the same model's answer to a fixed prompt: the task, what was tried and measured, the state of the files, what failed and why, and what is next.
- **If the summary call fails**, the bodies of the oldest tool results are left out instead, each with a one-line stub, until the conversation is at most half the window.
- **Only a conversation that the provider says is full, and that cannot fit the window even compacted,** ends a trial, as `context`, with the reason in words: for example, a brief larger than the window. So does a context the provider calls full again right after two compactions in a row. Thermite's own token counts are estimates: they alone never end a trial.
- **A worker whose model's window is unknown** (`0`) is compacted only when the provider says the context is full. The planner and an advisor in Pi with no window are not compacted.
- **OpenCode's own models** keep the window and the compaction point OpenCode knows for them.
- **A Pi planner call** has no file tool: its summary names where the run keeps the conversation, for the owner.
- **An advisor's call in Pi** (a teacher's review, the merged by model's set, an audit, a review by a reviewer of the review panel) compacts as the planner's does: what its tools return, such as past research and the kit's MCP tools, can fill its window. The supervisor keeps the conversation before each compaction in its own home, beside its record of the round: `advisors/compactions/<run>/<call>-<advisor>-<n>.md`, and the round's record (`advisors/<time>-<kind>.json`) lists the compactions. It does not go in the run's research folder: an advisor's conversation can hold what an outside knowledge base or a fetched page said, which the run's workers must not read. The advisor's summary names where it is kept, and the run's **Live** view has a line: `advisor <name>: its conversation was compacted (compaction <n>) at about <tokens> tokens, down to about <tokens>. It goes on. …`
- **An advisor's call in Claude Code, Codex or OpenCode** compacts in that program, with the same hook, compaction prompt or plugin as the workers. The summary names the file with the supervisor's records: `advisors/compactions/<run>/<call>-<advisor>-<n>.md (the supervisor's records)`. When the call ends, the supervisor keeps each compaction's conversation there, lists it in the round's record, and the run's **Live** view has `advisor <name>: its conversation was compacted by Claude Code (compaction <n>) …` (or Codex, or OpenCode), then the summary. For an advisor in Codex, Codex keeps its session in the call's own folder, which is removed after the call.
- **An advisor's package** (the teachers' brief, an audit's package, a review's package) is cut to fit the advisor's window before the call: at most the compaction point less 30% of the window, at about 3.5 characters a token (half the window at the default point), and never more than before (120,000 characters for a brief, 200,000 for an audit or a review). The owner's messages are never cut. When the window cuts it, the advisor's input says so on the line after its heading: `[Cut to fit the window: <n> of <m> characters.]`. The merged by model's brief is cut to what its window leaves beside the two reviews. A command-line advisor's window is unknown: its package is not cut to fit.
- **A worker's or a planner's first message** is cut to fit its model's window by the same rule: at most the compaction point less 30% of the window, at about 3.5 characters a token. The owner's messages, the role's own text and the trial's limits are never cut. A worker's largest parts of the run (the campaign's brief, field notes and past research, the judge's findings) are cut first, each to no less than 400 characters and each ending `[Cut to fit the model's window: <n> of <m> characters.]`, and a last part, `# Cut to fit the model's window`, says which were cut and that the campaign's brief is whole in `BRIEF.md` in the run's folder. The planner's state of the run is cut as an advisor's package is: the owner's messages first and whole, then `[Cut to fit the window: <n> of <m> characters.]`. A route whose window is unknown, as a Codex route without one, is not cut. It is a limit on one message, never on the research: the run goes on.

### Epochs and planning

The dashboard calls an epoch a **round**.

| What | Default | Notes |
| --- | --- | --- |
| An epoch's end | When every lane's trials are done and their attempts settled; in a run that keeps working, when its trials are done. It has no time cap | |
| Fork rounds | Every 20 epochs (epochs 21, 41, …). With `budget.wall_hours`, at one third and two thirds of it | Every lane starts again from the champion |
| Planner call | No time limit: it ends when the planner answers, or when its run is paused or closed. In Pi, a `submit_plan` its tool's schema refuses goes back to the planner with the reason; the same refused arguments a second time end the call (`invalid`) | A call that gives no plan, or an answer that code refuses, is tried once more; a refused answer goes back with its problems. After a second failure, with no model, or with the planner turned off, lanes take queued experiments by the fixed rules (the [fallback](glossary.md)). Each try's cause is recorded in the round's `epoch_started` event (`causes`) and in **History**: `timeout`, `text_only` (it answered in text without a plan), `cut_off` (its reply reached the output limit), `provider_error` (with the provider's kind and words), `cancelled`, or `invalid` (with each rule the plan broke). Planner trouble never pauses research. A research run makes no planner call: its research plan fills the queue, and its rounds count as research rounds, never as fallbacks |
| The fallback's directions | Mandated first, then tried; then, in a goal campaign, a direction that names a goal the champion does not meet yet; then the least explored. A direction whose goals the champion already meets all of (its name or description names their ids) is skipped; with none left, each goal not met yet becomes a direction | Fixed |
| The planner's answer | Every limit it is held to is in its tool's schema and in its prompt: see [The experiment queue](#the-experiment-queue) | |
| Goal campaign: wait for the goal report | Up to 2 hours, or until 3 checks of the champion failed | Then the epoch is planned without it |
| Hill climb: wait for the baseline | Until the judge has measured the starting point. No time limit: the run is the judge's to measure first | Live says `round <n> waits for the judge's baseline of the starting point (champion #<n>)` |
| Hill climb in setup | Each round is a setup round: one setup experiment and one trial for each lane, planned without the planner, until the judge can measure a change | Not a fallback |

### The judge

| What | Default | Notes |
| --- | --- | --- |
| A hill climb's baseline | 3 blocks of the starting point alone, each running every cell `acceptance.runs_per_cell` times, as the run's first job (priority 10, before every other job) | Fixed. Until it exists, no other job of the run is leased and no round or trial starts. After a failure of the rig itself, tried again at once; after a second such failure, 10 minutes after each; a starting point that can't be measured puts the run in setup ([The baseline](contract.md#the-baseline)) |
| The baseline's folder | 64 MiB and 1,000 files, at most 32 folders deep | Fixed. More fails the baseline ([The check's baseline folder](kit-manifest.md#the-checks-baseline-folder)) |
| Calibration (A/A) | 6 blocks (`THERMITE_CALIBRATION_BLOCKS`), at most once in 24 hours for each hill-climb run, at the lowest priority, and only once its baseline exists | Fewer than 2 blocks turns it off |
| Goal checks of the champion | Once for each champion. After a failure, up to 3 times, 10 minutes apart | |
| A job's lease | 15 minutes, renewed every block | A job whose lease ran out 3 times is `blocked` |
| Readiness before each block | Up to 15 retries, 2 s apart | Then an infrastructure failure: `crash_infra`, one retry |
| A CPU ready for timing | 1-minute load at most 75% of the cores | |
| A GPU ready for timing | Use at most 5%, memory in use at most 600 MiB, at most 85 °C, no compute processes and no thermal or power slowdown. A value `nvidia-smi` can't give, the list of compute processes too, counts as not ready | |
| A slowed-down block | Thrown away and run again when the harness was CPU-throttled for more than 2% of it or of any one run, or the device reports a problem afterwards. 3 tries | Then an infrastructure failure |

### The rig and control

| What | Default | Setting |
| --- | --- | --- |
| Exports | Every 60 minutes, when anything new was recorded | `THERMITE_EXPORT_MINUTES`; **Edit rig** › **Exports** |
| Reports to control, exports pushed, champion uploads | Every 60 s | `THERMITE_POLL_SECONDS` |
| Commands fetched from control | Every 5 s; with the message bus, as they are issued, and fetched every 180 s for any that never reached the bus | `THERMITE_COMMAND_POLL_SECONDS`; `THERMITE_NATS_URL` |
| Live view lines sent to control | Every 3,000 ms; with the message bus, published there as often | `THERMITE_LIVE_INTERVAL_MS` |
| The screens of the trials the owner watches, sent to control | Every second while a trial is watched, over HTTP even with the message bus; while none is, control is asked every 5 s whether one is | Fixed |
| The message bus's users looked at by control: a rig retired or brought back, a run a rig may now publish the live lines of | Every 5 s; written and reloaded only when they changed | Fixed |
| The message bus's server certificate looked at by control, at the same look | Made anew when its names change, when control's authority changed, or 30 days before its end; it is valid for 397 days, the authority for 10 years | Fixed |
| One line of the live view | 8,000 characters: a longer line, such as a long reply, is cut and ends with `[cut]` | Fixed |
| The model route checked on control | Every 30 s. With the message bus, not asked: it comes in the rig's config as control writes it, and on this beat the supervisor only hands its harness again what it lost | `THERMITE_MODEL_ROUTE_POLL_SECONDS` |
| Control's look at each rig's config on the message bus | Every 5 s: a key is written only when its value changed | Fixed |
| A rig shown as stale | After 180 s without a report | `THERMITE_CONTROL_STALE_SECONDS` |
| A rig shown as offline on **Rigs**, in the REST API, MCP and `thermite rig list` | After 900 s without a report, never before it is stale | `THERMITE_CONTROL_OFFLINE_SECONDS` |
| A GPU cloud in **Providers** read again: prices, pods and spend | Every 15 minutes, and on **Read again** | Fixed |
| A draining rig's reports looked at, for its image update | Every 10 s: its pods restart once its report says nothing runs: no open trial, and no judge job under a lease still in force (a lease that ran out is taken back, while draining too). **Update now, without waiting** skips it. A research run's clock stops while the rig drains | Fixed |
| A drain's deadline | 60 minutes: then the drain stops waiting by itself, and the owner chooses under **Needs you** to go ahead now or to end it. Nothing stops by itself: until the owner chooses, the rig starts nothing new ([At its deadline](rig-page.md#at-its-deadline)) | `THERMITE_DRAIN_MINUTES`; an update's `drain_minutes` |
| The disk floor | 5 GiB free on each place the harness writes to: below it, no trial, plan, judge's job or export starts, a state snapshot waits, and a model download is refused. The work under way ends as it would, and the rig goes on once each place has 1 GiB more ([The disk card](rig-page.md#the-disk-card)) | `THERMITE_DISK_FLOOR_GIB` |
| Control's disk floor, looked at every 60 s | 5 GiB free on control's state folder and in the message bus's store, the room left under its limit: below it, no new run starts; reports, commands and the runs under way go on, and nothing is dropped. Control lets go once each place has 1 GiB more ([Troubleshoot](../how-to/operate/troubleshoot.md#controls-disk-is-at-its-floor)) | `THERMITE_DISK_FLOOR_GIB`, control's; the minute is fixed |
| A part's loop that does not come around | Late after ten of its periods, never before 30 minutes: its part's health route answers 503, and a deployment that checks it restarts the part. A judge in a job and the scheduler in the planner's call are never late ([Health](rest-api.md#health)) | Fixed |
| Advisor rounds | 60 s after the last round ended, never less than 30 s, unless a new owner's message to the teachers ends the wait (below) | `THERMITE_POLL_SECONDS` |
| Teacher reviews of a run | Every 60 minutes, and soon after the owner writes to the teachers, or to all the advisors, of a running run | `teacher_minutes` in the advisors file |
| A new owner's message to the teachers, or to all the advisors, looked for between advisor rounds | Every 5 s, when the rig has teachers and its **Teachers** switch is on. Finding one ends the wait, and the next round starts, unless the advisors' spending for the day has reached `max_usd_per_day`; a round under way finishes first | Fixed |
| An audit or review that failed | Tried again 30 minutes later, each audit or review counting its own tries. An audit is tried up to 5 times in all, then waits for the owner (its hand-off is sent again every 30 minutes until it arrives). A review's fifth try, or any later one, posts it as not passed when a reviewer still gives no answer, each such reviewer failing it | Fixed |
| Past research synced into each running run's `knowledge/` folder | Every 180 s. A run that control says it did not assign, such as a rig check's run, is asked about again 1 hour later, or once it has stopped running and runs again | `THERMITE_KB_SYNC_SECONDS`. `0` turns it off. The hour is fixed |
| A rig's MCP servers, from control to its supervisor and harness | Every 30 s, with the model route; with the message bus, as control writes them. Control renews an OAuth or client sign-in when less than 5 minutes of its access token are left | `THERMITE_MODEL_ROUTE_POLL_SECONDS` |
| One call of the supervisor's, or of the command line's, to control or to the rig's harness | Ends after 5 minutes with no answer, as a call that failed: the supervisor makes it again at its next round. A call that sends a champion's patch or a kit's bundle, up to 64 MiB, has 30 minutes. A command the harness was still applying answers `in_progress` to the next call, and is applied once | Fixed |
| An MCP server's tool list, as the harness and the supervisor keep it | Read again at the first use after 5 minutes, or when the server's sign-in changes | Fixed |
| Research digests | Every 60 minutes. After `min_duration`, at a digest, the review panel is asked about the items with no standing decision, when every question has an answer card, the run has `min_verified_claims` (when set) and no review of the run waits; then the progress rule is checked | The contract's `report_cadence.digest_minutes` |
| Research fetches | 6 a minute for each domain: a fetch waits, it is never refused for this | A research run: the contract's `fetch_policy.per_domain_per_minute`. A hill-climb or goal run: fixed |

## Back-pressure

| What | Limit | Effect |
| --- | --- | --- |
| Open attempts | 4 (`budget.max_open_attempts` in the contract) | No new trial starts while this many of the run's attempts are `queued`, `building`, `screening`, `confirming`, `verifying`, `awaiting_audit` or `awaiting_approval` |
| A lane's next trial | After its last trial ended and that trial's attempt settled. In a run that keeps working (`lanes.keep_working`, or a `keep_working` rule), after its last trial ended | The lane waits for the judge, or for its trial and the open attempts above |
| A goal run whose champion met every required goal | While the judge's second, confirming validation of that champion is queued or running | No new round or trial starts; a trial at work goes on. If the validation agrees, and the held-out cases of the goals met pass, the run closes; if not, or if it fails or is blocked after three lost leases, the lanes go on ([The goal report](verdicts.md#the-goal-report)) |
| One running run for each rig | Assigning or resuming a run pauses the rig's others: `replaced by <run>` | The other runs wait, paused |
| The judge | One job at a time on each judge device. Each judge device builds as its own builder, so builds run at once; a change two devices need is built once, and the second waits for it | Jobs wait in a queue, by priority |
| Development runs on a shared device | A development run waits while the judge has any job queued or running, then holds the device | It waits until the judge is done or its trial ends: no time limit of its own |
| A development run behind another lane's | It waits for a free device | Until one is free, or its trial ends: `the trial ended before a device was free` |
| One development run for each lane | A lane's next development run waits for its last | |

## Per-process and per-trial limits

Each ends one process, command or trial. The lane, the run and the campaign go on.

### Kit processes

The [kit manifest](kit-manifest.md) sets these; the defaults apply when it does not.

| Process | Time | Memory | Disk | Tasks |
| --- | --- | --- | --- | --- |
| Build (`build`) | 600 s | 4,096 MiB | 4,096 MiB | 512 |
| Run (`run`) | 300 s | 1,024 MiB | 256 MiB | 256 |
| Check (`check`) | 120 s | none | none | none |

A cell may set its own run time, `timeout_s` in its entry in `cells`, which replaces the run's for that cell's runs only ([Cells](kit-manifest.md#cells)). Each time limit, a cell's own too, is at most 86400 s (a day), the longest the judge runs anything; a longer one is refused: `a time limit is at most 86400 s (24 hours)`.

Memory is the sum over all the processes the build or run started, sampled every 100 ms. Disk is the working directory, sampled every 500 ms; more than 50,000 files and folders, or more than 128 levels, also counts as over the disk limit. Only the last 64 KiB of output is kept. Tasks are the processes and threads the build's or run's user may have at once (`RLIMIT_NPROC`); the kit does not set them.

### Lanes and agents

| Limit | Default | Set in the contract's `lanes.limits` |
| --- | --- | --- |
| One command a lane runs (a build, a test) | None: it runs until it ends or the trial ends. On a trial with a length, a Pi worker's command (`run`, `dev_run`) stops 3 minutes before the trial's end, so that the worker can still submit, and nearer the end than that it gets 1 minute at most. Its result then says `stopped by the trial's clock` | `run_timeout_s` (10 to 7,200) |
| Memory of everything a lane runs at once, OpenCode, Claude Code and Codex included | 2,048 MiB | `run_rss_mib` (256 to 16,384) |
| The trial's workspace, build folders included | 2,048 MiB | `workspace_mib` (256 to 65,536) |
| One development run | None on a development device of its own; 300 s on a device the judge shares | `dev_run_timeout_s` (10 to 3,600) |
| Memory of one development run | 4,096 MiB | `dev_run_rss_mib` (256 to 16,384) |
| Processes and threads at once, for each of a lane's users: its commands with OpenCode, Claude Code or Codex, its development runs, its Pi worker | 256. At the limit, starting one more fails with `Resource temporarily unavailable` | `processes` (64 to 65,536) |
| A lane's build cache | 8 GB (`CCACHE_MAXSIZE`). ccache's paths are relative to the lane's folder (`CCACHE_BASEDIR`, with `CCACHE_NOHASHDIR`), so a build in the same folder of each trial's checkout hits what earlier trials compiled ([A lane's cache](ports-volumes-secrets.md#a-lanes-cache)) | Fixed |
| One file-tool call of a Pi worker | 30 s | Fixed |
| Preparing a submission's patch | 60 s | Fixed |
| A Pi worker process | 2 GiB of memory; with a trial length, that length plus 2 minutes | Fixed |
| A submission, its patch included | 32 MiB | Fixed |
| A submission | One for each trial: `trial <id> has already submitted` | Fixed |
| A repeated tool call of a Pi worker | None: the call runs. When its tool, its arguments and its answer are the same as a call's already in the conversation, the worker gets a short answer instead of the full one again: `Same call and same answer as at <time> UTC (call <n>). Its answer is above. Change what you ask, or go on.` The worker remembers the newest 2,000 answers it gave in full, and forgets them all at a compaction | Fixed |
| A streak of the same calls, in any harness | None: it ends nothing. At its 10th repeated call in a row (the same call with the same answer, or a Pi worker's short answer), the harness records a `trial_repeating` event, writes `repeats the same calls: …` in the trial's **Live**, and the trial's `at_work` and the teachers' brief show it. A new call, or a changed answer, ends the streak: `stopped repeating the same calls after <n>.` The harness remembers each trial's newest 2,000 different calls, and forgets them at a compaction | Fixed |
| Asks for a page the run refused | None: nothing ends a trial for them, and each is answered at once, with no download. From a trial's 10th ask for a page refused before for a reason that lasts, the trial asks the owner under **Needs you** | Fixed |
| A quiet trial | None: nothing ends it. With **Ask me after a quiet spell of (minutes)** set on **Edit rig** (1 to 1440), a trial with no line for that long asks the owner under **Needs you** ([Stuck trials](../how-to/campaigns/decide-what-waits.md#stuck-trials)) | `quiet_minutes`, a rig setting |
| A Pi worker's open model call | Reported every 30 s from a turn's start until its reply ends: since when, and the characters of text, thinking and tool-call arguments so far. A shorter call is never reported. It shows in the trial's `at_work` (`reply`) | Fixed |

### Checks and research

| Limit | Value |
| --- | --- |
| Model route check | 120 s |
| Isolation check | 30 s for each role |
| Smoke check | 3 hours for the whole check |
| A research fetch | 30 s, at most 5 redirects, at most `fetch_policy.max_bytes` (5,000,000 by default). In a hill-climb or goal run, 5,000,000 bytes, and `robots.txt` is respected |
| A research tool's answer | 14,000 characters, for a Pi worker's file tools and the `thermite-trial research` commands too, and a cut is always said. A read (`read_source`, a Pi worker's `read_file`) gives at most 10,000 characters, so that it fits whole (`read_source` gives 6,000 by default), with `next_offset` and where to read on while more of the text is left. `fetch` gives the first 6,000 characters of the page, the same way, and as many of its first 60 links as fit in 5,000 characters, with how many it left out. `search_corpus` gives a page of at most 30 matches, a folder listing at most 500 entries and a folder search at most 200 lines, each fewer when they would not fit, with `next_skip` for the next page. A folder search shows the first 400 characters of a line, and says how long the line is. Any other answer that is too long, JSON or not, ends `… [cut: this answer has <n> characters, and only its first 13800 are shown]`; one with a text from an offset cuts its text instead, with `next_offset` and `cut`: `the text is cut at character <n> of <m> to fit this answer: read_source <source> with offset <n>` |
| A claim (`add_claim`) | Its text has 5 to 4,000 characters. It has 1 to 10 quotes, and each quote has 20 to 2,000 characters. Outside these, the harness refuses the claim and records nothing; the answer names each field and what is wrong, such as `invalid request: quotes[0].quote has 9 characters; it needs at least 20` ([A worker's request is refused](../how-to/operate/troubleshoot.md#a-workers-request-is-refused)) |
| A refused request to the harness | Its answer names at most 5 problems, then how many more. A worker's tool and `thermite-trial` show the first 500 characters of it |
| One advisor call | No turn or time limit, unless the [advisors file](advisors-file.md) sets `max_turns` (`openai` runtime) or `timeout_s`. In Pi (`openai` runtime), an answer refused for the same problems three times running ends the call with those problems as its error; problems that change are asked again with no limit |
| A research run's review | Its package is at most 200,000 characters: past that, each question shows fewer claims, independently sourced ones first, then the newest, and then fewer findings, and the package says so. Each reviewer's reasons are cut to 8,000 characters, and the harness keeps the first 4,000. An answer to a question is up to 8,000 characters with up to 100 cited claims, and what is missing up to 4,000; a hypothesis's why is up to 4,000. A longer text is cut to its limit, and a longer list of claims to its first 100. A question or hypothesis an answer leaves out is asked for once more; still missing, it counts as not answered, or as no verdict. The answers the run's events keep are cut to 500 characters, and its gaps to 20 lines |
| A research run's paper | The final writer's paper is 1 to 100,000 characters before the references code appends, with up to 50 next experiments. Its package is cut to 200,000 characters in its prompt, and the STE checker's guide to 60,000. The rig's STE checker has 120 s for each run; `ste_check` gives its first 100 findings. A refusal keeps the first 20 problems. No limit on tries: a try that gave no paper is tried again 30 minutes later ([The research paper](../explanation/campaign-modes.md#the-research-paper)) |
| One reply of an agent or an advisor | The model's maximum output, from the provider's model list; none sent when the list gives none, so the provider's own applies. Anthropic's API needs one: 32,000 tokens when the list gives none. An advisors file's `max_tokens` sets an advisor's |

### Sizes a rig has

| Limit | Value |
| --- | --- |
| Lanes | 16: the harness image has users for lanes 1 to 16. More is refused, with the reason `at most 16: a rig has users for lanes 1 to 16 only`, by a contract's `lanes.count`, **Workers at a time** on **Edit rig** and the **New campaign** page. Control does not sign an `assign_campaign` that asks for more, and a harness whose `THERMITE_MAX_TRIALS` is above 16 does not start ([Settings](settings.md#the-rigs-settings)) |
| Judge and development GPUs | 8 of each |
| A rig's GPU set (`THERMITE_GPUS`) | 16. A longer list stops the harness: `THERMITE_GPUS names <n> GPUs; a rig takes at most 16` ([Settings](settings.md#gpus-and-cpus)) |
| GPUs on a rig control sets up on a machine or cluster | 16; 8 on a namespace joined with a join command |
| GPUs on the local stack's rig | 16: on a machine with more, `compose.gpu.yaml` gives it the first 16 ([Use the machine's NVIDIA GPUs](../how-to/install/one-machine.md#use-the-machines-nvidia-gpus)) |
| GPUs in a RunPod pod | 1 to 8 |

## The owner's messages

None of these ends anything. A message itself is 1 to 4,000 characters (see [Control's own limits](#controls-own-limits)), and [Signed commands](signed-commands.md#message_agent) describes who reads it.

| What | Limit |
| --- | --- |
| Messages kept in force | No limit: each one stays in every new trial's brief until the owner removes it |
| The owner's additions to a campaign's roles | 1 to 20,000 characters for each role, in the contract's [`role_additions`](contract.md#your-additions-to-the-agents-roles); a longer one is refused when the contract is checked. Each goes whole into every prompt of its role, and is never cut to fit a model's window |
| The owner's messages in an advisor's brief or package | Up to 20 that the role has not read. The teachers' brief also shows up to 5 that they read in the last 24 hours. The brief or package in an advisor's prompt is cut to 120,000 characters for the teachers and their merged by model, and 200,000 for the auditor, each reviewer of the review panel and the final writer; the owner's messages come first in it and are never cut |
| An advisor's answers to the owner's messages | The first 50 in one answer, each cut to 1,000 characters. An answer longer than 20,000 characters, empty, or otherwise not fitting is left out; the others still count, and so does the advisor's review, audit or verdict. See [Advisors file](advisors-file.md#answers-to-the-owners-messages) |
| The owner's input to an agent's terminal ([`terminal_input`](signed-commands.md#terminal_input)) | Text of up to 4,000 characters, or 1 to 16 keys by name. A trial takes at most 30 inputs a minute, and at most 20 wait for its program's usage window to reset: past either, the input is refused in words. At most 4 of a rig's terminals are watched at once ([The Live view](live-view.md#how-the-screen-reaches-the-page)) |
| How soon the teachers read a new message | In the next teacher round. While the run is running and no round is under way, that round starts within about 5 s. When the advisors' spending for the day has reached `max_usd_per_day`, it waits for the first round after midnight UTC, and the run's **Live** says so. See [The rig and control](#the-rig-and-control) |

## The experiment queue

None of these ends research. Nothing limits how many experiments a run's [experiment queue](glossary.md) holds, or how many ideas the lanes propose. [Experiment states](verdicts.md#experiment-states) describes the queue itself.

| What | Limit |
| --- | --- |
| An experiment's title | 1 to 200 characters |
| Its details | Up to 4,000 characters |
| Its direction | 1 to 80 characters: a direction's name, `:name:`, or your own words |
| Its why | Up to 2,000 characters. Dropping an experiment needs a why of 1 to 2,000 characters |
| A place in the queue | `top`, `end`, or an index from 0 to 100,000 among the queued experiments, 0 first. An index past the last puts it last |
| A lane's idea | One request of at most 64 KiB. No limit on how many |
| Experiments copied into a new run by **Start a run**, its twins (`thermite run start`, `POST /v1/campaigns/<campaign>/runs`, MCP's `start_run`) or `thermite assign --queue-from` (`assign_campaign`'s `queue`) | 500. Each copies at most the first 500: the run's experiments up next, in order, then its lanes' ideas. A command with more is refused. With **Agents** off, **Start a run** copies none, and its twins and `thermite assign` refuse a run to copy from |
| The planner's answer | At most 40 moves, 40 drops, 5 rules, 5 old rules in words converted and 13 new directions. No limit on the experiments it adds or the ideas it accepts. A title up to 200 characters; details, and an inline experiment's focus, up to 4,000 (a focus past its title goes into details); a direction up to 80; each why and rationale up to 2,000; a new direction's description 3 to 300; notes up to 2,000; a ref that names an added experiment up to 40; an experiment's id up to 64. Its tool's schema and its prompt say each of these |
| Old rules in words converted in one planner's round | 5, the oldest first. The rest convert at the next rounds |
| A teacher's or the merged by model's answer | No limit on the opportunities in its portfolio, or on its plain experiments; up to 10 moves, each with a why. One that doesn't fit is left out. Its review still counts. An opportunity's part longer than its limit, such as a `gain_bound` over 300 characters, is cut to it, and the opportunity is kept ([The portfolio](advisors-file.md#the-portfolio)) |
| The auditor's answer | One check |
| The advisors' experiments in one request to the harness | Up to 20 experiments and 20 moves. The supervisor sends the teachers' portfolio in as many requests as it needs |
| **Ideas kept ready**, a campaign's target queue depth | A target, not a limit: 0 to 1,000, two for each lane by default. The queue may hold more, and nothing stops when it holds fewer |
| The teachers' code and evidence reads | One listing: 2,000 files. One read of a file: 400 lines by default, at most 2,000; a file over 8 MiB is not read. One read of a diff: 40,000 characters, then the next part |
| The teachers' reads of the run's own research | One page of a list: 20 items by default, at most 50, and at most 60,000 characters; `next` gives the rest. One read of a source: 8,000 characters by default, at most 20,000. One read of a file: 400 lines by default, at most 2,000, and at most 60,000 characters; a file over 8 MiB is not read. One search: 10 items by default, at most 50, and at most 60,000 characters. The brief's `research` carries the newest report cut to 4,000 characters ([The run's own research](advisors-file.md#the-runs-own-research)) |
| The queue in the planner's and the teachers' brief | The first 40 up next, the newest 20 ideas, every experiment in progress, and the newest 20 tried, with the judge's verdicts and how each trial ended in words (`cause`). An experiment up next that came back says how many times and why (`returned`). Details are cut to 600 characters, whys to 400 and causes to 300 |
| The **Planner** tab's **What the planner did** | The newest 30 entries: hand-outs, the planner's changes to the queue and the rules, and the messages it read. Control keeps the newest 50 hand-outs for each run |
| The messages under **Tell the planner** | Your newest 10 to the planner or to everyone working. Control keeps the newest 200 messages for each run |

## Field notes and the knowledge base

None of these ends anything. Nothing limits how many [field notes](knowledge-base.md#field-notes) an agent writes, or how many items a campaign's collection holds. The windows below say how much each agent is shown, not how much is kept.

| What | Limit |
| --- | --- |
| A field note | 1 to 2,000 characters. What it is about: an id of 1 to 200 characters. In a research run, a worker's note that repeats one of the run's last 200 field notes word for word, case, punctuation and spaces aside, is refused |
| A worker's note (`thermite-trial note`, Pi's `note`) | One request of at most 64 KiB |
| An advisor's notes, posted to the harness | One request of at most 2 MiB for each advisor |
| A research note (`add_note`) | Cut to 4,000 characters, with at most 20 sources. A note that repeats one of the run's last 200 research notes word for word, case, punctuation and spaces aside, is refused |
| Field notes in a worker's brief | Its lane's newest 10, and the run's newest 5 decisions and lessons by other writers |
| Field notes in the planner's and the teachers' brief | The run's newest 20 |
| The run page's **Journal** tab | The newest 500 field notes; the rest are in the campaign's collection and the run's export |
| A briefing (`assign_campaign`'s `briefing`) | Up to 200 items, each 1 to 4,000 characters |
| A campaign's brief (the contract's `notes`, `links` (a research campaign's `seeds`), `ideas` and `hypotheses`) | No limit of its own: the whole contract goes to a rig in one signed command of at most 3.5 MiB. The planner gets it whole, and the advisors whole unless their package's own cut reaches it; each worker's brief carries its first 32,000 characters and says where the rest is (`BRIEF.md` in the run's folder). See [The campaign's brief](contract.md#the-campaigns-brief) |
| A research question | No limit of its own. A research task in the queue holds its first 4,000 characters, and says the whole question is in the worker's brief |
| An item of the knowledge base | Title 300 characters, text 20,000 |
| Search words | The first 8 words of 2 or more characters; at most 300 characters in all |
| Search results | The **Knowledge** page 100; **Start a run** › **From past research** 40; the owner's and the agents' `kb_search` 1 to 50, default 10; a search counts its first 12 words |
| The agents' searches and reads | Wait in the harness at most 15 seconds for the supervisor to take them, and 30 seconds for control's answer after that; the supervisor waits 20 seconds for control and takes 20 at a time; at most 200 wait in the harness at once, and control answers at most 32 of one rig's at once. Past each, the agent is told so in words and goes on ([How a search reaches control](knowledge-base.md#how-a-search-reaches-control)) |
| `kb_write` | A text of up to 20,000 characters, or any length kept as a file with `file_name`; a title of up to 300; up to 20 links |
| A run's sync of past research | Pages of up to 500 items from control, posted to the harness in parts of at most 8 MiB. The harness takes at most 32 MiB in one request |
| A kit's MCP servers | At most 20, each named once |
| An MCP server's tools | At most 1,000 read from one server; control keeps each one's description to 1,000 characters |
| One MCP call by an agent | Connecting 30 s, listing tools 30 s, a tool call 120 s: one that takes longer is a failure, the agent gets a tool error, and the run goes on. In Pi, an answer's text is cut at 30,000 characters. A call through the harness's gateway is at most 4 MiB |
| An OAuth sign-in | 15 minutes from **Sign in** to the server sending the browser back; each sign-in's state is good once |

## Control's own limits

| What | Limit |
| --- | --- |
| A command's time to reach its rig | 60 minutes by default, at most 7 days (`--ttl` or `ttl_minutes`). Propagation: 24 hours. A full reset's commands: 30 minutes |
| A signed command's size | 3.5 MiB: `the <kind> command is too large to deliver` |
| Clocks | A rig refuses a command dated more than 5 minutes ahead of its own clock, and control a report dated more than 5 minutes ahead of its own |
| A full reset's steps | Quiescing 1 hour, exporting 30 minutes, verifying 1 hour, waiting for the owner 24 hours, wiping 30 minutes. A step that takes longer fails the reset |
| Dashboard sessions | End after 30 days unused (`THERMITE_CONTROL_SESSION_DAYS`) |
| Failed sign-ins | After 20 in a minute from one address: `too many failed sign-ins; wait a minute`, to that address only. Control counts at most 4,096 addresses at once, and forgets the one that failed longest ago first |
| Why a dashboard form failed, in another program's words (ssh, git, kubectl, a GPU cloud, an MCP server) | Kept on control for 15 minutes, at most 500 at once, with what looks like a credential taken out; the page's address names them by an ID. Later, the page says `This message is no longer kept: do it again to see why.` |
| A join command | Works once, within 1 hour |
| Setting a rig up on a machine | 30 minutes for the script, then up to 10 minutes for the first report. A joined rig: up to 60 minutes. A cluster rig: up to 10 minutes |
| An install on a machine | 30 minutes |
| SSH connections | 15 s to connect |
| `kubectl` requests | 30 s |
| An MCP server's sign-in | 30 s for each answer, of 1 MiB at most |
| The live view | The newest 20,000 lines of each rig, and each open trial's newest 400 past them (the trials the rig's last report lists), so a trial that writes many lines can't push out another's |
| The live view on the message bus | The `LIVE` stream keeps each message an hour at most, at most 1,000 messages of each subject, and 256 MiB in all; the oldest go first. A message holds at most 1 MiB: one source's lines of one run, in more than one message when they would not fit. A rig may publish the live lines of its newest 1,000 runs on their own subjects; an older run's lines go on the rig's own subject. The supervisor's figures name the 100 subjects it used last, and count them all |
| The knowledge base's files on the message bus | The `KB_FILES` stream keeps each chunk until control has taken it, with no limit on how many wait or for how long: a full store refuses new ones. A chunk is 1 MiB, the last the rest. A supervisor puts at most 50 files a round, the rest the next round; a file has no size limit |
| A rig's config on the message bus | The `CONFIG` stream keeps the latest value of each rig's three keys, for good. A message holds at most 1 MiB: a value too large is not written, its log says so once, and the rig keeps the one it has. The supervisor's figures name up to 20 subjects, and count them all |
| Live's push to a page | At most 500 lines in one event: a page with more waiting gets the newest 500 and a count of the rest. An event every 15 s while there is nothing new, so nothing between closes it as idle. The browser connects again 3 s after a drop |
| A daily report | 200,000 characters: the supervisor cuts a longer one to that, and its end says so |
| A kit uploaded on the **New campaign** page | 64 MB and 2,000 files, which unpack to 256 MiB at most. Control reads the archive in memory and writes nothing of it out but the archive itself. It refuses links, devices, a path that leaves the kit (one that starts with `/` or has a `..` part), a zip64 archive and an encrypted entry |
| A kit's git bundle given to control | 64 MiB over REST and `thermite kit add`; over MCP's `kit_add`, 4,000,000 characters of base64, a bundle of at most 3,000,000 bytes, as an MCP request is at most 4 MiB |
| A message to an agent | 1 to 4,000 characters, after control trims it. One with no words: `Write a message first.` |
| A redirect | 1 to 40 directives, each with a rationale of up to 2,000 characters and up to 20 citations |
| A direction's name | 2 to 41 lowercase letters, digits and dashes, written in letters, digits, spaces and dashes, plain or as `:name:` |
| REST lists | `?limit=` from 1 to 5,000. Defaults: events and live lines 500, audit 200, commands 100, reports 20. A rig's exports on control (`GET /v1/rigs/<rig>/exports`) take no limit: the newest 1,000 |
| MCP lists | `kb_search`: 1 to 50, default 10; `recent_events`: at most the newest 50 events; `list_commands` (`limit`) and `get_run` (`attempts`): 1 to 500, default 50; `run_queue`: `tried` 0 to 500, default 50, with the newest 10 hand-outs and the newest 20 messages; `control_log`: 1 to 500 a page, default 100, with `before` and `after` for the other pages; `rig_reports` and `runpod_tests`: 1 to 50, default 5; `exports`: 1 to 500, default 50 |
| Dashboard lists | A run's newest 300 attempts and 400 history events; 300 audit entries a page, with **Older** and **Newer** for the rest; a campaign's first 8 **Earlier runs**, then **Show N more**; the **Exports** page's newest 1,000 exports. A run's **Live** first loads its newest 600 lines, then gets each new one as control has it |
| Request bodies from rigs | Reports 32 MiB; live lines 4 MiB; champion patches 64 MiB; daily reports 1 MiB; command results and supervisor figures 256 KiB |
| Request bodies from the owner and agents | Over REST, each route's own: a command 3.5 MiB, a rig launched on a GPU cloud 64 KiB, and 4 KiB for a route that takes a few fields (enrolling a rig, a restart, a full reset, a propagation, a test pod, a RunPod rig's terminate and limits). A dashboard form 1 MiB, but a kit's archive with its form 65 MiB, and a new campaign's form with its files 86 MiB. An MCP request 4 MiB. A body past its limit is answered 413 before control reads it |
