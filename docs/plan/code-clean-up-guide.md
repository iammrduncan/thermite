# The code clean-up guide

This guide is for the clean-up of v0.1.1, goal [125](goals/125-code-to-the-conventions.goal). It is the result of goal [127](goals/_completed/127-clean-up-pre-audit.goal), the pre-audit, which was done as part of the v0.1.1 audit, goal [160](goals/_completed/160-v010-audit.goal).

- **What it describes:** the code as v0.1.0 shipped it (tag `v0.1.0`), with the tests already moved to `tests/` by goal 160.
- **Part 2:** on the same evening, five more reviewers looked at the agents' definitions, every channel between the parts, NATS JetStream as a message bus, agents in their own terminal, and the hierarchy of Thermite's things. [Section 8](#8-part-2-lanes-9-to-13-goals-166-to-171) says what they change here.
- **Where it comes from:** eight reviewers, each with one area, read the code and its history on 2026-10-26: control; the harness; the supervisor, core, the command line and the scripts; what crosses the parts; data, storage and the infrastructure; knowledge; tests, folders and dead code; operations. Their reports, with every count and line number, are kept in `.internal/reviews/v0.1.1-audit/`. Those reports are private because they also hold the security findings, which are handled as [SECURITY.md](../../SECURITY.md) says and are never written here.
- **What it is not:** a diff. It names each change, where it goes and what to check. Goal 125 audits one area at a time against it, makes the changes and corrects this guide where the code differs.

The counts below are from the reports. A count marked "about" was measured with `git grep` and can be off by a few.

## 1. The map

### The parts

| Part | Files | Lines | What it does |
| --- | --- | --- | --- |
| `src/control/` | 109 | 49,800 | The control service: the dashboard, REST, MCP, the store (`control.db`), rig set-up on machines, clusters and RunPod, pull mode, exports |
| `src/harness/` | 115 | 49,700 | The rig's controller: the ledger, the service, the scheduler and planners, the workers and the CLI agent programs, the judge, the broker, research |
| `src/supervisor/` | 24 | 9,000 | The rig's outside half: the advisors, git and exports, the relay to control, past research and MCP sync |
| `src/core/` | 21 | 4,700 | Shared contracts: signed commands, contracts, versions, the knowledge base's reading of events, names |
| `src/cli/` | 8 | 3,300 | The `thermite` command |
| `src/common/` | 3 | 300 | Shared runtime helpers (the logger, the MCP client) |
| `src/release/` | 2 | 300 | The release bundle and its checks |
| `tests/` | 245 | 87,000 | The unit and cut-point tests, their helpers in `tests/helpers/`, the docs' test in `tests/docs/` |
| `scripts/` | 32 | 9,900 | Acceptance tests, the docs tools, the release tools, local development, the test runner, the public check |
| `containers/` | 29 | 2,400 | Image builds, the release template, test stand-ins, two wrapper scripts |
| `kits/`, `examples/` | 50 | 1,400 | The smoke kits and their candidates, the sample projects |

33 production files are over 800 lines. The largest are `control/dashboard.ts` (8,875), `control/store.ts` (4,380), `supervisor/advisors.ts` (3,075), `harness/agents/scheduler.ts` (3,045), `harness/service.ts` (2,995), `control/views.ts` (2,194) and `harness/judge/judge.ts` (2,131).

### What depends on what

- The parts should import only `core` and `common`. In fact:
  - control imports 5 harness files;
  - the supervisor imports 20 harness files, and loads 47 of the harness's 115 at run time, the ledger and its migrations among them;
  - the command line imports 3 control files and 2 harness files.
- What the supervisor takes from the harness is of two kinds: the agent runtimes that the workers and the advisors share, and the words and limits of contracts (the kit schema, the research limits, the model routes).
- The contracts between processes:
  - **The event stream** carries every rig's record to control. The harness writes at least 84 kinds of event with an untyped body. Control reads 64 of them by bare string in 143 places. Only `model_call` has a shared schema (`core/usage.ts`).
  - **The APIs.** Each body has a zod schema on the side that receives it. The side that sends it builds the same shape by hand, with its own copy of the limits.
  - **Signed commands** have one home (`core/commands.ts`), but the table of who may issue which kind is kept twice.

### Hot spots

- 44% of the commits that touched code (217 of 491) touched two or more parts.
- The most-changed files since mid-October: `harness/service.ts` (83 commits), `harness/agents/scheduler.ts` (81), `control/store.ts` (77 in October), `harness/main.ts` (66), `harness/api.ts` (52), `supervisor/advisors.ts` (51).
- `control/store.ts` carries the most risk: 54 production importers and 81 test importers.
- Quiet areas, with under 10 commits each: `harness/targets/`, `harness/v0.ts`, `harness/imports.ts`, `harness/git.ts`.

## 2. The themes

Each theme is a set of changes across the code. Sizes are in files. The checks are those of [AGENTS.md](../../AGENTS.md#checks); "the fast checks" means `npm run check`.

### T1. Shared words in `core`

- **What and why.** One fact, one home ("Don't repeat knowledge"). Words that control, the harness and the supervisor all use are kept in each of them, and several copies already differ.
- **Where.**
  - Event kinds and their bodies: 84 or more kinds, read in about 30 control files.
  - Verdict and lifecycle words: `PROMOTABLE_VERDICTS` in `harness/ledger.ts`, tested again by hand in at least 6 control places. Lists of "settled" lifecycles have 9, 7 and 6 words.
  - The agents' words: effort levels in 9 places, the agent program kinds in 20 files, provider types in 5 places. The review panel has four names (`panel`, `review_panel`, `review`, "review panel") and the merging teacher two (`combiner`, `merged_by`).
  - The command-issuer table, in `harness/service.ts` and `control/mcp.ts`.
  - Control's own repeated facts: "the current champion" is worked out inline 13 times, "a run without a campaign is its own campaign" 16 times, the judge's GPU share in 10 places (browser scripts included), and there are 4 rig-name rules.
- **Shape.** `core/events/` (one constant and one schema for each kind; `appendEvent` takes them typed), `core/verdicts.ts`, `core/agents.ts`, the issuer table beside `CommandPayloads` in `core/commands.ts`, and `core/names.ts` as the one map from old or wire names to public names. Control's facts become functions on its views (`currentChampion`, `campaignOf`, `judgeShareOf`, `rigHref`).
- **Size.** About 60 files read these words. Each word set is a change of its own.
- **Depends on.** Nothing. Most other themes use it.
- **Risks.** v0.1.1 breaks compatibility with v0.1.0 (the owner's answers to [Q7 and Q11](#7-the-owners-questions)), so stored and wire values take the public names. A change of a wire value changes every side in one commit, and the changelog says so.
- **Check.** The fast checks, and the steering and control acceptance checks when a word crosses the wire.

### T2. One home for each wire contract, and typed clients

- **What and why.** A body that crosses a process boundary has one schema, and a limit on it is one named constant.
- **Where.** The model route (built in `control/api.ts`, checked in `harness/agents/model-source.ts`). The supervisor's figures (limits 50 and 1,000 on one side, `slice(-50)` and `slice(0, 900)` on the other). The advisors' queue request (`max(20)` against "in parts of 20"). The largest signed command (4 MiB, 3.5 MiB and 3,000,000 bytes, in three files). The supervisor builds 20 calls to the harness and control by hand in 11 files, and reads some errors by matching their English text.
- **Shape.** A contract module for each API in `core` (route paths, schemas, limits), which both sides import. The receiver parses with the schema; the sender builds `z.input<typeof Schema>`. One small client each for the harness API and control's API, with typed errors.
- **Size.** About 25 files in the supervisor, control and the harness.
- **Depends on.** T1, T3.
- **Check.** The fast checks; the compose smoke, agents and steering acceptance checks.

### T3. A shared runtime toolkit in `common`

- **What and why.** One job, one way. `src/common/` holds 3 files today, so each part writes its own helpers.
- **Where.** 143 copies of the error-to-text idiom. 5 named copies of `writeAtomic` and about 10 inline ones. At least 7 git wrappers, with output buffers from 4 to 512 MiB. 7 copies of a constant-time compare. A shell quote 5 times. 12 supervisor files build the same auth header. `check()` is defined 16 times in the acceptance scripts.
- **Shape.** `common/errors.ts` (`errorText`, a few typed errors), `common/fs.ts` (`writeAtomic` and the safe file helpers), `common/git.ts` (one runner, with a named timeout), `common/exec.ts`, `common/http.ts` (calls with a named timeout), `common/secrets.ts`. Shared code for the acceptance scripts goes in one library under `scripts/`.
- **Size.** About 150 call sites, in small steps of one helper each.
- **Depends on.** Nothing.
- **Risks.** Programs that must import nothing of Thermite's (`harness/agents/opencode-plugin.ts`, the compaction hook, the kits' checks, the stand-ins) keep their own copies.
- **Check.** The fast checks; for git and exec, the judge acceptance check.

### T4. Settings, errors and logs to the conventions

- **What and why.** "Nothing stops silently", and CONVENTIONS.md's Interfaces and errors, Limits and state, and Logging.
- **Where.**
  - Settings: about 131 are read with raw `process.env` in about 30 files. A typo in a number reads as `0` or `NaN`, which for some intervals means "off" or "no pause", with no log line. Each default is kept in up to 4 files.
  - Errors: refusals take about 8 forms, and 153 plain `Error`s in the harness become HTTP 500. Control's API turns at least 6 forms into answers, and some refusals reach the client as HTTP 500.
  - Logs: one function writes JSON lines, with no level, no way to change a level while running, and no run, trial or command IDs. Control logs from 22 places, and its audit table serves as its log. 16 agent files have no log line, and there are about 40 silent catches with no stated reason.
  - Timeouts: of the supervisor's 13 files that make HTTP calls, one sets a timeout; git push and fetch to remotes have none.
- **Shape.** One settings module in each part, on `common/settings.ts`: each setting's name, default, unit, bounds and what 0 or empty means, in one table that the docs check reads; a bad value stops the part at start, with the reason. One mapping from errors to statuses in each API. One logger, `common/log.ts`, with levels and the IDs that tie a line to its cause. A named timeout on every outbound call.
- **Size.** About 30 files for settings, 3 APIs and the MCP server for errors, every part for logs.
- **Depends on.** T3. The log store and the logs page are goals [028](goals/028-log-store.goal) and [027](goals/027-logs-page.goal), which build on this logger.
- **Check.** The fast checks; a test for each part that a bad setting stops it at start; the docs check for the settings tables.

### T5. Domain logic out of the dashboard

- **What and why.** "Each layer is a different level of thinking", and "Pull complexity down into the module, instead of pushing it onto every caller" (CONVENTIONS.md, Modules and abstractions). REST and MCP call business logic through `ControlActions` (`control/actions.ts`), 12 optional slots that `createDashboard` fills while it is built. Adding a cluster rig, updating its images, resizing it, stopping it, giving an agent a model and starting a run are written inside the HTML layer, and every caller must handle a missing slot.
- **Where.** `control/dashboard.ts` (about 2,700 lines of rig operations), `control/actions.ts`, `control/api.ts`, `control/mcp.ts`.
- **Shape.** One domain module for each operation, which the dashboard, REST and MCP all call, as `copy-campaign.ts` and `rig-settings.ts` already do. A composition root in control's `main.ts` builds them once. Each rig placement (local, machine, cluster, RunPod) gives the same operations the same safety: drain, restart, remove.
- **Size.** About 15 files. It is also the first step of the dashboard's split.
- **Depends on.** T1 for the shared words. The owner's answer to [Q8](#7-the-owners-questions).
- **Check.** The fast checks; the control, cluster, machines and RunPod acceptance checks.

### T6. The ledger and the store hide their schemas

- **What and why.** Information hiding, and one way to do each storage job.
- **Where.**
  - `Ledger.db` is public, and 234 raw SQL sites in 35 harness files query its tables. The `event` table is queried by hand in 18 files; two of those queries miss the event kinds renamed on 2026-10-15.
  - Promotion is written three times. The judge promotes in one transaction; the auditor's clear and the owner's approval promote across an `await`, outside one.
  - Control's store is one class of 180 methods over 16 domains. Three modules create tables in `control.db`, each in its own way, and it migrates by checking columns at every start, with no version table.
  - There are three transaction helpers that behave differently, and two sets of pragmas.
- **Shape.** Each ledger table has one owner module, under `harness/ledger/`, with a typed event module and a typed attempt row; promotion is one function in one transaction. Control's store becomes sub-stores by domain, with ordered migrations and a version table, as the ledger has. One transaction helper.
- **Size.** About 35 harness files and every importer of `control/store.ts` (54 production files).
- **Depends on.** T1 (event kinds). Do the store last: every other split touches its callers.
- **Check.** The fast checks; the judge acceptance check; a migration test from a copy of a v0.1.0 database for each store.

### T7. One table of agent programs and one CLI trial loop

- **What and why.** One job, one way. OpenCode, OpenCode research, Claude Code and Codex each have their own trial loop: 848 lines that are 60–83% the same, and that have drifted. Which agent program runs is decided in 34 places in 7 files, with four near-identical dependency objects in `harness/main.ts`.
- **Where.** `harness/agents/opencode.ts`, `claude-code.ts`, `codex.ts`, the `cli-*` files, `harness/main.ts`, the scheduler.
- **Shape.** A table of agent programs, one entry each with what really differs (config format, event schema, usage, compaction, sign-in), and one CLI trial loop that takes an entry.
- **Size.** About 12 files.
- **Depends on.** T1 (agent words). The owner's answer to [Q1](#7-the-owners-questions) decides the folder.
- **Check.** The fast checks; the agents, Claude Code, real Claude Code and Codex acceptance checks.

### T8. The large files become folders

- **What and why.** "A file over 800 lines is normally split", by responsibility, into "a folder named for it" (CONVENTIONS.md, Files and their size).
- **Where, and the folder each becomes.** The reports give a split plan for every one of the 33 files. The main ones:

  | File | Lines | Becomes |
  | --- | --- | --- |
  | `control/dashboard.ts` (one closure of 116 routes and about 200 helpers) | 8,875 | `control/dashboard/`: one module for each page or area, and the routes registered from each |
  | `control/store.ts` | 4,380 | `control/store/`: one sub-store for each domain (T6) |
  | `supervisor/advisors.ts` and `advise.ts` (one function of 1,052 lines) | 4,443 | `supervisor/advisors/`: one module for each role, the shared loop, the tools |
  | `harness/agents/scheduler.ts` | 3,045 | `harness/scheduler/`: gates, lanes, rounds, planner calls, research, stops |
  | `harness/service.ts` (17 responsibilities) | 2,995 | `harness/service/`: commands, assignment, promotion, wipe, rig checks, tokens, advisors, research, trials, reports |
  | `control/views.ts` (`rigView` is a switch of 78 cases) | 2,194 | `control/views/`: one fold for each group of events, after a golden test of today's views |
  | `harness/judge/judge.ts` | 2,131 | more modules in `harness/judge/`: arms, blocks, the hill climb, held-out data, decisions |
  | `harness/ledger.ts` | 1,742 | `harness/ledger/`: one module for each table (T6) |
  | `control/api.ts` (72 routes in one function) and `control/mcp.ts` (56 tools, permissions in about 30 nested `if`s) | 3,434 | `control/api/` and `control/mcp/`: one module for each area; MCP gets a role table and a test of it |
  | `harness/main.ts` (one function of 803 lines) | 886 | `harness/controller/`: config, state, targets, the agents' shared parts, checks, loops |
  | `cli/thermite.ts` (a `switch` of 965 lines) | 1,330 | `cli/commands/`: one module for each command, with shared `--control` and `--token-file` handling |

- **Size.** One file at a time, in several steps each. `dashboard.ts` and `mcp.ts` each have one importer, and no test imports either, so their splits can't break a test's imports.
- **Depends on.** T1, T3 and T5 first, so that each split uses the shared homes instead of moving copies.
- **Check.** The fast checks at every step; the acceptance checks of the area.

### T9. Folders in place of names

- **What and why.** "Hierarchy goes in folders, not in file names" (CONVENTIONS.md, Folders and names). Files that share a word at the start or end of their names become a folder named for that word, with an `index.ts` as its interface. Today no folder in `src/` has an `index.ts`, and several files sit beside a folder of the same name (`control/api.ts` beside `control/api/`, `control/views.ts` beside `control/views/`).
- **Where.** The groups the reports found, with the folder each becomes:
  - control: `runpod-*` (6) with `tunnel.ts` → `control/runpod/`; `campaign-*`, `new-campaign`, `copy-campaign`, `start-run` and `queue-copy` → `control/campaigns/`; `rig-*` (5) and the other modules for one rig → `control/rigs/`; `mcp.ts` and its reads → `control/mcp/`; `mcp-servers*` and `mcp-ui.ts` → `control/mcp-servers/` (the agents' MCP servers); `kit-*` → `control/kits/`; `providers.ts`, `chatgpt.ts` and `plan-usage.ts` → `control/providers/`; the `*-view.ts` files → `control/views/`; in `ui/`, each of the 10 `*-client.ts` scripts beside its page module, and `ui/campaigns/`, `ui/rigs/` and `ui/components/`;
  - harness: `model*.ts` → `harness/agents/model/`; `research-*` and `*-tool.ts` → `harness/agents/tools/`; `broker.ts` beside `broker/` → `broker/main.ts`;
  - supervisor: the `*-tools.ts` and advisor files → `supervisor/advisors/` (T8);
  - scripts: 16 `*-acceptance.mjs` with `compose-smoke.mjs` and `research-longrun.mjs` → `scripts/acceptance/`, their library → `scripts/acceptance/lib/`; the docs tools → `scripts/docs/`; the release tools → `scripts/release/`; `dev-init.mjs` and `dashboard-demo.ts` → `scripts/dev/`.
- **Size.** Each group is a mechanical move. Do each one when no other branch changes those files.
- **Risks.** Each move must update every path that names the file ([below](#paths-that-name-files)).
- **Check.** The fast checks; the docs build and check; for scripts, the acceptance checks they hold.

### T10. Tests: shared scaffolding, splits and gaps

- **What and why.** "Tests at the system's cut-points", "Tests must be able to fail", and "Statistics and state machines: unit and property tests".
- **Where.**
  - The same control, harness and relay stack is written 21 times in control's tests (about 1,777 lines), a dashboard sign-in in 42 files, and an MCP client in 10. A change to `createControlApi`'s signature touches 67 test files.
  - 15 test files are over 800 lines; `tests/control/dashboard.test.ts` has 2,498. The longest single test has 564 lines.
  - `tests/core/core.test.ts` tests six modules in one file.
  - Two demo seeds do one job: `tests/helpers/control-demo.ts` and `scripts/dashboard-demo.ts`.
  - The 12-candidate adversarial set is judged end to end only by `scripts/judge-acceptance.mjs`, run by hand. There are no property tests. The research clock is tested with real sleeps.
- **Shape.** `tests/helpers/` gets the stack, the dashboard session and the MCP client once. One demo seed. Large test files split along the code they test. Property tests for the statistics, verdicts and promotion.
- **Size.** About 70 test files.
- **Depends on.** Nothing. Do the scaffolding before T8's splits of control, so each split changes one helper instead of 67 files.
- **Check.** The test totals stay the same or grow; no test is removed without a reason.

### T11. Knowledge: one name for each thing, one reading of it

- **What and why.** "One thing has one name", and "Don't repeat knowledge".
- **Where.**
  - "note" names nine things (a field note, the kind `note`, a research note, the knowledge base's kind `note`, a directive kind, the contract's `notes`, the planner's `notes`, a run's `--note`, a working note), and "folder" four.
  - The research corpus is rendered four ways: `harness/research/folder.ts`, `core/kb-index.ts`, `harness/run-research.ts` and `control/research-view.ts`. Raw SQL on the `claim` table is in 12 production files. There are five search implementations with three matching rules.
  - One source's text is kept in ten or more places.
  - Past research on a rig grows with the square of the number of runs: each run copies every item it may read, twice, and nothing removes a closed run's copies.
  - An item has five identity shapes.
- **Shape.** One word for each meaning, chosen by the owner ([Q23](#7-the-owners-questions)). One module that reads the corpus, which every renderer uses. The knowledge base's items keep structured fields, not `Label: value` lines in prose.
- **Size.** About 20 files.
- **Depends on.** T1, T6. Goal [162](goals/_completed/162-research-and-knowledge-bugs.goal) fixes the bugs here first.
- **Check.** The fast checks; the steering acceptance check.

### T12. Work that grows with history

- **What and why.** CONVENTIONS.md's Limits and state, and the cost behind goal [089](goals/089-dashboard-performance.goal) ("page loads are somewhat slow").
- **Where.**
  - Control rebuilds each rig's view from every event on every request. Measured: about 0.55 s for each rig at 100,000 events, 1.3 s at 200,000. `node:sqlite` is synchronous, so each rebuild blocks every other request, rig reports included. The dashboard calls `views()` 33 times, 8 of them only to see whether a rig exists.
  - Each hourly export writes a full copy of the ledger and vacuums it twice; a full copy goes out once a day. A ledger over a host's file limit (GitHub's is 100 MB) stops the push of attempts too, since one push carries both branches.
  - A run's export reads every event into memory: 1.5 GB of heap at 1,000,000 events.
  - Control prunes nothing it copies or derives, and several rig folders only grow (the build store, `.tmp-` folders after a crash, the advisors' records).
- **Shape.** Views kept up to date as events arrive (or cached by the last event's id), measured before and after. Exports that stream. Retention for what control only copies, as the owner decides ([Q12](#7-the-owners-questions)); the research record on the rig stays whole.
- **Size.** About 15 files in control, the harness and the supervisor.
- **Depends on.** T1 (typed events), T6.
- **Check.** A measurement at 100,000 and 1,000,000 events before and after; the fast checks.

### T13. Dead and transition code

- **What and why.** CONVENTIONS.md's Dead code and loose ends.
- **Where.**
  - Production code kept alive only by its tests: `usageLimitRetry` (`harness/agents/model.ts`), `gapPlan` (`harness/research/shares.ts`, a copy of a loop the scheduler writes itself), `JudgeOptions.promotion`, `POST /v1/export`, `setFamilyStatus`.
  - The research `search` tool always refuses, and writes a table nobody reads (goal 046 decided web search comes from MCP servers).
  - `scripts/stage-smoke.mjs` is called by nothing; CI still starts heavy jobs when it changes.
  - Transition code from before v0.1.0: `THERMITE_CONTROL_UNIT_TOKENS_FILE` (declared, never read), `THERMITE_UNIT_ID`, the CLI flags `--instance`, `--unit` and `--direction`, the reader for commands signed before 2026-10-15, about 260 lines of control migrations, and `scripts/dev-init.mjs`, which copies `cli/local-init.ts` "so it needs no build" although Node now runs the TypeScript.
  - `core/duration.ts` calls a time unit `RIG_MS`, left by a blind rename of "unit" to "rig".
  - 6 exports nothing uses, and 564 exports used only inside their own file.
- **Shape.** Remove what the owner agrees to ([Q6, Q7](#7-the-owners-questions)), each with the docs that name it. A small check in `npm run check` for unused exports and for paths that name no file.
- **Check.** The fast checks; the docs check.

### T14. Containers and CI

- **What and why.** One fact, one home; and checks that fail closed.
- **Where.**
  - The Containerfiles copy their build stage 3 times, and the OpenCode, Codex and Claude Code stages twice, with the versions in two files. The set-id sweep is written 4 times. The user ids are in the Containerfile and in `harness/broker/runner.ts`.
  - CI's heavy jobs start by path. The lists already miss part of the API code they say they cover, and each split in T8 widens the gap if the lists are not updated.
  - 13 of the 17 acceptance scripts never run in CI, not even for a tag.
- **Shape.** The shared stages once, with each pinned version in one place. CI's path lists by folder (`^src/control/api/`), not by file. The owner decides which acceptance checks run on tags ([Q20](#7-the-owners-questions)).
- **Check.** The rig image, compose smoke and quick-start acceptance checks; a dry run of the release workflow.

### Operations

The operations reviewer's findings that are bugs are in goals [164](goals/_completed/164-settings-that-fail-loudly.goal) and [165](goals/_completed/165-results-kept-through-remove-and-reset.goal). The ones that need the owner's choice first are questions [Q12–Q15](#7-the-owners-questions): backups and a copy of each database before a migration, retention, the remove guard, and health checks that test something. Today the health routes always answer `ok`, and no deployment has a healthcheck or a probe.

### Where the tests went

Goal 160 moved them, so goal 125 does not. `tests/<part>/` mirrors `src/<part>/`; the helpers, fakes and stand-ins written in TypeScript are in `tests/helpers/`, and the test of the docs' own steps in `tests/docs/`. `scripts/test.mjs` reads `tests/`, runs `tests/harness/judge/` and `tests/harness/broker/` alone, and stops if it finds a test file in `src/`. A split or move of a source file moves its tests to the matching folder in the same commit. Still open: where tests that wire several parts go ([Q18](#7-the-owners-questions)), and where the container stand-ins go ([Q19](#7-the-owners-questions)).

## 3. The rules of shape

Apply these the same way in every step. The ones marked **new** are additions to CONVENTIONS.md. The owner accepted them on 2026-10-26 ("these look mostly good"). Goal 125 adds them first, in a commit the owner reviews, so every later step follows them.

1. **New: the parts and the way they import.** `core` holds contracts: schemas, words, limits, signing and protocols, and does no I/O beyond `node:crypto`. `common` holds runtime tools: settings, logs, errors, files, git, subprocesses, HTTP. The parts (`harness`, `supervisor`, `control`, `cli`, `release`) import `core` and `common`, never each other; code two parts need goes to `core`, to `common`, or to a shared folder named for what it is. Domain modules never import page code (`control/ui/`). Tests and scripts may import any part; production code never imports them. A check in `npm run check` enforces it, with today's exceptions named until they are gone.
2. **New: a wire contract has one home.** Every body that crosses a process boundary (a route, a signed command, an event, a file one container hands to another, an environment variable) has one schema in `core`. Route paths and limits are named constants beside it.
3. **New: event kinds are constants with schemas.** A new kind is added to `core/events/` with its body's schema, and `appendEvent` takes it typed. A rename that must keep older data readable maps the old name in `core/names.ts`; v0.1.1 keeps none for v0.1.0's data ([Q7](#7-the-owners-questions)).
4. **New: one name map.** Where a public name differs from a stored or wire name, the mapping lives in `core/names.ts` or in the module that owns the word, never in a caller.
5. **New: shared tools live in `common`.** Use its helper for error text, atomic writes, git, subprocesses, HTTP, secret comparison and loops that repeat. A program that must import nothing of Thermite's says so in its header, and only it keeps its own copy.
6. **New: errors.** A small set of typed errors in `common/errors.ts`. Each API maps errors to statuses in one function. A refused input is answered in the same words by REST, MCP and the command line.
7. **New: settings.** Each part reads its environment in one module, from one table of name, default, unit, bounds and the meaning of 0 or empty. A bad value stops the part at start, with the reason.
8. **New: timeouts.** Every outbound call (HTTP, git, SSH, kubectl, a subprocess) has a named timeout, set in its client module, which says what happens when it is reached.
9. **New: files that name other files.** A source file that names another by path keeps the path in one named constant, so a move changes one line.
10. **Tests** (in CONVENTIONS.md since goal 160). `tests/<part>/` mirrors `src/<part>/`. **New:** shared scaffolding goes in `tests/helpers/`. (Where tests that wire two or more parts go is [Q18](#7-the-owners-questions).)
11. **New: scripts reach the code one way:** they import `src/**/*.ts`, never `dist/`.
12. **New: file names.** An entry program is its folder's `main.ts` or ends in `-main.ts`. Two files in different parts with the same name and different jobs get folders that say which (today: `research-tools.ts` in the harness and the supervisor; `rig-settings.ts` in control and the harness; four `usage.ts`).
13. **The existing rules hold through every step:** file sizes, folders with an `index.ts`, no repeated knowledge, no default caps on a run's turns, trials, time or spending.

### Paths that name files

A move or a split updates each of these in the same commit:

- `.github/workflows/ci.yml`: the heavy jobs' path lists and the `run:` lines; `.github/workflows/release.yml`: its `paths`.
- `.gitleaks.toml`: the allowlists' paths. Keep each old path beside the new one, since the scan reads the whole history.
- `package.json` scripts; `tsconfig.json`, `tsconfig.build.json` and `biome.json`; `scripts/test.mjs` (its folder and the judge's and broker's prefix).
- The Containerfiles (`COPY` lines and the entry points they start), and the wrappers `containers/thermite` and `containers/thermite-trial`, which name built files in `dist/`.
- Source files that name built files: `harness/broker.ts`, `harness/agents/spawn.ts`, `harness/main.ts`, `control/runpod-probe.ts`; and `cli/local-init.ts`, which names `scripts/dev-init.mjs`.
- Scripts that name other files: `scripts/rig-image-acceptance.mjs` (built files), the acceptance scripts and compose override files that name the stand-ins in `containers/test-*`.
- The docs: [AGENTS.md](../../AGENTS.md)'s checks, [CONVENTIONS.md](../../CONVENTIONS.md), [CREDITS.md](../../CREDITS.md) (then `npm run docs:credits`), `docs/local-development.md`, `docs/writing-docs.md`, and the site's Contributing and Compatibility pages. `scripts/docs-check.mjs` reads `src/`, `containers/`, `scripts/` and the compose files.
- The open goals that name the file. Completed goals keep the paths they had, as records.

## 4. The order of work

Each line is a set of small steps, each one green on its own.

1. **The size check and the rules of shape:** the size check, as goal 125's step 2 asks, so nothing gets worse while the rest goes on; and the accepted rules of shape added to CONVENTIONS.md, so every later step follows them.
2. **The bugs, each with a regression test,** so the splits after them are pure moves: goals [161](goals/_completed/161-control-bugs-from-the-audit.goal), [162](goals/_completed/162-research-and-knowledge-bugs.goal), [163](goals/_completed/163-harness-bugs-from-the-audit.goal), [164](goals/_completed/164-settings-that-fail-loudly.goal) and [165](goals/_completed/165-results-kept-through-remove-and-reset.goal).
3. **The shared homes, small and with little churn:** T1's words, T3's toolkit, then T4's settings, errors and logger.
4. **The test scaffolding** (T10), before control's splits.
5. **The contracts and clients** (T2), the domain modules out of the dashboard (T5), the ledger's owners and one promotion (T6), and the table of agent programs (T7).
6. **The splits** (T8), the largest and most-changed first: `control/dashboard.ts`, `harness/service.ts`, `harness/agents/scheduler.ts`, `harness/main.ts`, `supervisor/advisors.ts` with `advise.ts`, `control/mcp.ts`, `control/api.ts`, `harness/api.ts`, `control/views.ts` (after its golden test), `control/ui/`, `harness/research/`, `harness/judge/judge.ts`, `harness/ledger.ts`, `harness/broker.ts`, and `control/store.ts` last.
7. **The folder moves** (T9), each with its `index.ts` and every path that names it, then the moves out of the harness that the owner agrees to (Q1, Q2).
8. **Knowledge** (T11), **growth** (T12), **dead code** (T13) and **containers and CI** (T14), as the owner answers their questions. T12's measurement can start at any time.

The busy files (`harness/service.ts`, the scheduler, `control/store.ts`, `harness/main.ts`, `supervisor/advisors.ts`) change in other goals too. Split each one when no other open branch changes it. The quiet areas (`harness/targets/`, `harness/v0.ts`, `harness/imports.ts`, `harness/git.ts`) can wait.

## 5. What to leave

These look wrong, but have a reason. Keep them.

- **Old ledgers and databases are kept, never deleted** (invariant 3), even when v0.1.1 can no longer read them ([Q7](#7-the-owners-questions)). The names that goal 074 kept on the wire for v0.1.0 (`combiner` and `panel`) change to the public ones in v0.1.1 ([Q11](#7-the-owners-questions)).
- **Two checks of every signed command,** in control and in the harness. The harness must check commands itself. Share the table, keep both checks.
- **Pull mode's allow-list of rig routes** (`control/tunnel.ts`). It repeats the routes on purpose: what it does not list, it refuses. Add a test that the two agree.
- **Programs that import nothing of Thermite's:** `harness/agents/opencode-plugin.ts` and the compaction hook (they run inside another program, alone), the two smoke kits' `check.mjs` (a kit is a repository of its own), and the stand-ins in `containers/test-*` (they run inside images).
- **The dashboard's browser scripts as strings.** The browser gets them as text and they can't import modules. Inject server constants with `JSON.stringify`, as `ui/copy-campaign-client.ts` does, and add a lint and a parse test ([Q10](#7-the-owners-questions)).
- **The REST and MCP twins** (`xxxFields`, `XxxBody`, `xxxRequest`, `xxxAnswer` in `start-run.ts`, `rig-model.ts`, `rig-settings.ts`, `copy-campaign.ts`, `cluster-resources.ts`) and `RUN_DETAIL_INPUT`, one schema shared by REST and MCP. They are the model; extend them to the dashboard's forms.
- **`prepareCommand`** (`control/issue.ts`): one path that checks every command the same way. It is the template for T5.
- **The ledger's interface:** each write appends its event in the same transaction, leases are fenced, promotion is compare-and-swap. Split the file, keep the interface. One synchronous connection with savepoints is safe because no transaction body awaits.
- **The append-only triggers and the refusal of a newer ledger.** They enforce "Nothing is destroyed" in the database.
- **Events written for people, not code** (`measurement`, `receipt`, `goal_check`, `research_query`): they are the evidence of record.
- **`Ledger.invalidate()`** is unused but documented as not wired yet, and invariant 3 needs it. The owner decides ([Q25](#7-the-owners-questions)); don't remove it in a clean-up.
- **The knowledge base is built only from the rigs' signed events,** and the research folder is a projection of the ledger. Change where bulk text is stored, not where it comes from.
- **Lane files and kept conversations have a saved copy and a shown copy:** one lane must not change what another lane sees.
- **The brief windows** (10, 5 and 20 notes) are display windows, not limits on writing.
- **Signed and hashed fields** (the run's `direction`, the contract's `notes`) change their names only with a version that breaks compatibility, since a rename changes old commands and contracts. v0.1.1 is one ([Q7, Q11](#7-the-owners-questions)).
- **New optional contract fields get no default,** so older contracts keep their hash.
- **The release bundle's copy of `compose.yaml`,** checked against it by `templateDrift()`. It is the model for other generated copies.
- **`src/release/` with thin scripts:** the logic is in tested modules, and `scripts/release-bundle.ts` and `check-images.ts` only call it. The acceptance scripts should take this shape.
- **The supervisor's `git-export.ts`** commits without a checkout and keeps history a fast-forward.
- **`chatgpt.ts`'s own sign-in flow** (OpenAI's flow needs parameters the SDK's helpers don't take), **`tar-gz.ts`** (the standard library has no tar writer), and `node:http` in place of `fetch` in `api-call.ts` and `model-forward.ts` (it avoids undici's 300-second header timeout).
- **The real differences between the agent programs:** their config formats, event schemas, usage reports, compaction, sign-ins, and which ones run research trials.
- **The broker's process runner** apart from `common/exec`: it enforces the isolation limits, a different job from running git.
- **The broker restarting the controller and the supervisor** with a backoff, and the 60-second hold before a fatal exit in the one-container image (it keeps the error in the pod's log).
- **`scripts/patch-pi-ai.mjs`:** it patches one pinned version and stops the install on any other.
- **A release builds every layer with no cache,** on bases pinned by digest. With the upgrade of the base's system packages that each image makes when it is built (goal 125), every package gets its distribution's fixes.
- **The time bounds on set-up waits** (10 and 60 minutes), `FAILING_STOP_MS`, the progress rule and `MCP_WAIT_MS`: product rules and pacing, not caps on research.
- **Paths from tests to the repository's root:** they stayed right after the move, because a test sits at the same depth as its code did.
- **The judge's and the broker's tests run alone,** by folder. Some of them time nothing, but a rule by folder is simple.
- **The tests that drive the harness and control through `createHarnessApi` and `createControlApi`:** they are the cut-point tests CONVENTIONS asks for. Keep them through every split.

## 6. The review guide

A reviewer checks each step of goal 125 for these:

- **Behaviour stays the same,** unless the fix is the point, and then the goal and the changelog say so.
- **No test is weakened.** The number of tests stays the same or grows. A test is changed only to follow a moved or renamed interface. A removed test says why, in the commit.
- **A bug fix has a regression test** that fails without the fix.
- **A split is a move.** The moved code is the same, apart from imports; a change of logic goes in a commit of its own.
- **One step, one finding,** or one part of a file. A reviewer can read it at one sitting.
- **The conventions hold** in the new code: sizes, folders with an `index.ts`, no repeated knowledge, the rules of shape that the owner accepted.
- **Every path that names a moved file is updated** ([the list](#paths-that-name-files)), and `git grep` for the old path prints only completed goals and the changelog.
- **The docs follow:** a changed setting, message, route, limit or screen updates its pages in the same commit; `npm run docs:build` and `npm run docs:check` pass.
- **The checks ran:** the fast checks, and each acceptance check of AGENTS.md that the change needs. The commit or the goal says which ran.
- **Nothing private:** no host, address, account or secret in a file or a commit message, and no security finding anywhere public.

## 7. The owner's questions

The owner answered these on 2026-10-26. Every recommendation below is accepted, except those of questions 7 and 11, where the owner's answer is given. Goal 125 records the answers as decisions. The reports hold more questions, about details inside one area.

**Where code lives**

1. **The shared agent runtimes.** The workers and the supervisor's advisors share the code in `harness/agents/` (the CLI adapters, the model client, the MCP tools). Where does it live?
   - **Recommended:** a part of its own, `src/agents/`, that the harness and the supervisor both import.
   - **Why:** the supervisor then imports code that is meant to be shared, not the harness's internals, and the import rule (question 3) has no exception.
   - **Instead:** `src/common/agents/`; or keep it in the harness, with an `index.ts` that the supervisor may import as a named exception.
2. **The contract words.** Move the kit schema, the held-out words, the goal values, the research words and limits, the model-route names and the rig settings schema from the harness to `core`?
   - **Recommended:** yes.
   - **Why:** control and the supervisor already import them from the harness. In `core`, each has one home that every part imports.
   - **Instead:** leave them in the harness, and accept the imports from control and the supervisor.
3. **How the import rule is enforced.**
   - **Recommended:** a short script in `npm run check` that fails, with today's exceptions listed by file until each one is gone.
   - **Why:** it needs no new dependency, a new exception fails at once, and the list shows what is left to move.
   - **Instead:** a Biome `noRestrictedImports` rule; or a warning first and a failure later.
4. **May `core` read files?** `core/version.ts` reads `package.json`; nothing else in `core` does I/O.
   - **Recommended:** no. The read of `package.json` moves to `common`, and `core` keeps the version comparison.
   - **Why:** a rule with no exception is easier to keep, and `core` stays safe to import anywhere.
   - **Instead:** keep `core/version.ts` as the one named exception.
5. **Event schemas.** Check the typed event bodies only when the code compiles, or also when control takes in a rig's events?
   - **Recommended:** at compile time first. Check at control's intake later, once every rig in use writes the typed bodies.
   - **Why:** types cost nothing at run time and change no behaviour. A check at intake could refuse an older rig's events.
   - **Instead:** check at intake from the start, with the old bodies allowed.

**Old names and old data**

6. **Names from before v0.1.0.** Remove `THERMITE_UNIT_ID`, `THERMITE_CONTROL_UNIT_TOKENS_FILE`, the CLI flags `--instance`, `--unit` and `--direction`, and the reader for commands signed before 2026-10-15?
   - **Recommended:** yes, in v0.1.1, with a line in the changelog. First check that none of your own rigs still sets them.
   - **Why:** no public release used them. Every command signed before 2026-10-15 expired by 2026-10-22.
   - **Instead:** keep them until v0.2.0.
7. **How long older data and older parts are supported.** This decides which of these can go: control's migrations of databases from before v0.1.0 (about 260 lines), the harness's 32 branches for older ledgers and supervisors, and the supervisor's paths for an older harness.
   - **Owner's answer:** break compatibility. v0.1.1 doesn't have to read data that v0.1.0 wrote, or work with v0.1.0's parts, so all of the code above can go, the reading of old names in `core/names.ts` included. A ledger or database that v0.1.1 can't read is kept, never deleted (invariant 3), and the changelog says what an upgrade needs.
   - **Why:** v0.1.1 is a large refactor, and its breaking changes are expected. In the owner's words: "its ok to say v0.1.0 things don't work in v0.1.1".
   - **Recommended, not taken:** read data from v0.1.0 on, and work with parts of the release before.
8. **`ControlActions`.** May REST, MCP and the dashboard all call domain modules directly?
   - **Recommended:** yes.
   - **Why:** the business logic leaves the HTML layer, no caller has to handle a missing slot, and it is the first step of the dashboard's split. It reverses the design written in `control/actions.ts`.
   - **Instead:** keep `ControlActions`, filled by a composition root in place of the dashboard.
9. **Control's store.** Split it into sub-stores (`store.machines.get(...)`) or keep one class that hands each call on to a module?
   - **Recommended:** sub-stores.
   - **Why:** each domain gets a module with its own interface. One class that only hands calls on is a pass-through layer, which CONVENTIONS.md warns against. The cost is many call sites (54 production importers), each a mechanical change.
   - **Instead:** one class that delegates, with fewer call sites changed.
10. **The dashboard's browser scripts.**
    - **Recommended:** keep them as strings in the page modules. Add a lint and a parse test, and inject server constants with `JSON.stringify`.
    - **Why:** no build step is added, and the dashboard stays HTML from the server with small client scripts, as CONVENTIONS.md asks.
    - **Instead:** real `.js` files, which Biome and the typecheck read as they are, copied by the build.
11. **Internal names that differ from public ones** (`family` and `direction`, `combiner` and `merged_by`, `panel` and `review_panel`).
    - **Owner's answer:** rename to the public names everywhere, in v0.1.1: the code, the APIs, the stored names and the wire names. The APIs take only the new names. No wait for v0.2.0.
    - **Why:** one thing has one name, and v0.1.1 breaks compatibility anyway (question 7). In the owner's words: "Do what is needed."
    - **Recommended, not taken:** public names in the APIs only, with the stored and wire names kept and mapped.

**Data and operations**

12. **Retention on control.** Control keeps everything it copies or derives (each `model_call` body twice, an audit row for every MCP read, every export with its daily ledger copies).
    - **Recommended:** first show the space each kind uses, on a page and in `/metrics`. Then add pruning of what control only copies or derives, as settings that are off until you set them. The rigs' ledgers and the results repository are never pruned.
    - **Why:** nothing is destroyed by default, and you see the growth before you choose a limit.
    - **Instead:** keep everything and only show the space; or prune by default.
    - **The daily ledger copy in the results repository.** Recommended: keep it daily, compressed, and pushed apart from the attempts, so a large file can't block the push of attempts. Instead: weekly, or only with a full export.
    - **The judge's build store.** Recommended: let the judge remove old builds, keeping the champions' and the newest few for each lane, with the number as a setting. Each candidate's commit is kept, so any build can be made again. Instead: keep every build.
13. **Backups.**
    - **Recommended:** a copy of the ledger and of `control.db` before every migration, by default. A `thermite backup` and `restore` for control's state, with a page that says how to back up a rig.
    - **Why:** today an update that migrates can't be undone. The copy costs the disk of one database.
    - **Instead:** a page with the container engine's own commands, and no copy before a migration.
14. **Removing a rig whose results have not left.**
    - **Recommended:** refuse the remove until the results have left, as a RunPod terminate does. A typed `discard <rig>` goes on for a rig whose results can't leave, such as one with a broken supervisor, and the audit log records it.
    - **Why:** design invariant 3, "Nothing is destroyed". The override covers the rig that can't send.
    - **Instead:** keep the typed confirmation only, with a warning.
15. **Health checks and alerts.**
    - **Recommended:** health routes that check what each part needs (its database, its peer, the age of its last report) and a probe in every deployment (compose, the release bundle, Quadlet, Kubernetes). For alerts, `/metrics` and Needs you are enough in v0.1.x.
    - **Why:** a probe lets the container engine restart a stuck part. A researcher already watches Needs you.
    - **Instead:** also push alerts from control, by a webhook or e-mail through a provider you give.
16. **Log levels.**
    - **Recommended:** `info` by default. A rig's parts change level by a signed command from control, and control by a setting on its own Settings page. Logs go to a table in `control.db`, searched with SQLite's FTS5 (goal [028](goals/028-log-store.goal)); an OpenTelemetry collector later, if asked.
    - **Why:** Thermite is run through control, so the level changes there like everything else. SQLite already has FTS5, so logs need no new service.
    - **Instead:** a file in each part's state folder that the part reads again, or a signal.
17. **Node.js 24.**
    - **Recommended:** move the images to Node 24 in v0.1.2.
    - **Why:** CI already tests 24, and Node 22's maintenance ends on 2027-04-30. After the clean-up, a failure from the move isn't mixed with the refactoring.
    - **Instead:** in v0.1.1, with the clean-up.

**Tests, scripts and builds**

18. **Tests that wire several parts** (58 of 229 test files).
    - **Recommended:** `tests/system/`. Tests of control's pages that are named for a feature go to `tests/control/dashboard/`.
    - **Why:** under "mirror `src/`", a test of two parts lands under one of them by chance. In one folder, a reader finds them all.
    - **Instead:** each under the part it mostly tests.
19. **The container stand-ins and the acceptance scripts.**
    - **Recommended:** the stand-ins move to `tests/stand-ins/<name>/`. The acceptance scripts get `// @ts-check` now and become TypeScript when each is split. Each acceptance check gets an npm script, `acceptance:<name>`.
    - **Why:** CONVENTIONS.md puts stand-ins in `tests/`. `// @ts-check` brings the typecheck with no rename. With one npm script for each, `npm run` lists them all, where today 2 of 17 have one.
    - **Instead:** stand-ins to `containers/test/<name>/`; TypeScript at once; no npm scripts.
20. **Acceptance checks on version tags.**
    - **Recommended:** CI runs the judge's adversarial set and every acceptance check its runners can run on each version tag.
    - **Why:** 13 of the 17 never run in CI, so a release rests on runs by hand. Tags are rare, so the runner time is small.
    - **Instead:** keep them by hand, recorded in the release goal.
21. **The Containerfiles.**
    - **Recommended:** one Containerfile, with a target for each image (`control`, `harness`, `supervisor`, `rig`), shared build and program stages, and each pinned version given once.
    - **Why:** it removes the copies instead of checking them.
    - **Instead:** keep four files, and add a check that their pinned versions match.
22. **Goal numbers in code comments** (185 in the supervisor, 70 in `core`).
    - **Recommended:** keep the reason in words. Keep a goal number only where the sentence needs it, as in "decided in goal 074".
    - **Why:** a number alone doesn't tell the reader why, and the commits already name their goals.
    - **Instead:** keep every number, for tracing.

**Knowledge and research**

23. **One word for each meaning,** and more kinds in the knowledge base.
    - **Recommended words:** a field note stays a "field note", and its kind `note` becomes `other`; a research note becomes a "source note"; the directive kind `note` becomes `planner_note`; "knowledge base" names the store and "past research" what a run receives; "document" (kind `doc`) for every lane file; "direction" in place of "family". The KB's folders become "collections" (the owner's choice), so they don't share a name with the dashboard's campaign folders. The contract's `notes` and the signed `direction` field take their new names in v0.1.1 too (question 11).
    - **Recommended kinds:** the paper and each answer card become items of their own, and the review panel's decisions. Rules, directions and refuted approaches later.
    - **Why:** one thing has one name. The paper and the answer cards are what a research run makes, and today the knowledge base keeps the paper's first 20,000 characters and nothing after them.
    - **Instead:** choose other words; or keep the kinds as they are, with a note where text is cut.
24. **Two ways to do one job.**
    - **Recommended:** remove the research `search` tool, which always refuses, and drop the contract's `search_policy` at the next contract version. Retire the advisors file's `kb` in favour of MCP servers that a kit names.
    - **Why:** web search comes from MCP servers (goal 046), and an outside knowledge base reaches the agents through MCP servers too (goal 068).
    - **Instead:** keep both, with the tool's refusal saying where search is.
25. **`Ledger.invalidate()`.**
    - **Recommended:** wire it to an owner's command, "invalidate this evidence", with its propagation, in a goal of its own.
    - **Why:** design invariant 3 says bad evidence is invalidated, never deleted. The code exists and is tested; only a way to start it is missing.
    - **Instead:** remove it, with the states nothing sets (goal 061).
26. **Signals through the event table.** The service asks the scheduler to stop a trial or reset a run by writing an event, which the scheduler polls every second.
    - **Recommended:** keep writing the events, and also call the scheduler directly through a small interface (`onStopAsked`, `onReset`).
    - **Why:** the events stay the record, and the flow of one feature stays in one place instead of crossing files by an event name in a string.
    - **Instead:** keep the polling. It also keeps the service from depending on the scheduler.

## 8. Part 2: lanes 9 to 13 (goals 166 to 171)

After the owner answered section 7, they asked for four more things, and then for the hierarchy to be checked. Five more reviewers looked at them; their reports are in `.internal/reviews/v0.1.1-audit/` (lanes 9 to 13), and each public goal holds what its review found, the design it proposes and the owner's questions.

| Goal | What | What it changes in this guide |
| --- | --- | --- |
| [166](goals/_completed/166-agent-definitions.goal) | One definition for each agent role in `src/agents/roles/`, with a pure `render` for a run's prompt, a table of tools, and every prompt sent recorded | T7 grows: the table of agent programs sits beside the roles and the tools. T1 gains the role names. |
| [167](goals/_completed/167-how-the-parts-talk.goal) | A review of every channel: 45 channels, 35 polling loops, the delay each adds | Its explanation page, [How the parts talk](../_site/src/content/docs/explanation/how-the-parts-talk.md), is written. Its findings feed T2 and goal 168. |
| [168](goals/168-message-bus.goal) | The message bus: NATS JetStream as the event log, the delivery and the queues between control, the rigs' supervisors and the dashboard, chosen by the owner on 2026-10-26; the harness and the agents stay off it, bridged by the supervisor | T2 becomes the link's contract in `core/link/` (subjects, schemas, limits, signers). T12's views kept up to date are JetStream consumers. |
| [169](goals/169-agents-in-their-terminal.goal) | Workers in their program's own terminal UI, session logs as events, steering inside a turn | Comes after goal 166 and T7's one trial loop; its terminal mode is a field of each program's entry. |
| [170](goals/170-one-hierarchy.goal) | One hierarchy: run IDs unique across rigs, a run registry on control, views and addresses by run (`/ui/runs/<run>/attempts/<attempt>`), the run on every event | A new theme, T15. Its rule of shape: a thing is addressed through what owns it; where it ran is an attribute. |
| [171](goals/_completed/171-bugs-on-the-wire.goal) | Bugs on the wire: a lost long reply, a command sent again in full, a live view stopped by one line, a prompt too long for one argument | Joins goals 161 to 165 in step 2 of the order of work. |

**The order of work, with part 2:**

1. The size check and the rules of shape, with T15's rule.
2. The bugs: goals 161 to 165, 171, and goal 170's run IDs and a run's export with its verdicts.
3. The shared homes: T1 (with the role names and `core/ids.ts`), T3 and T4.
4. The test scaffolding (T10), and golden tests of every role's prompt (goal 166).
5. The link's contract in `core/link/` (T2) and the bus's first steps (goal 168: the compose spike, then commands), the domain modules out of the dashboard (T5), the ledger's owners (T6), the run on every event and the run registry (goal 170), and the table of agent programs with the roles and tools (T7, goal 166).
6. The splits (T8), with views by run and kept up to date (goals 168 and 170) when `control/views.ts` splits.
7. The folder moves (T9), and run-scoped addresses (goal 170).
8. The rest of the bus (goal 168: live lines and the dashboard's push, config and the knowledge base, queues, every placement), the record of prompts and their surfaces (goal 166), and the terminals (goal 169).
9. Knowledge (T11, with the knowledge base keyed by run), growth (T12), dead code (T13), containers and CI (T14).

The owner's questions for part 2 are in each goal; until they are answered, the goals keep the reviewers' recommendations as proposals.
