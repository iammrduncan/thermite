# Goal 258's design: a run owns its agents and its share of compute

**Status:** agreed by the owner on 2026-11-12, with the changes in section 6. Each step is a goal of its own. No code is written until the owner says start.

Goal [258](goals/258-runs-own-their-resources.goal) turns the order around: a run owns its agents, their models and its share of compute; machines are a pool; the agents' loops and the writing of code run in the control plane; a machine runs one light runner, which does only what needs the machine. The owner accepted it into v0.3.0 as the first work of the new app ([the app's build plan](app-build-plan.md)). This page is the written design the goal asks for: what was found, an answer to each of the goal's open questions, the order of the work, its cost, and what the owner decides.

## 1. Today, and after

```text
Today                                        After
control (one process, SQLite)                control plane (services, PostgreSQL)
  dashboard, API, MCP                          the dashboard and the API
  the record of every rig, folded in memory    the one record of every run, in tables
                                               the agents' loops, and each worker's own zone:
  a run is sent to a rig ──────────┐             its copy of the project, its shell, its program
                                   ▼           the scheduler, with the judge's decisions
rig (one for each machine or set)                │ gives a run devices from the pool,
  core: harness + supervisor                     │ and sends a change to a machine as a commit
    the run's record (its own SQLite)            ▼
    the scheduler, the planner, the judge    machine
    the workers' loops, the agent programs     one runner, in one image: builds for the device,
    the advisors (teachers, auditor, panel)      measurements, a worker's experiments on a device
  runners: builds and measurements             its devices, each given to a run whole or in part
```

## 2. What a reading of the code found

Two readers went through control, the harness and the supervisor on 2026-11-12. Their counts are theirs and were not checked again.

- **Control is one process** on Node's built-in SQLite, with synchronous calls: 74 tables, 37 migrations, and about 1,100 calls into the store from 170 files outside it.
- **A run's record lives on its rig,** in the rig's own SQLite (49 tables, 30 migrations). Control gets it as events over the message bus and folds them into views that it holds in memory, with caps, and rebuilds at each start. Control has no table of attempts, trials or notes.
- **The rig is in everything:** 35 of control's 68 ordinary tables are keyed by rig, all 37 kinds of command go to a rig, every bus user and most subjects are a rig's, and a rig runs one run at a time.
- **The loops are on the rig.** The scheduler, the planner and the judge are the harness's; the teachers, the auditor and the review panel are the supervisor's.
- **One worker loop already separates from the machine:** Thermite's own loop sends each file and shell tool to the harness as a request. An agent program with its own shell (Claude Code, Codex, OpenCode) does not: it is its own loop, and it edits and runs beside the files.
- **Today's runner is not light:** the whole harness image and a supervisor, on a container engine, with fixed users and groups made by the image. What crosses to a runner is one request and one answer; there is no stream and no shell that stays open.
- **The wall between a worker and the judge is built from the container:** the image's users, its dropped capabilities, a file system that holds nothing else, and the network rules. There is no sandbox code for a host that Thermite does not own.
- **The judge's clock is already on the machine.** Only its decisions would be remote, so a measurement's timing does not change.

## 3. The goal's open questions, each with a proposal

### What becomes of the rig

**Gone, as a thing and as a word.** A machine has a runner. A run has agents and devices. What is keyed by rig today is keyed by run or by machine. Until the last step of the order below, a rig still exists underneath, and nothing new is written for it.

### Which services the control plane has

Four, with PostgreSQL and the message bus beside them:

| Service | What it does | What its restart stops |
| --- | --- | --- |
| **The door** | The dashboard, REST, MCP, the stream of changes. | Nothing. |
| **The record** | The one writer of what happened: it takes what the machines report and writes the run's tables. | Screens lag until it is back. No work stops. |
| **The agents** | The loops: the workers, the planner, the teachers, the auditor, the review panel, and later Thermy. Each worker's zone: its copy of the project, its shell, and its agent program, in a sandbox. The terminals of the programs. | Turns in flight stop and go on from the conversation the record holds. A worker's zone is kept. |
| **The scheduler** | Gives each run its devices from the pool, hands out jobs, and makes the judge's decisions. | No new job is placed. A measurement in flight ends on its machine and is reported when the scheduler is back. |

