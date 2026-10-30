---
title: "Hand the work to agents"
description: "Give your rig a free AI model, start a campaign on the sample project in Thermite's repository, and watch agents propose changes that the judge measures."
type: tutorial
sidebar:
  order: 2
---

In this tutorial you give your rig a free AI model, then start a campaign in which AI agents try to make a small program faster. The program is the sample project in Thermite's own repository, in the folder `examples/matmul-cpu`: a slow matrix multiply in C. You start the campaign from the dashboard, watch an agent work, and watch the judge decide on every change it submits.

At the end you'll have seen Thermite's whole loop: agents propose, the judge measures, and only a change that is confirmed better can become the new best version.

It takes half an hour to an hour, most of it waiting. An agent works on one thing to try until it submits a change, often for a quarter of an hour or more, and the judge then measures what it made. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from [Your first run](first-run.md): Thermite running on your computer, the dashboard signed in, and `local-1` on the **Rigs** page.
- **git**, to get the sample from Thermite's source code (step 4).
- An internet connection. Your rig fetches the sample from GitHub, and the free models run on OpenCode's own service. You need no account and no key. The model sees the code the agents read, which here is only the sample project.
- A look at [Known limits](../reference/known-limits.md), if you haven't read it yet. From this tutorial on, agents run the code that a model writes, on your computer.

## 1. Add OpenCode as a model provider

A **provider** is where your agents' models come from. OpenCode is a program that runs coding agents, and its service offers some models for free.

1. Press the cog icon at the foot of the sidebar, beside **Sign out**. Its tooltip says **Settings**. It opens the **Providers** page, whose heading reads `Settings › Providers`.
2. Under **Add a provider**, set:
   - **Type**: **OpenCode (its own models)**
   - **Name**: `opencode`
   - **Base URL** and **API key**: leave them empty.
3. Press **Add and list its models**.

A green line says `"opencode" is saved and lists` a number of models, then `Choose one for a rig below.` The new row, **opencode · OpenCode**, shows **no key: its free models** and **runs in the OpenCode harness**.

## 2. Give the rig a free model

Find **Harness and model for each rig** at the bottom of the page. The row for `local-1` says `Its agents have no model: they wait.`

