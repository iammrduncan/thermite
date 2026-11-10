---
title: "Your first goal campaign"
description: "Run a goal campaign on the smoke project, submit a change yourself, and watch its goal go from unmet to met until the campaign ends by itself."
type: tutorial
sidebar:
  order: 4
---

In this tutorial you run a **goal campaign**. A hill climb improves a number for as long as you let it; a goal campaign works until a list of goals is met, then ends by itself. The third [campaign mode](../explanation/campaign-modes.md), research, studies a question and writes a report from sources that code has checked. You won't need an AI model: you propose the change yourself, and the judge decides whether it meets the goal.

At the end you'll have set a goal from a real measurement, seen it unmet, submitted a change, and watched the judge confirm the goal and close the campaign.

It takes about fifteen minutes. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from [Install on one machine](first-run.md): Thermite running on your computer, the dashboard signed in, and **Judge smoke** passed on `local-1`. This tutorial uses the smoke project and kit that the smoke check left on the rig.
- **Node.js** 22.19 or later, and **git**, for Thermite's command line.

A rig works on one run at a time, so starting a run pauses any other run on `local-1`. If you did [Run your first campaign](agents-with-a-free-model.md), its run stays paused; that is expected.

## 1. Install Thermite's command line

You start the campaign from the command line. It comes with Thermite's source code, in a folder `thermite-source` beside your `thermite` folder. If you did [Run your first campaign](agents-with-a-free-model.md), you made that folder in its step 4: open a terminal in it, and run only the last three commands below, from `ln -s` on.

Otherwise, go to the folder that holds your `thermite` folder, and do it all now:

```sh
cd ..
git clone --branch v0.2.3 https://github.com/iammrduncan/thermite.git thermite-source
cd thermite-source
ln -s ../thermite/.dev .dev
npm ci
npm run build
```

`v0.2.3` is the release your `compose.yaml` names in its first line, `# Thermite 0.2.3`; use yours, with a `v` before it. The link lets the command line read your tokens from `.dev/`, as the commands on this page do. Run every command on this page in the `thermite-source` folder, except the one that opens a shell in step 6: it runs in your `thermite` folder.

## 2. Read the example contract

A **contract** says what a campaign must achieve and how the judge decides. Thermite comes with one for this tutorial, `examples/contracts/smoke-cpu-goal.json`. Open it in a text editor. It names the smoke project and its kit by their exact commits, the ones the smoke check left on your rig, and lets a change touch only files in `src/kernel/`. Then comes its goal:

```json title="smoke-cpu-goal.json (part)"
"goals": [
  {
    "id": "faster",
    "description": "the large case reaches the speed this goal sets, in floating-point operations a second",
    "verify": {
      "type": "metric_threshold",
      "metric": "flops_per_s",
      "op": ">=",
      "value": 10000000000,
      "cells": ["large"]
    }
  }
]
```

The goal `faster` is met when the program's speed on the kit's `large` case (a **cell** in the contract), `flops_per_s`, is at least `value`. The judge doesn't take one run's word for it: it runs the case five times (`threshold_reps`, which this contract leaves at its default), and the goal is met only when it is sure, with 95% confidence, that the speed is at least the value.

The value here, ten billion operations a second, is deliberately far above what the smoke project does today. A goal must fit the computer it is measured on, so first you measure yours.

## 3. Measure where the project starts

Start a run of the example as it is:

```sh
npx thermite assign --contract examples/contracts/smoke-cpu-goal.json --run goal-start-1 --agents off \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

It prints `{"id":"…","status":"pending"}`. Control has signed a command, and within seconds the rig starts the run `goal-start-1`. `--agents off` means that no agent works on it: only the judge.

The first thing the judge does in a goal campaign is check which goals the project already meets. Look at it on the dashboard:

1. Within a minute, open **Campaigns** in the sidebar and press **refresh**. At the top, under **At work now**, a card shows your run: `smoke-cpu-goal › goal-start-1`, marked **judge only**, `on local-1`, `0/1 goals`. It has no **Message** button: no agent works on this run to read one.
2. In the table under **All campaigns**, choose **smoke-cpu-goal**. The campaign's page opens. Under **What it is for**, it shows the contract's `title`, and below it the goal `faster`. Under **At work now**, the same card shows the campaign's only run so far. A **run** is the campaign at work on one rig.
3. On the card, press the run's name, `smoke-cpu-goal › goal-start-1`. The run's own page opens. The line at the top reads `Campaigns › smoke-cpu-goal › goal-start-1`, then `on local-1 · goal · judge only · Running`. On the right are the buttons **Live**, **Pause**, **Export** and **⋯** (it holds **Close run**, which ends a run for good), but no **Message**: with no agents, the run has no lanes or planner to message. A box under the line says `Judge only: No workers run. The judge checks the champion; the advisors' ideas wait in the queue for a run with workers.` Below it are the run's tabs: **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**. This tutorial uses the run's **Overview** tab, which is open, and its **History** tab.