A one-machine install runs all of them with compose, as it runs control and a rig today, plus PostgreSQL. A site that wants every part of a run on its own hardware runs the control plane there: this is the goal's "all on the machine" shape, and it needs no second design.

For a restart to stop no run, an agent's conversation must be in the record, not in a process's memory. That is new work.

### Where a worker's workspace lives

**In the control plane** (the owner, 2026-11-12): "claude code should still work on the control in its user zone etc and still submits code/changes to machine runners etc... only thing that runs on machines is execution that needs the machine resourcees for that. but agent loops and writing code etc can all happen in the control plane."

- **Each worker has a zone in the control plane:** its own user, its copy of the project, its shell and its agent program. Claude Code runs there, as do Thermite's own loop and fxbot's. A sign-in for a model never reaches a machine.
- **What needs the machine goes to its runner:** a build for the device, a measurement, a worker's experiment on a device. A change reaches the runner as a commit, and its output comes back as it runs.
- **The control plane needs sandboxes of its own** (the owner: "Now control becomes a control plane... so it might need its own sandboxes and stuff"). The wall between two workers, and between a worker and the record with the judge's decisions, is now in the control plane. In v0.3.0 it is built as today's is: users, groups and a container that Thermite made, proven by the isolation self-test, which moves with it.
- **The control plane needs room for it:** CPUs, memory and disk for every worker's zone at once, and the tools to read and change a project. A one-machine install holds them as the rig's core does today.

Still to settle, in the step's own goal: which of a worker's commands run in its zone and which go to a runner, and who says so (the kit, or the kind of command).

### The wall on a machine

**In v0.3.0 the runner is one program in one image** (the owner, 2026-11-12: "for v0.3.0 keep it one runner in an image so container stay s the wall"). One process on a machine, with no supervisor beside it and no core. The container stays the wall, and the isolation self-test proves the same things there. A machine still needs a container engine.

**In v0.4.0, the runner as a program with no container engine to set up** (the owner: "for v0.4.0 we look at microsandbox as execution image system and bundling it into our program for distribution"). That is a goal of its own. The same study can say whether the control plane's zones use it too.

### How a part of a device is given

A run asks for a device **whole, in turns,** or **shared,** beside other runs. The scheduler gives what is asked. There is no rule that forbids a choice (the owner, 2026-11-10); the docs say what each does to a measurement, and the run's own noise figure shows it. Sharing a device by slices of its time is not in the first version.

### From SQLite to PostgreSQL

1. The store goes behind an interface whose calls can wait, still on SQLite. Every caller changes; nothing else does.
2. PostgreSQL beside SQLite, behind the same interface, with the tests run on both.
3. The knowledge base's search moves to PostgreSQL's own text search. The order of results changes, since its ranking is another, and the "exact" search loses SQLite's own syntax.
4. The move: a command copies a control's data at the upgrade, checks the counts, and keeps the SQLite file as the way back. The 37 migrations end there, and PostgreSQL starts its own list.

What it costs: the one-machine install gains a service; backup becomes a dump taken before the bus's snapshot; the fast tests need a PostgreSQL to run on (the owner, 2026-11-14: PostgreSQL inside the test process for the fast tests, a real server in CI and the acceptance checks). One settled decision changes: a rig's log lines were to be searched with SQLite's text search (goal [257](goals/257-find-the-fault.goal)), and will use PostgreSQL's.

### Which tables a run's query may read

A small set of **views** with fixed names and columns: attempts, their metrics, champions, ideas, experiments, trials, notes, events. A query is a select over them and nothing else, with a time limit and a row limit, through a role that can read them alone. Saved views depend on the columns, so the set has a version, and a change to it is announced.

They are filled from the events control already has, first (a proposal; the owner has not yet said). That gives the explorer (goal [262](goals/262-the-explorer.goal)) and the query its tables while rigs still run underneath. When the loops move, the same views read the run's own tables.

