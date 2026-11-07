---
title: "Thermite vs pi-autoresearch"
description: "Both run the same agent loop. pi-autoresearch runs it in your terminal and leaves the verdict to the agent and you; Thermite runs it in containers and leaves the verdict to a judge."
type: comparison
sidebar:
  order: 3
  label: "pi-autoresearch"
---

[pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) and Thermite run the same loop: an agent changes something, a run measures it, and the better version stays. The difference is who you have to trust. In pi-autoresearch the agent writes the benchmark, reports the number and decides what stays, and you review what comes out. In Thermite a judge that the agents can neither read nor change does all three.

Use **pi-autoresearch** when:

- the run is short, and you will review the result yourself;
- you want to start in a minute, in your own terminal, with no containers;
- you have no benchmark yet and want the agent to write one.

Use **Thermite** when:

- you want to leave research running for hours or days, and trust what you find when you come back;
- the number is noisy, or other numbers must not get worse;
- the agents must not be able to see or change what scores them;
- you run several agents or several projects, on more than one machine;
- the work is a list of goals or a question, not only a number.

:::note[What this page compares]
pi-autoresearch v1.9.0 (commit `04b8a50`, its newest on 2026-11-07) and Thermite v0.1.3. Links into pi-autoresearch's code go to that commit. Thermite's author ran pi-autoresearch on GPU kernels before building Thermite, so this page isn't neutral: [Why I built Thermite](../explanation/why-i-built-thermite.md) tells that story. If something here is wrong or out of date, [open an issue](https://github.com/iammrduncan/thermite/issues).
:::

## Side by side

