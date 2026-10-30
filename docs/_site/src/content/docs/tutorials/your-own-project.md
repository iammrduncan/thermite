---
title: "Your own project"
description: "Put a small project of your own in a public repository, start a campaign on it from the New campaign page, and take the best result home as a patch."
type: tutorial
sidebar:
  order: 4
---

In this tutorial you give Thermite a project of your own. You put a small, deliberately slow C program in a repository of yours, describe on the dashboard how to build it, run it and check its answer, and let an agent make it faster. Then you approve the agent's change and apply it to your own copy of the project.

At the end you'll know the whole path from a repository to a result you can keep, all from the dashboard. The same steps work for a real project.

It takes half an hour to an hour, most of it waiting for the agent. New words are explained as they come, and the [glossary](../reference/glossary.md) has them all.

## What you need

- Everything from the first two tutorials, [Your first run](first-run.md) and [Hand the work to agents](agents-with-a-free-model.md): Thermite running, the dashboard signed in, and `local-1` with a free model from OpenCode. This tutorial uses that model.

  Free models are often busy. Before you start, open **Settings**, find the row for `local-1` under **Harness and model for each rig**, and press **Check**. The row says the check was sent, then that it is running, then its result, with no refresh: usually within a minute. If the row says `Its model check FAILED`, for example with `Rate limit exceeded. Please try again later.`, choose another model whose name ends in `-free`, press **Use**, and wait until the check has `passed`, as in [step 3 of Hand the work to agents](agents-with-a-free-model.md#3-check-that-the-model-works).

  If your rig uses a paid model instead, set **Stop after (hours)** in step 7, so each run of the campaign pauses itself after that many hours.

- An account on a Git hosting service, such as GitHub, GitLab or Codeberg, where you can make a **public** repository, and git set up on your computer to push to it. Your rig fetches the project from there over `https`, and the agents send its code to the model's service as they work. For a private repository, see [Use a private repository](../how-to/campaigns/private-repository.md) after this tutorial.

## 1. Make the project

The program counts the prime numbers below a number, very slowly: to test each number, it tries every smaller number as a divisor. An agent will find faster ways.

In a terminal, go to your home folder, and make the project and its first commit there:

```sh
cd ~
mkdir primes
cd primes
cat > primes.c <<'EOF'
#include <stdio.h>
#include <stdlib.h>

/* Counts the prime numbers below n, the slow way: it tries every divisor. */
static int is_prime(int k) {
  if (k < 2) return 0;
  for (int d = 2; d < k; d++)
    if (k % d == 0) return 0;
  return 1;
}

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 1000;
  int count = 0;
  for (int k = 2; k < n; k++) count += is_prime(k);
  printf("%d\n", count);
  return 0;
}
EOF
git init -b main
git add primes.c
git commit -m "Count primes the slow way"
```

The last command prints a line that starts with `[main (root-commit)`.

## 2. Put it in a public repository

1. On your Git host's website, make a new, empty, **public** repository named `primes`. Don't let it add a README or any other file.
2. Copy its `https` address. It looks like `https://git.example.com/you/primes.git`, with your host and your account in it. You give this address to Thermite in step 5.
3. Push the project there. The empty repository's page shows the commands to push an existing repository. They look like these, with your own address in the first line:

   ```sh
   git remote add origin https://git.example.com/you/primes.git
   git push -u origin main
   ```

   If your git pushes over SSH, the page gives an SSH address for the first line: use that one. Thermite still reads the repository from its `https` address.

The repository's page on your host now shows `primes.c`.

## 3. Write down the right answers

The judge needs to know when the program's answer is right. You give it the answers in a file of their own, outside the project. The judge's check reads that file; the program that is timed never gets it.

```sh
cd ~
mkdir primes-answers
printf '100000 9592\n80000 7837\n' > primes-answers/expected.txt
```

Each line is a number and how many primes there are below it: 9,592 below 100,000, and 7,837 below 80,000.

## 4. Name the campaign

In the dashboard, open **Campaigns** in the sidebar, and press **New campaign** at the top right of the page. The page has six steps: **1 Aim**, **2 The brief**, **3 Project**, **4 How to measure**, **5 Where it runs** and **6 Review and start**. Each field's ⓘ says more about it.

On **1 Aim**:

1. Keep **Hill climb** chosen. A **hill climb** improves one measured number, here how long the program takes. The other cards, **Reach a list of goals** and **Research a question**, are Thermite's other two [campaign modes](../explanation/campaign-modes.md).
2. **Campaign name**: `primes-speed`
3. **Title**: `Count primes faster`
4. Press **Next**.

On **2 The brief**, leave every field empty and press **Next**. The brief is optional: it is where you give the agents background, links, ideas and hypotheses.

## 5. Point it at your project

On **3 Project**:

1. **Repository**: your repository's `https` address from step 2.
2. **Start from**: `main`
3. **Folder in the repository**: leave it empty. Your project is the whole repository.
4. **Repository access**: keep **Public: no key**.
5. Press **Look it up**. Control reads your repository and says `Found: main is at`, a short commit id, and how many files it has: `· 1 file. Rigs fetch it from there.` Every run starts from exactly that commit.

   If it says `control cannot read it without a key: is the repository private?` instead, check the address, and check that the repository is public. If it says `the repository has no branch or tag named main`, check **Start from**, and that step 2's push went through.
6. **Files the agents may change**: `primes.c`. A change to any other file is refused before it is built.
7. Press **Next**.

## 6. Tell the judge how to measure it

On **4 How to measure**, keep **Describe it here** chosen. You are describing the **kit**: the judge's recipe for building your project, running it and checking each answer. Control writes the kit from what you type and keeps it.

Fill in these fields, in the order the page shows them. Leave every field that this list doesn't name empty, such as **Input files**.

1. **Run**: `{build}/primes {args} > {out}/result.txt`

   `{build}` is the folder that holds what the build made (you describe the build itself in item 6), `{args}` is the test case's arguments, and `{out}` is a folder for the run's results.

2. **Test cases**: in the first row, replace `default` with `100k` under **Name**, and set **Arguments** to `100000`. Press **Add a case**, and in the new row set **Name** to `80k`, **Arguments** to `80000`, and tick **Hidden test**.

   The judge times every change on `100k`. It runs the hidden test, `80k`, only to double-check a change that already looks faster: the change must give the right answer there too, and may be slower there than the champion by no more than 1%.

3. **The score**: keep **How long a run takes**. Keep **Smallest gain that counts (%)** at `5` and **Runs per case** at `3`.
4. **Is it right?**: `grep -qxF "{args} $(cat {out}/result.txt)" {kit}/expected.txt`

   After each run, this looks for the number and the program's answer, together, as one line of your answers file. `{kit}` is the folder with the files you add next. A run whose answer is wrong never wins, however fast it is.

5. **Files for the check**: choose `expected.txt` from your `primes-answers` folder. Leave **the run reads these too** unticked, so the program never gets the answers.
6. **Build**: `cc -O2 -o primes primes.c`
7. **What the build makes**: `primes`
8. Press **Next**.

## 7. Choose where it runs

On **5 Where it runs**, the card for `local-1` is chosen. It shows the rig's hardware, `cpu · generic-cpu`, and after `agents:` the free model you gave it.

1. **Agents working at once**: `1`
2. **The agents' model**: keep **the rig's model**. `local-1` goes on with the free model you gave it.
3. With a paid model, open **Advanced** and set **Stop after (hours)**, for example `2`. That many hours after each run of this campaign starts, its agents stop and the run pauses. With the free model, leave it empty: no limit.
4. Leave the rest as it is, and press **Next**.

## 8. Try the kit first

On **6 Review and start**, a sentence sums up the campaign. It starts with `primes-speed will make its runs faster`, names `primes.c` as the only file to change, and ends `1 agent works on local-1.`

Press **Try the kit first**. This starts a run with no agents: the judge builds your project and runs it, so you see the kit work before an agent spends any time on it.

The run's own page opens and says `Starting primes-speed-try-1 on local-1.`, then how the start goes, such as `Sent to local-1 at`, the time, and `Waiting for the rig to take it.` The rig fetches your project from your Git host and the kit from control, and checks both. Stay on the page: once the rig reports the run, usually within a minute, the page shows the run by itself, at the same address. The line at the top reads `Campaigns › primes-speed › primes-speed-try-1`, then `on local-1 · hill climb · judge only · Running`, and below it is the note **A try of the kit.** The run's tabs follow: **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**. **Overview** is open.

A minute or two after you pressed **Try the kit first**, press **refresh**. Under **Recent**, on the **Overview**, you see `The judge measured the starting point, champion #1, on every case:` and how long the `100k` case took. This is the run's **baseline**: the judge built your project and ran the `100k` case alone, in 3 blocks of 3 runs, and the check passed on every answer. The block **Where the run started**, on the same tab, shows the time under `seconds`, with how much it varied. Every change an agent makes is held against these values.

A little later, **Recent** also says `The judge measured the rig's noise:` and a small percentage. For that, the judge timed your project against itself many times. Now it also knows how much your computer's timings vary on their own.

These lines mean that the kit works. The try has nothing more to do: under **Now**, the judge is `idle`. It stays **Running** until the run you start in step 9 replaces it, so you need not wait for it.

:::tip[If the try failed]
If **Recent** says instead `The judge could not measure the starting point, champion #1:`, the rest of the sentence says why, after the case that failed. For example, `cell 100k: the check exited 1` means that an answer was not a line of `expected.txt`: check the answers file and the **Is it right?** command. The sentence ends by saying that the run is in setup, where agents would work to make the project build and run; a try has no agents, so fix the kit instead, as below. If **Recent** says that `The judge's job` failed, the end of that sentence says why. If the run never appears, open **Commands** in the sidebar: the `assign campaign` line says why.

To fix a field, open **New campaign** again. It starts empty: fill in every field again as in steps 4 to 7, with the same campaign name and the field fixed, and press **Try the kit first**. That saves the campaign as version 2, and tries it as `primes-speed-try-2`. The campaign's page opens, and once the rig reports the new try, it opens the try's own page by itself.
:::

## 9. Start the campaign

The try shows that the kit works. Now start the real run, with an agent.

1. On the try's page, in the note **A try of the kit.**, press the link **start the campaign**. The campaign's page opens, with the panel **Start a run of primes-speed** on its right.

   If you left the try's page, open the campaign's page instead: press **primes-speed** in the line at the top of the try's page, or open **Campaigns** in the sidebar and press `primes-speed` under **All campaigns**. Then press **Start a run** at the top right. The same panel opens.
2. **Where it runs**: the card for `local-1` is chosen. It is marked **busy**, and says `Busy: primes-speed-try-1 is at work there, and pauses when this run starts (a rig runs one run at a time).` That is expected: the new run replaces the try.
3. **Agents**: keep **On**. Under it, the panel says `The rig's agents, on` and the name of the free model you gave `local-1`.
4. **From past research** searches what earlier runs of this campaign recorded, for a new run to start from ([Use past research in a new run](../how-to/campaigns/use-past-research.md)). The try recorded nothing a run can start from, so the list says `Nothing found in these collections yet.` Leave it.
5. Open **More options**, and set **When a change is confirmed better** to **ask me every time**. Every change the judge confirms will wait for you before it becomes the new best version.
6. At the bottom, the panel sums it up: `Starts a new run on local-1, with agents on` and your model. Press **Start the run**.

The new run's page opens with a card at the top, `Starting primes-speed-1 on local-1.`. As in step 8, once the rig reports the new run, the page shows the run, `primes-speed-1`, by itself, and its top line ends `Running`. The new run keeps what you set on the New campaign page, such as **Stop after (hours)**, whose hours count from this run's start.

The try has stopped. To see it, press **primes-speed** in the line at the top: the campaign's page lists the try under **Earlier runs** as **Paused**, with `replaced by primes-speed-1` under **Why it stopped**. Press `primes-speed › primes-speed-1` under **At work now** to go back to the run's page.

As in [Hand the work to agents](agents-with-a-free-model.md#9-watch-the-agent-work), the judge first measures the new run's starting point, as it did for the try: meanwhile the **Now** block on the run's **Overview** shows `planner` and `round 1 waits for the judge's baseline of the starting point (champion #1)`. Then the planner works, often for less than a minute. While it plans, the **Now** block on the run's **Overview** shows `planner` and `planning round 1 (1 lane)`, and **Agents**, under **The run**, says `On: they start work at the first round`. The run's page may open only after the planner is done. Then the agent starts, and **Now** shows `lane-1` with the experiment it works on: the one thing the planner gave it to try, from the run's **queue** of experiments. The run's **Experiments** tab shows that queue, and its **Journal** tab the field notes the agents keep as they work. A **lane** is one line of search, worked by one **trial** after another: each trial is one agent's session, which submits at most one change.

To watch the agent:

1. At the top of the run's page, press **Live**. Live opens on `primes-speed-1` and shows its lines as they come, newest at the bottom. Above them are filters: **Everyone**, **lane-1**, **Planner**, **Judge**, **Advisors** and **You**. (**lane-1** shows once the planner has given the lane its first experiment.)
2. Choose **lane-1**. It has a green dot while its agent works. Now you see only the agent: it reads `primes.c`, changes it, builds it and tries it. Each trial lasts until the agent submits its change or stops.

The box at the bottom of Live now says **To lane-1**, and its grey text says when the agent would read a message from you. You don't need it in this tutorial: [Steer a run](../how-to/campaigns/steer-a-run.md) says how to use it.

## 10. Approve the agent's change

The agent's first change often reaches the judge within a few minutes of **Start the run**, and usually within half an hour. Go back to the run's page: at the top of Live, press **Open the run**. Press **refresh** now and then.

The run's **Attempts** tab lists each change the agent submitted. The first one can be **Broken**: when we ran this tutorial, the agent built its change with an extra option that the kit's **Build** command doesn't use, so the judge's build failed. The change's page, which opens when you press its row, gives the judge's reasons. The next trial tries again.

When the judge has confirmed a change faster on fresh runs, it waits for you. Then, on the run's page:

- the top line ends **Approval** instead of `Running`;
- the run's **Overview** tab has a dot, and the tab's first line ends `1 decision waits for you.`;
- under **Recent**, a line says that the change was `confirmed faster on fresh runs`;
- under **Needs you**, at the top of the **Overview** tab, the change has the label **Your decision**. Its row says `lane-1 changed 1 file. The judge measured it:` and the gain, and it has the buttons **Make it the champion** and **Reject it**.

The **Overview** item in the sidebar shows a count too.

**Approval** means the change waits because you asked, in step 9, to decide every change: its row says `It waits for you because you asked to decide every change (promotion: owner approval).` Without that choice, Thermite is hands-off, and the change would have become the champion by itself. This rig has no auditor, so no audit comes first. Just after the rig starts, before its supervisor has said that it has no auditor, the word can be **Auditing** for a minute.

1. Open the item: press the text of its row, not its buttons. It asks `Make this change the new champion?`, and shows what the agent says it did, which files it changed and by how many lines, what the judge found, why the change waits for you, and what each choice does.
2. Read **Problems that the agent wrote**, if the item has them. Agents often note limits that don't matter here: when we ran this tutorial, the agent wrote that its new method uses some memory (`Basic sieve uses O(n) memory`). That is no reason to refuse a faster program. If a problem says that the answers can be wrong, or that the change works only for the test cases, press **Reject it** instead. The change then never becomes the champion, and the attempt shows **Declined**.
3. Press **Make it the champion**.

The item leaves **Needs you** at once. The change's own page says `You selected Make it the champion`, and within seconds, with no refresh, `The rig made the change champion #2.` The **champion** is the run's best version so far. Champion #1 was your project as you pushed it.

The agent goes on working while you decide, so another change may wait for you by then, and the top line still ends **Approval**. Its item says that the champion changed after the judge measured it, so **Make it the champion** would have the judge test it again against champion #2. You can leave it: this tutorial takes champion #2 home, and step 12 pauses the run.

The change itself stays on the rig until the rig's next **export**: it copies the run's results out of the harness, keeps them, and sends each new champion to control as a patch. You'll read the change line by line in the next step, before you keep it.

:::tip[If nothing waits for you after half an hour]
Press **Live** at the top of the run's page to see what the agent is doing, and open the run's **History** tab for trials that ended. A trial can end without a change; the next trial then tries again. A busy free model ends trials with `Rate limit exceeded. Please try again later.` If every trial ends that way, give `local-1` another free model, as under [What you need](#what-you-need). The next trial uses it.

If **History** says that the planner planned a round `(by the fixed rules: the model gave no usable plan, because` and a reason, the model could not plan that round, often because a free model was busy. The lane then takes the next experiment in the run's queue, or a new one that the fixed rules add when the queue is empty. The next round asks the model again.
:::

## 11. Take the result home

The rig exports its results every hour. To have them now:

1. Open **Rigs**, then **local-1**, and press **Export**. Leave **What changed** chosen and press **Export** under it. A line at the top of the page says `Sent to local-1 at`, the time, and `Waiting for the rig to take it.`, then, within a minute, `Done.`
2. About a minute later, open **Campaigns** in the sidebar. Under **At work now**, on the card of your run, press `primes-speed › primes-speed-1`. On the run's **Overview**, under **The run**, beside **Champion**, a link says `download champion #2 as a patch`, then `applies to` and the commit your campaign started from. If the link isn't there yet, press **refresh** after another minute.
3. Press the link. Your browser saves a file named like `primes-speed-1-champion-2-on-` and that commit, ending in `.patch`.

Apply it to your project. In the terminal, with the file name your browser saved:

```sh
cd ~/primes
git apply ~/Downloads/primes-speed-1-champion-2-on-1a2b3c4d.patch
git diff
```

Your `main` branch is still at the commit the campaign started from, so the patch applies cleanly. `git diff` shows the agent's change to `primes.c`. When we ran this tutorial, the agent replaced the divisor loop with a sieve of Eratosthenes, which crosses out the multiples of each prime instead of testing every number. Read the change: the program should still count the primes, not print an answer it was told. If you like it, keep it with a commit:

```sh
git commit -am "Count primes faster, as Thermite's judge confirmed"
```

## 12. Pause the campaign

The agent keeps looking for more speed until you stop it. At the top of the run's page, on the right, press **Pause**, just right of **Message**. A small menu opens. In its field **why (optional)**, type `result taken home`, then press **Pause the run**.

The menu closes, a line at the top of the page says `Sent to local-1 at`, the time, and `Waiting for the rig to take it.`, and the agent's current trial stops too. Within a minute, with no refresh, the line says `Done.`, the button says **Resume**, and the **Now** block says `This run is paused: result taken home. Nothing new starts until it is resumed.` The top line ends **Paused**, even while a change waits for you: it stays under **Needs you**.

A paused run uses no model: no agent works on it until you resume it. The runs from the earlier tutorials are paused or finished too. To stop Thermite itself, see [step 8 of Your first run](first-run.md#8-stop-or-keep-thermite).

## What you did

You put a project of your own in a repository, described its kit on the New campaign page, and tried the kit before any agent started. Then an agent made the program faster, you approved the change the judge confirmed, and you applied it to your own copy as a patch.

This is the last tutorial. From here, the how-to guides help with your own projects, and the explanations say why Thermite works as it does.

## Next

- [Choose a campaign mode](../how-to/campaigns/choose-a-mode.md): a goal campaign or a research campaign for your next piece of work.
- [Write a kit for your project](../how-to/campaigns/write-a-kit.md): kits for real projects, with their own scripts and cases.
- [Start a campaign from the dashboard](../how-to/campaigns/start-from-dashboard.md): every field of the New campaign page.
- [Use a private repository](../how-to/campaigns/private-repository.md): a project that isn't public.
- [Decide what waits for you](../how-to/campaigns/decide-what-waits.md): which changes become the champion at once, and which wait.
- [Take the result](../how-to/campaigns/take-the-result.md): every way to get a champion out of Thermite.
- [Why the benchmark lives in a kit](../explanation/kits.md): why the measurement stays out of the agents' hands.
