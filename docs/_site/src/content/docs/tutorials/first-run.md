---
title: "Your first run"
description: "Start Thermite on your own computer and watch its judge check a rig, in about twenty minutes."
type: tutorial
sidebar:
  order: 1
---

In this tutorial you start Thermite on your own computer, sign in to its dashboard, and watch its judge decide on a dozen changes whose right answers are known. You won't need an AI model or a GPU yet.

At the end you'll have a running Thermite and you'll have seen its central idea at work: a change counts only when a judge the agents can't touch says it does.

It takes about twenty minutes. You build nothing: Thermite comes as ready-made container images, which your computer downloads the first time.

## What you need

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory and several gigabytes of free disk. Thermite's three images, with the message bus's small one, take about 2.5 GB. With Podman on a Mac, that space must be free in Podman's virtual machine.
- **Docker** with Docker Compose, or **Podman** with `podman compose`. These run Thermite's parts as containers. `podman compose` hands the work to a compose program, so install one of them too: podman-compose (for example, `pipx install podman-compose`), or Docker Compose 2 or later. Not `docker-compose` 1.x, which some Linux systems' packages still give: it can't read Thermite's compose file, and `podman compose` uses it first when it is installed. If you have it, [remove it first](../how-to/operate/troubleshoot.md#compose-wont-start-name-does-not-match-any-of-the-regexes). On a Mac, Podman runs the containers in a small virtual machine, which must be started (`podman machine start`).
- `curl`, which macOS and most Linux systems already have, and an internet connection.

Thermite's agents run code that an AI model writes, on your computer. This tutorial uses no agents, but read [Known limits](../reference/known-limits.md) before you give Thermite a model: it says what that code can reach, and why to set a budget before you use a paid key. [The security model](../explanation/security-model.md) says what each part of Thermite can reach and what it trusts.

## 1. Get Thermite

Open a terminal. Make a folder for Thermite, and download the compose file of Thermite's latest release into it:

```sh
mkdir thermite
cd thermite
curl -fsSLO https://github.com/iammrduncan/thermite/releases/latest/download/compose.yaml
```

The folder now holds one file, `compose.yaml`. It says which containers make up Thermite and which images they run. Its first line names the release, such as `# Thermite 0.1.0`. Each image is pinned to the exact build of that release, so every computer that uses this file runs the same Thermite.

## 2. Make your local tokens

Thermite uses **tokens**, long random passwords, so that only you can steer it. Make a set for this computer. Use the line for your container tool:

```sh
docker compose run --rm init     # Docker
podman compose run --rm init     # Podman
```

The first time, this downloads Thermite's control image. Then it lists each file it makes, says in lines that start with `rig:` what Thermite can use on your computer (its CPUs, its memory and any GPUs), and its last line is `local init: .dev ready (17 made, 0 kept)`. The tokens are now in the folder `.dev/secrets/`, in your `thermite` folder. They stay on your computer. Keep the folder: Thermite reads its tokens from there every time it starts.

## 3. Start Thermite

Start Thermite's containers:

```sh
docker compose up -d             # Docker
podman compose up -d             # Podman
```

The first time, this downloads the other three images, which can take a few minutes. Later starts take seconds. When it finishes, check that four containers are up:

```sh
docker compose ps                # or: podman compose ps
```

You see four lines, one each for `control`, `nats`, `harness` and `supervisor`, and each one's status starts with `Up`. If lines for `init` and `enroll` say `Exited (0)`, those are the token steps: `init` of step 2, and `enroll`, which enrolls the rig with control at each start and gives it its token. Each stops when its work is done. The four are the two halves of Thermite:

- **control** is the one place you watch and steer everything from: the dashboard, its API and MCP. **nats** is its message bus, which carries what the rig reports to control, and control's commands to the rig.
- **harness** and **supervisor** together make a **rig**: the place where research happens. The harness holds the judge and the agents. The supervisor is the rig's link to control. This rig is called `local-1`.

:::tip[If a line is missing or its status isn't `Up`]
Read that container's log, for example `docker compose logs harness` (or `podman compose logs harness`). If `up` stopped with `address already in use`, another program has port 8800: see [The port is already in use](../how-to/operate/troubleshoot.md#the-port-is-already-in-use). If it stopped with `'name' does not match any of the regexes`, the compose program is the old Compose v1: see [how to replace it](../how-to/operate/troubleshoot.md#compose-wont-start-name-does-not-match-any-of-the-regexes). [Troubleshoot](../how-to/operate/troubleshoot.md) has the other common problems. It starts with `thermite doctor`, which checks Docker or Podman, the port, disk and the clock, and says how to fix each problem it finds.
:::

## 4. Sign in

1. Show your **owner's token**, the token that lets you steer everything, and copy it. The sign-in page calls it the **Admin token**:

   ```sh
   cat .dev/secrets/control-admin-token
   ```

2. Open <http://127.0.0.1:8800/ui> in your browser.
3. Paste the token into **Admin token** and press **Sign in**.

You see the **Overview**, the first page in the sidebar. Its first line says `nothing needs you · 0 runs at work · 1 of 1 rigs reporting`. If it says `0 of 1`, the rig hasn't reported yet: wait a minute and press **refresh** in the status bar, the line along the bottom of every page. This page doesn't update by itself.

The sidebar on the left holds the dashboard's pages: **Overview**, **Campaigns**, **Rigs**, **Metrics**, **Live** and more.

:::tip
If the sign-in page comes back with no message, the token didn't match. Copy it again, without spaces.
:::

## 5. Meet your rig

Choose **Rigs** in the sidebar, then **local-1**.

The page says `local-1 is live; it reported 10s ago.`, with your computer's processors, memory and disk under **What it runs on**. With Podman on a Mac, these are the virtual machine's, not the whole Mac's. Find the **Checks** block. It has three checks:

- **Model route** shows **not run yet**. It checks the agents' model, which you give the rig in [Hand the work to agents](agents-with-a-free-model.md).
- **Isolation** already shows **passed**: the rig ran it by itself when it started. Each agent works as its own operating-system user, and the check made sure that those users can't reach what they must not, such as the judge's files and other agents' work. If it shows **failed**, the sentence beside it says why: see [The isolation check failed](../how-to/operate/troubleshoot.md#the-isolation-check-failed) before you go on.
- **Judge smoke** shows **not run yet**. You run it next.

## 6. Run the judge's smoke check

Now give the judge something to judge. The **Judge smoke** check submits thirteen changes to a small matrix-multiplication program. For each one, the right **verdict**, the judge's decision on that change, is already known.

1. Beside **Judge smoke**, press **Run it**.

   The button turns at once into **Sending…**. Then **Judge smoke** shows **sent**, its button says **Sent**, and the line under its name says `Sent to the rig at`, the time, and `It starts when the rig takes it.`

2. Stay on the rig's page: it follows the check by itself, with no refresh. Within a few seconds, **Judge smoke** shows **running** with the time so far, such as `running · 12 s`, and its button reads **Running…**. The line under its name says `Its running runs are paused for it, and resumed after.` Within a minute, when the rig has reported, the line that starts `local-1 is live` goes on with `It runs rig-check-smoke-cpu-1abb49d1 › check-smoke-` and some letters, then says what the judge is doing. First it measures the starting point alone on every case, the run's **baseline**, which every change is then held against. Then it is **screening** each change: its first look at a change, in which it builds the change and measures it.

   The two names are the check's campaign and run. A **campaign** is one piece of research: what to improve, and how the judge decides. The check's campaign is `rig-check-smoke-cpu-1abb49d1`; its letters are the start of the smoke kit's commit, which [Your first goal campaign](first-goal-campaign.md) uses again. A **run** is a campaign at work on one rig: here, `check-smoke-` and some letters.

   The page shows the run twice more: on a card under **At work**, above **Checks**, marked **judge only**, with the lines `no agents on this run: changes come from people` and what the judge is screening; and under **Runs on this rig**, below **Checks**, where it stays after it ends.

3. Choose the name `rig-check-smoke-cpu-1abb49d1 › check-smoke-…` to watch the run. Its page has the title `check-smoke-…`, followed by `on local-1 · hill climb · judge only · Running`. A **hill climb** is a campaign that keeps improving a number, here the program's speed. It is one of Thermite's three [campaign modes](../explanation/campaign-modes.md): a goal campaign works until a list of goals is met, and a research campaign studies a question and reports what its sources show. **Judge only** means that no agent works on this run: the judge alone measures the check's changes. Below it are the run's tabs: **Overview**, **Experiments**, **Journal**, **Attempts**, **History** and **Planner**. The run's **Overview** tab, open first, lists its **Attempts**: an attempt is one submitted change. Each one shows up, then gets its verdict. Press **refresh** to see more.

   The **Campaigns** page in the sidebar doesn't show this run under **At work now**: that list leaves rig checks out. Step 7 shows where Campaigns keeps them.

4. Two or three minutes after you pressed **Run it**, go back to **Rigs** › **local-1**.

   **Judge smoke** shows **passed**, with `smoke on smoke-cpu: all 13 candidates were judged as expected (run check-smoke-…)`, and **Run it** comes back. Until then, it shows **running**, and the row changes by itself when the result comes. The rig reports to control about once a minute, so the result can show a minute after the check ended, as `passed 1m ago`.

   On a machine whose timing is noisy, such as a virtual machine that shares its host, it can show **passed** with `smoke on smoke-cpu: 12 of 13 candidates were judged as expected; the no-op came out inconclusive, not neutral` and the note `The timing on this machine is noisy. Results here need more repeats.` The judge works; the note means campaigns here need more repeats to tell small changes apart. Go on with the tutorial. In step 7, the no-op then counts as inconclusive, not neutral. See [Judge smoke passed with a note](../how-to/operate/troubleshoot.md#judge-smoke-passed-with-a-note).

   If it shows **failed**, the sentence beside it says why. The usual reason on a laptop is a computer too busy for fair timing: close other heavy programs and press **Run it** again. See [A check failed](../how-to/operate/troubleshoot.md#a-check-failed).

## 7. See what the judge decided

Open the check's run again, this time from **Campaigns**. Its table hides rig checks unless you ask for them:

1. Open **Campaigns** in the sidebar. Under **All campaigns**, it says `No campaign here.`, then `Rig checks are hidden: they are the smoke runs a rig check starts.` Choose the filter **Rig checks**, above the table. The table now lists `rig-check-smoke-cpu-1abb49d1`, marked **rig check**, with `1 finished` under **Runs**.
2. Choose `rig-check-smoke-cpu-1abb49d1`. On the campaign's page, under **Earlier runs**, the run `check-smoke-…` shows **Finished**, and **Why it stopped** says `the smoke check is done`.
3. Choose `check-smoke-…`, then the **Attempts** tab at the top of the run's page.

**How the judge decided** counts the judge's **verdicts**, its decision on each change: `invalid 4`, `neutral 4`, `rejected v0 2`, `crash candidate 2` and `win confirmed 1`. Three of the neutral changes test the rig and the judge: one overwrites the champion's build, one leaves a process running, and one keeps each call's result to reuse in the next, which gains nothing because every timed call has inputs of its own. On a busy machine any of the three can come out `inconclusive` or `regress` instead, and the check accepts that too. Below it, each change is listed by what it tries, and starts with one word for how it ended. Here is what the judge did with some of the thirteen:

| The change | Its word | The verdict | Why |
| --- | --- | --- | --- |
| `i-k-j loop order makes the inner loop contiguous` | **Champion #2** | win confirmed | It was faster, and stayed faster when measured again on fresh runs |
| `rename the accumulator` | **Lost** | neutral | No real difference |
| `skip half of the reduction` | **Broken** | invalid | Its answers were wrong |
| `call the reference implementation` | **Broken** | invalid | The judge noticed the reference ran |
| `use a large scratch buffer` | **Broken** | crash candidate | Stopped at the run's memory limit |
| `time the kernel from inside` | **Judging**, though it is final (see below) | rejected v0 | It adds a timer call, which the rules forbid |
| `make the reference trivial` | **Judging**, though it is final (see below) | rejected v0 | That file is not the agents' to change |

The word sums up the verdict. [Hand the work to agents](agents-with-a-free-model.md) uses these words. The **champion** is the run's best version so far. Champion #1 is the project as the run started, so the first change that beats it becomes champion #2.

`rejected v0` means refused by the first, static checks, before the change was built. Such a change never gets a verdict, so its row shows **Judging** for ever, with `rejected v0` under the change: a known fault ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). The judge isn't working on it: nothing more happens to it.

Open **Overview** in the sidebar. Its **What happened** block tells the same story in sentences, newest first. For example: `confirmed faster on fresh runs (+67.1%)` and `became champion #2`.

That is Thermite's central rule: **agents propose, and code they cannot touch decides.** Later, AI agents will propose the changes instead of the smoke check, and the same judge will decide.

## 8. Stop or keep Thermite

Thermite can keep running in the background. To stop it, run this in your `thermite` folder:

```sh
docker compose down              # or: podman compose down
```

To start it again, run `docker compose up -d` (or `podman compose up -d`). Your campaigns and results are kept between starts, and you stay signed in. They are kept in the containers' volumes, so don't add `-v` to `down`: `down -v` deletes the volumes, and everything Thermite has recorded with them.

## What you did

You started control and a rig on your own computer, signed in, and watched the judge give thirteen known changes their right verdicts. You've seen a champion promoted only after a confirmed gain.

## Next

- [Hand the work to agents](agents-with-a-free-model.md): connect a free model and watch agents propose changes.
- [Campaign modes](../explanation/campaign-modes.md): hill climbs, goal campaigns and research campaigns, and when each fits.
- [Why agents never judge](../explanation/why-agents-never-judge.md): how the judge decides, step by step.
- [Install Thermite on one machine](../how-to/install/one-machine.md): keep Thermite running for real work.
