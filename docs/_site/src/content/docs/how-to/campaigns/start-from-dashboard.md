---
title: "Start a campaign from the dashboard"
description: "Use the New campaign page to say what to improve, where the project is, how to measure it and which rig runs it."
type: how-to
sidebar:
  order: 1
---

The **New campaign** page starts a [campaign](../../reference/glossary.md) in six steps, five for research. Control checks your answers, saves the campaign, and starts its first run on the [rig](../../reference/glossary.md) you choose. For a guided first time, follow [Your own project, from the New campaign page](../../tutorials/your-own-project.md).

## Before you start

- You are signed in to the dashboard with the owner's token.
- A rig reports to control: on **Rigs**, in the sidebar on the left, it shows the green **Live** chip and a hardware line. The campaign measures on this rig's target, CPU or GPU.
- Your project is in a git repository at an `https://` address, or in a private repository with Git access set up: see [Use a private repository](private-repository.md).
- For agents to work, the rig needs a model from a provider in **Settings › Providers**: see [Connect a model provider](../models/connect-a-provider.md). The page won't start agents on a rig without a model; **Try the kit first** and **Save without starting** work without one. You can give the rig a model in step 5, but then **Start the campaign** only saves the campaign: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
- If the model uses a paid API key, set **Stop after (hours)** in step 5 under **Advanced**. See [Set a budget or a stop time](budget-and-stop-time.md).

## 1. Aim

Open **Campaigns** in the sidebar and press **New campaign**, at the top right of the page. The page shows the steps **1 Aim**, **2 The brief**, **3 Project** (not for research), **4 How to measure** (**4 Time and tools** for research), **5 Where it runs** and **6 Review and start**. Move with **Next** and **Back**. Hover over the "i" beside a field to read what it means.

Choose a card: it sets the campaign's mode. [Choose a campaign mode](choose-a-mode.md) helps you pick one, and [Campaign modes](../../explanation/campaign-modes.md) explains each.

| Card | Use it to | It ends when |
| --- | --- | --- |
| **Hill climb** | Improve one measured number, such as speed, size or accuracy | Never on its own: you pause it or close it |
| **Reach a list of goals** | Work until checks you write all pass | Every goal is met |
| **Research a question** | Collect sourced findings. No code changes | The rig's review panel finds every question answered, its open questions stop adding, or you close it ([Time and tools](#time-and-tools)) |

Fill in **Campaign name** (lowercase letters, digits, dashes and underscores, such as `sort-speed`) and **Title** (one sentence; agents read it too). Runs are named after the campaign and numbered across every rig: `sort-speed-1`, `sort-speed-2`. A run's name is used once on control. Using a name again saves a new version of that campaign, and the page doesn't warn you that the name is in use. Nothing that ran changes: runs that exist keep their version, and later runs use the new one. This is how you change a campaign made here, such as its stop time: fill in the page again with the same name. The page starts empty each time.

## 2. The brief

**The brief** says what the agents should know. They get it as starting points, not rules: the objective, the judge and your messages decide. Only a research campaign's **Topic** and **Questions** are required: leave the rest empty if you have nothing to add.

| Field | Mode | What it does |
| --- | --- | --- |
| **Topic** | Research | What the agents research, in one sentence |
| **Questions** | Research | What the research must answer, one question in each box. A question can be long and have several lines. **Add a question** adds a box, and **×** removes one. At least one. Every finding answers one of them, and the report counts the verified claims for each |
| **Additional information** | All | Background in Markdown: the project and its links, what was tried, limits, and what good looks like. No length limit. The preview beside the box shows it as it renders, as you type |
| **Starting links** | All | Pages for the agents, one address per line. For research, the harness fetches and archives them when the run starts, one after another, while the first trials run; **Live** says how many it has archived. For a hill climb or goals, the agents get them with the brief, and a worker fetches one when it needs it. Links written in **Additional information** reach the agents too, but nothing fetches them first |
| **Ideas to try** | Hill climb and goals | One idea in each box. The planner turns those that fit into experiments, and every worker reads them |
| **Hypotheses** | All | What you think is true, one in each box, for the agents to test. A research run starts with them as its own hypotheses |

**Add an idea** and **Add a hypothesis** add a box, as **Add a question** does. A box grows with its text. Empty boxes are left out. The count beside each list follows it, such as `3 ideas`; an empty list says `None yet. Empty is fine.`, and **Questions** says `At least one.` in red while it has none. The line under **Starting links** counts them, such as `2 links.`, or says in red which line is not a web address: `Line 2 is not a web address: write each as https://…`

The line under **Additional information** counts the whole brief as you type: the text, the starting links, the ideas and the hypotheses. While the text is empty it says `Markdown. Empty is fine.` Up to 32,000 characters it says, for example, `Markdown · 1,240 characters. Every agent gets all of it.` Over that, it says `Markdown · 40,512 characters. Each worker's brief has the first 32,000; the rest is in BRIEF.md in the run's folder. The planner gets all of it, and the advisors as much as their window takes.` A campaign goes to a rig in one signed command of at most 3.5 MiB: a brief of more than about 3,000,000 bytes shows `Too long to send: a campaign goes to a rig in one command of at most 3.5 MiB.` in red.

