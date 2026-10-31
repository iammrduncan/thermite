# Release plan: v0.1.0

v0.1.0 is Thermite's first public release. A tester installs it from published images, runs agents on a sample project, adds rigs on their own machines or clusters, and launches GPU rigs on RunPod.

It has four parts, then the release itself. The parts can run at the same time. The [roadmap](roadmap.md) shows what comes after it.

## Decided

- **2026-10-19:** v0.1.0 is the first public release. It holds the tester basics, install from published images, and rigs on RunPod.
- **2026-10-19:** The code moves to `main` only as the last step before the release. Until then, work stays on the development branch.
- **2026-10-19:** Advisors get no default spend limit. A limit applies only when someone sets one.
- **2026-10-19:** SECURITY.md, CONTRIBUTING.md and the other community files ship with v0.1.0.
- **2026-10-19:** The sample project lives in this repository, under `examples/`.
- **2026-10-19:** The release also includes a troubleshooting page, an own-registry how-to, the harness image's toolchains, a split of the local development guide, lane limits that agree, a README screenshot and the repository settings.
- **2026-10-19:** The docs become a documentation site, built with Astro Starlight from `docs/_site/` and arranged by Diátaxis, with `llms.txt` and `llms-full.txt` for agents (goal 060).
- **2026-10-20:** The owner took the recommended answer to each open decision, except the docs site's address: the site will be served from Cloudflare, under a domain the owner chooses, and the owner deploys it later. The answers are in the table below and in each goal.
- **2026-10-20:** The owner merges the code into `main` and makes the tag, when the project is ready for one.
- **2026-10-20:** The docs site is served at usethermite.com by Cloudflare Pages, built from `main`. So the code moved to `main` early, at the development branch's state that day. Work stays on the development branch, and `main` follows it.
- **2026-10-23:** The local rig uses what its machine has: every CPU and all the memory, and on Linux every NVIDIA GPU through NVIDIA's container toolkit. AMD GPUs and a Mac's Apple GPU are found and explained, not used yet (goal 037, moved from v0.3.0).
- **2026-10-24:** A rig control set up on a Kubernetes cluster changes its GPUs, CPUs and memory from control, keeping its state (goal 118). The owner needs it for a slot that gained a GPU and a larger quota; an operator's token may make the change, and only the judge's share stays the owner's.
- **2026-10-25:** The scope is frozen (the owner: "we keep scope creeping for 2 weeks"). v0.1.0 ships what is on `main`; anything new goes into a later version. See [What is left before the tag](#what-is-left-before-the-tag).
- **2026-10-24:** The development branch `v1/build` is retired: the work, and this release, happen on `main`. After v0.1.0, each version is built on a branch named for it, such as `v0.1.1`, and `main` moves only when a version ships.

## What a tester gets

**In v0.1.0:**

- Control and a rig on one machine, started from published images with one compose file. The rig uses every CPU and all the memory the container engine has and, on Linux with NVIDIA's container toolkit, every NVIDIA GPU. Building from source stays for contributors.
- The rig checks from the dashboard, and `thermite doctor` for the machine.
- A first agent campaign on the sample project, with a free model or the tester's own key.
- The New campaign page, the Providers page, kits and all three campaign modes.
- Rigs on the tester's own machines over SSH, and on their Kubernetes clusters.
- Rigs on RunPod GPUs, launched, stopped and paid for from control.
- A documentation site with tutorials, how-to guides, reference and explanation. Agents can read all of it through `llms.txt`.
- A changelog, a known-limits page, a security policy and a contributor guide.

**Later:** a code clean-up to the conventions (v0.1.1); GPUs on demand for the judge and the workers, with budgets in dollars and measurements that cost less (v0.1.2); follow-ups such as a kit bundle from the dashboard (v0.1.3); a UI clean-up and UX improvements, such as an Info tab for campaigns and runs, stuck rigs in Needs you and the model's reasoning on Live (v0.1.4); one Logs page and full API and MCP coverage (v0.2.0); safer managed rigs and lane network rules (v0.3.0); kit tools and clearer evidence (v0.4.0); multi-day runs (v0.5.0). Web search for research runs, planned for v0.5.0, is already built. 0.x versions make no upgrade promise.

## What is left before the tag

Since 2026-10-25, only this list holds the tag:

1. **Goal 135's pages.** Done, 2026-10-25: they describe all of it, and goal [135](goals/_completed/135-lanes-and-judge-throughput.goal) is verified.
2. **The CUDA 13 image, labelled untested.** It has never run on a GPU. The release publishes it, and its README, the pages and the known limits say it is untested (the owner, 2026-10-25). Goal [132](goals/132-cuda-images-per-gpu.goal) moves to v0.1.2.
3. **Goal [117](goals/117-research-that-answers.goal)'s acceptance runs.** v0.1.0 doesn't ship until research mode is solid (the owner, 2026-10-24). One of the three runs passed; the second failed and was fixed; the second and third run again. On 2026-10-26 the chunking test started again, and the rerun of the 35-hour brief, which could not end because any rewrite of a card kept its question from saturating, waits for that fix on its rig to close and write its paper. The owner tagged v0.1.0 the same day without waiting for these two ("Its good enough... we can push tags and do release."): they finish on the lab after the release. They also check goals [112](goals/112-research-ends-when-answered.goal) and [047](goals/047-research-planner.goal).
4. **Goal [026](goals/_completed/026-ship-v0.1.0.goal)'s steps:** the full checks and acceptance suites on `main`'s tip, the changelog's date, the tag (it closes goal [010](goals/010-published-images.goal)), the bundle on clean machines (it closes goal [011](goals/011-release-bundle.goal)), the release notes and the `v0.1.1` branch.

**Ships as built, checked on the lab after the tag:** goals 103, 136, 139, 140, 142, 144 and 147. Their code is on `main`; each one's only open item is a check on the lab. Goal [143](goals/_completed/143-stuck-and-looping-trials.goal) is verified on the lab, 2026-10-26. So is goal [151](goals/_completed/151-plan-usage-on-providers.goal), 2026-10-26.

**Moved out:** goal [132](goals/132-cuda-images-per-gpu.goal) (CUDA 13 images) to v0.1.2; goal [141](goals/141-waiting-win-after-champion-moved.goal) (a waiting win the champion moved past) to v0.1.3; goal 135's screens to goal [148](goals/148-keep-working-on-screens.goal), v0.1.4.

## Goals

### Tester basics

A tester can run Thermite, knows the risks, and knows where to report a problem.

| Goal | Status | Depends on |
| --- | --- | --- |
| [001 · Plans in public docs](goals/_completed/001-plans-in-public.goal) | `VERIFIED` | — |
| [002 · CI on every push, and repository settings](goals/_completed/002-ci-and-repository-settings.goal) | `VERIFIED` | — |
| [003 · No default spend limit for advisors](goals/_completed/003-advisors-no-default-cap.goal) | `VERIFIED` | — |
| [004 · Scan the history for secrets](goals/_completed/004-secret-scan.goal) | `VERIFIED` | — |
| [005 · A sample project in `examples/`](goals/_completed/005-sample-project.goal) | `VERIFIED` | — |
| [060 · The documentation site](goals/_completed/060-docs-site.goal) | `VERIFIED` | — |
| [006 · Docs for testers](goals/006-docs-for-testers.goal) | `DROPPED`, merged into 060 | — |
| [007 · Known limits and the security model](goals/_completed/007-known-limits.goal) | `VERIFIED` | — |
| [008 · Community files and contributor docs](goals/_completed/008-community-files.goal) | `VERIFIED` | — |
| [009 · Real subscription sign-in tests](goals/_completed/009-subscription-sign-in-tests.goal) | `VERIFIED` | — |
| [063 · Campaigns, runs and live views you can scan; steering as one message box](goals/_completed/063-scan-and-steer.goal) | `VERIFIED` | — |
| [080 · A button says at once that it took, and shows its outcome without a refresh](goals/_completed/080-buttons-show-progress.goal) | `VERIFIED` | [063](goals/_completed/063-scan-and-steer.goal) |

### Running campaigns

A tester sees what each run is doing, gives it work through one queue of experiments, and every campaign keeps what its agents learn.

| Goal | Status | Depends on |
| --- | --- | --- |
| [064 · One experiment queue for each run; the planner coordinates it](goals/_completed/064-experiment-queue.goal) | `VERIFIED` | 063 |
| [065 · Journals and a research corpus from every campaign](goals/_completed/065-journals-and-corpus.goal) | `VERIFIED` | 062, 064 |
| [066 · Rules name directions, picked with `:direction:`](goals/_completed/066-direction-rules.goal) | `VERIFIED` | 064 |
| [067 · `thermite assign` can copy a past run's untried experiments](goals/_completed/067-assign-queue-from.goal) | `VERIFIED` | 064 |
| [068 · MCP servers for a campaign's agents, named by its kit](goals/_completed/068-mcp-servers-for-agents.goal) | `VERIFIED` | 065 |
| [069 · Copy a campaign](goals/_completed/069-copy-a-campaign.goal) | `VERIFIED` | 065 |
| [056 · A Codex CLI harness](goals/_completed/056-codex-harness.goal) | `VERIFIED` | — |
| [070 · Cap the context window of a rig's model](goals/_completed/070-model-context-cap.goal) | `VERIFIED` | — |
| [073 · A harness for each agent](goals/_completed/073-harness-for-each-agent.goal) | `VERIFIED` | [029](goals/029-api-mcp-coverage.goal), [056](goals/_completed/056-codex-harness.goal) |
| [074 · One name for each agent](goals/_completed/074-one-name-for-each-agent.goal) | `VERIFIED` | [073](goals/_completed/073-harness-for-each-agent.goal) |
| [075 · Model usage for each run, campaign and the whole system](goals/_completed/075-model-usage.goal) | `VERIFIED` | — |
| [079 · Provider errors by kind, no hidden caps, restarts that keep work, and hands-off promotion](goals/_completed/079-thermite-overhead.goal) | `VERIFIED` | — |
| [077 · Archive a campaign; folders in the left navigation; no rigs there](goals/_completed/077-archive-and-folders.goal) | `VERIFIED` | — |
| [078 · A campaign's brief: additional information, ideas and hypotheses for every mode](goals/_completed/078-campaign-brief.goal) | `VERIFIED` | — |
| [082 · The judge's findings in view: held-out failures by kind, refusals everywhere, a time limit per cell, each goal's real check](goals/_completed/082-judge-findings-in-view.goal) | `VERIFIED` | — |
| [081 · Teachers put ideas first; a target queue depth; lanes propose follow-ups](goals/_completed/081-ideas-first.goal) | `VERIFIED` | [064](goals/_completed/064-experiment-queue.goal), [066](goals/_completed/066-direction-rules.goal), [074](goals/_completed/074-one-name-for-each-agent.goal) |
| [086 · A goal report keeps what it measured; lanes wait while a met champion is confirmed](goals/_completed/086-goal-report-values-and-confirmation-wait.goal) | `VERIFIED` | [082](goals/_completed/082-judge-findings-in-view.goal) |
| [087 · The owner closes a run by hand](goals/_completed/087-close-a-run.goal) | `VERIFIED` | [080](goals/_completed/080-buttons-show-progress.goal) |
| [096 · Give control a kit written elsewhere, as a git bundle](goals/_completed/096-kits-from-elsewhere.goal) | `VERIFIED` | — |
| [115 · A hill climb's first job measures its starting point, and its guards hold against it](goals/_completed/115-hill-climb-baseline.goal) | `VERIFIED` | — |
| [103 · Export, full or not, from the dashboard; an Exports page that downloads each export](goals/103-export-and-download.goal) | `IN_PROGRESS` | [024](goals/_completed/024-runpod-models-and-results.goal), [080](goals/_completed/080-buttons-show-progress.goal), [112](goals/112-research-ends-when-answered.goal) |
| [098 · A run's teachers read what the run found: its sources, claims, findings and files](goals/_completed/098-research-teachers-read-the-research.goal) | `VERIFIED` | [081](goals/_completed/081-ideas-first.goal), [065](goals/_completed/065-journals-and-corpus.goal), [062](goals/_completed/062-research-folder.goal) |
| [099 · Status words say how a run ended; a judge-only run says so](goals/_completed/099-campaign-status-words.goal) | `VERIFIED` | [077](goals/_completed/077-archive-and-folders.goal), [086](goals/_completed/086-goal-report-values-and-confirmation-wait.goal), [087](goals/_completed/087-close-a-run.goal) |

### Install from images

A tester pulls images in place of building them, and every remote rig has images to pull.

| Goal | Status | Depends on |
| --- | --- | --- |
| [010 · Published images and a release workflow](goals/010-published-images.goal) | `IN_PROGRESS` | — |
| [011 · A release bundle](goals/011-release-bundle.goal) | `IN_PROGRESS` | [010](goals/010-published-images.goal) |
| [012 · Version checks between control and rigs](goals/_completed/012-version-checks.goal) | `VERIFIED` | [010](goals/010-published-images.goal) |
| [013 · `thermite doctor`](goals/_completed/013-thermite-doctor.goal) | `VERIFIED` | — |
| [037 · The local rig uses what its machine has: CPUs, memory and NVIDIA GPUs](goals/_completed/037-gpu-compose.goal) | `VERIFIED` | [011](goals/011-release-bundle.goal), [013](goals/_completed/013-thermite-doctor.goal) |
| [014 · The quick start, tested in CI](goals/_completed/014-quick-start-in-ci.goal) | `VERIFIED` | [005](goals/_completed/005-sample-project.goal), [011](goals/011-release-bundle.goal) |
| [015 · Log paging](goals/_completed/015-log-paging.goal) | `VERIFIED` | — |
| [016 · Small fixes before the release](goals/_completed/016-small-fixes.goal) | `VERIFIED` | — |
| [118 · Change a cluster rig's GPUs, CPUs and memory from control](goals/_completed/118-cluster-rig-resources.goal) | `VERIFIED` | [035](goals/035-rig-upgrades.goal) |
| [017 · Remove the legacy model names](goals/_completed/017-legacy-names.goal) | `VERIFIED` | — |

### Research mode

Research workers build on what earlier trials learned, and a research campaign gives its corpus, claims and findings, not only a report.

| Goal | Status | Depends on |
| --- | --- | --- |
| [062 · A research folder agents can search and write](goals/_completed/062-research-folder.goal) | `VERIFIED` | — |
| [076 · A claim's source by its address, and a draft's reasons for the owner](goals/_completed/076-claim-sources-and-reasons.goal) | `VERIFIED` | [062](goals/_completed/062-research-folder.goal), [065](goals/_completed/065-journals-and-corpus.goal) |
| [112 · A research run ends when the review panel finds its questions answered](goals/112-research-ends-when-answered.goal) | `IN_PROGRESS` | [062](goals/_completed/062-research-folder.goal), [065](goals/_completed/065-journals-and-corpus.goal), [079](goals/_completed/079-thermite-overhead.goal), [098](goals/_completed/098-research-teachers-read-the-research.goal) |
| [117 · Research that answers its questions: one living answer per question, work driven by its gaps, and an end it can reach](goals/117-research-that-answers.goal) | `IN_PROGRESS` | [112](goals/112-research-ends-when-answered.goal), [047](goals/047-research-planner.goal), [116](goals/_completed/116-reviews-tab.goal) |
| [047 · A model planner for research mode](goals/047-research-planner.goal) | `IN_PROGRESS` | [046](goals/_completed/046-web-search.goal) |
| [116 · A Reviews tab for research runs: every review, each reviewer's answers and comments, and the outcome](goals/_completed/116-reviews-tab.goal) | `VERIFIED` | [112](goals/112-research-ends-when-answered.goal) |
| [119 · A research run's next experiments, tagged by the run that takes them: improvements for a hill climb, goals for a goal campaign](goals/_completed/119-next-experiments-by-run-kind.goal) | `VERIFIED` | [117](goals/117-research-that-answers.goal) |

### Rigs on RunPod

The owner launches a GPU rig on RunPod from control, runs campaigns on it, and stops paying when it is idle.

| Goal | Status | Depends on |
| --- | --- | --- |
| [018 · RunPod spike](goals/_completed/018-runpod-spike.goal) | `VERIFIED` | — |
| [019 · Control reaches RunPod rigs through RunPod's proxy](goals/_completed/019-rig-only-entry.goal) | `VERIFIED` | — |
| [020 · A one-container rig image](goals/_completed/020-runpod-rig-image.goal) | `VERIFIED` | [018](goals/_completed/018-runpod-spike.goal) |
| [021 · Enrollment codes](goals/_completed/021-enrollment-codes.goal) | `VERIFIED` | — |
| [022 · Launch a rig on RunPod](goals/_completed/022-runpod-launch.goal) | `VERIFIED` | [010](goals/010-published-images.goal), [019](goals/_completed/019-rig-only-entry.goal), [020](goals/_completed/020-runpod-rig-image.goal), [021](goals/_completed/021-enrollment-codes.goal) |
| [023 · Stop, start and terminate RunPod rigs](goals/_completed/023-runpod-lifecycle.goal) | `VERIFIED` | [022](goals/_completed/022-runpod-launch.goal) |
| [024 · Models into the pod, results out](goals/_completed/024-runpod-models-and-results.goal) | `VERIFIED` | — |
| [025 · RunPod tests and how-to](goals/_completed/025-runpod-tests-and-docs.goal) | `VERIFIED` | [022](goals/_completed/022-runpod-launch.goal), [023](goals/_completed/023-runpod-lifecycle.goal), [024](goals/_completed/024-runpod-models-and-results.goal) |

### The release

| Goal | Status | Depends on |
| --- | --- | --- |
| [026 · Ship v0.1.0](goals/_completed/026-ship-v0.1.0.goal) | `VERIFIED` | every other goal |

## Order of work

1. Goal 002 first, so CI runs on every push from now on.
2. The parts go on at the same time; in Running campaigns, 064 follows 063 and 065 follows 064. In RunPod, the launcher (022) waits for the images (010), the rig-only entry (019), the rig image (020) and the enrollment codes (021).
3. When [the list above](#what-is-left-before-the-tag) is done, goal 026 ships the release: the clean-machine tests, the full checks, the changelog, the tag and the GitHub Release, on `main`.
4. Fixes from tester reports, and the follow-ups the roadmap puts in v0.1.1 to v0.1.4, ship as 0.1.1, 0.1.2 and so on, each built on a branch named for it. Other new features go into v0.2.0.

## Decisions made from the open questions

| Decision | Answer | Goal |
| --- | --- | --- |
| RunPod packaging | One combined image per pod (2026-10-20) | [020](goals/_completed/020-runpod-rig-image.goal) |
| How rigs on other networks reach control | Control connects to RunPod rigs through RunPod's proxy (2026-10-19) | [019](goals/_completed/019-rig-only-entry.goal) |
| Who may launch on RunPod | The owner only (2026-10-20) | [022](goals/_completed/022-runpod-launch.goal) |
| RunPod cloud | Secure cloud on demand first; Community and spot later (2026-10-20) | [022](goals/_completed/022-runpod-launch.goal) |
| Where a pod's results go | The project's results repository when it has one, otherwise an upload to control (2026-10-20) | [024](goals/_completed/024-runpod-models-and-results.goal) |
| Terms in the community files | No contributor agreement, no sign-off rule, the Contributor Covenant (2026-10-20) | [008](goals/_completed/008-community-files.goal) |
| Subscription sign-in tests | Before the tag (2026-10-20) | [009](goals/_completed/009-subscription-sign-in-tests.goal) |
| How the code reaches `main` | A pull request merged as a fast-forward (2026-10-20) | [026](goals/_completed/026-ship-v0.1.0.goal) |
| The docs site's address | usethermite.com, on Cloudflare Pages, built from `main` (2026-10-20) | [060](goals/_completed/060-docs-site.goal) |

One step needs the owner's GitHub account: the repository settings ([002](goals/_completed/002-ci-and-repository-settings.goal)). The image packages are public ([010](goals/010-published-images.goal)).
