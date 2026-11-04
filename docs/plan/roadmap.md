# Roadmap

Every goal, by version, in priority order. Each line links to its goal. [How Thermite is planned](README.md) explains goals, their statuses and how to add an idea.

- **v0.1.0 is decided.** Its plan is [release-v0.1.0.md](release-v0.1.0.md).
- **Later versions are proposed.** Their order and their contents can change.
- **Versions count up by the middle number:** 0.2.0, 0.3.0 and so on. Fixes and quick follow-ups ship as 0.1.1, 0.1.2.
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

**Follow-ups from use: the open issues of its milestone first, then the first release's follow-ups, GPUs on demand and work within a budget.** In the order below. Goal [185](goals/185-a-runs-work-in-git.goal), built in v0.1.1, closes issue 39 once it is verified. Proposed.

**First, what users hit.** Bugs with a clear fix, and CI's tag run.

- [189](goals/189-opencode-provider-key.goal) OpenCode's own provider sends its key: its paid models work in OpenCode and in Pi (issue 26) · `IN_PROGRESS`
- [190](goals/190-research-on-a-subscription.goal) Research on a Claude subscription: refused before the run starts, with what to do (issue 25) · `IN_PROGRESS`
- [191](goals/191-check-while-taking-model.goal) Check waits while the rig takes its new model (issue 44) · `IN_PROGRESS`
- [150](goals/_completed/150-model-check-busy-model.goal) A model check on a busy model: it waits as long as the rig says, and doesn't call the model down · `VERIFIED`
- [192](goals/192-ci-tag-run-green.goal) CI's run on a version tag passes every check a runner can run (issue 54) · `IN_PROGRESS`

**The owner's asks of 2026-11-03.**

- [194](goals/_completed/194-start-a-teachers-round.goal) Start a teachers' round now: an MCP tool, a dashboard action and a signed command (issue 53) · `VERIFIED`
- [193](goals/193-usage-lists-configured-agents.goal) The usage table lists every agent with a model, with no calls yet when it has none (issue 52) · `IN_PROGRESS`

**The owner's asks of 2026-11-04.**

- [203](goals/203-machines-page.goal) Machines: a Settings page of where rigs run, apart from Providers; no Rigs' models page · `IN_PROGRESS`

**Runs that don't waste the machine.** The field report's ranked requests, and a waiting win.

- [198](goals/198-budget-counts-working-time.goal) A run's time budget counts the time it worked, and a run that spent it can go on (issue 50) · `IN_PROGRESS`
- [201](goals/201-judge-queue-per-run.goal) A paused or closed run's judge jobs stop, and stop holding up the rest (issue 50) · `PROPOSED`
- [199](goals/199-judge-files-once-disk-ready.goal) The judge copies a job's files once, and checks the disk before it times (issue 50) · `PROPOSED`
- [200](goals/200-plateau-stop.goal) A plateau stop: a run ends after a time without a new champion, when the owner sets it (issue 50) · `PROPOSED`
- [141](goals/141-waiting-win-after-champion-moved.goal) A waiting win the champion moved past: closed when a champion has it, an approval when none does (issue 23) · `PROPOSED`
- [202](goals/202-field-report-3080.goal) The 3080 field report: each of its items in a goal (issue 50) · `PROPOSED`

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
- [130](goals/130-mcp-tools-after-update.goal) An MCP client sees control's new tools after control is updated · `PROPOSED`
- [145](goals/145-drain-race.goal) A drain doesn't wait two hours for a trial that started seconds before it · `PROPOSED`
- [146](goals/146-supervisor-alone.goal) Restart or update a rig's supervisor alone, while its harness goes on · `PROPOSED`
- [149](goals/149-output-cut-notice.goal) A command's result says its output was cut only when it was · `PROPOSED`
- [178](goals/178-clean-up-continued.goal) Code clean-up, continued: what v0.1.1 left for later · `PROPOSED`
- [177](goals/177-dashboard-styles-in-its-stylesheet.goal) The dashboard's styles in its stylesheet, and a Content Security Policy with no inline style · `PROPOSED`
- [132](goals/132-cuda-images-per-gpu.goal) Rig images for each GPU generation: CUDA 12 for Pascal and Volta, CUDA 13 on amd64 and arm64 for Blackwell and DGX Spark · `IN_PROGRESS`
- [134](goals/134-run-resource-use.goal) A run's resource use: the rig's CPUs, memory and GPUs over the run's time, and what held its lanes back · `PROPOSED`
- [095](goals/095-runpod-spend-on-providers.goal) Providers shows what Thermite spent on a GPU cloud, not only its test pods · `PROPOSED`
- [100](goals/100-on-demand-gpus.goal) GPUs on demand for the judge and the workers · `PROPOSED`
- [101](goals/101-secondary-judge.goal) A secondary judge: an outside service's checks on a schedule, and its submissions · `PROPOSED`
- [186](goals/186-judge-a-released-artifact.goal) The judge measures a released artifact: a container image by digest, or a binary by its hash, as the thing under test · `PROPOSED`

## v0.1.4

**UI clean-up and UX improvements.** The screens agree with each other, and each one says what you need to know. Proposed.

