---
title: "Give each agent its own model"
description: "Choose a model, an effort, a harness and a context window for the workers, the planner and each advisor."
type: how-to
sidebar:
  order: 5
---

A rig runs several kinds of agent, and they need different things. The workers make many calls, so a cheap or local model may suit them. The planner and the advisors make a few calls each, where a stronger model can pay off. On a rig's **Edit rig** page you give each of them its own model, an effort (how long the model thinks before it answers), the program it runs in, and its context window.

The planner coordinates each run's experiment queue, the run's ordered list of things to try. At the start of each round it gives each [lane](../../reference/glossary.md) (one line of search in the run) an experiment from the queue, and it may add, move or drop experiments. See [Choose what a run tries next](../campaigns/choose-what-runs-next.md).

## Before you start

- At least one provider is added on **Settings › Providers**, with models listed. See [Connect a model provider](connect-a-provider.md).
- If a model uses a paid key, give each campaign a stop time and set a spending limit at the provider first. Nothing stops research by default, and Thermite's money limits don't count the planner, or any advisor given its model on this page. See [Spending](#spending).

## Set the models

1. Open **Rigs**, choose the rig, and press **Edit rig**.
2. Go to section **2 · The agents**. It is a table with the columns **Agent**, **Model**, **Effort**, **Runs in** and **Context**. Its lines are in two groups: **The work** ("in the rig's harness") and **The advisors** ("in the supervisor; they never judge"). Each agent's job is on one line under its name:

   | Group | Agent | Its job | With no model chosen |
   | --- | --- | --- | --- |
   | The work | **Workers** | "Change the code, one trial each." | The model of the rig's own `THERMITE_MODEL_*` settings, such as `rig's settings: my-model`. Without those, the agents have no model and wait: `none: can't run` |
   | The work | **Planner** | "Picks what each worker tries next." | **same as the workers**: their model, harness and context |
   | The advisors | **Teachers** | "Read recent trials and suggest next steps." One model, or two: see [Two teachers](#two-teachers) | The teachers of the rig's advisors file, such as `rig's file: opus-5.5`, or `none: off` |
   | The advisors | **Auditor** | "Checks a win before it is kept." | The auditor of the rig's advisors file, or `none: off` |
   | The advisors | **Review panel** | "Scores goals that code can't measure." Three reviewers, all on this model; the advisors file can set two to five | The review panel of the rig's advisors file, or `none: off` |
   | The advisors | **Synthesizer** | "Writes each research question's answer card." | **same as the first teacher**: its model, harness and context |
   | The advisors | **Final writer** | "Writes a research run's paper when it ends." | **same as the first teacher**: its model, harness and context |

   Every column title, group and agent has an info icon (ⓘ) that says more. The first choice in each **Model** list is the one with no model, and it names what the agent uses then. For an advisor, it names what the rig's [advisors file](../../reference/advisors-file.md) sets up, as the rig's supervisor reports it:

   | The first choice says | What it means |
   | --- | --- |
   | `rig's file: opus-5.5` | The file has a model for this advisor, and the advisor uses it. **Runs in** and **Context** show the file's program and window, greyed out, such as **Claude Code** and `200,000 · 80%` |
   | `none: off` | The file has no model for this advisor, or the rig has no file. The advisor does not run until you choose a model here. **Runs in** and **Context** show `—` |
   | `rig's file` | The rig's supervisor has not reported its file yet: it reports once a minute, and an older supervisor never does. The advisor uses the file's model, if the file has one |

   For the workers, `rig's settings: my-model` is the model that the rig's harness reports from its own settings, `none: can't run` says it has none, and `rig's settings` alone says that control can't tell. The **Synthesizer** and the **Final writer** run only in research runs; with no model, each uses the first teacher's: the **Teachers** line's model, or else the first teacher of the advisors file. With no teacher in either place, they are off, and their **Runs in** and **Context** show `—`.

3. For each agent you want to change, choose a model in its **Model** list, and an **Effort** (see [Effort](#effort)).
4. Check **Runs in**: **Pi**, **OpenCode v2**, **Claude Code** or **Codex**. When you choose a model, the page sets the program it needs: **Claude Code** for a Claude subscription's model, **OpenCode v2** for OpenCode's own free models, else the line's own program when it can run the model, or **Pi**. Change it if you want another. **Codex**, the Codex CLI, takes a ChatGPT subscription's model or one from an OpenAI-compatible provider: see [Run the agents in Codex](chatgpt-subscription.md#run-the-agents-in-codex). A line with no model shows where it runs then, greyed out: "as the workers (Pi)" for the planner, "as the first teacher (Codex)" for the synthesizer and the final writer, and for another advisor the program that the advisors file gives it, such as **Pi**, or `—` when it is off. [Where each agent runs](#where-each-agent-runs) says what each choice gives.

   A program that can't run the model is refused in a red line under the agent's line, such as "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model."
5. To change an agent's context window or the point where its conversation is compacted, see [Set an agent's context window and compaction](#set-an-agents-context-window-and-compaction).
6. Read the list under **What changes when you save**, at the foot of the page. It says each change in a short sentence, such as "You change the auditor's model to my-model." and "You change where the auditor runs to Claude Code." While a line is refused, the list says why instead, such as "Not saved yet (the auditor): A Claude subscription runs only in Claude Code: …", and **Save changes** is off.
7. Press **Save changes**. The button says **Sending…** at once.

You return to the rig's page, which says, for example, "Control sent a new model and a model for the auditor to rig-1. The rig takes the change in less than one minute." When the save also changed the rig's settings, the line goes on with how their command stands, and changes by itself: `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`, then `Done. rig-1 took it at 03:41 UTC.` While the rig takes a new model for its workers, its **Checks** block follows it, and shows its model check as it runs.

The workers and the planner take a new model within a minute. The advisors read their models from control each time they run, so an advisor uses its new model from its next round.

When the workers' or the planner's model changes, the rig runs its model check at once. The check tests only the workers' model. For the other agents, watch a run on the rig in **Live** (in the sidebar), the dashboard's view of one run's agents at work. Choose a filter above the stream:

- **Planner**: the planner's lines. Each round starts with a line that says whether the model planned it, such as "round 4: planned by the model", or the lanes took their experiments without it, such as "round 4: taken from the queue by the fixed rules (no model)". The words in brackets say why: "(no model)", "(the planner is off on this rig (Edit rig))" or "(the model gave no usable plan)". When the model's tries gave no usable plan, a line says why for each try, such as "no usable plan: try 1: it answered in text without a plan (…); try 2: the plan was refused (…)". A research run has the same filter: its rounds start with "round 4: planned by the model", or "round 4: set by the gap-driven plan (the model gave no usable plan)" or "(the planner is off on this rig (Edit rig))", then each lane's task, and the hypotheses the planner promoted or retired.
- **Advisors**: the advisors' lines. Each error is a line of its own with its text, and an "advisor round done" line counts what a round did, errors included.

A run's **Planner** tab also shows the planner's model, in the card **The planner**: for example "my-model, its own model (from my-litellm)", or "my-model, the agents' model (Edit rig can give the planner its own)".

## Change the model during a run

A campaign has no model of its own: its run uses the models of the rig it runs on, and a rig works on one run at a time. So to switch a running campaign to another model mid-run, change the model on its rig. The run goes on: nothing pauses or restarts, and its queue, champion, research and journal stay.

1. On the run's page, choose the rig's name after **on**, under the run's title, such as **on** `rig-1` **· hill climb · Running**.
2. On the rig's page, press **Edit rig**, and in section **2 · The agents** choose the new **Model** for each agent you want to change, as in [Set the models](#set-the-models).
3. Press **Save changes**.

When each agent takes its new model:

| Agent | Takes the new model |
| --- | --- |
| **Workers** | At each new trial, within a minute of the save. A trial already running ends on the model it started with. The rig checks the new model at once |
| **Planner** | At its next round's plan |
| **Teachers**, **Auditor**, **Review panel**, **Synthesizer**, **Final writer** | At their next round. A call already under way, such as a review, ends on the model it started with |

To see that the run took it, open **Live** and choose the filter **Planner** or **Advisors**; the run's **Planner** tab names the planner's model; and the run's **Stats** tab lists its calls **By agent and model** ([Model use and cost](../../reference/model-use.md#the-stats-tab)). If the new model fails the rig's check, the run's agents stop with an **Agents stopped** card in **Needs you**, and the run keeps everything it has: give the rig another model, or see [The agents stopped](../operate/troubleshoot.md#the-agents-stopped-the-provider-refuses).

The model you choose for **The agents' model** in the **Start a run** panel, or on the **New campaign** page, is given to the rig the same way, when the run starts. Over MCP or REST, `set_rig_model` makes the same change: see [Over MCP or REST](#over-mcp-or-rest). Under **What the planner did**, it shows each hand-out: which experiment went to which lane, and why. See [Check the planner's model](../campaigns/choose-what-runs-next.md#check-the-planners-model).

## Two teachers

The teachers take one model or two. Two teachers on different models, such as one on a Claude subscription and one on a ChatGPT subscription, give the planner two views.

1. Give the **Teachers** line a model. **+ second teacher** shows under it.
2. Press **+ second teacher**. Two lines show under the first teacher: the second teacher, and **merged by**, the model that joins the two teachers' suggestions into one set for the planner.
3. Choose the second teacher's model, and a **merged by** model, or leave the merged by model empty: its first choice then names the advisors file's merged by model, or says `none: off`. Each line has its own **Effort**, **Runs in** and **Context**. The sentences now say "teacher 1" and "teacher 2".
4. Press **Save changes**.

**What changes when you save** says, for example, "You add a second teacher: chatgpt:gpt-pro in Codex. The merged-by model joins the two teachers' suggestions: claude-code:sonnet-5.5 in Claude Code."

- **×** beside the second teacher's model removes the second teacher and its merged by model: "You remove the second teacher and its merged-by model." One teacher works alone: its review gives the set, and no merged by model runs.
- **Two teachers without a merged by model** (its first choice says `none: off`: the advisors file has none either): the first review that comes back gives the set.
- The first teacher with no model takes the second teacher and the merged by model with it.
- A second teacher with no model is refused: "Not saved yet (teacher 2): Choose its model, or remove it."

Without the page's script, **+ second teacher** and **×** open the page again with the two lines shown, or emptied: **Save changes** then saves them.

## Set an agent's context window and compaction

Each line's **Context** cell shows its agent's context window and its compaction point in short, such as `204,800 · 80%`: the most its model reads in one request, in tokens, and the share of that window at which its conversation is compacted. A number set on this rig is bold. A line with no model shows, greyed out, what its agent has then: for an advisor the window and point of the advisors file, such as `200,000 · 80%`, or `—` when it is off; `rig's settings` for the workers; for the planner with no model of its own "as the workers: 204,800 · 80%"; and for the synthesizer and the final writer with none "as the first teacher: 272,000 · 80%".

1. Press the agent's **Context** cell. Two fields open under it:

   | Field | What it does |
   | --- | --- |
   | **Context window** | A cap on the model's window, in tokens: from 4,096 up to the window the provider lists. Empty: the provider's window, shown in the field. Use it to compare two models at the same window |
   | **Compact at** | When the conversation is compacted: a percent of the window, from 50 to 95. Empty: 80, which leaves a fifth of the window for the summary and the next reply |

2. Type the numbers. One line under the fields says where the conversation compacts, such as "It compacts at 104,857 tokens.", or what is wrong:

   | The line says | Why |
   | --- | --- |
   | `glm-5.1 takes at most 204,800 tokens.` | A window above what the provider lists for the model |
   | `A context window is a whole number of tokens from 4,096 to 100,000,000.` | A window out of range |
   | `Write the number of tokens in digits, such as 131072.` | Not a number. Commas and spaces are fine: `131,072` |
   | `The compaction point is a whole percent of the context window, from 50 to 95.` | A point out of range |
   | `That is the provider's window: no cap.` | Not an error: the provider's own window is no cap |
   | `OpenCode v2 compacts only with a window.` | A warning: OpenCode compacts only for a model whose window it knows |
   | `Codex compacts at 90% at the latest: 184,320 tokens.` | A warning: Codex compacts at 90% of the window at the latest |
   | `Claude Code counts this window as 100,000 tokens.` | A warning: Claude Code takes a window of 100,000 to 1,000,000 tokens |

   The info icons of the two fields say what the line's program does at the point, such as "In Pi, at 104,857 tokens, Thermite keeps the whole conversation in the run's research folder, as `compactions/<trial>-<n>.md`. Then the same model writes a summary, and the worker continues with it and its most recent turns." A trial never ends, and no worker is told to submit, because its conversation grew.
3. Press **Save changes**. **What changes when you save** says, for example, "You cap the workers' context window at 131,072 tokens; the provider allows 204,800. The workers compact at 104,857 tokens (80%). The planner follows the workers."

Another model on a line keeps the two numbers, and checks them against the new model. Empty fields remove the agent's own cap and point.

The planner with no model of its own uses the workers' cap and point. An advisor in Pi compacts its call's conversation, and the supervisor keeps the conversation with its own records. An advisor's package, such as an audit's diff, is cut to fit its window when Thermite knows the window, and the advisor is told when it is cut. An advisor in Claude Code, OpenCode v2 or Codex gets the window and the point in that program's own settings, as the workers do, and the supervisor keeps its conversation before each of that program's compactions with its own records too. [Compaction](../../reference/limits-and-pacing.md#compaction) says how each agent compacts and where its conversation is kept.

These are the rig's numbers. A campaign can set a smaller window and its own point for all its runs: see [Set a campaign's own context window](#set-a-campaigns-own-context-window).

## Over MCP or REST

An agent or a script can set the same models without this page:

- **MCP**, with the owner's or an operator's token: [`set_rig_model`](../../reference/mcp-tools.md#set_rig_model), with `agent` set to `workers`, `planner`, `teachers`, `auditor`, `review_panel`, `synthesizer` or `final_writer`. [`rig_models`](../../reference/mcp-tools.md#rig_models) reads each agent's model.
- **REST**, with the owner's token: [`POST /v1/rigs/<rig>/model`](../../reference/rest-api.md#the-agents-model) takes the same fields, and `GET /v1/rigs/<rig>/model` reads each agent's model.

Each call changes one agent, and the others keep their models. The checks and the refusals are this page's. `clear: true` sends the agent back to its default, as the first choice in its **Model** list does here: the rig's own settings for the workers, **same as the workers** for the planner, **same as the first teacher** for the synthesizer and the final writer, and the rig's advisors file for another advisor. Every agent takes `harness`, `context_window` and `compact_at`.

The names `combiner` and `panel` of v0.1.0 are refused: give `agent` `teachers` with `merged_by` for the teachers' merged by model, and `review_panel` for the review panel.

`harness` chooses the program any agent runs in: `pi`, `opencode` (OpenCode v2), `claude-code` or `codex` (the Codex CLI). Without it, the agent gets the one its model needs. A harness that can't run the model is refused, for example "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model."

For example, to give the auditor a model from a ChatGPT subscription named `chatgpt-pro`, run in the Codex CLI, call `set_rig_model` with:

```json
{ "rig": "rig-1", "agent": "auditor", "provider": "chatgpt-pro", "model": "gpt-pro", "harness": "codex", "effort": "high" }
```

The answer says "Control sent a model for the auditor to rig-1. The rig takes the change in less than one minute.", and its `agents` lists each agent's model after the change, with its `harness`. The auditor's **Runs in** on this page then shows **Codex**.

The teachers take one model or two over MCP and REST too. `provider` and `model` give the first teacher's model. `second_model` gives a second teacher, and `merged_by` the model that merges the advice of two teachers into one set. Each of those two is an object with `provider` and `model`, and may have its own `harness`, `effort`, `context_window` and `compact_at`. For example, to give the teachers a Claude subscription's model and a ChatGPT subscription's, merged by a third model:

```json
{ "rig": "rig-1", "agent": "teachers", "provider": "claude-max", "model": "opus-5.5",
  "second_model": { "provider": "chatgpt-pro", "model": "gpt-pro", "harness": "codex" },
  "merged_by": { "provider": "my-litellm", "model": "my-model" } }
```

The answer says "Control sent a model for the teachers, a model for a second teacher and a merged by model for the teachers to rig-1. The rig takes the change in less than one minute." Control checks every model in the call before it saves any: if one is refused, nothing changes.

- **One teacher**: give `"second_model": null`. The answer says "Control sent the teachers back to one teacher to rig-1. …"
- **Two teachers without a merged by model**: `"merged_by": null` sends the merged by model back to the rig's advisors file.
- **A call without `provider` and `model`** may give `second_model` or `merged_by` alone; the first teacher keeps its model. A second teacher needs a first one, in the call or from before: else `The teachers have no model of their own yet: give a provider and a model for the first teacher too.`
- **`clear: true`** sends all three back to the rig's advisors file: "the teachers back to the rig's advisors file".

`rig_models` shows the teachers as `{"models": [...], "merged_by": ...}`: one model or two in `models` (none: the teachers of the advisors file), and the merged by model or `null`. Its `advisors_file` says what the rig's advisors file sets up for each advisor, as the first choices on this page do, or is `null` until the rig's supervisor has reported it.

A cap and a point go with the agent's model in the same call. For example, to cap the planner's window and compact its conversations at 70%:

```json
{ "rig": "rig-1", "agent": "planner", "provider": "my-litellm", "model": "my-model", "context_window": 131072, "compact_at": 70 }
```

The answer adds "Its context window: 131,072 tokens (capped; the provider allows 204,800). Its conversations are compacted at 70% of the window." `rig_models` shows each agent's `context_cap` and `compact_at`. Each call sets them anew for that agent: a call without them removes the cap and goes back to 80%. A cap above what the provider lists is refused: `my-model takes at most 204,800 tokens.`

## Set a campaign's own context window

The rig sets each agent's window and point. A campaign can set its own for all its runs, for example to run two rigs on different models at the same window. Each agent's window is then the lower of the campaign's and its own, and the campaign's point replaces the rig's.

On the dashboard, a campaign has **Agents' context** in four places: on its page, in **New campaign**'s step **5 Where it runs**, in the **Copy** panel, and in **Start a run**'s summary. See [Set a campaign's agents' context](../campaigns/start-from-dashboard.md#set-the-agents-context). An agent or a script uses the twins:

- **MCP**: [`set_campaign_context`](../../reference/mcp-tools.md#set_campaign_context) with `{ "campaign": "sort-speed", "context_window": 131072, "compact_at": 70 }`.
- **REST**: [`POST /v1/campaigns/<campaign>/context`](../../reference/rest-api.md#a-campaigns-context-settings) with `{"context_window": 131072, "compact_at": 70}`.
- **The command line**: `thermite campaign context sort-speed --context-window 131072 --compact-at 70 --control URL --token-file F`. See [`campaign context`](../../reference/command-line.md#campaign-context).

Control saves a new version of the campaign, and runs started from then take it: `Version 3 of sort-speed is saved. Its runs' agents: a context window of 131,072 tokens, compaction at 70% of the window. Runs started from now take it.` A copy can take its own with `copy_campaign`'s `agents_context`, or `thermite campaign copy` with `--context-window` and `--compact-at`.

When you then start a run, the answer of **Start a run** (over REST, MCP or `thermite run start`) says what applies to each agent on that rig, such as "Workers: 131,072 tokens (wide-model), compacted at 70% of the window. Planner: 65,536 tokens (wide-model), compacted at 70% of the window." A window above what a provider lists for one of the rig's agents' models is refused before the run starts: "This campaign sets a context window of 150,000 tokens. narrow-model, the model of the teachers on rig-1, takes at most 131,072 tokens. …"

## An agent with no model

- **Workers** with no model use the rig's own settings. See [Use the rig's own settings instead](connect-a-provider.md#use-the-rigs-own-settings-instead).
- **The planner** with no model of its own uses the workers' model, harness and context. When neither has a model, when the **Planner** switch in section **1 · Parts of the rig** is off, or when the model gives no valid plan in two tries, the lanes take queued experiments in order, by fixed rules. That order skips the directions an **Avoid** rule names and puts **Always** and **Try** directions first. It applies only rules that name a direction the run has used; rules in other words are applied only by the planner's model. The switch's own text says the same: "When it is off: Lanes take queued experiments in order, by the fixed rules. Rules that name a direction still apply; free-word rules need the planner's model."
- **The synthesizer and the final writer** with no model of their own use the first teacher's model, harness and context: the **Teachers** line's, or else the first teacher of the rig's advisors file. With no teacher at all, they do not run: a research run's answer cards and its paper wait.
- **Another advisor** with no model uses the model that the rig's advisors file gives its role, such as `rig's file: opus-5.5` in its **Model** list. If the file has none, or the rig has no file, that advisor does not run: `none: off`. See [Configure advisors](../operate/advisors.md).

An advisor also runs only while its switch is on in section **1 · Parts of the rig**: **Teachers**, **Auditor** or **Review panel**. The teachers' merged by model follows the **Teachers** switch, and so do the synthesizer and the final writer while they use the first teacher's model. With a model of their own, they run with the **Teachers** switch off too. The switches are on by default, but a switch that is on runs nothing until its advisor also has a model, here or in the advisors file. Why each advisor exists is in [Supervision](../../explanation/supervision.md).

The switches also decide who can get your messages. In **Live**'s message box, the **To** list greys out the planner and each advisor whose switch is off, and says why, such as "The planner is off on this rig (Edit rig), so nothing would read it." Once the rig's supervisor has reported, the list also greys out an advisor it hasn't set up, such as one whose switch is on but which has no model: "This rig's supervisor has no auditor set up, so nothing would read it." Control refuses a message to any of them with those words, from **Live**, MCP, the REST API or the command line. With the planner off, a run's **Planner** tab shows no **Tell the planner** form, only a note and a link back here. See [Send the agents a message](../campaigns/steer-a-run.md#send-the-agents-a-message).

A change to the rig's settings on this page, such as a switch in section **1 · Parts of the rig**, a trial's length or the promotion rule, also shows in the **History** of the run at work on the rig, such as "You changed the rig's settings: the planner off."

## Where each agent runs

Each agent runs in one of four programs, its **harness**, chosen under **Runs in**. The first program in each cell is the one the page sets when you choose the model; the others can be chosen there, or over MCP or REST.

| Model from | Workers | Planner, with a model of its own | Advisors |
| --- | --- | --- | --- |
| An API key (OpenAI-compatible, Anthropic) or a ChatGPT subscription | Pi or OpenCode v2, as you choose; Codex too for an OpenAI-compatible key or a ChatGPT subscription | Pi; or OpenCode v2, or Codex for an OpenAI-compatible key or a ChatGPT subscription | Pi in the supervisor, with read-only tools; or OpenCode v2, or Codex for an OpenAI-compatible key or a ChatGPT subscription |
| OpenCode's own provider | OpenCode v2 only | OpenCode v2 only | OpenCode v2 only, in the supervisor |
| A Claude subscription | Claude Code only | Claude Code only, with no tools but read-only file tools for the run's past research | Claude Code only, in the supervisor |

- **The planner** in OpenCode, Claude Code or Codex runs as the planner's own user in the harness and answers with its plan as JSON, checked as Pi's plan is. In OpenCode and Codex it reaches its own model through the harness's proxy, which adds the key.
- **An advisor** in Claude Code, OpenCode v2 or Codex runs in the supervisor, in a folder of its own for each call, with none of the program's own tools: no shell, no file edits or reads, and no web. It gets only a read-only search of the run's past research and the kit's MCP tools for the advisors, which the supervisor serves on `127.0.0.1` for the call. OpenCode and Codex reach the model through a proxy the supervisor serves for the call, which adds the key, so the key is in none of their files. The [advisors file reference](../../reference/advisors-file.md#runtimes) gives each program's settings.

A Claude subscription needs Claude Code in the images: in the harness image for the workers and the planner, and in the supervisor image for the advisors. See [Use a Claude subscription](claude-subscription.md). The published harness and supervisor images carry OpenCode v2 and the Codex CLI.

Where the workers run also sets when they read a message you send them from **Live**. A worker in Pi reads it at its next step. A worker in Claude Code or Codex reads it inside its turn, through Thermite's hooks, and one in OpenCode after the next tool it starts, through Thermite's plugin. A message that arrives after the turn ended goes in with the worker's next turn, if it has not submitted a change and the trial has time left; otherwise the lane's next trial reads it. The planner reads its messages when it plans the next round. See [When each agent reads it](../campaigns/steer-a-run.md#when-each-agent-reads-it).

### Run the workers' program headless

A worker in Claude Code, Codex or OpenCode runs in the program's own terminal by default, for the whole trial, as you would run it yourself. Thermite follows the program's own session log and hooks there. The dashboard doesn't show the terminal yet. A rig can run the program headless instead, an advanced choice: one run of the program for each turn. [Agents in their own terminal](../../explanation/agents-lanes-planner.md#agents-in-their-own-terminal) says how each works.

1. On the rig's **Edit rig** page, in section **2 · The agents**, open **Advanced** under the agents' table.
2. Set **Agent programs run** to **Headless**, or back to **In their own terminal**. Its ⓘ says what each does.
3. Press **Save changes**. **What changes when you save** says "You change how agent programs run to Headless."

The rig takes the change in less than one minute. A trial that runs keeps its mode; the next trial starts in the new one. A worker in Pi draws its Pi view in its own terminal, and runs with no view when headless ([The Pi view](../../explanation/agents-lanes-planner.md#the-pi-view)). A rig whose harness is older runs its programs headless, and shows the field off, with "update the rig first". Over REST and MCP the field is `program_mode`, `terminal` or `headless` ([A rig's settings](../../reference/rest-api.md#a-rigs-settings)). On a rig control set up on a Kubernetes cluster with its CPUs and memory set, the mode also sets the supervisor's share of the memory, 4 GiB in their own terminal and 2 GiB headless, so a new one restarts the rig's pods, draining first while it works ([The supervisor's share](../install/rig-on-a-cluster.md#the-supervisors-share)).

The advisors' read-only tools are the campaign's brief and a search of the run's past research, plus a guarded web fetch and a knowledge base where the rig's advisors file sets them up. A knowledge base is a search service of your own, reached over MCP, that the teachers may search but not change: see the `kb` field in the [advisors file reference](../../reference/advisors-file.md#top-level).

The advisors can also call the tools of the [MCP servers](../campaigns/give-agents-mcp-tools.md) that a run's kit gives them: the teachers, the auditor and the review panel, given a model on this page or in the advisors file. In Pi each tool is one of theirs, and in Claude Code, OpenCode v2 or Codex the program reaches each server through the supervisor. On a rig whose advisors file lets advisors fetch any web page (`fetch_domains` `"*"`), no advisor gets them.

## Effort

**Effort** sets how long the model thinks before it answers. Its ⓘ says: "More effort: better answers, slower, and more of a subscription's window. Providers other than a Claude subscription take up to high. "model's default": Thermite sends no effort, and the model (or Claude Code) uses its own."

The list offers **model's default**, **low**, **medium**, **high**, **xhigh** and **max**. What reaches the model depends on the provider:

| Provider | model's default | low, medium, high | xhigh, max |
| --- | --- | --- | --- |
| Claude subscription | Claude Code's own default | Passed to Claude Code as its effort | Passed to Claude Code as its effort |
| Every other provider | Nothing is sent: the model's own default | Sent as the model's reasoning effort | Sent as **high** |

Two cases take no effort from this page:

- Agents that run in **OpenCode v2**: Thermite does not pass the effort to OpenCode. In **Codex**, the effort is Codex's reasoning effort, with **xhigh** and **max** sent as **high**.
- Workers with no model here, on the rig's own settings: they use the rig's `THERMITE_MODEL_REASONING_EFFORT` setting instead.

## Share a subscription

When any agent uses a subscription, a note under the table counts the agents on it, such as "Up to 3 agents on a Claude subscription and 1 agent on a ChatGPT subscription at once on this rig. When a plan is full, they wait." Each worker counts as one agent, each teacher and the merged by model as one each, and the review panel as three. The planner with no model of its own counts with the workers' subscription. The same plan may serve other rigs too. When the plan is full, these agents wait; nothing pays for more.

## Spending

Thermite has two money limits, and neither covers every agent on this page:

| Agent | What counts its spend |
| --- | --- |
| Workers | The contract's `budget.llm_usd`, but only on a rig that has token prices (`THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT`). The local stack can set them; rigs that control sets up on machines and clusters, or by a join command, can't have them yet |
| Planner | Nothing |
| An advisor given its model on this page | Nothing: it counts as $0 |
| An advisor in the advisors file | The file's `max_usd_per_day`, but only for `openai` runtimes with prices. Rigs that control sets up have no advisors file yet |

For the rest, give each campaign a stop time (**Stop after (hours)** on the **New campaign** page, or `budget.wall_hours`), set a spending limit at the provider if it has one, and watch the provider's own usage page. **Pause**, at the top of a run's page or in **Live**, then **Pause the run**, stops a run's workers and planner at once ([Steer a run](../campaigns/steer-a-run.md)). See [Set a budget or a stop time](../campaigns/budget-and-stop-time.md), [Configure advisors](../operate/advisors.md#spending), and the gaps listed in [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).

## If something goes wrong

The page checks each line as you type, in control's words, and keeps **Save changes** off while a line is refused. Control checks the form again when you save. A refused change shows on the rig's page, in a card that starts with **Not done.** and the line's name, such as "Not done. Auditor: A Claude subscription runs only in Claude Code: …". Nothing on the page is saved then: not the other lines, nor the switches or the settings. Open **Edit rig** again, change the line, and save again.

| You see | What to do |
| --- | --- |
| "That provider does not list that model." (or with a role in brackets) | Refresh the provider's models on **Providers**, or add the model by name there. |
| "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model." | Set that line's **Runs in** to **Claude Code**. Over MCP or REST, leave out `harness`, or give `claude-code`. |
| "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider." (or "… Pi, OpenCode v2 or Codex …" for a ChatGPT subscription or an OpenAI-compatible provider) | Set that line's **Runs in** to one of those. |
| "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider." | Set that line's **Runs in** to **Pi** or **OpenCode v2**, or give it a model from a ChatGPT subscription or an OpenAI-compatible provider. |
| "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the review panel, or another model." (for the workers: "… run only in the OpenCode harness: choose OpenCode v2 for this rig.") | Set that line's **Runs in** to **OpenCode v2**. Over MCP or REST, leave out `harness`, or give `opencode`. |
| "my-model takes at most 204,800 tokens.", or another word on a window or a point | Change the line's **Context** numbers: see [Set an agent's context window and compaction](#set-an-agents-context-window-and-compaction). |
| "Teacher 2: a second teacher needs a first. Choose the first teacher's model, or remove the second teacher." | Give the **Teachers** line a model, or press **×** beside the second teacher. |
| "This rig's harness is older: it does not report its settings and cannot take them." | The rig's images are older than control. The workers' model still works. On the local stack, build the images again ([Stop, start and update](../install/one-machine.md#stop-start-and-update)). A rig that control set up on a cluster moves onto newer images from its page: see [Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster). A rig on a machine, or one you joined, can't move yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)): add a new rig from newer images ([Push the images to your own registry](../install/own-registry.md)). |