| | pi-autoresearch | Thermite |
| --- | --- | --- |
| What it is | An extension for the [Pi](https://pi.dev/) coding agent | A system you host: rigs that do the work, and control, one dashboard with a REST API and MCP |
| Setup | `pi install npm:pi-autoresearch` | Docker or Podman, and [about twenty minutes](../tutorials/first-run.md) |
| Where it runs | In your terminal, in your checkout | In containers: on your computer, on machines over SSH, on Kubernetes or on RunPod |
| Agent programs | Pi | Pi, OpenCode, Codex or Claude Code |
| Kinds of work | Improving a metric | [Hill climb, goal or research](../explanation/campaign-modes.md) |
| The benchmark | Written by the agent, which may change it during the loop | A [kit](../explanation/kits.md) the agents never see |
| The number in the record | Typed by the agent | Measured by the judge |
| Keep or discard | Chosen by the agent; a failed check blocks `keep` | Decided by the judge, by the rules in the [contract](../reference/contract.md) |
| Noise | An advisory confidence score | Paired, randomized blocks, and a win confirmed on fresh runs |
| Other metrics | Shown for monitoring | Guards with limits per step and in total |
| Hidden test cases | None | Run only at confirmation, so no agent can tune to them |
| A change that loses | Code reverted; the agent's notes stay in the log | Kept as a git ref, with its verdict and reasons |
| What ends the work | `maxIterations` if you set it; built-in stops at 200 automatic turns and after more than 20 failures in a row | Only a limit you set |
| Parallel work | One agent in one session | Many isolated lanes, one planner and one queue |
| Agent memory | One long session, plus `.auto/prompt.md` and the log | A fresh call each time, from a brief the rig builds out of its ledger |
| Oversight | Scripts you write, as hooks | Built-in advisors: teachers, an auditor and a review panel |
| Where you watch | A table in Pi, and a live page on localhost | One dashboard for every campaign on every rig |
| The result | Commits on a branch, which `/autoresearch finalize` splits into reviewable branches | The champion as a patch, and on request a commit for each champion in your repository |
| Licence | MIT | Apache-2.0 |

## Who measures and who decides

In pi-autoresearch, the agent writes `.auto/measure.sh`, and its setup skill says it can [update it during the loop](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/skills/autoresearch-create/SKILL.md#L92). `run_experiment` prints the values it parsed, but the [metric and the status in the log](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L2275-L2277) are what the agent passes to `log_experiment`. The [one hard rule](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L2228) is that a failed `.auto/checks.sh` blocks `keep`.

That works when you are the judge, and pi-autoresearch's authors say so plainly. In [Shopify Engineering's post](https://shopify.engineering/autoresearch), David Cortés writes that the agent "does ugly hacks sometimes, like removing a lot of files", and that "I throw away all the hacks and keep the good stuff". The post quotes Tobi Lütke calling his own result on the Liquid template engine "probably somewhat overfit". The review is the person's job.

Thermite does that review in code, so it happens for every change, with nobody watching. A kit holds how to build, run, time and check the project, and agents never see it. An agent submits a change and a claim. The judge builds the change, measures it and writes the verdict, and no agent can set one. Hidden test cases run only at confirmation. [Why agents never judge](../explanation/why-agents-never-judge.md) gives each step.

**The cost:** someone has to write the kit before the first change. The **New campaign** page can write a simple one from your answers, but a judge is only as good as its check, and that part is your work.

## What happens to a change that loses

pi-autoresearch keeps the branch clean. After `discard`, `crash` or `checks_failed` it [runs `git checkout` and `git clean`](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L2437-L2438), and the code is gone. Its skill warns the agent that [the only record that survives](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/skills/autoresearch-create/SKILL.md#L98) is the description and the notes the agent writes. The branch stays easy to read: it holds only what was kept.

Thermite [saves every change as a git ref](../explanation/why-agents-never-judge.md#how-a-change-becomes-the-champion) before it is built, and the ledger keeps its verdict and the judge's reasons. The one word `discard` becomes [a set of verdicts](../reference/verdicts.md#hill-climb) that say how a change lost: `neutral`, `regress`, `tradeoff`, `not_confirmed` and others. Work that moves no number can still be kept as [field notes and sources](../explanation/journals-and-knowledge.md), for later runs to read.

## Noise

pi-autoresearch shows a [confidence score](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L428-L459): the best kept gain divided by the median absolute deviation of the segment's runs. It is [advisory](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/README.md#L286), and the decision stays with the agent. Those runs are different versions of the code, so the score reflects how far apart the ideas were as well as how noisy the machine is. [An open issue](https://github.com/davebcn87/pi-autoresearch/issues/104) argues that it reads "likely real" on pure noise in most sessions, and [another](https://github.com/davebcn87/pi-autoresearch/issues/69) proposes repeated runs.

Thermite times the change and the champion together, in blocks that alternate in a random order on the same device. The smallest gain that counts is set in the contract before the run starts. A change that looks better is measured again in fresh blocks, and decided on that new data alone.

**The cost:** time on the device. Every change is timed many times beside the champion, so a judged attempt takes far longer than one benchmark run.

## Metrics that must not get worse

pi-autoresearch has one primary metric. The others are logged and shown, and its guidance to the agent is that they ["almost never affect keep/discard"](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L2204). A rule such as "raise prefill, never drop decode" has to live in the prompt, and the agent has to keep to it.

A Thermite contract gives each [guard](../reference/contract.md#hill-climb) two limits: how much worse a metric may get in one step, and how much worse in total against the starting point, so small losses can't add up. Hard constraints hold a metric to a fixed value. A change past a guard doesn't become the champion, unless the guard is set to ask you and you say yes.

Thermite still climbs one number at a time. Further priority metrics break ties; they are not a second climb.

## What ends the work

pi-autoresearch's README says the loop ["never stops unless interrupted"](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/README.md#L188). Under that sit two guards: it [stops resuming itself](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L116-L117) after 200 automatic turns, and after more than 20 discards or crashes in a row. Its documentation says these [are not tuning knobs](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/site/content/configuration.md#L142), and [two](https://github.com/davebcn87/pi-autoresearch/pull/62) [pull requests](https://github.com/davebcn87/pi-autoresearch/pull/70) to make the limit configurable were closed unmerged. You can add `maxIterations` as well. For a loop on your own bill, in a session you can see, these are sensible rails. On a search with long dry spells, they end the work at the first long one.

Thermite has [no default limit](../explanation/runs-until-done.md) on turns, attempts, failures or time. A hill climb runs until you pause it. Goal and research campaigns end when code says they are done. A lane with nothing to show waits longer between trials, and the search goes on.

**The cost:** nothing stops a paid model for you. Before you use a paid key, [set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md).

## One agent or many

pi-autoresearch runs one agent in one Pi session, and its README suggests [a dedicated branch or worktree](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/README.md#L381). Staying simple is a choice: a [proposal for a swarm mode](https://github.com/davebcn87/pi-autoresearch/issues/77) was closed by its maintainer with "I don't want to overcomplicate it". After a compaction, the agent re-reads `.auto/prompt.md` and the log and goes on.

Thermite splits a run into [lanes](../explanation/agents-lanes-planner.md), each with its own workspace and its own Unix user. A planner gives each lane its next experiment from one queue, never the same one to two lanes. Every agent call starts fresh from a brief the rig builds out of its ledger, so a crashed session loses nothing.

**The cost:** each trial reads the code again, which takes time and tokens that one long session would not spend.

## Watching and steering

pi-autoresearch shows a results table above Pi's editor, a fullscreen view, and a live page that the same process [serves on localhost](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/extensions/pi-autoresearch/index.ts#L2944). You steer by talking to the agent. [Hooks](https://github.com/davebcn87/pi-autoresearch/blob/04b8a50dac7efe80ffc91648bd00ed9b022e24c2/README.md#hooks-optional) run your own scripts around each iteration, and what they print reaches the agent.

Thermite's rigs report to [control](../explanation/how-it-fits-together.mdx), and a rig goes on researching while control is down. Every instruction is a [signed, recorded command](../reference/signed-commands.md), from the dashboard, the REST API, MCP or the command line. [Advisors](../explanation/supervision.md) are built in: teachers bring ideas, an auditor looks hard at surprising results, and a review panel decides what code can't. None of them can set a verdict.

## What pi-autoresearch does better

- **Getting started.** One install, then `/autoresearch optimize unit test runtime, monitor correctness`. The agent asks a few questions, writes the benchmark and starts. Thermite takes about twenty minutes to install, and each project then needs a kit.
- **Fewer moving parts.** One extension, one `.auto/` folder and one log you can read. Thermite is containers, a message bus and a control service.
- **Reviewable branches.** `/autoresearch finalize` groups kept work into independent branches, one for each logical change. Thermite gives you the champion as one patch, or a commit for each champion.
- **Track record.** It has been public since March 2026 and had 8,221 GitHub stars on 2026-11-07, and Shopify reports using it on more than 40 metrics. Thermite is at 0.x and [makes no upgrade promise](../reference/known-limits.md#0x-versions-make-no-upgrade-promise), and [the test that proves runs of several days](../reference/known-limits.md#runs-of-several-days-are-not-yet-proven) has not run yet.

Thermite owes it more than a comparison. Pi is Thermite's default worker harness, and a hill climb's first step, a baseline of the unmodified code before any change, [comes from pi-autoresearch](../project/credits.md#autoresearch-systems) and Karpathy's autoresearch. Thermite doesn't run the extension itself.

## Moving a project over

If you know pi-autoresearch, most of its parts have a home in Thermite:

| pi-autoresearch | Thermite |
| --- | --- |
| `.auto/prompt.md` | The campaign's [brief](../explanation/campaign-modes.md#the-campaigns-brief), and its contract for what must hold |
| `.auto/measure.sh` | The kit's build and run steps |
| `.auto/checks.sh` | The kit's check |
| `.auto/ideas.md` | The run's queue of experiments |
| `.auto/log.jsonl` | The rig's ledger |
| A segment | A run |
| `keep` | A confirmed win, which becomes the champion |
| `discard` | A verdict that says how the change lost |
| Notes in `asi` | Field notes |
| `/autoresearch finalize` | [Take the result](../how-to/campaigns/take-the-result.md) |

[Your own project](../tutorials/your-own-project.md) walks through a first campaign from the dashboard, and [Write a kit for your project](../how-to/campaigns/write-a-kit.md) covers a real benchmark.
