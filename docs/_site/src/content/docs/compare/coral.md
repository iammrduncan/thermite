---
title: "Thermite vs CORAL"
description: "Both keep the score out of the agent's hands. CORAL's agents read their grader and share everything they learn; Thermite hides its judge, isolates its lanes and measures with statistics."
type: comparison
sidebar:
  order: 4
  label: "CORAL"
---

[CORAL](https://github.com/Human-Agent-Society/CORAL) is the closest tool to Thermite. In both, agents work in their own git worktrees and a separate process scores each commit, so no agent types its own number. They differ in what the agents may know. CORAL's agents read the grader's source, share notes and see each other's work as it happens, and one grade settles a score. Thermite's workers see only their own lane and never see the judge, and a change counts only once it holds up on fresh measurements.

Use **CORAL** when:

- one grade is enough, because the score is exact or stable: a proof, a bound, a deterministic simulator;
- you want agents to build on each other's work as they go;
- you want to start quickly on one machine, without containers;
- you use an agent program Thermite doesn't run, such as Cursor or Kiro.

Use **Thermite** when:

- the number is noisy, like timing on real hardware, so one reading can't settle it;
- other numbers must not get worse;
- the agents must not be able to read what scores them;
- your work spans several machines or several campaigns, steered from one place;
- the work is a list of goals, or a question answered with quotes that code has checked.

:::note[What this page compares]
CORAL v0.7.21 (commit `896655d`, its newest release on 2026-11-07) and Thermite v0.1.3. Links into its code go to that commit. Its `dev` branch is eight commits ahead, and none changes how attempts are graded. Thermite's authors wrote this page, so it isn't neutral, and Thermite [takes much of its lane loop from CORAL](../project/credits.md#research-behind-the-design). If something here is wrong or out of date, [open an issue](https://github.com/iammrduncan/thermite/issues).
:::

## Side by side

| | CORAL | Thermite |
| --- | --- | --- |
| What it is | A Python tool with a command line and a web dashboard | A system you host: rigs that do the work, and control, one dashboard with a REST API and MCP |
| Setup | One install script, then `coral init` and `coral start` | Docker or Podman, and [about twenty minutes](../tutorials/first-run.md) |
| Where it runs | One machine, on the host or in its Docker session | In containers: on your computer, on machines over SSH, on Kubernetes or on RunPod |
| Agent programs | [Seven](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/README.md#supported-agents), among them Claude Code, Codex, Cursor, Kiro, OpenCode and Pi | Pi, OpenCode, Codex or Claude Code |
| Kinds of work | Anything a grader can score, including with an LLM rubric | [Hill climb, goal or research](../explanation/campaign-modes.md) |
| The measure | A grader you write, or that its plugin's agent writes with you | A [kit](../explanation/kits.md) |
| Can agents read it? | Yes, by design; hidden data stays private | No |
| The number in the record | Written by the grader | Measured by the judge |
| Noise | One grade for each attempt, unless your grader repeats | Paired, randomized blocks, and a win confirmed on fresh runs |
| Other metrics | One aggregate score is compared | Guards with limits per step and in total |
| Hidden test data | Private files the grader can read on any attempt | Cases run only at confirmation |
| A change that loses | Kept, with its commit and score | Kept as a git ref, with its verdict and reasons |
| What ends the work | Only a limit you set | Only a limit you set |
| Parallel work | Many agents sharing attempts, notes and skills, with optional islands | Many isolated lanes, one planner and one queue |
| Agent memory | Long-running sessions, resumed after a restart, and shared notes | A fresh call each time, from a brief the rig builds out of its ledger |
| Oversight | Heartbeat prompts: reflect, consolidate and pivot | Built-in advisors: teachers, an auditor and a review panel |
| Agent isolation | Permission rules on the host; Unix users in Docker, or if you opt in | A Unix user for each lane on every rig, checked at each start |
| Where you watch | `coral ui`, a web dashboard on localhost | One dashboard for every campaign on every rig |
| The result | `coral export` makes a git branch from any attempt | The champion as a patch, and on request a commit for each champion in your repository |
| Licence | Apache-2.0 | Apache-2.0 |

## Who measures, and what agents can see

CORAL got the first thing right, and Thermite took it. An agent runs `coral eval`, and [a grader daemon](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/docs/content/docs/concepts/eval-loop.mdx) checks out that exact commit in its own worktree, runs the grader in a separate process and writes the score back. The agent can't type a number.

They part ways on what the agent may read. CORAL [links the grader's source into the agents' shared folder](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/workspace/worktree.py#L246-L253) and [tells them to read it](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/template/coral.md.template#L222): "the exact code that scores you". Answer keys and other hidden data stay in a private folder. That helps on a task with a fixed scorer: an agent that knows how it is scored can aim at the real objective.

Thermite's agents never see the [kit](../explanation/kits.md). An agent that can read what scores it can, in time, improve the score without improving the work, and [published work on research agents](../explanation/why-agents-never-judge.md) shows it again and again.

**The cost:** Thermite's agents learn how they did only from the verdict and the judge's reasons, so they can spend attempts on something a look at the scorer would have shown.

How firmly the boundary holds differs too. By default CORAL runs on the host, in tmux, and [its own code says](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/workspace/worktree.py#L252-L253) "there is no isolation, so read-only is best-effort" there: permission rules guard the private folder. [Its Docker session](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/config.py#L216-L224) runs each agent as an unprivileged user, and on the host you can opt in to the same. A Thermite rig always runs each lane as its own Unix user, and [its self-test](../explanation/isolation.md) checks that every time the harness starts. That isn't complete isolation: [under compose, agents' code can reach your local network](../reference/known-limits.md#under-compose-that-code-can-reach-your-local-network).

## One grade, or a measurement

CORAL grades an attempt once and [compares the score with that agent's best](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/grader/daemon.py#L199-L223). For an exact score that is right, and cheap. For timing on a GPU, one lucky reading becomes `improved` and can lead the board. Your grader can repeat runs and take a median, but that is yours to write: the framework has no repeat or confirmation step.

Thermite times the change and the champion together, in blocks that alternate in a random order on the same device. The smallest gain that counts is set in the contract before the run. A change that looks better is measured again in fresh blocks and decided on that data alone, and only then do the hidden test cases run. When one fails, the agents learn only that a hidden check failed and in what way, never which case. In CORAL, hidden data goes into a grade whenever the grader reads it, so a score an agent sees can carry a little of it.

**The cost:** time on the device. A judged attempt takes far longer than one grade, and on an exact score that time buys nothing.

## Metrics that must not get worse

A CORAL grader may report several scores, but [one aggregate](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/grader/daemon.py#L453) is what gets compared. A rule such as "raise prefill, never drop decode" has to be coded into your grader. Because the grader is yours, it can be.

A Thermite contract gives each [guard](../reference/contract.md#hill-climb) two limits: how much worse a metric may get in one step, and how much worse in total against the starting point. A change past a guard doesn't become the champion, unless the guard is set to ask you and you say yes. Thermite still climbs one number at a time: further priority metrics break ties.

## Shared agents or isolated lanes

This is the biggest difference, and it is a real choice, not a flaw on either side.

CORAL is built on shared memory. Agents [see each other's attempts, notes and skills](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/README.md#how-it-works) as they happen. They are long-running sessions, and [heartbeats](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/config.py#L243-L246) interrupt them to reflect after each attempt, consolidate every ten, and pivot after five with no gain. [Islands](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/docs/content/docs/guides/multi-agent.mdx#L57) split agents into groups that explore apart. Its [paper](https://arxiv.org/abs/2604.01658) reports new best results on 10 tasks and 3 to 10 times higher improvement rates than fixed evolutionary search, and traces those gains to knowledge reuse and communication between agents.

Thermite follows [Stateless Language Agents](https://arxiv.org/abs/2610.07625) instead. The rig holds all the research state. Each lane sees its own results, a [planner](../explanation/agents-lanes-planner.md) sees every lane and hands out experiments from one queue, and each agent call starts fresh from a brief built out of the ledger. Lanes don't all chase the first idea that worked, and a crashed session loses nothing.

**The cost:** each trial reads the code again, and an insight reaches another lane only through the planner, the queue or a field note.

Thermite [weighed CORAL's shared lanes and didn't take them](../project/credits.md#research-behind-the-design), but nobody has run the two side by side on one task. Which works better may well depend on the task.

## What ends the work

Neither ends research by default. CORAL's [`run.stop`](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/config.py#L339-L340) can set a score target or an attempt limit, and both are off until you set them. Its manager [restarts a silent agent](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/config.py#L240) and pauses one that [keeps crashing](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/coral/config.py#L257). Thermite has [no default limit](../explanation/runs-until-done.md) either, and its goal and research campaigns end when code says they are done.

**The cost:** the same in both. Nothing stops a paid model for you. Before you use a paid key with Thermite, [set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md).

## One run or a fleet

A CORAL run is one task on one machine: its worktrees, shared state and grader daemon sit on one filesystem. Its code and documentation have no way to spread a run over machines, or to share GPUs between runs.

Thermite is built for many campaigns at once. Each [rig](../explanation/how-it-fits-together.mdx) does the work wherever you put it, can spread over [several machines](../how-to/install/runners.md), and reports to one control service, and a rig goes on researching while control is down.

**The cost:** that is a system to run. For one task on one machine, CORAL is much less to look after.

## Watching and steering

`coral ui` is a good dashboard for a run: a live score chart, a leaderboard, notes, and a lineage graph that Thermite's own lineage view learned from. To steer, [you stop the run](https://github.com/Human-Agent-Society/CORAL/blob/896655d599331a09ac9468b6b395fabcb22d4086/docs/content/docs/guides/web-dashboard.mdx#L56-L59), queue the action and resume, or use `coral resume -i` to pass an instruction. `coral heartbeat` changes when the heartbeats fire and what they say.

In Thermite you can [message a running lane](../how-to/campaigns/steer-a-run.md#send-the-agents-a-message) or the planner without stopping anything. Every instruction is a [signed, recorded command](../reference/signed-commands.md), from the dashboard, the REST API, MCP or the command line. [Advisors](../explanation/supervision.md) are built in: teachers bring ideas, an auditor looks hard at surprising results, and a review panel decides what code can't. None of them can set a verdict.

## What CORAL does better

- **Getting started.** One install script and no containers. Its plugin writes the grader with you, from a plain request to make a function faster without changing its output. Thermite takes about twenty minutes to install, and each project needs a kit.
- **More agent programs.** Seven against Thermite's four, and a run can mix them.
- **Agents that learn from each other.** Attempts, notes and skills reach every agent as they happen. Thermite's lanes are isolated on purpose, and they give that up.
- **Published evidence.** A paper accepted at COLM 2026, with results on many tasks. Thermite has [one study](../studies/qwen3-8-27b-on-a-p100.mdx), and [the test that proves runs of several days](../reference/known-limits.md#runs-of-several-days-are-not-yet-proven) has not run yet.

Thermite owes it a great deal: [the loop inside a lane](../project/credits.md#research-behind-the-design), with a grader outside the agents that scores the exact commit in its own checkout, along with attempt records, heartbeats, the lineage view and forking from another lane's best.

## Moving a project over

If you know CORAL, most of its parts have a home in Thermite:

| CORAL | Thermite |
| --- | --- |
| `task.yaml` | The campaign's [contract](../reference/contract.md) |
| The grader package | The kit |
| `grader.private` data | The kit's hidden test cases |
| `coral eval` | A worker's submission |
| An attempt | An attempt |
| `improved` | A confirmed win, which becomes the champion |
| Notes and skills | Field notes and the [knowledge base](../explanation/journals-and-knowledge.md) |
| Heartbeats | The teachers' advice, and the planner's next experiment |
| `coral export` | [Take the result](../how-to/campaigns/take-the-result.md) |

[Your own project](../tutorials/your-own-project.md) walks through a first campaign from the dashboard, and [Write a kit for your project](../how-to/campaigns/write-a-kit.md) covers a real benchmark.