### How a deployment of today moves

Both shapes run side by side while the work is done. At the upgrade, a control's SQLite is copied by the command above, and a rig's own record is read into the run's tables once, in step 9. Whether a run at work on a rig ends there first, or is paused and goes on in the new shape, is settled in step 9's goal ([275](goals/275-the-agents-in-the-control-plane.goal)). The rig's containers stay until its runs have ended or moved.

### Whether the judge's decisions may leave the machine

Yes, by default: they are the scheduler's. A site that does not want that runs the control plane on its own machine.

## 4. The order

Each step leaves a working system. The sizes are the readers' first estimates: M is a few days, L a week or more, XL several weeks. The screens start after step 8 (the owner): what steps 5 and 7 let be built is built then.

| Step | What is done | Size | What it lets happen |
| --- | --- | --- | --- |
| 1 | The store behind an interface whose calls can wait, on SQLite. | XL | Every later step. |
| 2 | PostgreSQL beside SQLite; the copy command; backup and restore. | L | The move can be proven before it is made. |
| 3 | The knowledge base's search on PostgreSQL. | L | Nothing of control needs SQLite. |
| 4 | The move to PostgreSQL. | M | More than one service may write. |
| 5 | A run's tables as views, filled from events; the read-only role. | L | The explorer and the query (goal [262](goals/262-the-explorer.goal)). |
| 6 | The door apart from the record. | L | A restart of the dashboard stops nothing. |
| 7 | A run owns its agents, their models and its workers; still sent to a rig. | L | A run's Setup can be built. |
| 8 | Machines and devices as a pool; the scheduler places a run on today's machines. | XL | Compute, New campaign and Start a run can be built. **The app's model is true from here, and the screens start** (the owner, 2026-11-12): a run owns its agents and is given devices from the pool. Until step 9 a machine still serves one run at a time, and a run still needs a machine; the screens show what is true. |
| 9 | The loops, each worker's zone and the judge's decisions move to the control plane, with its sandboxes; a change goes to a machine as a commit; the runner as one program in one image; a rig's own record is read into the run's tables. | XL | A run with no machine; several runs on one machine; no sign-in on a machine. |
| 10 | The rig goes: its tables, its bus users, its commands, its set-up, its words in the docs. | XL | One model in the code. |

The acceptance checks follow the steps: about 13 of them assume a rig as a core and a supervisor and are rewritten at steps 9 and 10; the checks of the bus, the judge and the terminals mostly stay.

## 5. The hard problems

1. **The control plane runs the agents' code.** It holds every worker's zone, with a wall between them and around the record. It needs its own sandboxes, its own limits on CPUs, memory and disk, and the tools each project needs to be read and changed.
2. **What runs where.** A worker's shell is in the control plane, and the device is on a machine. Each command must go to the right place, and a worker must not wait on a machine for work its zone can do.
3. **A change and its output across the link.** Today's link carries one request and one answer. A build or an experiment on a machine needs its output as it comes.
4. **A restart that stops no run.** Conversations and turns in flight must be in the record, and a worker's zone must outlive the service.
5. **Every call into the store changes.** Step 1 touches about 170 files and most of control's tests, and must not change what any of them does.

## 6. What the owner decided (2026-11-12)

1. **The screens start after step 8,** when the app's model is true at the API. Steps 9 and 10 go on beside them.
2. **The runner:** in v0.3.0, one runner in an image, so the container stays the wall. In v0.4.0, a look at microsandbox as the system that runs the work, bundled into Thermite's program.
3. **The agents work in the control plane:** their loops and the writing of code, Claude Code in its own zone among them. A machine runs only what needs the machine. The control plane gets its own sandboxes. This took the place of the design's first proposal, which kept a worker's workspace and Claude Code on the machine.
4. **Each step is a goal of its own,** on the roadmap in this order.

Not yet answered, and kept as a proposal: a run's tables as views filled from events first. The PostgreSQL for the fast tests was answered on 2026-11-14 (goal [268](goals/268-postgresql-beside-sqlite.goal)).
