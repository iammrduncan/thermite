# Roadmap

Every goal, by version, in priority order. Each line links to its goal. [How Thermite is planned](README.md) explains goals, their statuses and how to add an idea.

- **v0.1.0 is decided.** Its plan is [release-v0.1.0.md](release-v0.1.0.md).
- **Later versions are proposed.** Their order and their contents can change.
- **A version with new work counts up the middle number,** such as 0.3.0, and holds the new features. **Each fix is a version of its own** that counts up the last number, such as 0.2.1: it is released when its pull request merges to `main`, and it goes into the next middle version too ([decisions](decisions.md#releases-and-planning), 2026-11-08 and 2026-11-09). Before v0.1.4, versions with new work also counted up the last number, from 0.1.1 to 0.1.3.
- **Each version ships when its goals are verified,** not on a date. Each one also takes the fixes from tester reports on the version before it.

## Built so far

Before v0.1.0, the v1 design was built in milestones. Each milestone ended with checks that had to pass before the next one started.

| Milestone | Delivers | Status |
| --- | --- | --- |
| **M1: core** | Contracts for all three modes, the ledger, the harness API, signed commands and verified imports, container images and a local compose stack | Built |
| **M2: judge** | Process isolation, target drivers (CUDA GPU and CPU), the build and run pipeline, gates, timing owned by the executor, statistics, verdicts. Acceptance tests with known good, broken, no-op and tampering candidates | Built; accepted on the CPU and CUDA GPU targets |
| **M3: control** | Supervisor reporting and command relay, git export, the central control service with dashboard, API and MCP | Built; accepted with two local rigs |
| **M4: agents** | Stateless workers with submit, status and development-run tools; the planner; goal and research modes | Built; accepted with a scripted model; the first real-model trials have run |
| **M5: supervision** | Teacher review with cited directives, audits, the review panel for subjective goals, "not possible" endings, propagation and cross-verification across rigs, daily reports, lifecycle control and full reset | Built; accepted locally |
| **M6: test fire** | Several campaigns in all three modes running unattended for days, with failures injected along the way | Goal [049](goals/049-multi-day-test-fire.goal) |

Since M5, control also sets rigs up by itself, on machines over SSH and on Kubernetes clusters, or gives you one command to join a rig where it cannot connect. Rigs may have many GPUs, split between the judge and the agents by what is deployed on them. The dashboard has a New campaign page and one Providers page: model providers (API keys and subscriptions), Git access, machines, clusters and RunPod. Each agent role can have its own model.

## v0.1.0

**First public release.** A tester installs Thermite from published images, runs agents on a sample project, adds rigs on their own machines or clusters, and launches GPU rigs on RunPod. Decided.

The plan: [release-v0.1.0.md](release-v0.1.0.md).

**Scope frozen, 2026-10-25.** v0.1.0 ships what is on `main`. Before the tag: goal 117's acceptance runs, the CUDA 13 image labelled untested, and goal 026's steps. A goal here whose code is on `main` and whose only open item is a check on the lab doesn't hold the tag; its check goes on after the release. Anything new goes into a later version.

### Tester basics

- [001](goals/_completed/001-plans-in-public.goal) Plans in public docs · `VERIFIED`
- [002](goals/_completed/002-ci-and-repository-settings.goal) CI on every push, and repository settings · `VERIFIED`
- [003](goals/_completed/003-advisors-no-default-cap.goal) No default spend limit for advisors · `VERIFIED`
- [004](goals/_completed/004-secret-scan.goal) Scan the history for secrets · `VERIFIED`
- [005](goals/_completed/005-sample-project.goal) A sample project in `examples/` · `VERIFIED`
- [060](goals/_completed/060-docs-site.goal) The documentation site · `VERIFIED`
- [006](goals/006-docs-for-testers.goal) Docs for testers · `DROPPED`, merged into 060
- [007](goals/_completed/007-known-limits.goal) Known limits and the security model · `VERIFIED`
- [008](goals/_completed/008-community-files.goal) Community files and contributor docs · `VERIFIED`
- [009](goals/_completed/009-subscription-sign-in-tests.goal) Real subscription sign-in tests · `VERIFIED`
- [063](goals/_completed/063-scan-and-steer.goal) Campaigns, runs and live views you can scan; steering as one message box · `VERIFIED`
- [080](goals/_completed/080-buttons-show-progress.goal) A button says at once that it took, and shows its outcome without a refresh · `VERIFIED`

### Install from images

- [010](goals/010-published-images.goal) Published images and a release workflow · `IN_PROGRESS`
- [011](goals/011-release-bundle.goal) A release bundle · `IN_PROGRESS`
- [012](goals/_completed/012-version-checks.goal) Version checks between control and rigs · `VERIFIED`
- [013](goals/_completed/013-thermite-doctor.goal) `thermite doctor` · `VERIFIED`
- [037](goals/_completed/037-gpu-compose.goal) The local rig uses what its machine has: CPUs, memory and NVIDIA GPUs · `VERIFIED`
- [014](goals/_completed/014-quick-start-in-ci.goal) The quick start, tested in CI · `VERIFIED`
- [015](goals/_completed/015-log-paging.goal) Log paging · `VERIFIED`
- [016](goals/_completed/016-small-fixes.goal) Small fixes before the release · `VERIFIED`
- [017](goals/_completed/017-legacy-names.goal) Remove the legacy model names · `VERIFIED`
- [118](goals/_completed/118-cluster-rig-resources.goal) Change a cluster rig's GPUs, CPUs and memory from control · `VERIFIED`

### Running campaigns

- [064](goals/_completed/064-experiment-queue.goal) One experiment queue for each run; the planner coordinates it · `VERIFIED`
- [065](goals/_completed/065-journals-and-corpus.goal) Journals and a research corpus from every campaign · `VERIFIED`
- [066](goals/_completed/066-direction-rules.goal) Rules name directions, picked with `:direction:` · `VERIFIED`
- [067](goals/_completed/067-assign-queue-from.goal) `thermite assign` can copy a past run's untried experiments · `VERIFIED`
- [068](goals/_completed/068-mcp-servers-for-agents.goal) MCP servers for a campaign's agents, named by its kit · `VERIFIED`
- [069](goals/_completed/069-copy-a-campaign.goal) Copy a campaign · `VERIFIED`
- [056](goals/_completed/056-codex-harness.goal) A Codex CLI harness · `VERIFIED`
- [070](goals/_completed/070-model-context-cap.goal) Cap the context window of a rig's model · `VERIFIED`
- [073](goals/_completed/073-harness-for-each-agent.goal) A harness for each agent · `VERIFIED`
- [074](goals/_completed/074-one-name-for-each-agent.goal) One name for each agent · `VERIFIED`
- [075](goals/_completed/075-model-usage.goal) Model usage for each run, campaign and the whole system · `VERIFIED`
- [079](goals/_completed/079-thermite-overhead.goal) Provider errors by kind, no hidden caps, restarts that keep work, and hands-off promotion · `VERIFIED`
- [077](goals/_completed/077-archive-and-folders.goal) Archive a campaign; folders in the left navigation; no rigs there · `VERIFIED`
- [078](goals/_completed/078-campaign-brief.goal) A campaign's brief: additional information, ideas and hypotheses for every mode · `VERIFIED`
- [082](goals/_completed/082-judge-findings-in-view.goal) The judge's findings in view: held-out failures by kind, refusals everywhere, a time limit per cell, each goal's real check · `VERIFIED`
- [081](goals/_completed/081-ideas-first.goal) Teachers put ideas first; a target queue depth; lanes propose follow-ups · `VERIFIED`
- [086](goals/_completed/086-goal-report-values-and-confirmation-wait.goal) A goal report keeps what it measured; lanes wait while a met champion is confirmed · `VERIFIED`
- [087](goals/_completed/087-close-a-run.goal) The owner closes a run by hand · `VERIFIED`
- [096](goals/_completed/096-kits-from-elsewhere.goal) Give control a kit written elsewhere, as a git bundle · `VERIFIED`
- [103](goals/103-export-and-download.goal) Export, full or not, from the dashboard; an Exports page that downloads each export · `IN_PROGRESS`
- [098](goals/_completed/098-research-teachers-read-the-research.goal) A run's teachers read what the run found: its sources, claims, findings and files · `VERIFIED`
- [099](goals/_completed/099-campaign-status-words.goal) Status words say how a run ended; a judge-only run says so · `VERIFIED`
- [115](goals/_completed/115-hill-climb-baseline.goal) A hill climb's first job measures its starting point, and its guards hold against it · `VERIFIED`
- [128](goals/_completed/128-get-run-bounded.goal) `get_run` stays a size an agent can read, for a run of any length · `VERIFIED`
- [133](goals/_completed/133-metric-values-beside-gains.goal) A hill climb shows its main metric's real values beside each gain · `VERIFIED`
- [135](goals/_completed/135-lanes-and-judge-throughput.goal) Lanes that keep working while the judge works, a judge that builds in parallel, and changes carried to a new champion · `VERIFIED`
- [136](goals/136-no-idle-lanes.goal) No idle lanes: a round doesn't wait for another lane's trial, and a refused page isn't fetched again and again · `IN_PROGRESS`
- [137](goals/_completed/137-auditor-sees-checks.goal) The auditor sees what the judge checked · `VERIFIED`
- [138](goals/_completed/138-answers-fit-tool-output.goal) `get_run`, `run_queue` and `rig_setup` fit an agent's tool output · `VERIFIED`
- [139](goals/139-trial-session-over-mcp.goal) A trial's session, read over MCP · `IN_PROGRESS`
- [140](goals/140-long-tool-call-no-stall.goal) A long tool call doesn't stall the process that streams it · `IN_PROGRESS`
- [142](goals/142-champion-value-on-run-page.goal) A hill climb's champion value: measured right, and at the top of its run's page · `IN_PROGRESS`
- [143](goals/_completed/143-stuck-and-looping-trials.goal) A stuck or looping trial shows itself, and an agent's refused request says why · `VERIFIED`
- [144](goals/144-trial-clock.goal) A trial's clock: the agent sees the time left, a command ends before its trial does, and a lane's build cache works across its trials · `IN_PROGRESS`
- [147](goals/147-notes-per-turn.goal) An optional limit on the field notes a worker writes in one reply · `IN_PROGRESS`
- [151](goals/_completed/151-plan-usage-on-providers.goal) A subscription's usage on Providers: Claude's and ChatGPT's windows, how much is used and when each resets · `VERIFIED`

### Research mode

- [062](goals/_completed/062-research-folder.goal) A research folder agents can search and write · `VERIFIED`
- [076](goals/_completed/076-claim-sources-and-reasons.goal) A claim's source by its address, and a draft's reasons for the owner · `VERIFIED`
- [112](goals/112-research-ends-when-answered.goal) A research run ends when the review panel finds its questions answered · `IN_PROGRESS`
- [117](goals/117-research-that-answers.goal) Research that answers its questions: one living answer per question, work driven by its gaps, and an end it can reach · `IN_PROGRESS`
- [047](goals/047-research-planner.goal) A model planner for research mode · `IN_PROGRESS`
- [116](goals/_completed/116-reviews-tab.goal) A Reviews tab for research runs: every review, each reviewer's answers and comments, and the outcome · `VERIFIED`
- [119](goals/_completed/119-next-experiments-by-run-kind.goal) A research run's next experiments, tagged by the run that takes them: improvements for a hill climb, goals for a goal campaign · `VERIFIED`

### Rigs on RunPod

- [018](goals/_completed/018-runpod-spike.goal) RunPod spike · `VERIFIED`
- [019](goals/_completed/019-rig-only-entry.goal) Control reaches RunPod rigs through RunPod's proxy · `VERIFIED`
- [020](goals/_completed/020-runpod-rig-image.goal) A one-container rig image · `VERIFIED`
- [021](goals/_completed/021-enrollment-codes.goal) Enrollment codes · `VERIFIED`
- [022](goals/_completed/022-runpod-launch.goal) Launch a rig on RunPod · `VERIFIED`
- [023](goals/_completed/023-runpod-lifecycle.goal) Stop, start and terminate RunPod rigs · `VERIFIED`
- [024](goals/_completed/024-runpod-models-and-results.goal) Models into the pod, results out · `VERIFIED`
- [025](goals/_completed/025-runpod-tests-and-docs.goal) RunPod tests and how-to · `VERIFIED`

### The release

- [026](goals/_completed/026-ship-v0.1.0.goal) Ship v0.1.0 · `VERIFIED`

## v0.1.1

**Code clean-up.** The code follows the [conventions](../../CONVENTIONS.md): files of a size you can review, in folders, no duplicated knowledge or dead code, and the engineering rules for design, errors, limits, logging, security and tests, so that later changes are easier. Worked on after v0.1.0 ships: first a read-only look at the whole code that writes a guide, then the clean-up, area by area. Proposed. With it (owner, 2026-10-26): agent definitions in code, a review of how the parts talk, one message bus on NATS JetStream, and agents in their own terminal. v0.1.1 breaks compatibility with v0.1.0.

- [172](goals/172-build-v011.goal) Build v0.1.1: every goal the audit planned, in one order, to verified · `IN_PROGRESS`
- [179](goals/_completed/179-system-view.goal) The whole system on Metrics: the message bus, control, its storage and each rig, live · `VERIFIED`
- [180](goals/180-testing-bugs-exports-checks-cli.goal) Testing's first bugs: exports of what changed, a check's stale refusal, a command line behind its code · `IN_PROGRESS`
- [181](goals/_completed/181-testing-pages.goal) Testing's pages: one audit log, campaigns' reports, exports to find, settings with their own navigation, Live on the agents' terminals · `VERIFIED`
- [182](goals/_completed/182-campaigns-and-kits-for-agents.goal) Campaigns and kits for agents: a kit from git, grants that reach running runs, the metrics a contract uses · `VERIFIED`
- [183](goals/183-advisors-take-their-message.goal) A program in its terminal takes its message: typed in when ready, a message never taken ends the run, audits never wait behind the teachers · `IN_PROGRESS`
- [184](goals/184-guards-beside-the-main-metric.goal) A hill climb's guards beside its main metric: in each verdict, under each champion, beside each attempt · `IN_PROGRESS`
- [187](goals/187-type-into-the-terminal.goal) Type straight into an agent's terminal on Live: keys as you press them, one terminal filling the pane · `IN_PROGRESS`
- [185](goals/185-a-runs-work-in-git.goal) A run's work in git: a branch for its champions, one for each lane, and new campaigns from a champion's commit · `IN_PROGRESS`
- [173](goals/_completed/173-recovery-and-health.goal) Recovery and health: backups, a copy before every migration, a disk floor, drains that end, logs that are bounded, health that checks · `VERIFIED`
- [174](goals/_completed/174-invalidate-evidence.goal) Invalidate evidence: the owner withdraws bad evidence, and what depended on it follows · `VERIFIED`
- [175](goals/_completed/175-knowledge-base.goal) The knowledge base on control: one collection for each campaign, every agent on MCP, each writer in its own slot · `VERIFIED`
- [176](goals/_completed/176-knowledge-explorer.goal) The knowledge explorer: the owner reads, searches and sees what the knowledge base stores · `VERIFIED`
- [160](goals/_completed/160-v010-audit.goal) The v0.1.1 audit: code, data and operations, by specialized reviewers, with the tests moved to tests/ · `VERIFIED`
- [127](goals/_completed/127-clean-up-pre-audit.goal) Pre-audit for the code clean-up: a read-only look at the whole code, and a guide that sets up goal 125 · `VERIFIED`
- [161](goals/_completed/161-control-bugs-from-the-audit.goal) Control's bugs found by the v0.1.1 audit: wrong states on the pages, refusals answered as server errors, errors that vanish · `VERIFIED`
- [162](goals/_completed/162-research-and-knowledge-bugs.goal) Research and knowledge bugs found by the v0.1.1 audit: error pages as sources, domain counts, cut text in the knowledge base · `VERIFIED`
- [163](goals/_completed/163-harness-bugs-from-the-audit.goal) Harness bugs found by the v0.1.1 audit: promotion in one transaction, OpenCode's turn cap, the judge's quiet failures · `VERIFIED`
- [164](goals/_completed/164-settings-that-fail-loudly.goal) Settings that fail loudly: a bad value stops the part at start, and no failure passes as success · `VERIFIED`
- [165](goals/_completed/165-results-kept-through-remove-and-reset.goal) Results kept through remove, reset and update: the remove guard on every placement, two reset bugs, an update that survives a restart · `VERIFIED`
- [171](goals/_completed/171-bugs-on-the-wire.goal) Bugs on the wire: lost long replies, commands sent again in full, a live view stopped by one line, prompts too long for one argument · `VERIFIED`
- [167](goals/_completed/167-how-the-parts-talk.goal) How the parts talk: a review of every interface between control, rigs, kits, campaigns, runs and agents · `VERIFIED`
- [170](goals/_completed/170-one-hierarchy.goal) One hierarchy: each thing identified and addressed through what owns it, so a run's history stays whole wherever it runs · `VERIFIED`
- [166](goals/_completed/166-agent-definitions.goal) Agent definitions you can read and change: one definition for each role in code, and the prompt each run gives it · `VERIFIED`
- [168](goals/_completed/168-message-bus.goal) One message bus: NATS JetStream between control, rigs and agents, with fast storage and retrieval · `VERIFIED`
- [169](goals/_completed/169-agents-in-their-terminal.goal) Agents in their own terminal: each agent program runs its TUI, the live view shows it, steering types into it, session logs become events · `VERIFIED`
- [125](goals/_completed/125-code-to-the-conventions.goal) Code clean-up: all of Thermite's code to its conventions, from file sizes and structure to duplication · `VERIFIED`
- [124](goals/124-file-sizes.goal) Files of a size you can review · `DROPPED`, merged into 125

## v0.1.2

**Every agent on Live, and long messages in a terminal.** Released 2026-11-03. The fixes after v0.1.1, and every agent's work on Live; the goals planned for it moved to v0.1.3.

- [188](goals/188-every-agent-on-live.goal) Every agent on Live: each advisor's own lines and chip, what headless advisors do as they work, and Everything · `IN_PROGRESS`

## v0.1.3

**A rig over several machines, and what a first campaign on it needs.** Released 2026-11-06. A rig is a core and its runners on other machines; every agent program works on them; a kit says what each of its metrics is for; and the fixes a first real campaign on runners needed, on the lab's three DGX Sparks. The rest of v0.1.3's first plan moved to [v0.2.0](#v020).

- [206](goals/_completed/206-core-and-runners.goal) A rig is a core and its runners: lanes and the judge run their experiments on runners anywhere, shared or dedicated · `VERIFIED`
- [208](goals/_completed/208-every-program-on-runners.goal) Every agent program on a rig of runners: a smoke hill climb for Claude Code, Codex, Pi and OpenCode · `VERIFIED`
- [209](goals/209-priority-guard-informational-metrics.goal) Priority, guard and informational metrics: in kits, one word each everywhere, on a run's page · `IN_PROGRESS`
- [211](goals/_completed/211-metric-of-zero.goal) A metric may be zero: a guard against a fixed value, or an informational metric, that measures nothing wrong as 0 · `VERIFIED`
- [212](goals/_completed/212-guard-that-asks.goal) A guard that asks: a change past it waits for the owner's yes, with its numbers, instead of being refused · `VERIFIED`
- [213](goals/_completed/213-models-on-every-runner.goal) A run's model files wherever it runs, however large: a lane's runs reach them too, and a long fetch isn't cut at three hours · `VERIFIED`
- [214](goals/_completed/214-experiment-tried-more-than-once.goal) An experiment tried more than once: tries that end without a win send it back, each to a lane that has not tried it · `VERIFIED`
- [205](goals/205-rig-over-machines.goal) A rig over several machines, with pools of devices for its judge and its workers · `DROPPED`, replaced by 206

**For the tag.** CI's run on the tag, and the images the runners take.

- [192](goals/192-ci-tag-run-green.goal) CI's run on a version tag passes every check a runner can run (issue 54) · `IN_PROGRESS`

**Done on the way.**

- [150](goals/_completed/150-model-check-busy-model.goal) A model check on a busy model: it waits as long as the rig says, and doesn't call the model down · `VERIFIED`
- [194](goals/_completed/194-start-a-teachers-round.goal) Start a teachers' round now: an MCP tool, a dashboard action and a signed command (issue 53) · `VERIFIED`

## v0.1.4

**New campaign for every mode again, and the dashboard checked in a browser.** Released 2026-11-09. v0.1.4 is the fix release of v0.1.3: its fixes are in the [changelog](../../CHANGELOG.md). It also holds one safeguard:

- [239](goals/_completed/239-browser-checks.goal) Browser checks of the dashboard: New campaign and every kind of page in headless Chrome with Playwright, their layouts at two widths · `VERIFIED`

## v0.2.0

**A faster judge, and a running run changed in place.** Released 2026-11-09. The new work after v0.1.3, with v0.1.4's fixes: its changes are in the [changelog](../../CHANGELOG.md). A goal still `IN_PROGRESS` below is built and released, and waits for its check on the lab or for its issue to be closed. The goals not started moved at its release (the owner, 2026-11-09: "cut v0.2.0 with what changes we have now"): the fixes to [v0.2.x](#v02x), each a version of its own, and the rest to [v0.3.0](#v030).

- [189](goals/_completed/189-opencode-provider-key.goal) OpenCode's own provider sends its key: its paid models work in OpenCode and in Pi (issue 26) · `VERIFIED`
- [190](goals/_completed/190-research-on-a-subscription.goal) Research on a Claude subscription: refused before the run starts, with what to do (issue 25) · `VERIFIED`
- [191](goals/_completed/191-check-while-taking-model.goal) Check waits while the rig takes its new model (issue 44) · `VERIFIED`
- [215](goals/_completed/215-planner-with-a-busy-lane.goal) The planner plans a round while a lane is still busy, instead of being refused for it · `VERIFIED`
- [217](goals/_completed/217-lane-fetch-progress.goal) A lane's runner begins fetching the model files when the run starts, and a lane is told how the whole fetch stands · `VERIFIED`
- [218](goals/218-advisor-tools-in-terminal.goal) A teacher in Claude Code's own terminal has its tools from its first turn · `IN_PROGRESS`
- [219](goals/219-lane-runner-memory.goal) A lane on a runner of its own can build and serve a large model in `run_experiment` · `IN_PROGRESS`
- [220](goals/220-chatgpt-usage-refused.goal) Control shows a ChatGPT subscription's usage while its rigs use it · `DROPPED`
- [221](goals/_completed/221-repair-a-run-in-place.goal) Repair a run in place: send an experiment back, and change a running run's lane limits · `VERIFIED`
- [222](goals/222-chatgpt-prompt-cache.goal) Agents on a ChatGPT plan get its prompt cache: the session headers through the model proxy, and a session for Pi · `IN_PROGRESS`
- [223](goals/223-judge-off-mid-job.goal) Turning the judge off says what becomes of the job under way · `DROPPED`
- [226](goals/226-teacher-review-kept.goal) One long field of a teacher's recommendation never loses its review · `IN_PROGRESS`
- [228](goals/_completed/228-attempt-stage-times.goal) An attempt's page says how long each of its stages took · `VERIFIED`
- [229](goals/_completed/229-lanes-runner-pool.goal) A runner pool shared by the lanes, never the judge · `VERIFIED`
- [230](goals/_completed/230-open-attempts-in-place.goal) A running run's limit of unjudged changes, set in place, and no default · `VERIFIED`
- [231](goals/_completed/231-runner-utilization.goal) How busy each runner is: its share of time with the judge, each lane, idle and away · `VERIFIED`
- [232](goals/232-teachers-research-the-web.goal) Teachers research the web with their program's own search and fetch · `IN_PROGRESS`
- [233](goals/233-judge-turnaround.goal) The judge's turnaround: a screen in 20 minutes, its confirmation at once and in 10 to 20 · `IN_PROGRESS`
- [234](goals/234-trial-keeps-its-route.goal) A trial under way keeps its model's route when the rig's workers move to another model · `IN_PROGRESS`
- [235](goals/_completed/235-supervisor-cpus-for-terminals.goal) The supervisor has the CPUs to start its advisors in their own terminals · `VERIFIED`
- [238](goals/238-judge-cards-keep-noise-floor.goal) Every judge card keeps a noise floor, and no judge job starves behind a full queue · `IN_PROGRESS`
- [240](goals/_completed/240-hung-run-holds-judge.goal) A change that hangs gets its verdict, and holds one judge card for no longer than its kit allows · `VERIFIED`
- [193](goals/_completed/193-usage-lists-configured-agents.goal) The usage table lists every agent with a model, with no calls yet when it has none (issue 52) · `VERIFIED`
- [203](goals/203-machines-page.goal) Machines: a Settings page of where rigs run, apart from Providers; no Rigs' models page · `IN_PROGRESS`
- [198](goals/198-budget-counts-working-time.goal) A run's time budget counts the time it worked, and a run that spent it can go on (issue 50) · `IN_PROGRESS`

## v0.2.x

**Fixes to v0.2.0, each a version of its own (the owner, 2026-11-09).** Each is one pull request to `main`, released as the next patch number when it merges, v0.2.1, then v0.2.2, and merged into v0.3.0 too.

**v0.2.1** (the owner, 2026-11-10) holds several fixes at once: Dependabot's updates (pull requests 69, 71, 72 and 74), the outside contributors' fixes (pull requests 57, 58, 59 and 67; the last is items 1 and 3 of goal [195](goals/195-model-prices-cache-and-tiers.goal)), and these two goals:

- [216](goals/_completed/216-pi-1-5.goal) Pi 1.5.0: the agents' tools in pi-schema, and pi-ai's own fix for long tool calls · `VERIFIED` · v0.2.1
- [241](goals/_completed/241-typed-input-once.goal) Input the owner types into an advisor's terminal reaches it once · `VERIFIED` · v0.2.1

**v0.2.2** (the owner, 2026-11-10) fixes critical bugs only, from a check of [issue 50](https://github.com/iammrduncan/thermite/issues/50) against v0.2.1; changes to how Thermite works for the owner wait for v0.3.0:

- [201](goals/_completed/201-judge-queue-per-run.goal) A paused or closed run's judge jobs stop holding up the rest: other runs' dev runs, a shared runner and a RunPod rig's Terminate, and control's view of the queue (issue 50) · `VERIFIED` · v0.2.2
- [259](goals/_completed/259-runner-builds-retention.goal) A retention policy for the judge's builds reaches the builds on a rig's runners (issue 50) · `VERIFIED` · v0.2.2

The fixes after them, one version each, in the order to take them:

- [227](goals/227-runners-ride-through-restart.goal) A rig's runners ride through control's restart · `IN_PROGRESS`: item 4 shipped in v0.2.0, items 1 to 3 are the fix
- [224](goals/224-update-across-control-restart.goal) A rig's update that a control restart cuts off goes on, or says so · `PROPOSED`
- [225](goals/225-drain-waits-for-advisors.goal) A drain waits for the supervisor's advisors too · `PROPOSED`
- [204](goals/204-quiet-ride-through.goal) A supervisor rides through control's restart quietly · `PROPOSED`
- [141](goals/141-waiting-win-after-champion-moved.goal) A waiting win the champion moved past: closed when a champion has it, an approval when none does (issue 23) · `PROPOSED`
- [145](goals/145-drain-race.goal) A drain doesn't wait two hours for a trial that started seconds before it · `PROPOSED`
- [149](goals/149-output-cut-notice.goal) A command's result says its output was cut only when it was · `PROPOSED`
- [130](goals/130-mcp-tools-after-update.goal) An MCP client sees control's new tools after control is updated · `PROPOSED`
- [199](goals/199-judge-files-once-disk-ready.goal) The judge copies a job's files once, and checks the disk before it times (issue 50) · `PROPOSED`
- [131](goals/131-ux-fixes-found-in-use.goal) UX fixes found in use: the screens' small faults that the owner reports · `DROPPED`, merged into 247 and 251

## v0.3.0

**The dashboard's refresh, on fxbot's UI system, and the code's structure behind it (the owner, 2026-11-10).** A dashboard that reads at a glance, with providers as a catalogue and a set-up for a new control; every action and every read in the API; and the changes of shape that make a feature smaller and a fault easier to find. Its plan is [release-v0.3.0.md](release-v0.3.0.md), from the [UI refresh guide](ui-refresh-guide.md) and the [code structure guide](code-structure-guide.md). The owner accepted the plan on 2026-11-10, with the recommended answer to each of its questions (goal 242): its goals are ready, and v0.3.0 ships when they are verified.

**The review.**

- [242](goals/_completed/242-v030-review.goal) The v0.3.0 review: the dashboard's screens, fxbot's UI system and the code's structure, with the guides that set the work up · `VERIFIED`

**The dashboard.** In the order to build them; goal 244 runs beside them, one area ahead.

- [243](goals/243-web-app-base.goal) The new dashboard's base: fxbot's UI system as a web app in control, with its shell, sign-in and checks · `IN_PROGRESS`
- [244](goals/244-one-door.goal) One door for each action and each read: written once, for REST, MCP and the dashboard · `READY`
- [245](goals/245-providers-and-set-up.goal) Providers as a catalogue, and Set up Thermite: fxbot's provider set-up, with a key checked when it is added and a model given to a rig in one flow · `READY`
- [246](goals/246-home-and-decisions.goal) Home and decisions: what needs you in one list, each decision on one page · `READY`
- [247](goals/247-campaigns-and-runs.goal) Campaigns and runs in the new dashboard: a run's page in six tabs, and one panel to steer · `READY`
- [248](goals/248-live.goal) Live in the new dashboard: one design for a run, a rig and everything, with the way back · `READY`
- [249](goals/249-new-campaign.goal) New campaign and Start a run in the new dashboard: what it needs checked first, a refusal at its field · `READY`
- [250](goals/250-rigs-and-machines.goal) Rigs and machines in the new dashboard: a rig's page in tabs, the agents' models first, Add a rig in one flow · `READY`
- [251](goals/251-library.goal) Library: knowledge, reports and exports in one place · `READY`
- [252](goals/252-usage-logs-settings.goal) Usage, Logs and the rest of Settings: one home for cost, one log, one place for the system · `READY`
- [253](goals/253-the-switch.goal) The switch: the new dashboard alone, the old pages removed, every docs page and screenshot current · `READY`

**The code's structure.**

- [254](goals/254-one-record.goal) One record for each setting, command and event kind: a feature's facts written once · `READY`
- [257](goals/257-find-the-fault.goal) Find the fault from Thermite's own records: a record where work did not happen, and IDs on every log line · `READY`
- [255](goals/255-one-way-to-run-a-program.goal) One way to run an agent program: for workers and advisors, headless and in a terminal · `READY`
- [256](goals/256-layers-and-splits.goal) Layers inside the parts, and files split on purpose · `READY`

**From before the plan: run Thermite without the dashboard.** Every dashboard action has an API and MCP twin, all logs are in one place you can search, and sign-in uses your identity provider. The plan's goals took in the ones marked as merged, here and in the lists after. The others are proposed: one with a screen is built in the new dashboard, and what is not verified when goals 242 to 257 are moves on at the release ([release plan](release-v0.3.0.md#the-other-goals-of-v030)).

- [027](goals/027-logs-page.goal) One Logs page · `DROPPED`, merged into 252
- [028](goals/028-log-store.goal) Search every log and session · `DROPPED`, merged into 257
- [029](goals/029-api-mcp-coverage.goal) Full API and MCP coverage · `DROPPED`, merged into 244
- [071](goals/071-bounded-mcp-answers.goal) MCP answers that fit an agent's context · `PROPOSED`
- [083](goals/083-deep-research-teacher.goal) A deep-research teacher that runs on a trigger · `PROPOSED`
- [084](goals/084-research-tasks-in-code-runs.goal) Research tasks inside goal and hill-climb runs, with web search · `PROPOSED`
- [085](goals/085-move-a-campaign-to-another-rig.goal) Move a campaign's work to another rig · `PROPOSED`
- [092](goals/092-knowledge-explore-and-dumps.goal) Explore the knowledge base, and dump it to outside stores · `PROPOSED`
- [102](goals/102-kits-define-campaigns.goal) Kits define how a campaign runs; rigs are the slots it runs in · `PROPOSED`
- [120](goals/120-research-kit-prep.goal) From research to the next campaign: next experiments in Start a run and New campaign, and kit prep · `PROPOSED`
- [121](goals/121-hill-climb-stages.goal) Stages: a hill climb that improves several metrics, one after the other · `PROPOSED`
- [105](goals/105-amd-gpus.goal) AMD GPUs in rigs · `PROPOSED`
- [106](goals/106-apple-silicon-rig.goal) A rig on Apple silicon that uses its GPU · `PROPOSED`
- [107](goals/107-runs-side-by-side.goal) Several runs at once on one rig, within its resources · `PROPOSED`
- [030](goals/030-oauth-sign-in.goal) Sign in with OAuth or OIDC · `PROPOSED`
- [031](goals/031-design-docs.goal) The design reasons, in public docs · `PROPOSED`
- [061](goals/061-gaps-found-by-the-docs.goal) Gaps found by the docs work · `PROPOSED`

**Moved from v0.2.0 at its release (the owner, 2026-11-09).** The features planned for v0.2.0 that were not started.

**The judge, rigs and images.**

- [236](goals/236-judge-builds-on-a-builder.goal) The judge's builds on a builder, off the judge cards' clock · `PROPOSED`
- [237](goals/237-supervisor-roll-keeps-judge.goal) A roll of the supervisor alone keeps the judge measuring · `PROPOSED`
- [207](goals/207-runpod-runners.goal) A RunPod GPU as a rig's runner, launched while it works · `PROPOSED`
- [132](goals/132-cuda-images-per-gpu.goal) Rig images for each GPU generation: CUDA 12 for Pascal and Volta, CUDA 13 on amd64 and arm64 for Blackwell and DGX Spark · `IN_PROGRESS`

**Runs that don't waste the machine.** The field report's ranked requests, and a question on the judge.

- [200](goals/200-plateau-stop.goal) A plateau stop: a run ends after a time without a new champion, when the owner sets it (issue 50) · `PROPOSED`
- [202](goals/202-field-report-3080.goal) The 3080 field report: each of its items in a goal (issue 50) · `PROPOSED`
- [210](goals/210-first-candidate-bias.goal) The first change a run's judge measures reads high: a question for the owner, seen on a noisy machine · `PROPOSED`: a question for the owner

**Costs, and what a hill climb keeps.**

- [195](goals/195-model-prices-cache-and-tiers.goal) Model prices: a price for cache writes, and prices by request size (issue 41) · `PROPOSED`
- [123](goals/123-budgets-made-simple.goal) Budgets made simple: one amount in dollars, easy to set, that holds on every rig · `PROPOSED`
- [196](goals/196-hill-climbs-keep-what-they-learn.goal) Hill climbs keep what they learn: broken attempts tried again, small gains kept, a run's bar and reference carried on (issues 29, 36, 37, 38) · `PROPOSED`
- [197](goals/197-experiment-queue-cap-and-split.goal) The experiment queue: a cap that keeps the best, and the worker's measurements beside the judge's (issues 30, 20) · `PROPOSED`
- [114](goals/114-hill-climb-contract-gaps.goal) Hill-climb contracts: a check once per candidate, cheaper held-out cells, and goal mode's fields · `PROPOSED`
- [122](goals/122-repeat-measurements-setting.goal) Repeat measurements: a setting to turn off the judge's repeats, with why to keep them or not · `PROPOSED`

**Planned before the issues.** The rest of the first release's follow-ups, then GPUs on demand and a secondary judge.

- [097](goals/097-add-a-kit-bundle-from-the-dashboard.goal) Give control a kit bundle from the dashboard · `PROPOSED`
- [108](goals/108-gated-models-on-cloud-rigs.goal) Gated models on cloud rigs · `PROPOSED`
- [129](goals/129-copy-takes-rubrics.goal) A research campaign's copy can take its own rubrics · `PROPOSED`
- [146](goals/146-supervisor-alone.goal) Restart or update a rig's supervisor alone, while its harness goes on · `PROPOSED`
- [178](goals/178-clean-up-continued.goal) Code clean-up, continued: what v0.1.1 left for later · `PROPOSED`
- [177](goals/177-dashboard-styles-in-its-stylesheet.goal) The dashboard's styles in its stylesheet, and a Content Security Policy with no inline style · `DROPPED`, merged into 243 and 253
- [134](goals/134-run-resource-use.goal) A run's resource use: the rig's CPUs, memory and GPUs over the run's time, and what held its lanes back · `PROPOSED`
- [095](goals/095-runpod-spend-on-providers.goal) Providers shows what Thermite spent on a GPU cloud, not only its test pods · `DROPPED`, merged into 250
- [100](goals/100-on-demand-gpus.goal) GPUs on demand for the judge and the workers · `PROPOSED`
- [101](goals/101-secondary-judge.goal) A secondary judge: an outside service's checks on a schedule, and its submissions · `PROPOSED`
- [186](goals/186-judge-a-released-artifact.goal) The judge measures a released artifact: a container image by digest, or a binary by its hash, as the thing under test · `PROPOSED`

**UI clean-up and UX improvements.** The screens agree with each other, and each one says what you need to know.

- [126](goals/126-ui-clean-up.goal) UI clean-up: every screen checked against the rules for screens, and the gaps fixed · `DROPPED`, merged into 253
- [088](goals/088-new-campaign-button-progress.goal) New campaign's buttons show they were pressed · `DROPPED`, merged into 249
- [090](goals/090-info-tab.goal) An Info tab for campaigns and runs: everything they were started with · `DROPPED`, merged into 247
- [091](goals/091-needs-you-stuck-rigs.goal) Needs you shows a rig that is stuck · `DROPPED`, merged into 246
- [093](goals/093-live-shows-reasoning.goal) Live shows what the model thinks and says, not only its tool calls · `PROPOSED`
- [094](goals/094-copy-id.goal) Copy an ID from any page · `DROPPED`, merged into 243
- [109](goals/109-exports-page-shows-what-matters.goal) The Exports page shows what matters, not every slice · `DROPPED`, merged into 251
- [110](goals/110-judge-only-runs-show-progress.goal) A judge-only run shows its progress · `DROPPED`, merged into 247
- [072](goals/072-why-nothing-at-work.goal) Say why a running run has nothing at work · `DROPPED`, merged into 247
- [089](goals/089-dashboard-performance.goal) Faster dashboard pages · `PROPOSED`
- [148](goals/148-keep-working-on-screens.goal) Keeping working, on New campaign and on a run's page · `DROPPED`, merged into 247

## v0.4.0

**Rigs you can trust.** Setting up and removing rigs on machines and clusters is safe to repeat, and lanes are kept off the local network. Proposed.

- [032](goals/032-deploy-checks.goal) Checks before a rig is deployed · `PROPOSED`
- [033](goals/033-slot-helper.goal) Slots made easy · `PROPOSED`
- [034](goals/034-trustworthy-removal.goal) Removal you can trust · `PROPOSED`
- [035](goals/035-rig-upgrades.goal) Upgrades from control · `IN_PROGRESS`
- [036](goals/036-install-it-yourself.goal) "I will install it myself" · `PROPOSED`
- [038](goals/038-lane-network-rules.goal) Keep lanes off the local network · `PROPOSED`
- [039](goals/039-cluster-ranges-and-key-rotation.goal) Cluster ranges and key rotation · `PROPOSED`
- [104](goals/104-change-a-cloud-rigs-gpu.goal) Change a cloud rig's GPU and settings, keeping its state · `PROPOSED`

## v0.5.0

**Kits and evidence.** Kits are easier to write and to test before agents start, and each result shows clearer evidence. Proposed.

- [040](goals/040-kit-tools.goal) Kit tools · `PROPOSED`
- [041](goals/041-kits-and-rigs-explained.goal) Kits and rigs, explained · `DROPPED`, merged into 060
- [042](goals/042-kit-self-test.goal) A kit self-test · `PROPOSED`
- [043](goals/043-progress-charts.goal) Progress charts · `PROPOSED`
- [044](goals/044-comparable-results.goal) Comparable results · `PROPOSED`
- [045](goals/045-richer-receipts.goal) Richer receipts · `PROPOSED`
- [113](goals/113-research-lab-campaign.goal) A research lab: one campaign that researches, builds, improves and researches again · `PROPOSED`

## v0.6.0

**Unattended for days.** Campaigns in all three modes run for days with no person watching. Research mode already searches the web, through an MCP server the campaign names (046, done ahead of this version). Proposed.

- [046](goals/_completed/046-web-search.goal) Web search for research mode · `VERIFIED` (through MCP servers, 068)
- [048](goals/048-validation-scenarios.goal) Six validation scenarios · `PROPOSED`
- [049](goals/049-multi-day-test-fire.goal) The multi-day test fire · `PROPOSED`
- [050](goals/050-docs-site-and-init.goal) A two-command start, and a generated settings reference · `PROPOSED`

## Later

**Not scheduled.** Ideas with a clear source and no version yet. Proposed.

- [258](goals/258-runs-own-their-resources.goal) A run owns its agents and its share of compute: the control plane runs the loops, a light runner does the work · `PROPOSED`
- [051](goals/051-pareto-and-population.goal) Pareto champions and population search · `PROPOSED`
- [052](goals/052-more-target-drivers.goal) More target drivers · `PROPOSED`
- [053](goals/053-cross-rig-planning.goal) Planning across rigs · `PROPOSED`
- [054](goals/054-signed-artifacts.goal) Signed receipts and images · `PROPOSED`
- [055](goals/055-runpod-inference.goal) RunPod for inference · `PROPOSED`
- [057](goals/057-finalize-champions.goal) Finalize a champion into reviewable branches · `PROPOSED`
- [058](goals/058-helm-and-npm.goal) Helm charts and an npm package · `PROPOSED`
- [059](goals/059-knowledge-base-export.goal) Research results into a knowledge base · `DROPPED` (now part of 065)
- [111](goals/111-reuse-a-goal-report.goal) A new run reuses the judge's goal report on the same starting point · `PROPOSED`