1. In its first list, choose **OpenCode v2**. This is the **worker harness**: the program the agents work in. (It is not the rig's `harness` container, which runs it.) OpenCode's free models run only in OpenCode's own program.
2. In its second list, under **opencode (OpenCode harness only)**, choose the first model whose name ends in `-free`. Those are the models OpenCode serves without a key. OpenCode decides which they are, and the list changes over time.
3. Press **Use**.

A green line at the top of the page says that `local-1` takes your model from `"opencode"` under OpenCode v2 within a minute, and checks it. The row for `local-1` shows `taking` and your model's name.

## 3. Check that the model works

The rig checks a new model by itself. It asks the model, through the worker harness, to run one command, and the answer must come back as a correct tool call. That is how agents work: by calling tools.

Wait a minute or two, and stay on the page: the row follows the rig by itself, with no refresh. Once the rig takes the model, the row says that its agents run under OpenCode v2 with your model from `opencode`. Below that, `Its model check is running ·` and the time so far, then:

`Its model check passed … ago:` your model's name, then `answered with a correct tool call in` some seconds `(OpenCode)`.

If it says **FAILED** instead, the rest of the sentence says why, such as `Rate limit exceeded. Please try again later.` when the free model is busy, or `Model unavailable:` and the model's name when OpenCode no longer serves it, though its list still names it. Choose another model whose name ends in `-free`, press **Use**, and wait again. It can take a few tries to find one that answers. **Check** runs the check again at any time.

The rig's own page shows the same result: open **Rigs**, then `local-1`, and under **Checks**, **Model route** says **passed**, with the same sentence.

## 4. Get the sample and pack its kit

The sample is in Thermite's source code, in the folder `examples/matmul-cpu`. It has two folders:

- `project` is the **project** the agents change. Its `src/kernel/matmul.c` multiplies two matrices the slow way.
- `kit` is its **kit**: the judge's recipe for building the project, running it and checking each answer. The agents never see it.

The dashboard takes a kit as one file. In a terminal in your `thermite` folder, get the source code of your Thermite version into a folder `thermite-source` beside it, and pack the kit there:

```sh
cd ..
git clone --branch v0.1.0 https://github.com/iammrduncan/thermite.git thermite-source
cd thermite-source
tar -czf matmul-cpu-kit.tar.gz -C examples/matmul-cpu kit
```

`v0.1.0` is the release your `compose.yaml` names in its first line, `# Thermite 0.1.0`. If yours names another one, put a `v` before it and use it in place of `v0.1.0`, here and in step 6.

The last command prints nothing. Your `thermite-source` folder now holds the file `matmul-cpu-kit.tar.gz`.

## 5. Name the campaign

In the dashboard, open **Campaigns** in the sidebar, and press **New campaign** at the top right of the page. The page has six steps: **1 Aim**, **2 The brief**, **3 Project**, **4 How to measure**, **5 Where it runs** and **6 Review and start**. Each field's ⓘ says more about it.

On **1 Aim**:

1. Keep **Hill climb** chosen. A **hill climb** improves one measured number, here the speed of the matrix multiply. The other two cards are Thermite's other [campaign modes](../explanation/campaign-modes.md): **Reach a list of goals** works until checks you write all pass, and **Research a question** has agents read sources and report findings, with no code changes.
2. **Campaign name**: `matmul-agents`
3. **Title**: `Make the sample's matrix multiply faster`
4. Press **Next**.

On **2 The brief**, leave every field empty and press **Next**. The brief is optional: it is where you give the agents background, links, ideas and hypotheses.

## 6. Point it at the sample

The sample is one folder of Thermite's repository. Your rig fetches the whole repository from GitHub, and the run starts from that folder: the agents see only its files.

On **3 Project**:

1. **Repository**: `https://github.com/iammrduncan/thermite.git`
2. **Start from**: `v0.1.0`, the release of step 4. The sample then matches your images.
3. **Folder in the repository**: `examples/matmul-cpu/project`
4. **Repository access**: keep **Public: no key**.
5. Press **Look it up**. Control reads the folder's file names and says `Found: v0.1.0 is at`, a short commit id, then `· 4 files in examples/matmul-cpu/project. Rigs fetch it from there.` Every run starts from exactly that commit.
6. **Files the agents may change**: `src/kernel/**`. The path is inside the folder, and `**` matches every file below `src/kernel`. A change to any other file is refused before it is built.
7. Open **Advanced**, below that field. In **Lines never allowed**, type these three lines:

   ```text
   __real_
   __wrap_
   thermite_ref_calls
   ```

   The kit counts every call to the sample's reference implementation, which a change may not use. A change that adds one of these names could hide such a call, so it is refused before it is built.
8. Press **Next**.

## 7. Upload the kit

On **4 How to measure**:

1. Choose the card **Upload a kit**.
2. Under **Kit archive**, choose the file `matmul-cpu-kit.tar.gz` in your `thermite-source` folder. Control unpacks it and checks it. The page says `matmul-cpu-kit.tar.gz: checked.`, then sums the kit up: `matmul-cpu: measures on cpu, 3 cases, scores flops_per_s.`
3. Under **The kit's cases**, keep `small` and `large` at **Measured**, and set `held` to **Hidden test**. The judge measures every change on `small` and `large`. It runs the hidden test, `held`, only to double-check a change that already looks faster: the change must give the right answer there too, and may be slower there than the champion by no more than 1%.
4. **The score** shows `flops_per_s: a rate (FLOP/s)`: the speed of the matrix multiply, in floating-point operations a second. Keep **Better is** at **higher**, and **Smallest gain that counts (%)** at `5`. A change must be at least 5% faster to count.
5. Press **Next**.

## 8. Start the campaign

On **5 Where it runs**, the card for `local-1` is chosen. It shows the rig's hardware, `cpu · generic-cpu`, and after `agents:` the free model you gave it.

1. **Agents working at once**: `1`. The agent works in a **lane**: a line of search, worked by one agent at a time.
2. **The agents' model**: keep **the rig's model**.
3. Leave the rest as it is, and press **Next**.

**When a change is confirmed better** stays at **the rig's default**. On `local-1` that rule is automatic: a change the judge confirms becomes the best version without waiting for you, unless it is held for a second look (see step 10).

On **6 Review and start**, a sentence sums up the campaign. It starts with `matmul-agents will make flops_per_s higher`, names `thermite (the folder examples/matmul-cpu/project)` and `src/kernel/**` as the only files to change, and ends `1 agent works on local-1.`

Press **Start the campaign**. Control keeps the kit, saves the campaign, and sends its first **run** to `local-1`: this campaign at work on that rig.

The run's own page opens and says `Starting matmul-agents-1 on local-1.`, then `Sent to local-1 at`, the time, and `Waiting for the rig to take it.` The rig fetches Thermite's repository from GitHub and the kit from control, and checks both. Stay on the page: once the rig reports the run, usually within a minute, the page shows the run by itself, at the same address. The line at the top reads `Campaigns › matmul-agents › matmul-agents-1`, then `on local-1 · hill climb · Running`.

Open **Campaigns** in the sidebar. Under **At work now**, a card shows `matmul-agents › matmul-agents-1`, on `local-1`: the campaign, then its run. Under **All campaigns**, the row `matmul-agents` shows your title, `Make the sample's matrix multiply faster`, and `1 at work` under **Runs**.

For the first few minutes the judge measures the project as it is (step 9 says more), and then the **planner**, an agent that decides what each lane tries, plans the first round. Meanwhile the card's `lanes` line says `waiting for the first round`. `lane-1` takes its place once the planner has given the lane its work.

:::tip[If the run does not appear]
Open **Commands** in the sidebar. The `assign campaign` line shows **failed**, and its outcome says why:

- `commit` and a commit id, then `has no folder examples/matmul-cpu/project`: the folder's path in step 6 has a typing mistake.
- `staging:` and a reason: the rig could not fetch the repository, for example without an internet connection. See [A campaign doesn't start: staging](../how-to/operate/troubleshoot.md#a-campaign-doesnt-start-staging).

To fix a field, open **New campaign** again. It starts empty: fill in every field again as in steps 5 to 8, with the same campaign name and the field fixed, and press **Start the campaign**. That saves the campaign as version 2, and starts it as `matmul-agents-2`.
:::

## 9. Watch the agent work

Open **Live** in the sidebar. It shows the run at work, `matmul-agents-1`. The list on its left, **At work**, holds every run at work: here, only this one. In a narrow window that list is hidden, and **☰** in the header shows it. In the header above the lines, the run's name is followed by **Running**, then `local-1` (the rig) and how the run stands: its round and its gain so far. On the right are the buttons **Open the run**, **Pause** and **⋯**, which holds **Restart the lanes**.

Under the header is a row of filters, which choose whose lines you see:

- **Everyone** is chosen at first, and shows every line.
- **lane-1** is the agent itself. Its filter appears only when the planner has given the lane its work, a few minutes in. The agent gets a fresh copy of the project, works on the one thing the planner gave it to try, and ends by submitting its change. This is one **trial**. It has no time limit unless someone sets one: it ends when the agent submits, or when it stops and has nothing more to do.
- **Planner** works before the lanes. Before each round of work, it reads what has happened so far and gives each lane an **experiment**: one thing to try. It takes experiments from the run's **queue**, the list of what to try next, and adds new ones of its own.
- **Judge** is the code that measures the project and each change. It is not an agent, and takes no messages.
- **Advisors** shows the rig's advisors, models that review the work, and **You** shows your own messages. You won't need them here.

First the judge measures the project as it is, on every case: the run's **baseline**, which every change is held against. Until it has, the planner's line says `round 1 waits for the judge's baseline of the starting point (champion #1)`. Then it says `the judge measured the starting point (champion #1):`, with the speed of each case, and that the rounds of the plan start now. When the planner is done, a few minutes after the run starts, the planner's line says `round 1:` and how it planned, and the lane's first trial begins. A **lane-1** filter appears with its first line. Choose **lane-1**. Its trial starts with the line `lane-1 · trial started`, followed by the experiment it was given: its direction (the kind of change), then what to try, such as `optimization, Kernel micro-interleaving for flops_per_s (from the champion, seq 1)`. Each line after that is one step: a command the agent ran, or a file it read or wrote, with what came back. Most agents look around the project and read `src/kernel/matmul.c`, then change it, build it and try it.

New lines come in by themselves, at the bottom: the newest line is the last. **↓ Follow**, on the right above the lines, keeps the newest line in view; press it to stop following, so you can read further up. The rest of this page, like every other page, needs **refresh**. After a **refresh**, a green dot on **lane-1** means it is working.

The box under the lines sends the agents a message, and its grey text says when they would read it. You won't need it here: see [Steer a run](../how-to/campaigns/steer-a-run.md).

## 10. Watch the judge decide

The first change takes a while. The judge measures the starting point, the planner works for a few minutes, a trial often takes a quarter of an hour or more, and the judge then needs a minute or more to measure what it made. Expect the first verdict between 5 and 30 minutes after the run starts, depending on how fast the model works.

When the agent submits its change, the judge takes over. Open **Overview** in the sidebar and look at **What happened**, newest first. You see `lane-1 submitted` with the agent's description of its change, then the judge screening it: building it and measuring it against the champion. The **champion** is the best version so far. At the start it is the project as it was: champion #1.

Then open **Campaigns**, and on the card under **At work now**, choose `matmul-agents › matmul-agents-1`. The run's page opens. Its title, `matmul-agents-1`, is followed by `on local-1 · hill climb · Running`. On the right of the header are the buttons **Live**, **Message**, **Pause**, **Export** and **⋯**. Below the header, a line counts the run's trials and rounds and gives its time. Once the agents have made a model call, two cards under it show its cost and its tokens; the cost says no price, because OpenCode's model list gives no prices, even for its free models. Below them are the run's tabs: **Overview**, **Experiments**, **Journal**, **Attempts**, **History**, **Planner** and **Stats**.

Choose **Experiments**. It shows the run's queue of experiments. Three of its parts matter here:

- **Up next**: the experiments that wait for a lane, in order. It starts with a form to add an experiment, and the waiting experiments are below it. The planner fills it as it plans, so it may be empty: `Nothing queued.`
- **In progress**: what `lane-1` works on now, while its trial runs.
- **Tried**: every experiment that has ended, newest first, with its result. For a trial that submitted a change, the result is its attempt and a word for how the judge decided it, as in the table below.

The card **Ideas from the lanes** holds what an agent proposes beyond its own experiment, such as a follow-up its work suggests; the planner queues the distinct ones when the queue runs low. You can add, reorder and drop experiments yourself, and queue or drop the lanes' ideas. You don't need to here: [Choose what a run tries next](../how-to/campaigns/choose-what-runs-next.md) says how.

The next tab, **Journal**, holds the agents' **field notes**: what they observe, the decisions they make and why, and what they learn, written as they work. Later runs can read them: see [Use past research in a new run](../how-to/campaigns/use-past-research.md).

Choose **Attempts**. Each change the agent submitted is an **attempt**, with one word for how it ended. The word sums up the judge's verdict, as in [Your first run](first-run.md#7-see-what-the-judge-decided):

| You see | It means |
| --- | --- |
| **Judging** | The judge is still measuring it |
| **Lost** | Not faster, not faster by 5%, or its gain did not hold up when measured again |
| **Unclear** | The measurements could not tell, or the rig failed while measuring it |
| **Broken** | It did not build, gave wrong answers, or crashed |
| **Judging**, with `rejected v0` under the change | It broke a rule of the campaign, such as a change outside `src/kernel/` or one of the lines never allowed, and was refused before it was built. It never gets a verdict, so the word stays **Judging**: a known fault ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)) |
| **Needs you** | It was confirmed faster, and waits for your decision: only when the run asks you, or an auditor sent it to you |
| **Declined** | You rejected it |
| **Champion #2** | It was confirmed faster on fresh runs and became the new best version |

