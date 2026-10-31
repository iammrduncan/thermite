---
title: "Configure advisors"
description: "Turn on the advisors that watch over a rig's research (the teachers, the auditor and the review panel), and write to them."
type: how-to
sidebar:
  order: 4
---

A rig's supervisor can run **the advisors**: models that watch the research but never judge it. Give them models on **Edit rig**, or in an advisors file, then check that they work.

- The **teachers**, one or two, review each running run, every hour by default and at once when its queue runs low. They bring a portfolio of new ideas for the run's [experiment queue](../campaigns/choose-what-runs-next.md) first, and rules for the planner only when new evidence calls for one. With two teachers, a **merged by** model joins their advice, and drops no distinct idea.
- The **auditor** answers the judge's audits: its clear is the last step before a change becomes the champion, and its block stops it. A rig without one has no audits.
- The **review panel** grades goals that code cannot check, and decides each question and required hypothesis of a research run, by a majority. Its pass meets the goal, or ends the research run with its final report, unless the run asks you to accept it ([Decide what waits for you](../campaigns/decide-what-waits.md#reviews)). A rig without one leaves such goals unmet, and keeps such research runs researching.
- The **synthesizer** keeps each research run's answer cards current: one card for each question, with its answer, certainty and gaps. It uses its own model from **Edit rig**, else the model of the rig's first teacher ([The synthesizer](#the-synthesizer)).
- The **final writer** writes the research paper of a research run whose questions the review panel found answered. It uses its own model from **Edit rig**, else the model of the rig's first teacher ([The final writer](#the-final-writer)).

[Supervision](../../explanation/supervision.md) explains what each one may and may not do. No advisor runs until it has a model. **Edit rig** also has a switch for each part, **on** by default; a switch only lets a role run once it has a model.

There are two ways to give them models, and you can mix them:

| | **On Edit rig** | **In the advisors file** |
| --- | --- | --- |
| Rigs | Every rig | Only the local compose stack. The units and manifests that control writes for the rigs it sets up, and for rigs you join, have no setting for the file ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)) |
| Models | A model from **Settings › Providers** for each role, a Claude subscription included | An OpenAI-compatible or Anthropic API, a command-line agent, OpenCode v2 or the Codex CLI, each key in a file of its own |
| Web fetch | No | Yes |
| Knowledge-base search, for the teachers | No | The file's own `kb`, for `openai` teachers |
| MCP servers that the run's kit gives the advisors | Yes, in every program an advisor runs in | Yes, for the `openai`, `opencode` and `codex` runtimes; not for `cli` |
| Counted toward a spending limit | No: these models count as $0 | Yes, with prices set ([Spending](#spending)) |

A role given a model on **Edit rig** uses it, and the other roles keep what the file says. On **Edit rig**, the first choice in each advisor's **Model** list names what the file gives that role, such as `rig's file: model-a`, or says `none: off` when the file gives it none.

:::caution[What limits the advisors' spending]
Advisors with a paid key spend money for as long as runs are running. Thermite sets no spending limit of its own.

- **Rigs that control sets up, and rigs you join,** get their advisors only from **Edit rig**, and Thermite counts what those spend as $0. Nothing in Thermite limits it: set a limit with your model provider before you give advisors a paid key.
- **On the local compose stack,** set `max_usd_per_day` in the advisors file. It counts only what the file's API advisors spend, from the prices you give them; advisors from **Edit rig** on the same rig add nothing to it. See [Spending](#spending).
:::

## On Edit rig

You need a provider on control. See [Connect a model provider](../models/connect-a-provider.md).

1. Open **Rigs** in the sidebar, choose the rig, then press **Edit rig**.
2. In **1 · Parts of the rig**, check that the switches **Teachers**, **Auditor** and **Review panel** are **on**. They are on by default, but a part with no model does nothing. **Teachers** also covers their merged by model.
3. In **2 · The agents**, under **The advisors**, choose a **Model** and an **Effort** for **Teachers**, **Auditor** and **Review panel**. For a second teacher, press **+ second teacher** under the first: a line for the second teacher and a **merged by** line show, the model that joins the two teachers' suggestions. See [Two teachers](../models/model-per-agent.md#two-teachers). For research runs, the **Synthesizer** and **Final writer** lines take a model of their own; leave them empty to use the first teacher's.
4. Check each line's **Runs in**, the program the advisor runs in, in the supervisor. When you choose a model, the page sets the program it needs, and you can choose another:
   - **Pi**: a model with an API key, or a ChatGPT subscription. Pi gives the advisor read-only tools.
   - **Claude Code**: a Claude subscription, which runs only there. Claude Code gets none of its own tools: only a read-only search of the run's past research, the teachers' read-only reads of the run's code and evidence and of its own research, and the MCP servers the run's kit gives the advisors, which the supervisor serves on localhost for the call. The supervisor's image must be built with `CLAUDE_CODE_VERSION` for this (see [Use a Claude subscription](../models/claude-subscription.md)).
   - **OpenCode v2**: OpenCode's own models, which run only there, or another model. OpenCode gets the same tools as Claude Code, and none of its own.
   - **Codex**: the Codex CLI, for a ChatGPT subscription or an OpenAI-compatible provider. It gets the same tools as Claude Code, and none of its own.

   The published supervisor image carries OpenCode and the Codex CLI. A program that can't run the model is refused under the line, such as "A Claude subscription runs only in Claude Code: choose Claude Code for the auditor, or another model."
5. Press **Save changes**.

The page says, for example, "Control sent a model for the teachers to rig-1. The rig takes the change in less than one minute." A review panel from **Edit rig** is always three reviewers with the same model; in the file, it is two or more. To give a role back to the file, choose the first choice in its **Model** list. It says what the role then uses: `rig's file: model-a` when the file has a model for it; `none: off` when the file has none, or the rig has no file, so the role does not run; or `rig's file` alone until the rig's supervisor has reported its file. Each advisor's **Context** cell sets its context window and compaction point: see [Set an agent's context window and compaction](../models/model-per-agent.md#set-an-agents-context-window-and-compaction).

## In the advisors file

1. Write the file. This one uses one OpenAI-compatible endpoint for every role:
   ```json title="advisors.json"
   {
     "teachers": [
       { "name": "teacher-a", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
       { "name": "teacher-b", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-b", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 1, "usd_per_mtok_out": 5 }
     ],
     "merged_by": { "name": "merged-by", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "auditor": { "name": "auditor", "runtime": "openai", "base_url": "https://llm.example.com/v1",
       "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key", "reasoning": "high",
       "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
     "review_panel": [
       { "name": "reviewer-a", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-a", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 3, "usd_per_mtok_out": 15 },
       { "name": "reviewer-b", "runtime": "openai", "base_url": "https://llm.example.com/v1",
         "model": "model-b", "api_key_file": "/etc/thermite/advisors/llm-key",
         "usd_per_mtok_in": 1, "usd_per_mtok_out": 5 }
     ],
     "teacher_minutes": 60,
     "fetch_domains": ["arxiv.org", "github.com"],
     "max_usd_per_day": 20
   }
   ```

   Leave out a role to turn it off. One teacher works alone, with no merge. Two teachers without `merged_by` give the set of the first review that comes back. A review panel needs at least two reviewers with different names: the file loads with one, but then each review fails with an `advisor error`. OpenCode's free models don't work in the file either, since they answer only OpenCode itself. Since v0.1.1 a file that still says `combiner` for `merged_by` or `panel` for `review_panel` is refused: rename the field. The [advisors file reference](../../reference/advisors-file.md) has every field.

2. Put the file and its key files in `.dev/advisors/`, which the local stack's supervisor sees as `/etc/thermite/advisors/`. Each key goes in a key file that the file names with `api_key_file`: the supervisor refuses a key or a token written into the file itself, and says where it comes from instead.

   ```sh
   cp advisors.json .dev/advisors/advisors.json
   printf '%s\n' "<your API key>" > .dev/advisors/llm-key
   ```

3. Name the file in the supervisor's `THERMITE_ADVISORS_FILE` setting. On the local stack, add this line to a `.env` file next to `compose.yaml`:

   ```sh
   THERMITE_ADVISORS_FILE=/etc/thermite/advisors/advisors.json
   ```

4. Start the supervisor again with the setting: `docker compose up -d` (or `podman compose up -d`), with your `-f` options if you start the stack with override files. With the `two-rigs` profile, `local-2`'s supervisor reads the same `.env` and folder, so both rigs get the same advisors.

The supervisor reads the file only when it starts, so after each change run `docker compose restart supervisor`. At its next report to control, within a minute, **Edit rig** names the file's models in the first choice of each advisor's **Model** list, such as `rig's file: model-a`, with the file's program under **Runs in** and its window under **Context**. The supervisor tells control only each role's model, program, provider name and kind of API, window and compaction point: never a key, a key file, an address or a command.

:::caution[A mistake in the file stops the rig's reports]
A file with a mistake stops the supervisor: its log has a `fatal` line with the reason, and it starts again and stops again until you fix the file. The supervisor is also the rig's link to control, so meanwhile the rig shows **Stale**, then **Offline**, on **Rigs**. There is no command that checks the file first. At least check that it is valid JSON before you restart, for example with `node -e 'JSON.parse(require("fs").readFileSync(".dev/advisors/advisors.json", "utf8"))'`, then watch `docker compose logs supervisor`.
:::

### Other runtimes and options

The example uses the `openai` runtime: a model API that the supervisor calls itself, with read-only tools. Add `"api": "anthropic"` for Anthropic's API. Four other runtimes exist:

- `cli`: a command-line agent that you install in the supervisor's image. It runs as an advisor user of its own, as every advisor's program does ([The supervisor's users](../../reference/ports-volumes-secrets.md#the-supervisors-users)), so it reads none of the supervisor's tokens or keys; still, its `argv` must turn off the agent's own shell and file tools, and the file must say `"restricted": true`: your statement that the `argv` does so.
- `claude-code`: Claude Code with a Claude subscription. It comes only from **Edit rig**, where control keeps the subscription's token: a file that gives a role `claude-code`, or holds a `token`, stops the supervisor at start ([How the file is read](../../reference/advisors-file.md#how-the-file-is-read)).
- `opencode` and `codex`: OpenCode v2 and the Codex CLI, which the supervisor image carries. Thermite sets each up with none of its own tools, only the search of the run's past research, the teachers' reads of the run's code and evidence and of its own research, and the kit's MCP tools, and reaches the model through a proxy for each call, which adds the key.

On a rig whose agent programs run in their own terminal (**Edit rig › 2 · The agents › Advanced › Agent programs run**), the teachers, the auditor and the review panel's reviewers in `claude-code`, `opencode` or `codex` run each call in that program's own terminal, and those in `openai` (Pi) in their own Pi view, with the same tools, where you can watch them and type into them, and where your messages to them go in inside their turn ([An advisor's terminal](../campaigns/agent-terminal.md#an-advisors-terminal)). The teachers' merged by model, the synthesizer, the final writer, and the `cli` runtime run as before.

`fetch_domains` lists the sites that the teachers and the auditor may read, for papers and upstream code; leave it out for no web fetch. The optional `kb` field connects a knowledge base of your own: a search service over your notes or documents, reached over MCP, which the teachers may search but not change. Its `mcp_url` starts with `https://`, or with `http://` only for this machine itself, and its token is in the file that `token_file` names; another address stops the supervisor at start. A search that can't connect in 30 seconds, or gets no answer in 120, fails, and the teacher goes on without it ([`kb`](../../reference/advisors-file.md#top-level)). With `"*"` (any public site) in `fetch_domains`, the teachers get no knowledge-base search at all, no reads of the run's code and evidence, and no reads of its own research beyond the summary in their brief, and their brief leaves out the background and the past-research line described in [What they read](#what-they-read-and-their-field-notes), both in their prompt and from their `brief` tool. The [advisors file reference](../../reference/advisors-file.md#runtimes) has every runtime's fields, and what each role may read and fetch.

On any rig, without the file, a campaign's kit can give its advisors **MCP servers**, such as a knowledge base you run: add the server in **Settings › Providers › MCP servers**, then tick **Advisors** for it in the kit's **MCP servers for the agents** ([Give agents MCP tools](../campaigns/give-agents-mcp-tools.md)). The teachers, the auditor and the review panel then get its tools; the teachers' merged by model gets none. The supervisor makes each call with the sign-in control gives it, and the advisor sees the tools and their answers, never the secret. With `"*"` in `fetch_domains`, the advisors get no MCP server, and the run's live view says so once ([MCP servers](../../reference/advisors-file.md#mcp-servers)).

## The synthesizer

The synthesizer rewrites a research run's [answer cards](../../explanation/campaign-modes.md#answer-cards) from the run's newly verified claims: at each round, one call for each running research run with a question whose evidence changed since its card. Code checks each card before it keeps it.

- **Its model.** Its own, on the **Synthesizer** line of **Edit rig**, or with `set_rig_model` and `agent` `synthesizer`. With none, the first teacher's: on **Edit rig**, or the first of the advisors file's `teachers`; then, with the teachers switched off on **Edit rig**, or no teacher at all, the rig has no synthesizer, and its research runs' questions keep no cards. With its own model, it runs with the teachers switched off too. Its calls count as the **Synthesizer**'s in the run's model usage, in rounds named `cards <time>`.
- **Its tools.** The teachers' read-only tools for the run's research, served on localhost in Claude Code, OpenCode and the Codex CLI; a `cli` synthesizer gets none. It never fetches a web page, searches a knowledge base or gets an MCP server.
- **How often.** Whenever a question's evidence changed and the supervisor runs a round (every `THERMITE_POLL_SECONDS`, 60 by default, after the last round ends). While a run's claims keep coming, it gets a call in most rounds: [set a spending limit](#spending) if its model uses a paid key.

In a run's **Live**, under **Advisors**, its lines read, for example, `the synthesizer (teacher-1) writes the answer cards of questions 1, 3: their evidence changed` (`(synthesizer)` with a model of its own), then `the harness kept the answer cards of questions 1, 3`, with `. it refused question 2's (the number 7777 is not in the claims it cites): the synthesizer writes it again at the next round` for a card the harness refused. The harness's own line shows under **Everyone**: `the synthesizer teacher-1 wrote the answer cards of question 1 (version 4), question 3 (version 2)`, and for a refused card `the harness refused the card of question 2 (…): the old card stands, and the problems go back with the next request`. The run's **History** has a line for each card: `The synthesizer wrote the answer card of question 1 (version 4): certainty moderate, 6 claims cited, 2 open gaps.`, or `The harness refused the synthesizer's answer card of question 2: 1 problem, the first: …. The old card stands.`

## The final writer

When a research run ends, by the review panel's accepted pass or by the progress rule, the final writer writes the run's [research paper](../../explanation/campaign-modes.md#the-research-paper): one whole paper in Simplified Technical English, written from the answer cards, with the review panel's decisions and certainty, what stayed open, a table of the hypotheses' verdicts, the limits of the evidence and the next experiments. Code checks it, and appends the review panel's decisions with each dissent and the references, before it leads the run's final report.

- **Its model.** Its own, on the **Final writer** line of **Edit rig**, or with `set_rig_model` and `agent` `final_writer`. With none, the first teacher's: on **Edit rig**, or the first of the advisors file's `teachers`, with that runtime's options; then, with the teachers switched off on **Edit rig**, or no teacher at all, the rig has no final writer, and a research run that ended closes with the review panel's decisions alone. With its own model, it runs with the teachers switched off too. Its calls count as the **Final writer**'s in the run's model usage, in rounds named `final paper <review>`.
- **Its tools.** The teachers' read-only tools for the run's research, `check_paper`, which runs the harness's checks on a draft and gives each problem with its line, and `ste_check`, which runs the rig's STE checker. In Claude Code, OpenCode and the Codex CLI the supervisor serves them on localhost for the call, as it serves the research tools; a `cli` writer gets none. It never fetches a web page, searches a knowledge base or gets an MCP server, so it reads the run's research even on a rig whose teachers may fetch any page (`"*"` in `fetch_domains`).
- **An STE checker.** Thermite ships none. To check the papers' style, put a checker in the supervisor's container, such as in a folder you mount there, and set [`THERMITE_STE_CHECKER`](../../reference/settings.md#places-and-advisors) in the supervisor's environment to its script. The compose file and the rigs control sets up pass no such folder or variable: add both to the supervisor's container yourself. The supervisor runs the script with its own Node, as `node <path> --json --mode descriptive -`, with the text on its input, and reads the JSON it prints: `{version, issue, counts, findings}`, each finding with its line, column, severity, rule, message and text. The script must exit with 0, or 1 when it found an error, within 120 seconds. The supervisor runs it itself on the paper it posts, and the harness refuses a paper with an error. A checker that fails (another exit code, no JSON, no answer in time, or no script at the path) means the paper is not posted that round: it is an error, and the paper is tried again 30 minutes later, never posted unchecked. When `reference/ste-guide.md` is beside the script's folder (the folder `reference` next to the one the script is in), the writer's prompt carries that guide, up to 60,000 characters; otherwise short STE rules in Thermite's own words. Without a checker, `ste_check` says `the rig has no STE checker`, and the paper is accepted as not checked.

In a run's **Live**, under **Advisors**, the final writer's lines read, for example, `the final writer (teacher-1) writes the research paper` (`(final-writer)` with a model of its own), with ` (try 2)` from its second try and `; the rig has no STE checker, so its style is not checked` on a rig without one; `the research paper is in: 12 claims cited, 2 next experiments kept in the knowledge base, STE checked`; or `the harness refused the research paper (3 problems): …. The final writer writes it again at the next round`. The harness's own lines show under **Everyone**: `the final writer is asked for the run's research paper`, `the final writer's paper was refused: 3 problems, the first: …`, `the research paper is in: 12 claims cited, 2 next experiments, STE checked` (or `STE not checked (no checker)`), and, on a rig with no final writer, `every question is answered; the run ends with no research paper: no final writer on this rig`. A refused paper is written again at the next round, with the problems in its brief. A try that gave no paper, such as a model error, a checker that failed, or, in Pi, an answer refused for the same problems three times running, is an error line (`the research paper of <run>: …`) and is tried again 30 minutes later. There is no limit on tries.

## What they read, and their field notes

Besides the run's own records, the advisors read what the run's agents noted and what you picked from past research. All of it reaches them marked as data, not instructions:

- **The teachers' brief** has the newest attempts with the judge's reasons, why each experiment tried ended as it did, the queue's target and how many experiments it holds ready, and what the teachers proposed before and what became of it. The teachers also read the run's code and evidence, read only, with `list_files`, `read_file`, `read_diff` and `read_evidence`: the champion's tree, the attempts' diffs and the judge's findings. A research run has no code, so its teachers get none of these tools. They never see held-out results or the kit's files ([Supervision](../../explanation/supervision.md#what-they-read)).
- **What the run itself found.** A research run's brief starts with a short summary of its research: how many sources, claims (verified and draft), hypotheses, findings, notes and files it has, each question's coverage, and the start of its newest report. Its teachers read the rest, read only, with `list_research`, `read_source`, `read_research_file` and `search_research`: the sources with their archived text, the claims with the harness's reasons for a draft, the hypotheses and findings, the research notes, the report and each lane's files, such as a lane's synthesis of a question. They are told to read what the run found before they propose. A hill-climb or goal run's teachers get the same summary and tools once its workers recorded a source, a claim or a note ([The run's own research](../../reference/advisors-file.md#the-runs-own-research)).

- **The teachers' brief** holds the run's 20 newest [field notes](../../explanation/journals-and-knowledge.md), by every writer: the short notes the workers, the planner and the advisors keep as they work. It also holds the run's **background**: the findings, claims, notes and reports from earlier runs that you picked when you started the run ([Use past research in a new run](../campaigns/use-past-research.md)). When the run's `knowledge/` folder holds past research from the collections its campaign may read, the brief has one line that says what it holds; the teachers read no files, and the workers search that folder. For teachers that may fetch any web page (`"*"` in the advisors file's `fetch_domains`), the supervisor leaves the background and that line out of their brief: out of their prompt, and out of what their `brief` tool returns. Their brief keeps the field notes.
- **The auditor's and each reviewer's package** hold the background, and neither the field notes nor that line.
- **Every brief and package** holds the campaign's brief from its author, whole, when it has one: its additional information, starting links, ideas to try and hypotheses, as `campaign_brief`. It comes before the evidence and the diff, so a package cut at its end, to fit the advisor's window or its size limit, loses those first. The advisors take it as the author's view, and the review panel uses it to read the criteria, not as more criteria. See [The campaign's brief](../../reference/contract.md#the-campaigns-brief).

Every advisor may also write field notes: each teacher, the teachers' merged by model, the auditor and each reviewer of the review panel. A note is an observation, a decision and why, a surprise, an open question or a lesson. The supervisor posts an advisor's notes after its review, audit or verdict, and the rig records each one as written by `<role>:<name>`, such as `teachers:teacher-1`, `teachers:merged-by`, `auditor:auditor` or `review_panel:reviewer-2`. Notes written before v0.1.1 say `panel:`; the pages show them under the review panel. They show:

- on the run's **Journal** tab, under the writers **Teachers**, **Auditor** and **Review panel**;
- in the run's **Live**, under **Advisors**, such as `teachers:teacher-1 noted (lesson): …`;
- in the workers' briefs, when they are among the run's newest decisions and lessons.

A note the rig can't keep never costs the advisor's work: its review, audit or verdict stands, and **Live** says what went wrong, such as `the field notes of teacher-1: note 2: not recorded: …`.

## Spending

`max_usd_per_day` sets a limit for all advisors of the rig together, per day (UTC). There is no limit unless you set one. Each rig counts its own spending, so with two rigs on the stack, each has the whole limit.

- The limit counts only `openai` runtimes in the file, from their `usd_per_mtok_in` and `usd_per_mtok_out` prices. Without prices, they count as free.
- `cli` and `claude-code` advisors, and every model given on **Edit rig**, count as $0: they add nothing to the total.
- When the day's total reaches the limit, every advisor of the rig skips its turns until the next UTC day, wherever its model comes from. The research itself goes on.
- At the limit, a message you write to the teachers starts no round. The run's **Live** says so once for each new message, under **Advisors**: `the advisors reached the day's spending limit (20 USD): the teachers read your message after midnight UTC`.
- The check comes before each role's turn, so a round can go a little past the limit.

## Check that they work

Wait a minute, then press **refresh** in the status bar, the line along the bottom of the rig's page:

- The **Advisors** row of the **The rig** block shows `N teacher rounds · N directive sets · N audits · N errors · $N.NN` instead of `none configured`.
- A run's **Live** page shows each step of the advisors' rounds for that run when you choose **Advisors**. Open it with **Live** on the run's page, or **Live** in the sidebar, which opens a run at work. The lines read, for example:
  - `the teachers review run-1`, or `the teachers review run-1 now: its queue has 1 of its target of 4 experiments ready: ideas are wanted now` when a low queue started the round;
  - `teacher teacher-a: …`, with what it suggests, or `teacher teacher-b gave no review: …`;
  - `directives for the planner: …`, each with its reason, or `the teachers set no directives`, with `. Dropped: …` for what the supervisor left out, such as an opportunity without evidence or a rule that would freeze the queue's size;
  - `the teachers added to the queue: …`, with the titles of their portfolio's experiments, `the teachers moved …`, with their ids, and `refused: add "…": it repeats x-… (up next)` for an idea already waiting, or, in a research run, `refused: add "…": this asks for a measurement ("…"), …` for one that only a measurement could settle;
  - `audit of …`, with the attempt, which try of that audit it is (`(try 1)`), the auditor's decision, what it did to the result and why; after the last try, `audit of …: the auditor could not answer after 5 tries, so it waits for the owner`, or, when that hand-off fails, `audit of …: handing it to the owner (tried again in 30 minutes): …`;
  - `the auditor added to the queue: …`, with the title of its check;
  - `review …`, with each reviewer's pass or fail and why, then the review panel's outcome; for a research run, `review 3 of the research questions, reviewer-1: pass. Questions: 2 answered, 0 insufficient, 0 open; 1 hypotheses judged. …`; the reviewers of a review work at once, and their lines come in the review panel's order once all have answered. When a reviewer gives no answer, the line is an error that names it, `review 3: 1 of 2 reviewers of the review panel answered (reviewer-2: …)`, and the review is tried again 30 minutes later; from its fifth try, it is posted as not passed, each reviewer with no answer giving none: `review 3: … in try 5: posted as not passed`;
  - `advisor round done: …`, the round's counts, when the round did something.

  The rig's own live view (the **Live** button on the rig's page) shows the same lines when you choose **Supervisor** in its list.
- When the teachers' advice reaches a run, its **History** tab has a line for each rule they set, such as `The teachers set a rule for the plan: avoid :loop-tiling:.`, and for each experiment they add, such as `The teachers added "Unroll the loop by 4" to the queue.` A rule they set for a direction the run doesn't have yet is designed by the planner at its next round. Advisors can't bring back a rule you removed: History then says, for example, `The teachers named a rule you removed (avoid :loop-tiling:): left out.` ([Remove a rule](../campaigns/choose-what-runs-next.md#remove-a-rule)). A rule that would freeze the queue's size or pin an experiment is left out too: History says, for example, `The teachers gave a rule that would freeze the queue's size (note): left out.`, and why. When a round leaves the queue below its target, History says `After round 3, the queue had 1 of its target of 4 experiments ready: the teachers were asked for ideas at once.` In a research run, a rule for a direction that is not one of its task kinds is left out too: History says, for example, `The teachers named a direction this research run doesn't have (try :blog-posts:): left out.`, and why.
- The run's **Experiments** tab shows the experiments the advisors added, with **teachers** or **auditor** as who added each one.

A count of errors that grows means a role keeps failing. Each error is a line in **Live** with its reason, such as `audit of …: advisor auditor has no key`, and the supervisor's log has an `advisor error` line with the same reason. When the rig can't record an advisor's experiments and moves at all, the error line starts with `the queue for run-1:`. A move that the rig refuses, for example of an experiment a lane has taken since, shows after `refused:` in the advisor's own line, and the other changes still apply.

## Write to the advisors

You write to a run's advisors as you write to its agents: on the run's **Live** page, choose **To the teachers**, **To the auditor**, **To the review panel** or **To all advisors** under **To**, write, and press **Send**. See [Send the agents a message](../campaigns/steer-a-run.md#send-the-agents-a-message).

The teachers read it in a round that starts at once; the auditor and the review panel only with their next audit or review. Each advisor that reads it answers in one or two sentences in **Live**, such as "the teachers (teacher-a) answered you: …". [When each agent reads it](../campaigns/steer-a-run.md#when-each-agent-reads-it) gives each reader's timing, and [`message_agent`](../../reference/signed-commands.md#message_agent) lists the reasons a message is refused. A role with no model is greyed out under **To**, once the rig's supervisor has reported its advisors, and control refuses a message to it however it is sent, such as `This rig's supervisor has no teachers set up, so nothing would read it.` Before the supervisor has reported, control can't tell: a message to such a role goes to the rig, and nothing reads it until you give the role a model.