Control keeps the brief in the campaign's contract: [The campaign's brief](../../reference/contract.md#the-campaigns-brief) lists the fields and what each agent gets. The campaign's page shows it under **The brief**: the questions, the starting links, the ideas and the hypotheses, then the additional information as it renders. A long text is folded, with its size; press it to open it.

## 3. Project

Research campaigns skip this step.

| Field | What to enter |
| --- | --- |
| **Repository** | The project's address, such as `https://git.example.com/you/project.git`. Rigs fetch it themselves. Thermite never pushes to it |
| **Start from** | A branch, a tag or a full commit. Empty: the default branch. Control pins it to one commit, so every run starts from the same code |
| **Folder in the repository** | Empty when the project is the whole repository. For a project in one folder of a repository, the folder's path from the top, such as `examples/matmul-cpu/project`. The rig fetches the whole repository, and the run starts from the folder: the agents see only its files. **Files the agents may change**, the kit's commands and the champion's patch are then paths inside the folder |
| **Repository access** | **Public: no key**, or a Git access from **Settings** |
| **Files the agents may change** | Patterns, one per line, such as `src/**`. A change to any other file is refused before it is built |
| **Lines never allowed** (under **Advanced**) | Regular expressions, one per line, such as `clock_gettime`. A change that adds a matching line is refused |

Press **Look it up**. Control reads the repository's file names, not their contents, and shows a line such as `Found: main is at 1a2b3c4 · 214 files. Rigs fetch it from there.` with a few folders as buttons. With a folder, it counts and suggests only the folder's files, from the folder's top: `Found: main is at 1a2b3c4 · 4 files in examples/matmul-cpu/project. Rigs fetch it from there.` Press a folder to add it to **Files the agents may change**. If you skip **Look it up**, control looks the commit up when you start.

:::caution
- Without Git access, control reads only `https://` addresses. Others give `the repository must be an https:// URL, or choose Git access for a private one`.
- A private repository without access gives `control cannot read it without a key: is the repository private?`
- A folder the commit doesn't have gives `main has no folder examples/none, or the folder has no files`, and a path that leaves the repository, such as `../src`, gives `The folder is a path in the repository, such as examples/matmul-cpu/project: no / at either end, and no part that starts with a dot.`
- If you change **Repository**, **Start from** or **Folder in the repository** after **Look it up**, press it again: the page keeps the commit it found first.
:::

## 4. How to measure

The judge needs a [kit](../../explanation/kits.md): how to build your project, run it on test cases and check the output. This page calls a test case a **case**; a `kit.json` and a contract call it a **cell**. Agents never see the kit. Choose a card:

- **Describe it here**: a few commands and test cases. Control writes the kit and keeps it.
- **A kit in a repository**: a kit you keep in git. See [Write a kit for your project](write-a-kit.md).
- **Upload a kit**: a `.zip`, `.tar.gz`, `.tgz` or `.tar` file holding a kit.

### Describe it here

| Field | What to enter |
| --- | --- |
| **Run** | The command that runs your program for one case, such as `{build}/build/app {args} --out {out}/result.txt`. The buttons below it insert placeholders |
| **Test cases** | One row per case: **Name**, **Arguments**, **Input file**, **Work done** and **Hidden test**. **Work done** is only for a score as a rate: how much one run of the case does, such as the number of items sorted. **Add a case** adds a row. **Paste a list…** takes one case per line: its name, then its arguments |
| **Input files** | Files the cases run on, such as datasets |
| **The score** | **How long a run takes** (shorter is better), or **A number your check works out**, with **The number's name**, **Better is** and **Unit** |
| **Smallest gain that counts (%)** | 5 unless changed. A change must beat the best so far by this much, on repeated runs |
| **Runs per case** | 1, 3 or 5 (3 unless changed). The middle value counts |
| **Is it right?** | The check: a command, such as `python3 {kit}/check.py {out}/result.txt`. It runs after each case. Exit 0 means the result is right, and any other exit means it is wrong. To report a score, it also prints, as its last line, a JSON object with `pass` and the number, such as `{"pass": true, "accuracy": 0.93}` |
| **Files for the check** | Scripts and expected answers the check uses. The run can read them only if you tick **the run reads these too** before you choose them. Never let the run read the answers |
| **Build** | The command that builds the project in a fresh copy of the code, such as `make`. Empty: `true`, for a project with nothing to build |
| **What the build makes** | The files or folders the run needs, separated by spaces, such as `build/app` |

The placeholders, in **Run** and in **Is it right?**, are `{args}` (the case's **Arguments**), `{input}` (its **Input file**), `{build}` (what the build made: `{build}/build/app`), `{out}` (a folder for the run's results, which the check reads) and `{kit}` (the **Files for the check**). Any other gives `{x} is not a placeholder here: use {args}, {input}, {build}, {out} or {kit}`. This short set is the page's own: a `kit.json` you write yourself has other placeholders, and there the check's exit code doesn't count, only its JSON line. See [Write a kit for your project](write-a-kit.md).

- A **Hidden test** case is used only to double-check a change that already looks better, and, in a goal campaign, the champion before the run closes, so a change can't win by helping only the cases agents see. At least one case must not be hidden.
- With **How long a run takes**, the score is a time, better lower. When every case, hidden ones too, has a **Work done** value, the score is a rate instead: **Work done** divided by the time, such as items per second, better higher.
- A kit described here takes up to 64 cases, 32 check files and 32 input files, each up to about 10 MB.

### A kit in a repository

This card has no **Better is** or **Smallest gain that counts (%)** of its own: the page takes them from the **Describe it here** card, as higher and 5% unless you change them there ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). So, for a hill climb:

1. Choose **Describe it here**. Under **The score**, choose **A number your check works out**, so that **Better is** shows. Set it to the way your kit's metric improves: **lower** for a time.
2. Set **Smallest gain that counts (%)**.
3. Choose **A kit in a repository**. Fill in **Kit repository**, **Kit repository access**, **Kit commit** (the full commit), **Cases to measure** and **Hidden tests** (case names separated by spaces), and **The kit's metric** (a metric name from its `kit.json`).

