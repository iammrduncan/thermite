---
title: "Known limits"
description: "What a tester must know before running Thermite 0.x: the risks that come with its design, what it does not do yet, and the goal that removes each limit."
type: reference
sidebar:
  order: 16
---

Thermite is at version 0.x. This page lists what to know before you run it: the risks that come with its design, and what it does not do yet. Each limit says what it means for you, and which goal removes it when a goal does. [The security model](../explanation/security-model.md) explains what each part of Thermite can reach and what it trusts. The [glossary](glossary.md) explains the terms.

| Limit | Removed by |
| --- | --- |
| [Agents run code that a model wrote, on your machine](#agents-run-code-that-a-model-wrote-on-your-machine) | No goal: it is how Thermite works |
| [Under compose, that code can reach your local network](#under-compose-that-code-can-reach-your-local-network) | [Goal 038](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/038-lane-network-rules.goal), v0.3.0 |
| [There are no default caps](#there-are-no-default-caps) | No goal: it is a decision |
| [Timing on RunPod is noisier](#timing-on-runpod-is-noisier) | No goal: it comes with shared machines |
| [Research mode searches the web only through an MCP server](#research-mode-searches-the-web-only-through-an-mcp-server) | No goal: give the campaign a search server |
| [Runs of several days are not yet proven](#runs-of-several-days-are-not-yet-proven) | [Goal 049](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/049-multi-day-test-fire.goal), v0.5.0 |
| [The CUDA 13 harness is untested](#the-cuda-13-harness-is-untested) | [Goal 132](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/132-cuda-images-per-gpu.goal), v0.1.2 |
| [A win the champion moved past still asks to be made the champion](#a-win-the-champion-moved-past-still-asks-to-be-made-the-champion) | [Goal 141](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/141-waiting-win-after-champion-moved.goal), v0.1.3 |
| [0.x versions make no upgrade promise](#0x-versions-make-no-upgrade-promise) | No goal yet: it holds until 1.0 |

## Agents run code that a model wrote, on your machine

The agents' work is code: shell commands, builds and tests that a model chose, run as soon as the model asks for them. The judge then builds and runs the changes that the agents submit. All of it runs in the rig's harness container, on the machine where the rig runs.

- Each lane's commands run as the lane's own Unix user, in a workspace of its own. They can't read the judge's files, the rig's secret files or another lane's work. The rig's isolation self-test checks this every time the harness starts ([Isolation inside a rig](../explanation/isolation.md)).
- That code still uses the machine's processors, memory, disk and network, within the limits on each command, trial, build and run ([Per-process and per-trial limits](limits-and-pacing.md#per-process-and-per-trial-limits)).
- The harness is a container, not a virtual machine. It shares the kernel of the computer it runs on; on macOS, that is the Linux virtual machine that Docker or Podman runs.

**Removed by:** no goal. Running the code that a model writes is how Thermite works. Run rigs on machines that you can give to this work.

## Under compose, that code can reach your local network

Compose joins the harness to a normal network, `egress`, for its way out ([Networks](ports-volumes-secrets.md#compose)). Through it, the lanes' commands, the builds and the timed runs can reach the internet, your computer (as `host.docker.internal`) and the other machines on your local network. A rig that control sets up on a machine, or that you join on one, has the same kind of way out ([Machines](ports-volumes-secrets.md#machines)).

- A worker's research fetches are different: the harness fetches each page itself, and refuses private and local addresses.
- On a Kubernetes cluster, in a namespace that control creates or that you join, network rules let the harness reach only DNS and addresses outside the private ranges of RFC 1918. Control refuses a slot unless its rules do the same, and the rig's isolation check fails when a lane reaches the cluster's API server ([Kubernetes](ports-volumes-secrets.md#kubernetes)).

**Removed by:** [goal 038](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/038-lane-network-rules.goal), Keep lanes off the local network (v0.3.0), under compose. Until then, run a compose rig where nothing on your local network relies on being out of reach.

## There are no default caps

Thermite never ends research by default. A hill climb runs until you pause or close it, a goal campaign until its goals are met, and a research campaign until the review panel finds its questions answered or its `max_duration` is over, or, without either, until you stop it. Nothing limits turns, attempts, failures, time or spending unless you set it ([Limits and pacing](limits-and-pacing.md#caps)). The advisors have no spending limit either, unless the advisors file sets one, and that limit counts only the advisors that the file gives prices ([Configure advisors](../how-to/operate/advisors.md#spending)).

So with a paid model key, the agents spend for as long as the campaign runs. Before you give a rig a paid key, set a stop time or a budget ([Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md)). Also set a spending limit with your model provider: the contract's model spend limit counts only the workers' trials, and only on a rig that has token prices.

The dashboard's RunPod launch form fills in an idle stop of 30 minutes, which you can change or clear; it stops the pod only when no run is at work ([Run a rig on RunPod](../how-to/install/runpod-rig.md)). Control checks a pod's spend limit and idle stop only while control runs: a pod goes on costing while control is down, and control stops it when it starts again ([Run a rig on RunPod](../how-to/install/runpod-rig.md#5-watch-its-cost-and-change-its-limits)).

**Removed by:** no goal. It is a decision: [Why Thermite runs until the job is done](../explanation/runs-until-done.md) says why.

## Timing on RunPod is noisier

Control launches rigs on RunPod ([Run a rig on RunPod](../how-to/install/runpod-rig.md)), and short test pods ([Test a GPU on RunPod](../how-to/install/runpod-test.md)).

A RunPod GPU is in a machine that other customers' pods share. Their work can slow the processors, memory, disk and network that a timed run uses, so the same change can take a different time from one run to the next. In a hill climb, the judge measures the rig's noise and never assumes less ([Calibration](limits-and-pacing.md#the-judge)). On a noisier rig, a change needs a larger gain before the judge confirms it. RunPod's Community cloud is less predictable than its Secure cloud.

**Removed by:** no goal. It comes with shared machines. For the most exact timing, use a machine of your own.

## Research mode searches the web only through an MCP server

Research workers have no search of their own: their `search` tool answers that the rig has no web search. They search the web with the tools of an MCP server that the campaign gives them, such as a search or browsing server you add in **Settings** ([Give agents MCP tools](../how-to/campaigns/give-agents-mcp-tools.md)). Without one, they start from the contract's starting pages (`seeds`) and follow the links of the pages already archived ([the research contract](contract.md#research)), so a research campaign finds only what its starting pages lead to.

**Removed by:** no goal. Give the campaign a search or browsing MCP server.

## Runs of several days are not yet proven

Thermite is built to run unattended for as long as a campaign takes, and to recover from crashes and restarts. Its own tests run campaigns for minutes to a few hours: the longest, `scripts/acceptance/research-longrun.mjs`, runs a research campaign for about two hours by default and kills the harness's controller halfway. The test that proves runs of several days has not run yet: several campaigns in all three modes, for days, with crashes, restarts, a full disk and a lost model along the way.

**Removed by:** [goal 049](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/049-multi-day-test-fire.goal), The multi-day test fire (v0.5.0). If a long run goes wrong for you, [report it](../project/getting-help.md).

## The CUDA 13 harness is untested

The release publishes two CUDA harnesses ([The CUDA harness](harness-image.md#the-cuda-harness)). The CUDA 12 one (`-cuda`) runs Thermite's GPU rigs, on P100 GPUs among others. The CUDA 13 one (`-cuda13`), for Turing to Blackwell and the DGX Spark, is built, and the release's checks hold it to its architectures, but it has not yet run on a GPU. Control sets GPU rigs up from the CUDA 12 image unless `THERMITE_RIG_HARNESS_CUDA_IMAGE` names another, and it doesn't yet choose the image from a rig's GPUs.

**Removed by:** [goal 132](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/132-cuda-images-per-gpu.goal), Rig images for each GPU generation (v0.1.2). If you run it on a Blackwell GPU or a DGX Spark, [tell us how it went](../project/getting-help.md).

## A win the champion moved past still asks to be made the champion

A confirmed win can wait for you: under **Needs you** when you ask to decide each promotion, or after an audit. Meanwhile another win can become the champion. The waiting win's card still asks **Make it the champion**, but approving it does not make it the champion at once: the judge screens it again against the new champion, and it becomes the champion only if it still wins there. The change it held may also come back as a port onto the new champion.

**Removed by:** [goal 141](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/141-waiting-win-after-champion-moved.goal), A waiting win the champion moved past (v0.1.3).

## 0.x versions make no upgrade promise

Until version 1.0, a new version may change settings, commands, routes, files and stored data, with no way back. A newer harness upgrades the rig's ledger, so an older image may not open it again. Control can move a rig it set up, on a machine or a cluster, onto new images, but not a rig that you joined, and it has no way back to older images ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

Before you move to a new version, make sure that what you want to keep is in your results repository, and download the champions that you want ([Take the result](../how-to/campaigns/take-the-result.md)).

Since v0.1.1, a run is addressed by its name alone, which control uses once. Two runs that shared a name before v0.1.1, on two rigs or again after a full reset, show as one: the newest of them, on its campaign's page and at its address. The older one's events stay on control, in its rig's exports and in the knowledge base.

**Removed by:** no goal yet. The [roadmap](../project/roadmap.md#later-versions) says how versions count up.

## More that is not built yet

Other pages say where a feature is not built yet, each with a link to its goal. The [roadmap](../project/roadmap.md) lists every goal. To report a security problem, follow the [security policy](https://github.com/iammrduncan/thermite/blob/main/SECURITY.md), not a public issue.