- [126](goals/126-ui-clean-up.goal) UI clean-up: every screen checked against the rules for screens, and the gaps fixed · `PROPOSED`
- [131](goals/131-ux-fixes-found-in-use.goal) UX fixes found in use: the screens' small faults that the owner reports · `PROPOSED`
- [088](goals/088-new-campaign-button-progress.goal) New campaign's buttons show they were pressed · `PROPOSED`
- [090](goals/090-info-tab.goal) An Info tab for campaigns and runs: everything they were started with · `PROPOSED`
- [091](goals/091-needs-you-stuck-rigs.goal) Needs you shows a rig that is stuck · `PROPOSED`
- [093](goals/093-live-shows-reasoning.goal) Live shows what the model thinks and says, not only its tool calls · `PROPOSED`
- [094](goals/094-copy-id.goal) Copy an ID from any page · `PROPOSED`
- [109](goals/109-exports-page-shows-what-matters.goal) The Exports page shows what matters, not every slice · `PROPOSED`
- [110](goals/110-judge-only-runs-show-progress.goal) A judge-only run shows its progress · `PROPOSED`
- [072](goals/072-why-nothing-at-work.goal) Say why a running run has nothing at work · `PROPOSED`
- [089](goals/089-dashboard-performance.goal) Faster dashboard pages · `PROPOSED`
- [148](goals/148-keep-working-on-screens.goal) Keeping working, on New campaign and on a run's page · `PROPOSED`

## v0.2.0

**Run Thermite without the dashboard.** Every dashboard action has an API and MCP twin, all logs are in one place you can search, and sign-in uses your identity provider. Proposed.

- [027](goals/027-logs-page.goal) One Logs page · `PROPOSED`
- [028](goals/028-log-store.goal) Search every log and session · `PROPOSED`
- [029](goals/029-api-mcp-coverage.goal) Full API and MCP coverage · `IN_PROGRESS`
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

## v0.3.0

**Rigs you can trust.** Setting up and removing rigs on machines and clusters is safe to repeat, and lanes are kept off the local network. Proposed.

- [032](goals/032-deploy-checks.goal) Checks before a rig is deployed · `PROPOSED`
- [033](goals/033-slot-helper.goal) Slots made easy · `PROPOSED`
- [034](goals/034-trustworthy-removal.goal) Removal you can trust · `PROPOSED`
- [035](goals/035-rig-upgrades.goal) Upgrades from control · `IN_PROGRESS`
- [036](goals/036-install-it-yourself.goal) "I will install it myself" · `PROPOSED`
- [038](goals/038-lane-network-rules.goal) Keep lanes off the local network · `PROPOSED`
- [039](goals/039-cluster-ranges-and-key-rotation.goal) Cluster ranges and key rotation · `PROPOSED`
- [104](goals/104-change-a-cloud-rigs-gpu.goal) Change a cloud rig's GPU and settings, keeping its state · `PROPOSED`

## v0.4.0

**Kits and evidence.** Kits are easier to write and to test before agents start, and each result shows clearer evidence. Proposed.

- [040](goals/040-kit-tools.goal) Kit tools · `PROPOSED`
- [041](goals/041-kits-and-rigs-explained.goal) Kits and rigs, explained · `DROPPED`, merged into 060
- [042](goals/042-kit-self-test.goal) A kit self-test · `PROPOSED`
- [043](goals/043-progress-charts.goal) Progress charts · `PROPOSED`
- [044](goals/044-comparable-results.goal) Comparable results · `PROPOSED`
- [045](goals/045-richer-receipts.goal) Richer receipts · `PROPOSED`
- [113](goals/113-research-lab-campaign.goal) A research lab: one campaign that researches, builds, improves and researches again · `PROPOSED`

## v0.5.0

**Unattended for days.** Campaigns in all three modes run for days with no person watching. Research mode already searches the web, through an MCP server the campaign names (046, done ahead of this version). Proposed.

- [046](goals/_completed/046-web-search.goal) Web search for research mode · `VERIFIED` (through MCP servers, 068)
- [048](goals/048-validation-scenarios.goal) Six validation scenarios · `PROPOSED`
- [049](goals/049-multi-day-test-fire.goal) The multi-day test fire · `PROPOSED`
- [050](goals/050-docs-site-and-init.goal) A two-command start, and a generated settings reference · `PROPOSED`

## Later

**Not scheduled.** Ideas with a clear source and no version yet. Proposed.

- [051](goals/051-pareto-and-population.goal) Pareto champions and population search · `PROPOSED`
- [052](goals/052-more-target-drivers.goal) More target drivers · `PROPOSED`
- [053](goals/053-cross-rig-planning.goal) Planning across rigs · `PROPOSED`
- [054](goals/054-signed-artifacts.goal) Signed receipts and images · `PROPOSED`
- [055](goals/055-runpod-inference.goal) RunPod for inference · `PROPOSED`
- [057](goals/057-finalize-champions.goal) Finalize a champion into reviewable branches · `PROPOSED`
- [058](goals/058-helm-and-npm.goal) Helm charts and an npm package · `PROPOSED`
- [059](goals/059-knowledge-base-export.goal) Research results into a knowledge base · `DROPPED` (now part of 065)
- [111](goals/111-reuse-a-goal-report.goal) A new run reuses the judge's goal report on the same starting point · `PROPOSED`