For a goal campaign, do only step 3, without **The kit's metric**. Control reads only the MCP servers that this kit's `kit.json` names ([below](#mcp-servers-for-the-agents)); the rig checks the kit when the run starts.

### Upload a kit

Choose the file under **Kit archive**. It holds `kit.json` at its top or inside one folder, and has at most 2000 files, 64 MB in all, and no links. From a kit kept in git, `git archive --format=tar.gz -o kit.tar.gz HEAD` makes one. Control leaves out what a Mac adds to an archive: the hidden `._` files that `tar` puts beside each file, the `__MACOSX` folder of a zip made in the Finder, and `.DS_Store` files. Control checks `kit.json` and shows a line such as `smoke-cpu: measures on cpu, 3 cases, scores flops_per_s.` Nothing in the kit runs until a run starts.

Under **The kit's cases**, mark each case **Measured**, **Hidden test** or **Not used**. For a hill climb, also choose **The score**, **Better is** and **Smallest gain that counts (%)**. A time is always better lower.

### Goals

A goal campaign has a **Goals** table. Each row has **The goal**, **Checked by** and **Detail**. **Add a goal** adds a row. Every goal made here is required.

| Checked by | Detail | Works with |
| --- | --- | --- |
| **the check passes on cases** | Case names, such as `small large` | A kit described here |
| **the score reaches** | A bound and cases, such as `>= 4e13 on large` | A kit described here, or uploaded (its first metric) |
| **the kit's own check** | The name of a verifier in the kit's `kit.json` | A kit in a repository, or uploaded |
| **people review it** | Criteria separated by `;` | Any kit, on a rig with a review panel: see [Decide what waits for you](decide-what-waits.md#reviews) |

A goal campaign made here can't end as "not possible": it runs until every goal is met, or until you stop it. See [Decide what waits for you](decide-what-waits.md#not-possible-endings).

### MCP servers for the agents

The last part of **How to measure** gives the campaign's agents tools from outside Thermite: the MCP servers in **Settings › Providers**, such as a knowledge base or a code host. Skip it and the agents have only Thermite's own tools.

1. Tick a server. The workers get it at once; choose the agents that get it: **Workers**, **Planner**, **Advisors**.
2. Optional: open **Advanced: its tools for each kind of agent** under the server, and untick a tool for the agents that should not call it. Tools that change something on the server are marked **writes**.

The line under the list says what each kind of agent gets, such as `The workers get 31 tools from gbrain; the planner gets none; the advisors get 31 tools from gbrain.`, and warns of a server that is not in **Settings**, of one that doesn't work now, of one with no agents, and of a kind of agent left with no tool. **What goes into kit.json** shows the list. A kit described here gets it in its `kit.json`. An uploaded kit's list starts as its `kit.json` has it, and a change is written into the kit control keeps. A server it names that **Settings** lacks stays in the list, with `paper-search is not in Settings: this campaign can't start until it is. The uploaded kit names it: add it in Settings, or upload the kit without it.` A tool limit in its `kit.json` stays for a server whose tools **Settings** has not read. For **A kit in a repository**, the list is read from the kit's `kit.json` once you fill in **Kit repository** and **Kit commit**, each server marked `✓ found` or `✕ missing`, with **Add it in Settings** for a missing one; change it in the kit's repository. [Give agents MCP tools](give-agents-mcp-tools.md) says more.

### Time and tools

For research, step 4 is **Time and tools**. It asks for **Run for at least**, such as `8h` or `2d`: the time the run has to collect sources and claims. The topic, the questions and the starting links are in [the brief](#2-the-brief), on step 2. It is a floor, never a stop. After it, at each digest, the rig's review panel decides each question and each hypothesis that needs a verdict; once every question has an end, the run writes its final report, with its research paper and the decisions, and ends by itself, as it does when its open questions stop adding ([When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends)). A research run made here has no end time otherwise: without such an end, it runs until you stop it. Time while it is paused, or while its agents could not work, doesn't count. Beside it, **Verified claims before the check** sets a floor: the run must have at least that many verified claims, in all, before the review panel first checks it. It only delays the check. Leave it empty for no floor: then the check needs only an answer card for each question. A number with a fraction, or below 1, is refused: `Verified claims before the check is a whole number` or `Verified claims before the check is 1 or more`. **MCP servers for the agents** is on this step too, as [above](#mcp-servers-for-the-agents); control writes the servers into the campaign's contract.

## 5. Where it runs

Choose the rig. Each card shows its hardware, whether it is idle, and its agents' model after `agents:`, followed by ` (OpenCode v2)` or ` (Codex)` when they run there, or `no model for its agents yet` in red. A rig that is not reporting can't be chosen. A [rig on RunPod](../install/runpod-rig.md) whose pod is stopped can: its card says `its pod is stopped: the first run starts it`, and control starts the pod before the first run. The campaign's page then says `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.`

| Field | What it does |
| --- | --- |
| **Agents working at once** | 1 to 4 (2 unless changed). Despite its name, it sets how many [lanes](../../reference/glossary.md) the planner plans, not how many agents work at once. See the caution below |
| **The agents' model** | **the rig's model** (the default) keeps the model the rig has. Or choose one of the models in **Providers**, listed by provider. It becomes the rig's model for every run on that rig, as on its **Edit rig** page. See the caution below |
| **The agents run in** | The [worker harness](../../reference/glossary.md), the program that runs the agents, for the model you chose: **what the model needs** (the default: the rig's own harness when control gave the rig this model already, else OpenCode v2 for OpenCode's free models, Claude Code for a Claude subscription, and Pi for the rest), **OpenCode v2**, **Pi** or **Codex**. Codex, the Codex CLI, takes a ChatGPT subscription's model or one from an OpenAI-compatible provider. Claude Code is not in the list: for a Claude subscription, keep **what the model needs** |
| **When a change is confirmed better** | **the rig's default**: the choice on the rig's **Edit rig** page, **Automatically** unless changed. Or **always keep it**, or **ask me every time**. See [Decide what waits for you](decide-what-waits.md#choose-what-waits) |
| **Ask me first about** | What else waits for you; all off by default (hands-off): **a gain above this %**, such as 15; **a change whose agent declared flaws**; **a review panel's pass of a goal or of a research run's questions**; **ending a goal campaign as not possible**. A percent that is not a number above 0 is refused: `Ask me first: "…" is not a percent above 0 (for example 15).` The same fields are under **More options** in a campaign's **Start a run** panel. See [Decide what waits for you](decide-what-waits.md#choose-what-waits) |

:::caution[A model the rig doesn't run yet: Start only saves]
**Start the campaign** starts the run only when the rig already runs the model. When you choose a model here that the rig doesn't run yet, control gives the rig that model and **saves the campaign without starting it**. The rig takes the model within a minute. The same happens with **the rig's model** when control gave the rig a model a moment ago, on **Edit rig**, **Settings › Providers** or over MCP. Then start the run as [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet) says.
:::

:::caution[How many agents work at once]
The rig's **Workers at a time** decides it: on **Rigs**, open the rig, press **Edit rig**, and find it under the **Workers** switch. It is 1 unless changed, so with the defaults the two lanes take turns, one trial at a time: the run's card shows one lane at work and the other with `next:` and its experiment. Raise it for agents to work side by side ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The summary at **6 Review and start** counts lanes as agents too, such as `2 agents work on rig-1.`
:::

### Agents' context

Under the fields above, **Agents' context** sets the campaign's own context window and compaction point for every agent of its runs, on any rig. Leave both empty to keep each rig's, as its **Edit rig** page sets them for each agent: "Empty: the rig's. A number applies to every agent of its runs, on any rig."

| Field | What it does |
| --- | --- |
| **Context window** | The most each agent reads in one request, in tokens, from 4,096. Each agent works with the lower of this and its own window, so an agent its rig caps lower keeps its own. Type `131072` to compare two models at the same window |
| **Compact at** | When each agent's conversation is compacted: a percent of its window, from 50 to 95. It replaces the rig's point |

A line under them says what the first run's workers get on the rig you chose, such as "On rig-1, the first run's workers get **131,072** tokens and compact at 80%." Bold numbers are this campaign's. The line says what is wrong instead, such as `The compaction point is a whole percent of the context window, from 50 to 95.`, or `narrow-model takes at most 131,072 tokens: a run on rig-1 can't start with this window.` when the window is above what a provider lists for a model of that rig's agents. The summary at **6 Review and start** ends with it, such as `Its agents get at most 131,072 tokens and compact at 70%.` Control keeps the numbers in the campaign's contract, as `agents_context`. You can change them later on the campaign's page: see [Set the agents' context](#set-the-agents-context).

### Your additions to the agents' roles

Under **Agents' context**, **Your additions to the agents' roles** (folded until you open it) has a box for each role a campaign of the chosen mode runs, such as **Worker**, **Planner** and **Auditor** for a hill climb, or **Research worker** and **Synthesizer** for a research campaign. Text in a box is added to that role's own instructions in every prompt of the campaign's runs; an empty box adds nothing. See [Add your words to the agents' roles](#add-your-words-to-the-agents-roles).

### Advanced

Under **Advanced**, at the foot of step 5:

| Field | What it does |
| --- | --- |
| **One try lasts (minutes)** | How long an agent works on one idea, in one [trial](../../reference/glossary.md) (not a try of the kit), 1 to 1440. Empty: the rig's own length, which is none unless someone set one: a trial then lasts until its worker submits or stops |
| **Memory per agent (MiB)** | 256 to 16384. Empty: 2048 |
| **Disk per agent (MiB)** | For one trial's copy of the code and its builds, 256 to 65536. Empty: 2048 |
| **Stop after (hours)** | Empty: no limit. When the time is up, no new trial starts and the run is paused. See [Set a budget or a stop time](budget-and-stop-time.md) |
| **Ideas kept ready** | How many experiments each run's queue keeps ready for the agents, 0 to 1000. A target that drives ideas, not a cap: below it, the planner and then the teachers are asked for more. Empty: 2 for each agent. 0: ask for none. Hill climbs and goals only. See [Keep ideas ready](choose-what-runs-next.md#keep-ideas-ready) |
| **GPUs for the judge** | For a rig with several GPUs: how many the judge measures on. The rig's harness, its container that holds the judge and the agents, restarts to apply it. Empty: the rig's current split |

## 6. Review and start

Read the summary sentence. When the brief has something in it, the sentence ends with it in a few words, such as `Its brief: 1,240 characters of additional information, 2 starting links, 3 ideas to try, 1 hypothesis.` **What control will check (the draft)** shows your answers as JSON, as the page sends them; control builds the contract from them. Then press one of:

- **Start the campaign**: starts the first run, with agents.
- **Try the kit first** (hill climb and goal): starts a run with no agents, so you see the kit work before an agent spends anything. See [Test a kit with known candidates](test-a-kit.md).
- **Save without starting**: saves the campaign and starts nothing.

Below the buttons, **Past research** says that the campaign's agents read its own collection in Thermite's knowledge base (the link opens **Knowledge**), and that reading other campaigns' collections and starting a run from past research are set on the campaign's page once it is saved. To use them for the first run, press **Save without starting**, then follow [Use past research in a new run](use-past-research.md#past-research-for-a-new-campaign).

:::caution[Keep the address of a campaign you save without starting]
The **Campaigns** list shows a campaign only once a rig reports a run of it. A campaign saved without starting, or whose first run failed to start, is not on the list. Its page is at `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`: keep that address. The page has a **Start a run** button ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
:::

## Check that it started

- After **Start the campaign** or **Try the kit first**, the new run's page opens, at `/ui/campaigns/<campaign>/runs/<run>`. Until the rig reports the run, it says, for example, `Starting sort-speed-1 on rig-1.`, and how the start goes: `Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it.`, then `rig-1 took it at 03:41 UTC. This page shows the change when the rig next reports.` Stay on the page. Once the rig reports the run, usually within a minute, the page shows the run by itself, with the tabs **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**, and, for a run with agents, **Stats**. On **Campaigns** in the sidebar, the run also shows under **At work now**, and the campaign in the list below it.
- A try's run is named like `sort-speed-try-1`, and its page says **A try of the kit.** Its results look right when the starting point builds and runs every case, and **History** has no `The judge's job (…) failed` line: see [Read the dry run](test-a-kit.md#3-read-the-dry-run). Then press **start the campaign** in that note: the **Start a run** panel opens. Keep **Agents** on **On**, and press **Start the run**. A rig runs one run at a time, so the new run pauses the try.
- After **Save without starting**, the page says `Saved on control, with no run yet.` and offers **Start a run of** and the campaign's name, such as **Start a run of sort-speed**.
- If the page says `Saved.` and that the rig takes a model, nothing started yet: see the next section.
- If the page comes back at **Review and start** with **Not started: fix these first.**, fix each item in the list. Everything you typed is kept. A kit described here or uploaded is checked against the campaign here, before anything is saved. The items about the agents' model are:
  - `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model".`
  - `OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.` Choose **OpenCode v2** or **what the model needs** under **The agents run in**.
  - `Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.` Choose another harness under **The agents run in**, or a model from a ChatGPT subscription or an OpenAI-compatible provider.
  - For research, with one of OpenCode's free models and the agents in Pi: `… is one of OpenCode's free models, which work only inside OpenCode, and rig-1's agents would run in Pi: a research run there could not work. Set the agents' harness to OpenCode, or give the rig a model Pi can use.` Choose **OpenCode v2** under **The agents run in**, or another model.
  - `The agents' context: The compaction point is a whole percent of the context window, from 50 to 95.`, or the same for a window out of range: correct **Agents' context** in step 5.
- If the run never shows, open **Commands** in the sidebar. The newest **assign campaign** row is **failed**, with the reason.

| The reason starts with | What to do |
| --- | --- |
| `staging:` | The rig could not fetch the project or the kit: the reason names the address, such as `staging: https://git.example.com/you/project.git has no commit …`, or gives git's own error. Check that the address works from the rig and that the commit is pushed there. For a private repository, use **Try it** on its Git access: see [Use a private repository](private-repository.md#5-check-that-the-rig-fetched-it). |
| `the kit does not fit the contract:` | A kit in a repository lacks a case, metric or verifier that the page named, a case it runs has no `work` parameter above zero for one of the kit's rate metrics, or it measures on another target. Each problem is named, such as `cells names cell large, which the kit does not have`. Correct the names, or commit the kit again and use its new **Kit commit**. |

When nothing in the campaign must change, such as after you fixed the repository's access, **Start a run** on the campaign's page starts the same version again. Otherwise fill in the **New campaign** page again with the same **Campaign name** and press **Start the campaign**: this saves a new version and starts it.

## When the rig doesn't have the model yet

When control has just given the rig a model, from step 5, the **Start a run** panel, **Edit rig**, **Settings › Providers** or MCP, the rig takes it within a minute. Until then, **Start the campaign** saves the campaign instead of starting it, and **Start the run** doesn't start a run. Start it once the rig has the model:

1. Note the campaign's page and its address. It says, for example, `Saved. rig-1 takes my-model within a minute. Settings › Providers shows the rig taking it until then; then start the run here.`, or `rig-1 takes my-model within a minute; Settings › Providers shows it taking the model until then. Then start the run again.` after **Start the run**. When control gave the rig the model elsewhere a moment ago, **Start the campaign** says `Saved. rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then). Then start the run here.` The address is `/ui/campaigns/<name>`, such as `http://127.0.0.1:8800/ui/campaigns/sort-speed`. A campaign with no run yet is not in the **Campaigns** list, only at this address.
2. Open **Settings › Providers**, the cog at the foot of the sidebar, and find the rig's row under **Harness and model for each rig**. While the rig hasn't taken the model, the row shows `taking my-model under Pi` (or the harness you chose). Stay on the page: the row follows the rig by itself, and once the chip is gone it says `Its agents run under Pi with my-model from <provider>.`
3. Go back to the campaign's address, press **Start a run**, choose the rig under **Where it runs**, and press **Start the run**. The run starts as [Start a run later](#start-a-run-later) says.

Pressed too soon, **Start the run** answers **Not started.** and `rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.` Check the rig's row on **Settings › Providers** again, then press it again.

## Start a run later

Press **Start a run** at the top of the campaign's page. A panel opens, headed **Start a run of sort-speed**:

| Field | What it does |
| --- | --- |
| **Where it runs** | One card per rig, with its hardware, `free` or `busy`, and its agents' model, or `No model for its agents yet.` A rig with other hardware than the campaign's kit is greyed out. A busy rig's card says `Busy: sort-speed-1 is at work there, and pauses when this run starts (a rig runs one run at a time).` A [rig on RunPod](../install/runpod-rig.md) whose pod is stopped says `stopped` and `Its pod is stopped: this run starts it first.` You can choose it: control starts the pod, then the run. The panel chooses a free rig for you first, and a stopped pod only when no other rig fits |
| **Agents** | **On**: the agents propose changes, and the judge measures each one. **Off: a try**: no agents, only the judge, which measures the starting point. A try needs no model |
| **The agents' model** | Shows with **Agents** **On**, for a rig with no model: the model to give it, as on its **Edit rig** page. Control then gives the rig the model and starts nothing yet: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet) |
| **Agents' context** | Shows with **Agents** **On**: what the workers get on the chosen rig, such as "On rig-1, the workers get **131,072** tokens and compact at **70%**." Bold numbers are this campaign's, plain ones the rig's. The link **Set this campaign's context** (or **Change this campaign's context**) closes the panel and goes to [the campaign's own](#set-the-agents-context). Each rig's card also says `Workers' window: 131,072.`, or, in red, `Can't start: narrow-model takes at most 100,000 tokens.` when the campaign's window is above what a provider lists for a model of that rig's agents. On such a rig the line at the foot says `Not on rig-1: choose another rig, or lower this campaign's window.`, and **Start the run** is off |
| **Experiments to start with** | **Copy the untried experiments of** and a run of this campaign, such as `sort-speed-1 (4 up next, 1 lane idea)`: the new run's [experiment queue](choose-what-runs-next.md) starts with that run's waiting experiments, in the same order, and its lanes' ideas, each with who added it and why, up to 500. Ticked by default. It shows only with **Agents** **On**, and only when a run of the campaign has experiments up next or ideas. Untick it for an empty queue, which the planner fills. The run with the newest activity is chosen first; **Start a run** on a judge-only run's **Experiments** tab opens the panel with that run chosen |
| **From past research** | A search of the collections this campaign may read: its own and those you let it read. It lists the newest 40 experiments, findings, claims, notes and reports, and the box **Search past experiments, findings and notes** searches those collections. Ticked experiments join the new run's queue, after the copied ones; a ticked finding, claim, note or report becomes background in every agent's brief. It shows only with **Agents** **On**: with **Off: a try**, it hides, and nothing ticked in it is sent. See [Start a run from past research](use-past-research.md#start-a-run-from-past-research) |
| **What its agents search** | What the run's agents search in [Thermite's knowledge base](../../reference/knowledge-base.md#a-runs-scope) with `kb_search`: **Continue the campaign's collection** (the default: every earlier run's items, and this run's) or **Start fresh** (only this run's own items). Either way, this run's items go into the campaign's collection. Under **Also search, read only:**, each collection you let this campaign read, ticked: untick one to leave it out. Fixed when the run starts; the run's page says what its agents search. It shows only with **Agents** **On** |
| **When a change is confirmed better** | Under **More options**: **the rig's default**, **always keep it** or **ask me every time** |
| **Ask me first about** | Under **More options**: as on the New campaign page, for this run |
| **GPUs for the judge** | Under **More options**: as in step 5. Empty: the rig's current split |

The line at the foot sums it up, such as `Starts a new run on rig-1, with agents on <model>.` or `Starts a new run on rig-1, as a try: the judge only.` With **Agents** on **On** and items ticked under **From past research**, it ends with a sentence such as `It starts from 3 items of past research.` Press **Start the run**: the button says **Sending…** at once. The run uses the latest saved version. It is named `<campaign>-<n>`, or `<campaign>-try-<n>` without agents, with the first number not yet used on control, on any rig, such as `sort-speed-2`.

The new run's page opens, with a card at the top such as `Starting sort-speed-2 on rig-1. Sent to rig-1 at 03:41 UTC. Waiting for the rig to take it. The rig fetches the project and the kit, and checks both. The run's page opens here when the rig reports the run, usually within a minute.` Stay on the page: once the rig reports the new run, the page shows the run by itself. If the rig refuses the start, for example because it could not fetch the project, the card says `Not started: sort-speed-2 on rig-1.` and the rig's reason. The run also shows under **At work now** on the campaign's page. If control can't start it, the campaign's page says **Not started.** and the reason, with the panel open again, such as:

- `rig-1 has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`
- `rig-1 has not taken my-model yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.`: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
- `<campaign> may not read <collections>: grant it on the campaign's page under Can read from, or leave it out.`: a collection named for its agents to search is not one the campaign may read now.
- `An item from past research is not one this campaign may read and start from: search again.`: an item ticked under **From past research** is no longer in a collection the campaign may read, for example because its collection was removed after the panel opened. Search again, and tick the items again.
- `sort-speed has no run sort-speed-1: copy from a run of this campaign.`: control no longer finds the run chosen under **Copy the untried experiments of**. Open the panel again and choose another run. A run of a retired rig, or from before its rig's full reset, stays in the list, marked, such as `sort-speed-1 (before rig-1's full reset, 3 up next)`.
- `This campaign sets a context window of 150,000 tokens. narrow-model, the model of the teachers on rig-1, takes at most 131,072 tokens. Set the campaign's window to 131,072 or less, or give that agent another model.`: lower the window under [Agents' context](#set-the-agents-context), choose another rig, or give that agent another model on the rig's **Edit rig** page.

For a research campaign with agents, it refuses a rig whose agents would run OpenCode's free models in Pi, with the message above. If the run you chose to copy from has tried every experiment since the panel opened, the run starts with an empty queue, and the page says `sort-speed-1 has no untried experiments: the new run's queue starts empty.`

With an agents' context set, the note at the top also says what applies to each agent on that rig, such as `This campaign sets a context window of 131,072 tokens, compaction at 70% of the window. The lower window wins on each agent. Workers: 131,072 tokens (wide-model), compacted at 70% of the window. …`

**Start a run** also works for a campaign started from the command line, the REST API or MCP, even before a rig reports a run of it: see [Start a campaign from the command line](start-from-command-line.md#start-further-runs). For runs on other rigs, see [Run a campaign on several rigs](several-rigs.md).

### Start a run from a script or an agent

**Start a run** has a twin on the REST API, on MCP and on the command line. Each one runs the dashboard's own code, so it takes the same fields, checks the same things and refuses with the same words. With the owner's token file of the local stack:

```sh
npx thermite run start sort-speed --rig rig-1 --queue-from sort-speed-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
```

It prints the new run and its command:

```json
{"started":true,"campaign":"sort-speed","rig":"rig-1","run":"sort-speed-2","command":"<command id>","status":"pending"}
```

| Panel field | Command line | REST and MCP |
| --- | --- | --- |
| **Where it runs** | `--rig rig-1` | `"rig": "rig-1"` |
| **Agents** **Off: a try** | `--agents off` | `"agents": false` |
| **The agents' model** | `--provider zen --model my-model` | `"agents_model": {"provider": "zen", "model": "my-model"}` |
| **Copy the untried experiments of** | `--queue-from sort-speed-1` for a run on the `--rig`, or `--queue-from rig-2/sort-speed-1` for a run on another rig | `"queue_from": {"rig": "rig-1", "run": "sort-speed-1"}` |
| **From past research** | `--past 12 --past 40` | `"past": [12, 40]` |
| **What its agents search** | `--fresh` for **Start fresh**; `--granted survey-study` for each collection to include, or `--no-granted` for none | `"collection": "fresh"` (default `"continue"`); `"granted": ["survey-study"]`, or `[]` for none |
| **When a change is confirmed better** | `--promotion auto` or `--promotion owner` | `"promotion": "auto"` or `"owner_approval"` |
| **Ask me first about** | `--ask gain:15 --ask flaws --ask reviews --ask not-possible` | `"ask_owner": {"above_gain": 0.15, "declared_flaws": true, "reviews": true, "not_possible": true}` |
| **GPUs for the judge** | `--judge-gpus 2` | `"judge_gpus": 2` |

- **The command line** and **the REST API** (`POST /v1/campaigns/sort-speed/runs`) take the owner's token: see [the route](../../reference/rest-api.md#campaigns) and [`thermite run start`](../../reference/command-line.md#run-start).
- **MCP's** [`start_run`](../../reference/mcp-tools.md#start_run) takes the owner's token or an operator's. An operator's call can't change the GPU split, and can't start a stopped pod on RunPod.
- **Past research** is named by each item's id, which MCP's [`kb_search`](../../reference/mcp-tools.md#kb_search) or [`thermite kb search`](../../reference/command-line.md#kb) gives.
- **A model given first.** With `--provider` and `--model` (or `agents_model`), control gives the rig the model and starts nothing yet, as the panel does. The answer is `{"started":false,"said":"rig-1 takes my-model within a minute; …"}`, and the command line exits with 1. Run it again without the model once the rig has taken it.
- **Notes.** The answer's `notes` say what else to know, such as `sort-speed-1 is at work on rig-1, and pauses when this run starts (a rig runs one run at a time).` The command line writes them on standard error.
- **Refusals** come back in the panel's words, such as `409` and `{"error":"rig-1 has no model for its agents, so they could not work: …"}` over REST. The command line writes the route, the status and that answer on standard error, and exits with 2.
- **A try.** With `--agents off`, or `"agents": false`, the twins refuse a model, a run to copy from and past research, which the panel hides: `A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.`

## Set the agents' context

A campaign's page has a block **Agents' context**, "every run of" the campaign. It sets one context window and one compaction point for every agent of the campaign's runs, on any rig, as step 5 of **New campaign** does. Use it to run two models at the same window.

1. Open **Campaigns** in the sidebar, then the campaign, and scroll to **Agents' context**.
2. Type a **Context window** in tokens, such as `131072`, and a **Compact at** percent, such as `70`. Leave a field empty to keep each rig's.
3. Read **What applies on each rig**: one row for each rig that can run the campaign, with its workers' window, **Compact at** and a **Status**. Bold numbers are this campaign's, plain ones the rig's: a rig that caps its workers lower keeps its own window. **Status** is `ok`, or `can't start: narrow-model takes at most 100,000` on a rig where a model of an agent takes less than the window. The rows change as you type.
4. Read the line beside **Save**, such as `You set the window: 131,072 tokens. You set Compact at: 70%. New runs take it.`, and press **Save**.

The block says, for example, `Saved as version 3: 131,072 tokens at 70%. New runs of sort-speed take it. sort-speed-2 keeps what it started with.` Control saved a new version of the campaign's contract, with the numbers as `agents_context`. A run at work keeps what it started with; runs started from now take the new numbers. Saving the same numbers again says `Nothing changed: version 3 has these numbers already.` Both fields empty remove the campaign's own: `Saved as version 4: the rig's, for each agent.`

A number the block refuses shows under the help line as you type, and **Save** stays off: `Write the number of tokens in digits, such as 131072.`, `A context window is a whole number of tokens from 4,096 to 100,000,000.` or `The compaction point is a whole percent of the context window, from 50 to 95.` Control refuses the same with **Not saved.** and the reason, and keeps what you typed in the fields. Under **The same over REST, MCP and the command line**, the block shows the same request for a script or an agent: see [Set a campaign's own context window](../models/model-per-agent.md#set-a-campaigns-own-context-window).

## Add your words to the agents' roles

Each agent role has its own instructions in Thermite's code ([Agent roles](../../reference/agent-roles.md)). A campaign's page has a block **Your additions to the agents' roles** that adds your own words to a role for this campaign's runs, with no change to that code: for example, "Keep every change small enough to read in one sitting." for the workers.

1. Open **Campaigns** in the sidebar, then the campaign, and scroll to **Your additions to the agents' roles**. Its heading's right side names the roles that have one, or says `none`.
2. Open **Add text to a role** (or **Change them**). There is one box for each role a campaign of its mode runs, named as the [Agent roles](../../reference/agent-roles.md) page names it, with its id, such as **Worker** `worker`.
3. Write in the boxes you want, at most 20,000 characters each. Empty a box to remove that role's addition.
4. Press **Save**.

The block says, for example, `Saved as version 4: additions for worker and planner. New runs of sort-speed take it.` Control saved a new version of the campaign's contract, with the text as [`role_additions`](../../reference/contract.md#your-additions-to-the-agents-roles). A run at work keeps what it started with. Saving the same text again says `Nothing changed: version 4 has these additions already.`

Each prompt of the role then carries your text as a part of its own, after the role's instructions: it starts `# The campaign owner's addition (contract version 4)`, and a line tells the agent that it adds to its instructions and replaces none of them, which come first where the two differ. On a run's **Prompts** tab, that part shows as from `owner's addition`. Your text never decides a measurement, a verdict or a promotion: code does.

A script or an agent does the same with [`POST /v1/campaigns/<campaign>/additions`](../../reference/rest-api.md#the-owners-additions-to-a-campaigns-roles), MCP's [`set_campaign_additions`](../../reference/mcp-tools.md#set_campaign_additions) or [`thermite campaign additions`](../../reference/command-line.md#campaign-additions).

### What the operator proposes

The prompts carry the additions as your own words, so an operator's change to them waits for you. So does an operator's change to which roles write in the campaign's collection, and an operator's grant of another campaign's collection ([A proposed grant](../../reference/knowledge-base.md#a-proposed-grant)). With the operator's token, `set_campaign_additions` and `set_campaign_kb_writes` check the change as they would yours, keep it as a proposal, and save nothing: they answer `Proposed to the owner: additions to its roles of sort-speed. Nothing changes until the owner approves it on the campaign's page; the campaign's runs keep what they have.` A newer proposal of the same setting replaces one still waiting.

The campaign's page then has a block **Proposed to you**, above **Your additions to the agents' roles**, and **Needs you** has the same card: who proposed it, and, when you open it, the setting now and as proposed. **Approve** saves a new version of the contract with it, as your own change, and the block says `Approved: version 5 of sort-speed has the additions to its roles owner:operator proposed. Runs started from now take it.` **Decline** changes nothing. Your own changes, on this page, over REST and with your token on MCP, take effect at once.

## Compare two models from zero

To compare two models on the same campaign, give each model a campaign of its own: a copy. Two runs of one campaign share its collection in [Thermite's knowledge base](../../reference/knowledge-base.md). Each new run starts with what the campaign's earlier runs recorded, and while both work, each reads the other's records every few minutes. So the second model would not start from zero. A copy has the same contract and kit under another name, its own empty collection, no [grants](../../reference/knowledge-base.md#grants) and no runs.

You need a campaign that control keeps (one saved on the **New campaign** page, or one assigned before over the command line, the REST API or MCP), and a rig for each model, or one rig with the runs one after the other.

1. Open **Campaigns** in the sidebar, then the campaign. Press **Copy**, beside **Start a run** at the top of its page. A panel opens, headed **Copy sort-speed**. It says why to copy: the copy gets its own empty folder, so its runs read nothing that the runs of `sort-speed` recorded.
2. Under **Name of the copy**, keep the free name the panel gives, such as `sort-speed-b`, or type another, such as `sort-speed-model-b`. The panel checks it as you type, with the **New campaign** page's rules, and says `✓ Free. Its runs are named sort-speed-model-b-1, sort-speed-model-b-2, and so on.` For a name it refuses, see [When the panel refuses](#when-the-panel-refuses). **Copy** stays off until the name is free.
3. Look at **MCP servers for its agents**, the tools from outside Thermite that the copy's agents can call:
   - **A research campaign.** The panel lists the servers in **Settings › MCP servers**, ticked as the campaign has them. Leave them so to compare the models alone. To give the copy's agents another server, tick it, then **Workers**, **Advisors** or both; open **Advanced: its tools for each kind of agent** under a server to untick tools. The line under the list says what each kind of agent gets, such as `The workers get 4 tools from gbrain (4 of 6); the advisors get 6 tools from gbrain.`, then `✓ The same as sort-speed.` or, when the list differs, `Not as sort-speed.`: the copy's contract then names its own servers, so its hash is its own. **Use the servers of sort-speed again** puts the campaign's list back.
   - **A hill-climb or goal campaign.** The panel shows its kit's servers, read only, such as `gbrain for the workers` and `All its 31 tools.`: they are in the kit's kit.json, which a copy does not change.

   Under **The same over REST, MCP and the command line**, the panel shows the same request for a script or an agent: see [Copy from a script or an agent](#copy-from-a-script-or-an-agent).
4. Look at **Agents' context**: the copy's own context window and compaction point for every agent of its runs. They start as the campaign has them, and the line under them says `✓ As sort-speed.` To compare the two models at the same window, give both copies the same **Context window**, such as `131072`: models whose providers list different windows then work at that one. A number that differs from the campaign's makes the line say, for example, `Not as sort-speed: 131,072 tokens at 70%.`: the copy's contract then has its own `agents_context`. Empty fields give the copy none: each rig's applies.
5. Press **Copy**. The copy's page opens, with `Copied sort-speed version 2 as sort-speed-model-b.` at the top (and, with its own agents' context, `Agents' context: 131,072 tokens at 70%.`), then `Copied from sort-speed version 2 by you, just now. Its collection in the knowledge base started empty.` and `Saved on control, with no run yet.` A copy of a research campaign whose servers differ adds `Its agents use other MCP servers than its source's:` and the list.
6. For the other model, go back to the campaign and copy it again, such as to `sort-speed-model-a`. If the campaign has no runs yet, you can also run it as it is for the first model.
7. Give each rig its model, on its **Edit rig** page, or under **The agents' model** in the next step: see [When the rig doesn't have the model yet](#when-the-rig-doesnt-have-the-model-yet).
8. On each copy's page, press **Start a run of sort-speed-model-b** (or **Start a run** at the top), choose the copy's own rig under **Where it runs**, and press **Start the run**, as [Start a run later](#start-a-run-later) says.

Don't let one copy read the other's collection: leave **Can read from** empty on each copy's page.

To tell it worked, open each copy's page: on **Campaigns** once its run reports, or at its address, `/ui/campaigns/sort-speed-model-b`. It says where the copy came from, such as `Copied from sort-speed version 2 by you, 5m ago. Its collection in the knowledge base started empty.`, or `Copied from sort-speed as assigned for sort-speed-1 on rig-1 by you, …` for a campaign that was only assigned before. A copy made with the operator's token over MCP says `by the operator`. Its **Knowledge** section counts only its own run's records, and **Can read from** says `None: its agents read only this campaign's collection.` Then compare the two runs' results on their pages.

### When the panel refuses

The panel says why under the name, or under the servers, and **Copy** stays off:

| The panel says | What to do |
| --- | --- |
| `There is a campaign named sort-speed-b already. Choose another name.` | Type another name. A name is taken when control keeps a campaign by it, a rig reported a run of it, or the knowledge base has a collection or a grant by it. For a name only the knowledge base has, the panel adds `It has no runs now, but its collection is in the knowledge base.` |
| `A campaign's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit.` | Press the button beside it, such as **Use sort-speed-b**, for a valid name made from yours, or type another |
| `A name that starts with rig-check- is for rig checks. Choose another name.` | Type another name: [rig checks](../../reference/rig-checks.md) use these names |
| `Choose the agents that get paper-search, or untick it.` | A research copy: tick **Workers** or **Advisors** for the server, or untick the server |
| `The workers get no tool of paper-search: give them one, or untick workers.` | A research copy: tick a tool for them under **Advanced**, or untick **Workers** for that server |
| `The compaction point is a whole percent of the context window, from 50 to 95.`, or another word on the window under **Agents' context** | Correct the number, or empty the field |

Control checks the copy again when you press **Copy**, with the same words. If it refuses, for example because another copy took the name after the panel opened, the panel opens again with **Not copied.** and the reason, and control saves nothing. Without the page's script, the panel posts all the same and shows control's answer the same way.

### Copy from a script or an agent

**Copy** has twins on the command line, the REST API and MCP, which take the owner's token (MCP also an operator's) and give the same refusals:

```sh
npx thermite campaign copy sort-speed sort-speed-model-a \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
npx thermite run start sort-speed-model-a --rig rig-1 \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token
```

The first command prints the copy, such as `{"campaign":"sort-speed-model-a","version":1,"contract_sha":"<sha256>","from":{"campaign":"sort-speed","version":2}}`; the second starts a run of it. Over REST it is `POST /v1/campaigns/sort-speed/copy` with `{"name": "sort-speed-model-a"}`. Over MCP it is [`copy_campaign`](../../reference/mcp-tools.md#copy_campaign) with `{"from": "sort-speed", "name": "sort-speed-model-a"}`. A research copy's other servers are `mcp_servers` there, or `--mcp-servers-json` on the command line: see [`campaign copy`](../../reference/command-line.md#campaign-copy). The copy's own agents' context is `agents_context` there, such as `{"context_window": 131072}` (`null`: none), or `--context-window` and `--compact-at` on the command line.

The copy keeps the campaign's [brief](#2-the-brief). To give it its own, send `notes`, `links`, `ideas` or `hypotheses` with the copy over REST or MCP, or `--info-file`, `--link`, `--idea` or `--hypothesis` on the command line: each part given replaces the campaign's, and an empty one removes it. A research copy's links are its seeds, and it takes no ideas.
