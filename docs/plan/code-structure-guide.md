# The code structure guide

This guide is for the work on the code's structure in v0.3.0, goals [244](goals/244-one-door.goal) and [254](goals/254-one-record.goal) to [257](goals/257-find-the-fault.goal). It is one result of goal [242](goals/_completed/242-v030-review.goal), the review of 2026-11-10. Its partner, the [UI refresh guide](ui-refresh-guide.md), covers the screens. The [release plan](release-v0.3.0.md) puts both in one order.

- **What it describes:** the code at v0.2.0 (branch `v0.3.0`, commit `e62f80cb`), two weeks after the clean-up of v0.1.1 ([guide](code-clean-up-guide.md), goal [125](goals/_completed/125-code-to-the-conventions.goal)).
- **What it answers:** the owner's questions of 2026-11-10: where the code has bloat, what makes a fault hard to find, and where adding a feature makes it easy to break something; and how to separate things so that it doesn't.
- **Where it comes from:** three reviewers on 2026-11-10 (control; the harness, the supervisor, the agents' code, `core` and `common`; how the dashboard is built), and counts over the history since 2026-10-28. Their reports, with every count and line number, are kept in the maintainers' private notes. A finding that concerns security is handled as [SECURITY.md](../../SECURITY.md) says, and is not written here.
- **What it is not:** a second clean-up of everything. The clean-up of v0.1.1 held. This guide names six changes of shape, in the places where the history shows the cost.
- **What is decided:** on 2026-11-10 the owner took the recommended answer to each of [the questions](#7-the-owners-questions), and accepted the goals of the six changes.

## 1. The state of the code

### What the clean-up fixed, and what held

Each of these was a finding of the audit of 2026-10-26. Each is still closed.

- **The parts import only `core`, `common` and `agents`.** One exception is recorded, in the command line. `core` does no I/O.
- **No file is over 800 lines.** 33 production files were.
- **No SQL outside the stores,** in control or in the harness. Promotion is one function in one transaction.
- **Events are typed where they are written:** 141 kinds, each with a body, and no cast at any of the 147 places that append one. Bus subjects are built in one folder.
- **Control keeps each rig's view up to date as events arrive.** It no longer builds a view from every event at each request.
- **No domain module imports page code,** and `ControlActions` is gone.
- **The test stack is written once.** A change to control's main constructor touches 1 test file, where it touched 67.
- **One loop runs a trial in a CLI program,** where there were three. A fix there now lands once.

### The code in numbers

| Part | Files | Lines | What it is |
| --- | --- | --- | --- |
| `src/control` | 457 | 87,032 | Of which the pages are 169 files and 33,769 lines |
| `src/harness` | 311 | 57,368 | |
| `src/agents` | 95 | 17,719 | The agent programs, shared by the harness and the supervisor |
| `src/core` | 90 | 17,256 | Contracts |
| `src/supervisor` | 95 | 15,709 | |
| `src/common`, `src/cli`, `src/release` | 74 | 10,201 | |
| `tests/` | 668 | 151,668 | |

The code is not growing fast: 191,104 lines at v0.1.1, 205,285 at v0.2.0. The cost is in how a change spreads.

### What a change touches

Measured over the commits since 2026-11-01 that touched `src/`.

| Measure | Number |
| --- | --- |
| Commits that touch two or more parts | 46% (44% at the audit, before the clean-up). 24% touch three or more |
| One commit, at the middle | 5 source files, 1 test file, 2 pages of the docs |
| One commit in ten | 15 source files or more |
| Control's commits that touch page code | 76% |
| A change to `control/rigs/` that also changes the pages | 94% |
| A change to `core/events/` that also changes the pages | 86% |
| A change to control's MCP tools that also changes the pages | 73% |

What five real features took:

| Feature | Files in its commit | Written by hand more than once |
| --- | --- | --- |
| One rig setting (how long the model check waits) | 27 | The setting is named in 10 source files and 18 places. Its range, 10 to 3600, is written three times in the code and three times in the docs |
| One command, with its API route, its MCP tool and its menu entry | 34 | The command's name goes into up to five lists in one file. Its size limit is written three times |
| A rule on a running run: two event kinds, a field, a block on the page | 38 | The body of each event is described three times: for its writer, for its reader, and again by casts in the code that reads it |
| How busy each runner is: a table, a view, a block, a route, a tool | 44 | Five test files changed only to turn the store's version from 35 into 36 |
| A fifth agent program, counted from where the fourth is named | About 35 files outside control and 17 in it | The program's name is written in 10 files |

A read-only field on a run is the cheap case: 12 files, 6 of them in control. A new field of a kit's contract is 3 to 5 files on the rig's side. The cost comes with a setting, a command, a screen or a program.

### What is not wrong

The reviewers looked for these and did not find them.

- **Dead code.** The check's list of 666 "loose ends" holds no dead code: nearly every entry is used in its own file, and only the word `export` is spare.
- **Copy-paste.** 38 repeated blocks of 7 lines in 113,000 lines outside control. What is repeated is jobs, not text ([finding 3](#2-the-findings)).
- **Errors dropped in silence.** No empty `catch` outside control lacks its reason.
- **Research mode as a tangle.** Its folder of 48 files is cohesive: 57 exports, 55 used, and it imports nothing of the scheduler or the judge.
- **Tests as a brake on features.** A commit to the rig's side changes 1 existing test file at the middle. The tests brake only where they read HTML or the store's tables ([finding 9](#2-the-findings)).

## 2. The findings

In the order of risk to a new feature times how often the code changes.

1. **An action lives in a front end.** Control has three front ends: REST, MCP and the dashboard.
   - Retire a rig is written three times, and the three already differ: REST takes a rig the other two refuse, and asks for no typed confirmation.
   - Start a full reset is the same four steps, written three times.
   - MCP's `get_run` gives a field that REST's read of the same run does not. Only MCP adds the briefing to an assignment.
   - Providers, Git access, machines, clusters, GPU clouds, a rig on a machine and a joined rig exist only as page routes of 150 to 636 lines: 71 writes to the store from page code, and no API.
   - A rule fixed in one front end stays wrong in the others.
2. **One feature's facts are written by hand in many files** ([the table above](#what-a-change-touches)).
   - Nothing says that a step was left out. A new event kind with no handler is just missing from the page.
   - 39% of the MCP folder's bytes are the tools' descriptions in prose. `issue_command`'s is one string of 7,154 characters, changed by 22 commits. The docs' MCP page, 1,762 lines, says it all again by hand, and no check compares the two.
3. **One behaviour is built once for each role, each program and each mode.**
   - Workers and the planner run an agent program through the harness's code. Advisors run the same programs through the supervisor's own code: its headless runs share no line with the harness's.
   - A Pi agent's session is set up at 5 places.
   - 5 of 6 sampled fixes to agent programs had to be made more than once: for another program, for the advisors after the workers, or for the terminal after headless. Where the clean-up made one module, later fixes landed once.
   - Hill climb and research are two copies of "start a trial" and "plan a round", 27% to 49% the same.
4. **A fault often leaves no record.**
   - Of 15 recent bug hunts, 8 had no log line and no event at the branch that failed. In 7, the first evidence was outside Thermite's own records: a program's files on the rig, an agent's notes, a container's output.
   - What fails in silence is work that never starts: a message a terminal never took, a judge's job never leased, a reply lost when a link dropped.
   - About 300 log lines cover 101,000 lines of the rig's code, and 133 cover control's 87,000. Every line of control says `control` and no more. A third of the rig's lines carry an ID. Eight of control's folders log nothing, the Kubernetes and machine work among them.
   - 31 named waits, in 12 files, sit on the path that types into a program's terminal. Nothing holds an outer wait longer than the one inside it.
5. **What control reads of events is untyped, and each front end builds its own answers.**
   - A handler takes a body of unknown fields: 181 casts by hand, after a schema already checked the body.
   - No test asks a new event kind for its handler or its sentence.
   - A run's and a rig's views are the shape of two API answers with no schema, so a rename inside the view changes the API and no check sees it.
   - A fact derived in each place it is shown drifts: a rig's "is it alive" is three facts, read at 41 places. Three of five traced "wrong state on a page" faults were of this kind.
6. **The parts have no layers inside.**
   - 113 of the harness's 311 files are one import cycle. Its service is 86 public methods, 43 of them one line that hands the whole service on, and 17 fields that other files set after it is made.
   - 14 of control's 22 folders are one import cycle, and its top level is 32 files with about 20 jobs.
   - The supervisor's `main` is one function of 681 lines; control's is 395.
   - Control hands code what it needs in three ways at once: five bags of options (125 fields, 35 repeated), nine registries found through the store, and readers with default settings. A miss gives "empty", not an error.
7. **The size limit is met by squeezing.** 7 of the most-changed files sit at 780 to 800 lines. Three commits moved code out inside a feature because "the file was at its 800 lines", into files named for what fitted (`body-parts`, `queue-tries`). Each was back at the limit within days.
8. **Two contracts have no schema, and "refused" is said five ways.**
   - The summary that rides with every report of a rig is built by hand on one side and read by hand on the other. It is the contract that grows most.
   - 15 routes between an agent's process and the harness are strings on both sides.
   - A domain function says "refused" by a returned error, by two shapes of result, by a typed error or by a plain one. So REST maps each by hand, and in 8 places picks the status by the error's English words. MCP records every refusal; REST only where a route does it itself.
9. **Tests that read HTML or the store's tables.** 105 test files hold dashboard HTML, and 60 run SQL on control's store. Many test a behaviour through a page because the page is its only door.
10. **Where a rig runs has no home.** 15 files find it by looking in two or three stores. Restart goes four ways.

## 3. The six changes

Each has its goal. Sizes are in files. "The fast checks" means `npm run check`.

### S1. The screens leave control

- **What and why.** Page code is 38.8% of control and in 76% of its commits. With the [UI refresh](ui-refresh-guide.md#3-how-thermite-uses-it-two-designs), the screens become a web app that knows control only through its API.
- **Shape.** `web/` beside `src/`, importing `core`'s contracts alone. `src/control/ui/` and `src/control/dashboard/` go at the end.
- **Goals.** [243](goals/_completed/243-web-app-base.goal) to [253](goals/253-the-switch.goal).

### S2. One door for each action and each read

- **What and why.** Findings 1, 5, 8 and 9. An action is written once, where its rule lives. A front end reads the request, calls it and gives the answer.
- **Where.** `src/control/api/`, `src/control/mcp/`, the page routes, and the domain folders that gain the operations.
- **Shape.**
  - **An action is one function in its domain folder,** with its request and its answer as schemas in `core`. The clean-up's own pattern is the model: `setRigSettings` and `startARun` are called by all three front ends today, and 15 answers are shared by REST and MCP.
  - **An action has one entry** that names its REST route, its MCP tool, who may call it and its short description. REST and MCP are registered from the entries. A test holds that every entry has both, and which token gets which tool.
  - **An answer is built once.** One function gives a run's answer and one gives the rigs', for REST, MCP and the app, each with a schema in `core`. A fact that is derived, such as a rig's state, is derived in one place.
  - **Words come with the answer.** The modules that turn a state, a verdict or an event into a sentence move out of page code. REST, MCP and the app give the same words.
  - **What needs the owner is data.** Today it exists only as HTML.
  - **One way to refuse:** typed errors, and one mapping to statuses, held by a table of today's statuses so that no status changes by accident.
- **Size.** About 6 files for the actions that already differ. About 15 for Settings and for rigs on machines. About 12 route files lose their mapping of errors. The rest goes area by area, with each area of the UI.
- **Depends on.** Nothing. Each area of the UI depends on it.
- **Risks.** The dashboard's tests assert words: move first, change no sentence. A status that changes breaks a script.
- **Check.** The fast checks; the control acceptance check; each action's tests at the API.
- **Goal.** [244](goals/244-one-door.goal), which takes in what is left of goal [029](goals/029-api-mcp-coverage.goal).

### S3. One record for each thing a feature adds

- **What and why.** Finding 2. "Don't repeat knowledge": a setting, a command and an event kind are each written once, and the lists, the limits and the descriptions are worked out from that.
- **Where.** `src/core/`, and each place that copies from it today.
- **Shape.**
  - **A rig setting** is one entry: its schema with its range, its default, its label and hint, who may change it, whether it restarts the rig. The command's payload, the harness's defaults, control's request, the reader of a rig's report, the form's range and the MCP description read the entry.
  - **A command** is one record: its payload, who may issue it, whether it is the owner's alone, whether it is about one run, and one line of what it does. The five lists and `issue_command`'s description are worked out.
  - **An event kind's handler takes the body its schema parsed.** One test walks the kinds: each has a handler and a sentence, or is on a short list of kinds that have none on purpose.
  - **The two contracts with no schema get one:** the report's summary, and the agents' routes with one small typed client.
  - **Small tables where a word has a list today:** the agent programs (name, whether it is a CLI program, whether it runs research), the target drivers, the folders that two containers share.
  - **The docs' MCP page is made from the tools as registered,** as the Agent roles page is made, with a sentence by hand where one is wanted.
- **Size.** About 8 files for settings, 6 for commands, 14 for the handlers, 12 for the two contracts, 15 for the tables.
- **Depends on.** Nothing.
- **Risks.** A framework where a table would do: 14 settings and 29 command kinds are a table. Text that is worked out reads worse than text that is written: each record keeps a place for one sentence by hand, and a golden test holds each MCP description while its source moves.
- **Check.** The fast checks; the docs check; the control and steering acceptance checks where a wire value's source moves.
- **Goal.** [254](goals/254-one-record.goal).

### S4. One way to run an agent program

- **What and why.** Finding 3, and the path where most recent faults were. Each program's entry already holds what differs between programs, and the harness uses it well. The supervisor and Pi go around it.
- **Where.** `src/agents/`, `src/supervisor/advisors/`, `src/harness/agents/`.
- **Shape.**
  - **One maker of a Pi agent's session,** for its 5 places.
  - **The supervisor's headless runs go through each program's entry,** as its terminal runs already do. What an advisor needs differently (no tools, web tools, the answer's schema) is an option of the entry.
  - **The supervisor names a program by `core`'s word,** where today it has a second set of names.
  - **What a program's screen looks like is in its entry,** beside its start signal, not in the shared typing code.
  - **The waits on the typing path are one table,** each worked out from its neighbour, with a test of their order.
  - **One suite that every program must pass:** typed input taken once, a message left in the input, a compaction kept, a usage limit waited out, the owner's message inside a turn. On the stand-in in the fast checks, and on the real programs in the terminal acceptance check.
  - **Then one "start a trial" and one "plan a round"** that take the mode's parts.
- **Size.** About 6 files for Pi, 8 for the supervisor's runs, 6 for the names, 5 for the screens, 10 for the waits, 6 for the scheduler.
- **Depends on.** Nothing.
- **Risks.** The real differences between the programs stay: their settings, their events, their sign-ins. The differences that go are those between workers and advisors, and between headless and terminal.
- **Check.** The fast checks; the agents, Claude Code, Codex, terminal and steering acceptance checks.
- **Goal.** [255](goals/255-one-way-to-run-a-program.goal).

### S5. Layers inside the parts, and files split on purpose

- **What and why.** Findings 6, 7 and 10. The rule between the parts holds because a check holds it. Inside a part nothing holds an order, so each feature adds an edge.
- **Where.** `src/harness/`, `src/supervisor/main.ts`, `src/control/`, `scripts/checks/`.
- **Shape.**
  - **An order of folders inside the harness and inside control,** written in CONVENTIONS.md and held by `npm run check:imports`, with today's breaches listed and the list only shrinking, as the parts' rule was brought in. The harness's cycle of 113 files falls to 67 when the ledger's three imports of the judge go, and to 19 when the judge's import of the service and the top-level files' imports of the service and the agents go too.
  - **A thing is whole when it exists.** The harness's service takes its 17 late fields when it is made. Control is one object made by one function, which `main` and the test stack both call; the five bags and nine registries go, one in each step.
  - **The supervisor's `main` becomes a folder,** as the harness's did: what it reads of the environment once, its state files behind one small store, and one module for each loop.
  - **The files at the limit are split on purpose,** before the next feature, each into a folder named for it: the events' bodies, the commands, the queue, the judge's decision, the bus's client, control's schema.
  - **The size check warns at 700 lines,** so a split is planned, not squeezed into a feature.
  - **Where a rig runs is asked in one place.**
- **Size.** About 8 files and the check for the harness's order; about 8 for the service; 1 file becomes about 7 for the supervisor; about 60 for control's one object, mechanical; about 12 new files for the splits; 16 for "where a rig runs".
- **Depends on.** S2 for control's folders, so that each moves once.
- **Risks.** Moves that meet feature branches: each is done when its area is quiet, with every path that names a moved file ([the list](code-clean-up-guide.md#paths-that-name-files)).
- **Check.** The fast checks at every step; the acceptance checks of the area.
- **Goal.** [256](goals/256-layers-and-splits.goal), which takes in item 4 of goal [178](goals/178-clean-up-continued.goal).

### S6. Find the fault from Thermite's own records

- **What and why.** Finding 4. The owner's question, "what makes it hard to debug", has one main answer: the record is missing where work did not happen.
- **Where.** `src/common/log.ts`, `src/core/events/`, the loops of every part, the terminal path, control's front ends.
- **Shape.**
  - **A log line names its module and carries its IDs.** A logger is made for a module and bound to a run, a trial, a job or a command, so no call passes them by hand. An error keeps its cause.
  - **One ID for each request** to control, on every log line and audit entry it causes.
  - **Work that is overdue makes a record:** a message not taken, an ask not answered, a job not leased, a lease not renewed, a runner away and back, the bus down and up. One family of events, each with what waits, since when and its limit.
  - **A wait that gives up says which condition was unmet.**
  - **A decision that is weaker than it should be says so:** a verdict with no noise floor, a job whose result was dropped.
  - **Every loop is watched the same way,** and the health route shows each one's last round. A part that restarts says why, where control can read it.
  - **A rig's log lines reach control,** to be searched in one place: goals [028](goals/028-log-store.goal) and [027](goals/027-logs-page.goal).
- **Size.** 1 file for the logger, then each place as it is touched; about 8 writers of the new events; 3 files for the terminal's waits; about 15 of control's modules gain lines.
- **Depends on.** Nothing. The two log goals build on its logger.
- **Risks.** Volume, and a secret in a field: the logger's scrubber is already in the path.
- **Check.** The fast checks; for each kind of overdue work, a test that the record is written.
- **Goal.** [257](goals/257-find-the-fault.goal).

## 4. Rules of shape to add

Additions to CONVENTIONS.md. The first is there since 2026-11-10. Each goal adds its own, in a commit the owner reviews, as the clean-up did.

1. **The dashboard** is a web app that imports `core`'s contracts alone and holds no rule of the product. This replaces today's rule ([UI refresh guide](ui-refresh-guide.md#what-the-app-may-hold)).
2. **An action has one function.** A front end reads the request, calls it and gives the answer. It writes nothing to the store itself.
3. **An answer that leaves control has a schema in `core`.**
4. **A setting, a command and an event kind are each one record.** A list of them, a limit and a description are worked out, never written again.
5. **A part has an order of folders,** and `npm run check:imports` holds it.
6. **A thing is whole when it exists:** no field set later, nothing found through a key, no reader with settings of its own.
7. **A file is split before the limit,** into a folder named for it. The check warns at 700 lines.
8. **A wait that gives up says what it waited for. Work that is overdue makes a record.**
9. **A log line names its module and carries its IDs.**
10. **One way to refuse:** a typed error, mapped to a status in one place.
11. **What differs between agent programs is in each program's entry.** What they share is written once, for workers and advisors, headless and in a terminal.

## 5. The order of work

1. **The cheap guards, first.** They change no shape and stop new debt: the store's version as a constant; the test that walks the event kinds; the order of folders in the import check, with today's breaches listed; the size check's warning at 700 lines; the check of the docs' MCP page.
2. **The actions that already differ:** retire a rig, start a full reset, an assignment's preparation, one answer for a run and one for the rigs (goal 244).
3. **Two lanes, side by side:**
   - **Control, with the UI:** one door, area by area (goal 244), then the records (goal 254).
   - **The rig:** the records for a fault (goal 257), then one way to run a program (goal 255).
4. **Layers and splits** (goal 256), each when its area is quiet: the splits of the files at the limit early, control's one object after its actions have moved.

## 6. What to leave

Everything in [section 5 of the clean-up guide](code-clean-up-guide.md#5-what-to-leave) still stands. And these, which the review found in good shape:

- **The rule between the parts, and `core` with no I/O.**
- **The stores:** no SQL outside them, one transaction helper, ordered migrations with a copy of the database before each.
- **The ledger's interface:** a module for each table, an event in the same transaction as its write, one `promote`.
- **Events typed where they are written,** and the tie, checked when the code compiles, between what a writer gives and what control's views read.
- **The path of a signed command:** signed once, checked twice on purpose, delivered once, logged with its ID at every branch.
- **`prepareCommand`:** one path that checks every command.
- **The views control keeps,** and a fold that fails for one rig without failing the page.
- **Each program's entry, the one CLI trial loop and the shared terminal call.** They are extended, not replaced.
- **The research folder, the target drivers' interface, the broker, the supervisor's relay.**
- **The test stack, and the tests through the harness's and control's APIs.** They are what outlives each change above.
- **The loose-ends list.** Remove the spare `export` words (goal 178's item 2), and spend no more of v0.3.0 on it: it hides no dead code.
- **`store.db` in tests.** Making it private would change 60 test files for no gain. Stop adding to them.

## 7. The owner's questions

The owner answered these on 2026-11-10: every recommendation below is taken. The answers are goal 242's decisions.

1. **One entry for each action,** from which REST and MCP are registered ([S2](#s2-one-door-for-each-action-and-each-read)); or the pattern of today, a route and a tool written by hand that call one function.
   - **Recommended:** entries, for the actions that move out of page code and for new ones. The 48 pairs that exist move as they are touched.
   - **Why:** 42 actions need both written now, and nothing but an entry can make "every action has both, and this token gets these tools" a test.
   - **Instead:** by hand, with a test that compares the two lists.
2. **The size rule.** The limit of 800 lines stays, the check warns at 700, and the 7 files at the limit are split on purpose now.
   - **Recommended:** yes.
   - **Instead:** raise the limit. It would end the squeezing and keep the files with several jobs.
3. **An order of folders inside the harness and inside control,** held by the import check, with today's breaches listed.
   - **Recommended:** yes. The rule between the parts held for two weeks of fast work because a check holds it.
4. **Code for stores from v0.1.0.** About 680 lines of control exist to move a v0.1.0 store up. May v0.3.0 take data from v0.2.0 alone, so that an older control moves up through v0.2.x first?
   - **Recommended:** yes, said in the changelog. A store that v0.3.0 can't read is kept, never deleted.
   - **Instead:** keep the code.
5. **A rig's harness and supervisor are updated together** (the decision of 2026-10-31). 9 branches serve a harness or a supervisor older than its partner on the same rig. May they go, and does the same hold for a core and its runners?
   - **Recommended:** they go for a harness and its supervisor. A core and its runners keep theirs: they are on other machines and move at other times.
6. **A rig's log lines reach control in v0.3.0** (goals 028 and 027), as the other half of [S6](#s6-find-the-fault-from-thermites-own-records).
   - **Recommended:** yes, in a table of control's own store with SQLite's text search, as the clean-up guide's question 16 chose.
7. **The docs' MCP and REST reference pages are made from the code,** with a sentence by hand where one is wanted; or they stay written by hand, with a check that every tool and route on the page exists.
   - **Recommended:** made from the code. Both are written twice today, and nothing compares them.