[Outcome words on the dashboard](../reference/verdicts.md#outcome-words-on-the-dashboard) lists every word. Open an attempt to read the judge's reasons. Not every experiment works, and that is normal: the agent's next trial reads the judge's reasons for its last attempts and tries again. When a change is confirmed faster and nothing holds it, it becomes **champion #2**, every later trial starts from it, and the **Champions** chart on the run's **Overview** tab shows the gain. Above that chart, **Where the run started** shows the baseline: the `flops_per_s` the judge measured on each case before any change.

:::tip[Nothing yet after half an hour?]
- On **Live**, choose **lane-1**. If it has its green dot and new lines keep coming, the agent is still on its experiment: wait.
- In **What happened**, a line that says `lane-1's trial` … `ended without a submission` gives the reason. If every trial ends this way, give the rig another model whose name ends in `-free`, as in step 2, or pause the run (step 11) and resume it later.
- On **Live**, under **lane-1**, a line that starts `waiting until` and names `the provider's rate limit` means the free model is busy: the trial waits until that time, then goes on in the same conversation. If it waits again and again, give the rig another model whose name ends in `-free`, as in step 2.
- If **What happened** says that the planner planned a round `(by the fixed rules: the model gave no usable plan, because` and a reason, the model could not plan that round, often because a free model was busy. The lane then takes the next experiment in the queue, or a new one that the fixed rules add when the queue is empty. The next round asks the model again.
:::

### If a change waits for you

Thermite is hands-off by default: a change the judge confirms becomes the champion with no step of yours. The sample's kernel is slow on purpose, so a good first change is often far more than 15% faster. On a rig with an **auditor**, a model that gives such surprising gains a second look, the auditor's clear would come first. This rig has none, so **What happened** says that the change `had no audit: this rig has no auditor`, and the change becomes **Champion #2**. **Needs you** stays empty.

A change waits for you only when you asked for it, when you start a run: **Ask me first about**, under **More options** in a campaign's **Start a run** panel, or on the **New campaign** page. Then **Needs you** shows **Your decision** with the question `Make this change the new champion?`, and the row says why it waits. In [Your own project](your-own-project.md) you decide a change yourself. [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) explains each choice.

If after an hour you see only **Lost**, **Unclear** or **Broken**, that is normal for a small model: go on to step 11.

## 11. Pause the campaign

A hill climb never ends by itself, and Thermite sets no time limit unless you ask for one: see [Why Thermite runs until the job is done](../explanation/runs-until-done.md). When you have seen enough, open the run's page: **Campaigns**, then `matmul-agents › matmul-agents-1` on the card under **At work now**. In the page's header, press **Pause**, just right of **Message**. A small menu opens. It says that the lanes' running trials stop, and that the run's jobs waiting for the judge wait until you resume. In its field **why (optional)**, type `seen enough for now`, then press **Pause the run**.

The menu closes, and a line at the top of the page says `Sent to local-1 at`, the time, and `Waiting for the rig to take it.` If `lane-1` was in a trial, the trial stops, and its experiment goes back to the top of **Up next**, to be tried again when the run resumes. Within a minute, the line says `Done.`, the line under the run's name ends `· Paused`, and the button says **Resume**, with no refresh. On the run's **Overview** tab, the **Now** block says `This run is paused: seen enough for now. Nothing new starts until it is resumed.`

The rig keeps its model. [Your own project](your-own-project.md) uses it.

## What you did

You gave a rig a free model and checked it, and started a hill climb from the **New campaign** page: its project one folder of Thermite's repository, its kit uploaded as one file. Then you watched an agent propose changes while the judge measured each one. Only a change the judge confirmed could become the champion.

## Next

- [Your first goal campaign](first-goal-campaign.md): a campaign that ends by itself when its goal is met. It needs no model.
- [Choose a campaign mode](../how-to/campaigns/choose-a-mode.md): when to run a hill climb, a goal campaign or a research campaign.
- [Agents, lanes and the planner](../explanation/agents-lanes-planner.md): how the planner and the workers share the work.
- [Why agents never judge](../explanation/why-agents-never-judge.md): how the judge decides, step by step.
- [Choose a model](../how-to/models/choose-a-model.md): other free and paid models, and models on your own machine.
- [Free Inferencing](https://freeinferencing.com/): a list of services that give free access to models, to find more free models for your agents. A service there can need an account and a key: [Connect a model provider](../how-to/models/connect-a-provider.md) says how to add one. Free limits change often, and a free service can keep what you send it, so read its own terms before you give it your code.
- [Verdicts and states](../reference/verdicts.md): every verdict the judge can give.
