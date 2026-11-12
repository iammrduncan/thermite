# Goal 258's design: a run owns its agents and its share of compute

**Status:** proposed on 2026-11-12, for the owner's yes. No code is written before it.

Goal [258](goals/258-runs-own-their-resources.goal) turns the order around: a run owns its agents, their models and its share of compute; machines are a pool; the agents' loops run in the control plane; a machine runs one light runner. The owner accepted it into v0.3.0 as the first work of the new app ([the app's build plan](app-build-plan.md)). This page is the written design the goal asks for: what was found, an answer to each of the goal's open questions, the order of the work, its cost, and what the owner decides.

## 1. Today, and after

```text
Today                                        After
control (one process, SQLite)                control plane (services, PostgreSQL)
  dashboard, API, MCP                          the dashboard and the API
  the record of every rig, folded in memory    the one record of every run, in tables
                                               the agents' loops
  a run is sent to a rig ──────────┐           the scheduler, with the judge's decisions
                                   ▼             │ gives a run devices from the pool
rig (one for each machine or set)              ▼
  core: harness + supervisor                 machine
    the run's record (its own SQLite)          one runner: a worker's shell and files,
    the scheduler, the planner, the judge        builds, measurements, an agent program
    the workers' loops, the agent programs       that has its own shell
    the advisors (teachers, auditor, panel)    its devices, each given to a run whole
  runners: builds and measurements               or in part
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
| **The agents** | The loops: Thermite's own workers, the planner, the teachers, the auditor, the review panel, and later Thermy. | Turns in flight stop and go on from the conversation the record holds. |
| **The scheduler** | Gives each run its devices from the pool, hands out jobs, and makes the judge's decisions. | No new job is placed. A measurement in flight ends on its machine and is reported when the scheduler is back. |

A one-machine install runs all of them with compose, as it runs control and a rig today, plus PostgreSQL. A site that wants every part of a run on its own hardware runs the control plane there: this is the goal's "all on the machine" shape, and it needs no second design.

For a restart to stop no run, an agent's conversation must be in the record, not in a process's memory. That is new work.

### Where a worker's workspace lives

**On the machine, in the runner.** The loop in the control plane sends each tool call to the runner over a session that stays open, with output as it comes and processes that keep running. That session is new: today's link carries one request and one answer.

**An agent program with its own shell runs on the machine,** beside the workspace, started and watched by the runner. For it the control plane keeps the trial's record and its rules, not its loop. Its sign-in reaches the machine for the life of a trial, as it does today. Goal [260](goals/260-fxbot-and-thermite.goal) moves the workers to fxbot's agent core, whose loop does separate; Claude Code stays the one program of this kind.

### The wall without a container

This is the hardest part, and the proposal is to take it in two steps.

1. **First, the runner is one program in one image.** One process on a machine, with no supervisor beside it and no core. The container stays the wall, as today, and the isolation self-test proves the same things. A machine still needs a container engine.
2. **Then, the runner as a program on the host,** with a sandbox for each job that it makes itself. This is a goal of its own, after v0.3.0: the self-test must first say what it can prove on a host that holds other users' files and programs.

The app's screens need the pool and a run's own resources. They do not need the second step.

### How a part of a device is given

A run asks for a device **whole, in turns,** or **shared,** beside other runs. The scheduler gives what is asked. There is no rule that forbids a choice (the owner, 2026-11-10); the docs say what each does to a measurement, and the run's own noise figure shows it. Sharing a device by slices of its time is not in the first version.

### From SQLite to PostgreSQL

1. The store goes behind an interface whose calls can wait, still on SQLite. Every caller changes; nothing else does.
2. PostgreSQL beside SQLite, behind the same interface, with the tests run on both.
3. The knowledge base's search moves to PostgreSQL's own text search. The order of results changes, since its ranking is another, and the "exact" search loses SQLite's own syntax.
4. The move: a command copies a control's data at the upgrade, checks the counts, and keeps the SQLite file as the way back. The 37 migrations end there, and PostgreSQL starts its own list.

What it costs: the one-machine install gains a service; backup becomes a dump taken before the bus's snapshot; the fast tests need a PostgreSQL to run on. One settled decision changes: a rig's log lines were to be searched with SQLite's text search (goal [257](goals/257-find-the-fault.goal)), and will use PostgreSQL's.

### Which tables a run's query may read

A small set of **views** with fixed names and columns: attempts, their metrics, champions, ideas, experiments, trials, notes, events. A query is a select over them and nothing else, with a time limit and a row limit, through a role that can read them alone. Saved views depend on the columns, so the set has a version, and a change to it is announced.

They are filled from the events control already has, first. That gives the explorer (goal [262](goals/262-the-explorer.goal)) and the query its tables while rigs still run underneath. When the loops move, the same views read the run's own tables.

### How a deployment of today moves

Both shapes run side by side while the work is done. A run that started on a rig ends on it. At the upgrade, a control's SQLite is copied by the command above, and a rig's own record is read into the run's tables once. The rig's containers stay until its runs have ended or moved.

### Whether the judge's decisions may leave the machine

Yes, by default: they are the scheduler's. A site that does not want that runs the control plane on its own machine.

## 4. The order

Each step leaves a working system. The sizes are the readers' first estimates: M is a few days, L a week or more, XL several weeks.

| Step | What is done | Size | What it lets happen |
| --- | --- | --- | --- |
| 1 | The store behind an interface whose calls can wait, on SQLite. | XL | Every later step. |
| 2 | PostgreSQL beside SQLite; the copy command; backup and restore. | L | The move can be proven before it is made. |
| 3 | The knowledge base's search on PostgreSQL. | L | Nothing of control needs SQLite. |
| 4 | The move to PostgreSQL. | M | More than one service may write. |
| 5 | A run's tables as views, filled from events; the read-only role. | L | The explorer and the query (goal [262](goals/262-the-explorer.goal)). |
| 6 | The door apart from the record. | L | A restart of the dashboard stops nothing. |
| 7 | A run owns its agents, their models and its workers; still sent to a rig. | L | A run's Setup can be built. |
| 8 | Machines and devices as a pool; the scheduler places a run on today's machines. | XL | Compute, New campaign and Start a run can be built. **The app's model is true from here.** |
| 9 | The loops and the judge's decisions move to the control plane; the session for tool calls; the runner as one program in one image. | XL | A run with no machine; several runs on one machine. |
| 10 | The rig goes: its tables, its bus users, its commands, its set-up, its words in the docs. | XL | One model in the code. |

The acceptance checks follow the steps: about 13 of them assume a rig as a core and a supervisor and are rewritten at steps 9 and 10; the checks of the bus, the judge and the terminals mostly stay.

## 5. The hard problems

1. **Agent programs that run their own tools.** Answered above: such a program runs on the machine, and only Thermite's own loop and fxbot's leave it.
2. **The wall without a container.** Answered by two steps: the container stays the wall in v0.3.0.
3. **Tool calls over the link.** A worker makes hundreds of small calls, and a shell needs its output as it comes. The session is new work, and it is on the path of every trial.
4. **A restart that stops no run.** Conversations and turns in flight must be in the record.
5. **Every call into the store changes.** Step 1 touches about 170 files and most of control's tests, and must not change what any of them does.

## 6. What the owner decides

1. **Where the screens start.** After step 8, when the app's model is true at the API and rigs still run underneath (recommended), or after step 10, when the rig is gone. Steps 9 and 10 change no screen.
2. **The container stays the wall in v0.3.0,** and the runner as a program on the host is a goal after it. Or the host runner is part of v0.3.0.
3. **An agent program with its own shell runs on the machine,** with its sign-in there for the life of a trial, as today.
4. **A run's tables are views filled from events first.**
5. **The fast tests need a PostgreSQL** on the machine that runs them.
6. **Each step becomes a goal of its own** on the roadmap, in this order.
