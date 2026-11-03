---
title: "Test a kit with known candidates"
description: "Check that a kit gives each known change the verdict you expect before agents start."
type: how-to
sidebar:
  order: 5
---

Before agents spend time or money, check the campaign's [kit](../../reference/glossary.md). Hill climbs and goal campaigns have one; a research campaign has no kit, so this page is not for it. Start a run with no agents (a try of the kit), read what the judge makes of the starting point, then submit a few changes whose right [verdicts](../../reference/verdicts.md) you already know. Thermite's own **Judge smoke** check does this for its smoke kits: see [Check a rig](../operate/check-a-rig.md).

## Before you start

- A kit and a contract that names it, or a campaign on the **New campaign** page. See [Write a kit for your project](write-a-kit.md).
- To submit changes by hand: a rig whose harness, the rig's container that holds the judge, has a proposer token. The local stack from [Install on one machine](../../tutorials/first-run.md) has one, which the harness sees as `/run/secrets/harness-proposer-token`. Rigs that control sets up on machines or clusters, and rigs you join yourself, have none: there you can do the dry run (steps 2 and 3), but not submit changes.

:::caution[GPU kits]
A rig refuses a kit made for another target, and GPU rigs that control sets up have no proposer token. So a GPU kit can be tested with known candidates only on the local stack's rig, on a machine with NVIDIA GPUs ([Use the machine's NVIDIA GPUs](../install/one-machine.md#use-the-machines-nvidia-gpus)). On another GPU rig, do the dry run (steps 2 and 3). Then start the campaign with **ask me every time** (`--promotion owner`), so that no change becomes the champion before you have read its verdict. [Goal 042](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/042-kit-self-test.goal) plans known bad candidates in **Try the kit first**.
:::

## 1. Make a set of known candidates

Keep a few changes with known outcomes next to the kit, in a `candidates` folder, as `kits/smoke-cpu/candidates` does in Thermite's repository. Each candidate is a folder with the files it changes, laid out as in the project. A candidate that deletes a file needs `git rm` on that file in step 4. Write down what each should get. Cover at least:

| Candidate | Expected verdict |
| --- | --- |
| A real improvement | `win_confirmed`, then it becomes the champion |
| The same code with a renamed variable | `neutral`. On a rig noisier than `acceptance.equivalence_band` (0.005 unless set), `inconclusive`: raise the band |
| A change that gives wrong answers | `invalid` |
| A change that doesn't build | `invalid` |
| A change that calls the slow reference | `invalid`, if your check proves the fast path ran |
| A change to a file agents may not edit, or one that adds a forbidden line | `rejected_v0`: refused before building |
| A change that uses far too much memory | `crash_candidate` |

## 2. Start a run with no agents

Use one of:

- **Try the kit first** on the **New campaign** page;
- **Start a run** on a campaign's page: in the panel, choose the rig under **Where it runs**, choose **Off: a try** under **Agents**, and press **Start the run**. A try needs no model, so the rig need not have one. This works for a campaign started from the command line too;
- for a campaign control keeps, `--agents off` on `thermite run start`, such as `npx thermite run start sort-speed --rig local-1 --agents off --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token`, or `"agents": false` over REST or MCP's `start_run`;
- `--agents off` on the command line. Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The example uses the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

  ```sh
  npx thermite assign --contract contract.json --run sort-speed-try-1 --agents off \
    --seed https://git.example.com/you/project.git@0123456789abcdef0123456789abcdef01234567 \
    --kit https://git.example.com/you/project-kit.git \
    --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig local-1
  ```

The run starts from the project's unchanged commit, and no agent starts.

## 3. Read the dry run

From the dashboard, the try's run is named like `sort-speed-try-1`. Open its page: on the campaign's page, press the run's name on its card under **At work now**. Press **refresh** in the status bar, the line along the bottom of the page, now and then.

- **A hill climb:** the judge's first job measures the starting point alone on every case, the run's [baseline](../../reference/contract.md#the-baseline). **History** says, for example, `The judge measured the starting point, champion #1, on every case: ops_per_s small 4.512e+7 ±0.31% (median of 3 blocks).`, and the run's **Overview** shows each case's values under **Where the run started**. Check that they look right for your project. Then the judge times the starting point against itself, to learn how much the rig's timings vary. It does this when no other judge work waits, and again every 24 hours. **History** then says, for example, `The judge measured the rig's noise: ±1.84% per block.`, and the **Planner** tab's **Agent figures** show it as **Rig noise**. Choose a `min_effect` well above that noise. On a noisy rig, widen `acceptance.equivalence_band` too. This dry run doesn't run the held-out cells: the real improvement in step 5 is the first change they check.
- **A goal campaign:** the judge builds the starting point and checks every goal. **History** says, for example, `The judge checked champion #1: 1 of 3 goals met.`, and the run's **Overview** lists each goal with why it is unmet. Each should be unmet for the reason you expect, not because a run failed.

If the starting point does not build, or a run of it fails, **History** shows the cause: in a hill climb, `The judge could not measure the starting point, champion #1: …`, and the run is in setup, waiting for a change that makes the project build and run; in a goal campaign, `The judge's job (…) failed: …`. Fix the kit, commit it, raise the contract's `version`, and start a new run. For a campaign made on the **New campaign** page, fill in the page again with the same **Campaign name** instead: that saves a new version. If the run never starts, open the **Audit log** in the sidebar and pick **Commands** under **Type** for the reason: [If it is refused](start-from-command-line.md#if-it-is-refused) says what to do for each.

## 4. Make a patch for each candidate

Make each patch against the run's starting commit:

```sh
git clone https://git.example.com/you/project.git cand
cd cand
git checkout 0123456789abcdef0123456789abcdef01234567
cp -R ~/src/project-kit/candidates/noop/. .
git add -A
git diff --cached --binary > ~/noop.patch
git reset --hard -q && git clean -fdq
```

Repeat the last four lines for each candidate.

## 5. Submit them

On the local stack, copy each patch into the harness container and submit it there with the proposer token. Run these in your Thermite folder, with `podman compose` in place of `docker compose` if that is your tool:

```sh
docker compose exec -T harness sh -c 'cat > /tmp/noop.patch' < ~/noop.patch
docker compose exec -T harness thermite submit --harness http://127.0.0.1:8700 \
  --token-file /run/secrets/harness-proposer-token --run sort-speed-try-1 \
  --patch-file /tmp/noop.patch --hypothesis "rename the accumulator"
```

The harness answers with the attempt's id and state, such as `{"attempt":"a-0123456789abcdef","lifecycle":"queued",…}`. A change the static checks refuse answers `"lifecycle":"rejected_v0"`, with the reasons under `violations`.

Submit the real improvement last. Each patch applies to the current champion, so once the improvement wins, patches made against the starting commit may no longer apply.

## 6. Read the verdicts

Open the run's **Attempts** tab. Each change shows its outcome. The dashboard learns a verdict with the rig's next report, within a minute: until then the change shows **Judging**, so press **refresh**. Open one for **What happened to it** and **The judge's reasons**. From the harness container, without the wait, `thermite status --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token --attempt <id>` prints its state and verdict.

Three things can hold a winner back:

- On a rig with an auditor, a confirmed gain above 15% goes to the auditor first, unless the contract raises `acceptance.audit.absolute`; its block stops the change. See [Decide what waits for you](decide-what-waits.md).
- With **Ask me first about** set, such as **a gain above this %**, or `--ask gain:15`, those wins wait for you.
- With **ask me every time**, or `--promotion owner`, every confirmed win waits for you.

## Check that the kit is ready

- Each known candidate got the verdict you expected.
- The dry run met or missed each goal for the reason you expected, or showed a noise well below `min_effect`.

Then start the campaign with agents. The page of a try, a run whose name ends in `-try-` and a number, says **A try of the kit.** and links **start the campaign**. A run started with its agents off under another name says **Judge only:** instead, and its **Experiments** tab links **Start a run** when experiments wait in its queue ([Judge-only runs](../../reference/verdicts.md#judge-only-runs)). Press **start the campaign**: press it, and the **Start a run** panel opens on the campaign's page. Keep **Agents** on **On**, and press **Start the run**. This works for a campaign made on the **New campaign** page and for one started from the command line, which control assigns again as before, now with agents. From the command line, you can also assign a new run without `--agents off`. A rig runs one run at a time, so the new run pauses the try.
