---
title: "Thermite vs Karpathy's autoresearch"
description: "Karpathy's autoresearch is the idea in three files: one prompt, one GPU, one number. Thermite takes the same loop to any project, and moves measuring and deciding into code the agents can't touch."
type: comparison
sidebar:
  order: 2
  label: "Karpathy's autoresearch"
---

[autoresearch](https://github.com/karpathy/autoresearch), by Andrej Karpathy, is the project this kind of tool grew from: pi-autoresearch and CORAL both credit it, and Thermite generalizes its loop. It isn't a product. It is three files and a prompt that tell an agent how to improve one small language model on one GPU overnight. Thermite runs the same loop on any project you can measure, and turns the prompt's rules into code the agents can't change.

Use **Karpathy's autoresearch** when:

- you want to see the idea work, and read all of it, in an afternoon;
- your work is training a small language model on one NVIDIA GPU;
- you want to write your own loop as a prompt, for whichever agent you already use.

Use **Thermite** when:

- your project is anything other than that training script;
- the rules must hold in code, not only in a prompt;
- the number is noisy, or other numbers must not get worse;
- you want several agents, several projects or more than one machine;
- the work is a list of goals or a question, not only a number.

:::note[What this page compares]
autoresearch at commit `228791f` (2026-03-25, the newest on `master` on 2026-11-07) and Thermite v0.1.3. Links into its code go to that commit. Thermite's authors wrote this page, so it isn't neutral, and Thermite [credits this loop](../project/credits.md#autoresearch-systems) as its starting point. If something here is wrong or out of date, [open an issue](https://github.com/iammrduncan/thermite/issues).
:::

## Side by side

| | Karpathy's autoresearch | Thermite |
| --- | --- | --- |
| What it is | Three files: a training script, a fixed evaluation and a prompt, `program.md` | A system you host: rigs that do the work, and control, one dashboard with a REST API and MCP |
| Setup | `uv sync`, `uv run prepare.py`, then point your agent at `program.md` | Docker or Podman, and [about twenty minutes](../tutorials/first-run.md) |
| Hardware | [One NVIDIA GPU](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md#L23), tested on an H100 | CPU or GPU, on your computer, on machines over SSH, on Kubernetes or on RunPod |
| Agent programs | Whichever you start | Pi, OpenCode, Codex or Claude Code |
| Kinds of work | Lowering `val_bpb` for this training script | [Hill climb, goal or research](../explanation/campaign-modes.md), on your project |
| What agents may change | `train.py`, by instruction | The paths the [contract](../reference/contract.md) allows, checked in code |
| The benchmark | `evaluate_bpb`, which the prompt says not to change | A [kit](../explanation/kits.md) the agents never see |
| The number in the record | Copied into `results.tsv` by the agent | Measured by the judge |
| Keep or discard | The agent, by the prompt's rule | The judge, by the rules in the contract |
| Noise | One run for each change | Paired, randomized blocks, and a win confirmed on fresh runs |
| Other metrics | Memory and simplicity, weighed by the agent | Guards with limits per step and in total |
| Hidden test cases | None | Run only at confirmation, so no agent can tune to them |
| A change that loses | `git reset`; one line stays in `results.tsv` | Kept as a git ref, with its verdict and reasons |
| What ends the work | Only you | Only a limit you set |
| Parallel work | One agent on one branch | Many isolated lanes, one planner and one queue |
| Where you watch | `results.tsv` and a notebook | One dashboard for every campaign on every rig |
| Licence | MIT, as its README says; it has no licence file | Apache-2.0 |

## Rules in a prompt, rules in code

`program.md` sets the rules: [don't modify `prepare.py`, add no packages, and treat `evaluate_bpb` as the ground truth](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L29-L31). The README says to start your agent and ["disable all permissions"](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md#L44), meaning its permission prompts, so those rules hold only because the agent follows them. `train.py`, the file the agent edits, [calls the evaluation](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/train.py#L613) and [prints the result](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/train.py#L622). The agent reads it from a log and writes it down.

For this repository that is a sound choice. One file to change [keeps the diffs reviewable](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md#L63), and you read the results in the morning.

Thermite makes the same rules code. A change to a path the contract doesn't allow is refused before it is built. Each agent works as its own Unix user and can't reach the kit. The judge builds the change itself, measures it and writes the verdict. [Why agents never judge](../explanation/why-agents-never-judge.md) gives each step.

**The cost:** all of that is a system to install and a kit to write, where autoresearch needs a prompt.

## One run, one number

Each experiment is one training run with a [fixed 5-minute budget](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md#L64), and the rule is simple: [lower `val_bpb` stays, anything else is reset](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L103-L104). The fixed budget is a neat idea. Whatever the agent changes, runs stay comparable, and the search finds the best model for your machine in that time. Its README names the price: your results don't compare with those from other hardware. The [public log of an H100 run](https://github.com/karpathy/autoresearch/blob/6c087cb5e2185879fc7fe0426336b95e5fb65275/results.tsv) shows the loop at work: 126 runs, 23 kept, 102 discarded and 1 crash, taking `val_bpb` from 0.9979 to 0.9697.

One run can't tell a small gain from noise. Thermite times the change and the champion together, in blocks that alternate in a random order on the same device, and a change that looks better is measured again on fresh runs and decided on those alone.

**The cost:** time on the device. A judged attempt takes far longer than one run.

## What happens to a change that loses

A losing change is [reset, and its line in `results.tsv` stays](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L102-L104). That file is left out of git, so the record of what was tried lives beside the branch and not in it.

Thermite [saves every change as a git ref](../explanation/why-agents-never-judge.md#how-a-change-becomes-the-champion) before it is built, and the ledger keeps its verdict and the judge's reasons, so a later run can read the idea and why it lost.

## What ends the work

Here the two agree. `program.md` says [NEVER STOP](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L112): the loop runs until a person interrupts it. Thermite has [no default limit](../explanation/runs-until-done.md) on turns, attempts, failures or time either.

The difference is what happens when an agent's session ends by itself. Nothing in autoresearch's three files starts it again. In Thermite the next trial starts from the ledger, because no state lives in the agent.

**The cost:** the same in both. Nothing stops a paid model for you. Before you use a paid key with Thermite, [set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md).

## Simplicity

`program.md` has a rule Thermite's judge doesn't: [simpler is better](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L37). "A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it." A change that deletes code and holds the score is a win. That takes judgement, and an agent can use it.

Thermite's judge weighs only what the kit measures. A hacky change that wins on the numbers wins. To hold complexity back, measure it: make it a metric in your kit, with a guard.

## One agent or many

autoresearch runs one agent on one branch, and [a branch name such as `autoresearch/mar5-gpu0`](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/program.md#L92) suggests one for each GPU. Its [`agenthub` branch](https://github.com/karpathy/autoresearch/tree/agenthub) sketches agents that share their work through a central hub.

Thermite splits a run into [lanes](../explanation/agents-lanes-planner.md), each with its own workspace and its own Unix user, and a planner gives each lane its next experiment from one queue.

## What autoresearch does better

- **You can read all of it.** It is [deliberately small](https://github.com/karpathy/autoresearch/blob/228791fb499afffb54b46200aca536f79142f117/README.md#L11): about 1,200 lines in all, and the whole method is one prompt. Thermite is a system you learn.
- **The method is yours to edit.** You program the research in Markdown, so changing how it works means changing a prompt.
- **Almost nothing to install.** uv and your agent, with no containers and no services.
- **A simplicity rule,** as above.
- **Reach.** It had 99,417 GitHub stars on 2026-11-07, with forks for macOS, Windows and AMD. Thermite is at 0.x and [makes no upgrade promise](../reference/known-limits.md#0x-versions-make-no-upgrade-promise).

Thermite owes it the loop itself, and starts a hill climb the way it does: with [a baseline of the unmodified code](../project/credits.md#autoresearch-systems) before any change.

## Moving a project over

If you know autoresearch, most of its parts have a home in Thermite:

| autoresearch | Thermite |
| --- | --- |
| `program.md` | The campaign's [brief](../explanation/campaign-modes.md#the-campaigns-brief), and its contract for what must hold |
| `prepare.py` and `evaluate_bpb` | The kit |
| `train.py` | The paths the contract allows |
| `results.tsv` | The rig's ledger |
| `keep` | A confirmed win, which becomes the champion |
| `discard` and `crash` | A verdict that says how the change lost |
| A branch such as `autoresearch/mar5` | A run |

[Your own project](../tutorials/your-own-project.md) walks through a first campaign from the dashboard, and [Write a kit for your project](../how-to/campaigns/write-a-kit.md) covers a real benchmark.