On the run's **Overview** tab, the **Goals** block says `0 of 1 met`, and under the goal `faster`, marked **unmet**, a line like this:

```text
flops_per_s >= 10000000000: large: 3.44791e+9 [3.32615e+9, 3.56967e+9]
```

The first number after `large:` is your computer's speed now: here 3.45 × 10⁹, or 3.45 billion operations a second. The two in brackets are the range the judge is 95% sure of. Your numbers will differ: they depend on your processor. A long goal or line shows only its start: press **more** to read all of it.

Under the goal, press **How it is checked**. It opens to the goal's real check, as your rig's kit runs it: `flops_per_s >= 1.000e10` FLOP/s on each case below, run 5 times; the case `large` with the parameters the kit runs it with, `n=256 reps=40 seed=23 work=1342177280`, and its time limit, `60 s`; and the kit's run command. This is how you check that a goal's words and the kit agree. If the block says `The judge has not checked the goals yet.`, press **refresh** after another minute.

## 4. Set a goal you can reach

The change you will submit makes the large case much faster. You saw it in your first run: the smoke check's winning change was confirmed tens of percent faster. So set the goal a fifth above where the project starts. The starting point can't reach that, and the change can.

1. Copy the example:

   ```sh
   cp examples/contracts/smoke-cpu-goal.json my-goal.json
   ```

2. Open `my-goal.json` in a text editor and change two lines. First, the line `"version": 1` (not `"schema_version"`, which stays 1) becomes:

   ```json title="my-goal.json (part)"
   "version": 2,
   ```

   Then, in the goal, the line `"value": 10000000000` becomes:

   ```json title="my-goal.json (part)"
   "value": 4.2e9,
   ```

   For `value`, multiply your first number from step 3 by 1.2 and round it up. In the example, 3.45 × 10⁹ × 1.2 is about 4.14 × 10⁹, so `4.2e9`. The version goes up because a contract never changes in place: a changed contract is a new version of its campaign.

3. Check the file with Thermite's own rules:

   ```sh
   npx thermite contract validate my-goal.json
   ```

   It prints `ok goal smoke-cpu-goal v2 sha256=` and a long hash.

## 5. Start the goal campaign

```sh
npx thermite assign --contract my-goal.json --run goal-1 --agents off --promotion auto \
  --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
```

`--promotion auto` lets a change that the judge confirms become the **champion**, the run's best version, without waiting for you. `local-1` already does that by its own rule; the flag makes this run do it whatever the rig's rule is.

Then look at the campaign again:

1. After a minute, go back to the campaign's page: in the line at the top of the run's page, press **smoke-cpu-goal**. Press **refresh**. The page now counts two runs. Under **At work now**, a card shows the new run, `smoke-cpu-goal › goal-1`. Under **Earlier runs**, `goal-start-1` is **Paused**, and **Why it stopped** says `replaced by goal-1`, because a rig works on one run at a time. Leave it paused.
2. On the card, press `smoke-cpu-goal › goal-1`. Its page opens on the run's **Overview** tab. The **Goals** block says `0 of 1 met`: the goal `faster` is **unmet**. Its line starts with your value written out in full (in the example, `flops_per_s >= 4200000000`), which is more than the speed the judge measured after `large:`. If the block says `The judge has not checked the goals yet.`, press **refresh** after another minute.

## 6. Propose a change yourself

The change is the one the smoke check confirmed in your first run: it loops over the matrix in a different order, so the inner loop reads memory in sequence. Thermite's image holds it, with the smoke project.

You submit it from inside the rig's harness container, where the agents work too. You submit as a **proposer**: someone who submits changes by hand, with `thermite submit` and the harness's proposer token. The harness listens on port 8700 inside its container, and has no port open to your computer: only the rig's supervisor reaches it from outside.

1. In a terminal in your `thermite` folder, open a shell in the harness container:

   ```sh
   docker compose exec harness sh     # Docker
   podman compose exec harness sh     # Podman
   ```

   The prompt changes to `#`: you are now inside the container.

2. Make the change as a patch, and submit it to the run `goal-1`:

   ```sh
   rm -rf /tmp/smoke
   cp -r /opt/thermite/checks/examples/smoke-project /tmp/smoke
   cd /tmp/smoke
   git init -q -b main
   git add -A
   cp /opt/thermite/checks/kits/smoke-cpu/candidates/good/src/kernel/matmul.c src/kernel/matmul.c
   git diff > /tmp/good.patch
   thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token \
     --run goal-1 --patch-file /tmp/good.patch --hypothesis "i-k-j loop order makes the inner loop contiguous"
   ```

   The last command prints a line that starts with `{"attempt":"a-` and goes on with `"lifecycle":"queued"`. Your change is now an **attempt**, waiting for the judge.

3. Leave the container:

   ```sh
   exit
   ```

## 7. Watch the goal be met

It takes less than a minute. Stay on the page of `goal-1`. Press **refresh** until the line at the top says **Completed** after `on local-1 · goal · judge only`. On the run's **Overview** tab, **Recent** shows the newest ten lines of the story, newest at the top. Read them from the bottom up:

1. The judge screens your change: it builds it and checks the goal. It says the change `looked like goal progress; being confirmed on fresh runs. Newly met: faster.`
2. It checks the change again on fresh runs: `confirmed: it meets more goals and loses none. Newly met: faster.` Then your change `became champion #2`. Champion #1 was the project as it started.
3. The judge checks the goals of the new champion: `The judge checked champion #2: 1 of 1 goals met, every required goal. It checks the champion a second time before the run closes; no new trial starts until then.`
4. It checks them a second time, because ending a campaign is final and one check is not enough. The last three lines come at the same moment: `Run goal-1 closed: every required goal is met.`, `Every required goal is met: the campaign is complete.`, and the second check's `1 of 1 goals met, every required goal`. This campaign has no hidden test cases. In one that has them, the second check also runs those of each goal met, and the run closes only if they pass.

To see the whole story, from `Run goal-1 started`, open the run's **History** tab: it keeps every line, also newest first.

The run's state is now **Completed**: it closed because it met its goal. On the run's **Overview** tab, the **Goals** block says `1 of 1 met`, with a ✓ beside `faster`, and under it the line with the speed the judge measured, now above your goal. The sidebar shows the campaign as **Completed** too, because a campaign with no run at work shows its newest run's state. Open **Campaigns** in the sidebar: no run of the campaign is under **At work now** any more, and the table's default filter, **Active and paused**, no longer lists **smoke-cpu-goal**. Choose the filter **All**: the row for **smoke-cpu-goal** says `1 paused` and `1 completed` under **Runs**, and `1/1 goals met` under **Best so far**. The paused run is `goal-start-1`, which you left paused in step 5. It uses nothing while it is paused. Nothing more runs: `goal-1` stopped once its goal was met.

## What you did

You measured where a project starts, set a goal the judge can check, and saw it unmet. Then you submitted a change from inside the rig, and watched the judge screen it, confirm it, make it the champion, check the goals twice and close the campaign by itself.

## Next

- [Your own project](your-own-project.md): give Thermite a project of your own from the dashboard, with agents, and take the result home.
- [Campaign modes](../explanation/campaign-modes.md): hill climbs, goal campaigns and research, and when each fits.
- [Choose a campaign mode](../how-to/campaigns/choose-a-mode.md): pick one for your own work, and see what each needs.
- [Write a contract](../how-to/campaigns/write-a-contract.md): goals checked by your kit's own code, by a measured value, or by people.
- [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md): submit changes yourself to see that a kit judges them right.
- [Decide what waits for you](../how-to/campaigns/decide-what-waits.md): approvals, audits, reviews and "not possible" endings.
- [Contract](../reference/contract.md): every field of a goal contract.
