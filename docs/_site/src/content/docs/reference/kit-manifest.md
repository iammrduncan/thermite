---
title: "Kit manifest"
description: "Every field of kit.json, and the placeholders, processes, limits, outputs and outcomes of a kit."
type: reference
sidebar:
  order: 3
---

A **kit** is the judge's recipe for one project: how to build a candidate, run it on each input, time it and check its results. It is a git repository with `kit.json`, the manifest, at its root. Agents never see it. This page describes the manifest and how the [judge](glossary.md) uses it.

[Why the benchmark lives in a kit](../explanation/kits.md) says why kits exist. [Write a kit for your project](../how-to/campaigns/write-a-kit.md) and [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md) give the steps.

This is the manifest of the CPU smoke kit in the repository, [`kits/smoke-cpu`](https://github.com/iammrduncan/thermite/blob/main/kits/smoke-cpu):

```json title="kit.json"
{
  "schema_version": 1,
  "name": "smoke-cpu",
  "target": "cpu",
  "build": {
    "copy": ["bench"],
    "command": ["sh", ".kit/bench/build.sh"],
    "outputs": ["out/bench"],
    "timeout_s": 120,
    "rss_mib": 1024,
    "disk_mib": 256
  },
  "cells": {
    "small": { "n": 128, "reps": 240, "seed": 11, "work": 1006632960 },
    "large": { "n": 256, "reps": 40, "seed": 23, "work": 1342177280 },
    "held": { "n": 192, "reps": 60, "seed": 37, "work": 849346560 }
  },
  "run": {
    "command": ["{build:out/bench}", "{params}", "{out}"],
    "timeout_s": 60,
    "rss_mib": 256,
    "disk_mib": 32
  },
  "metrics": {
    "flops_per_s": { "unit": "FLOP/s", "work": "work" }
  },
  "check": {
    "command": ["node", "{kit:check.mjs}", "{params_json}", "{out}"],
    "timeout_s": 60
  }
}
```

The build copies the kit's `bench` folder into the source tree and compiles the candidate. Each run executes the build on one cell's parameters. The check, the judge's own program, reads the run's outputs and says whether they are correct. The metric is the cell's `work` divided by the run's time on the judge's clock.

## Layout

A kit is a git repository. `kit.json` sits at its root; every other file belongs to the kit: build scripts, run drivers, the check, reference results. Scripts may be in any language the rig's image can run. A [contract](contract.md) names the kit and pins its commit in `project.kit`.

## `kit.json`

Unknown fields are refused at every level.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | `1` | required | The manifest format |
| `name` | text matching `^[a-z0-9][a-z0-9._-]{0,63}$` | required | The kit's name |
| `target` | text | required | The kind of device the kit measures on. This version has the drivers `cpu` and `cuda-gpu`. A rig only measures with a kit whose `target` is its own |
| `build.copy` | list of kit paths | `[]` | Kit files and folders copied into the source tree under `.kit/<path>` before the build |
| `build.command` | list of text, at least one | required | The build's command and arguments, run in the source tree. Placeholders are not expanded here |
| `build.outputs` | list of paths, at least one | required | Paths, relative to the source tree, that make up the build |
| `build.timeout_s` | integer from 1 to 86400 | 600 | The build's time limit, in seconds |
| `build.rss_mib` | integer ≥ 1 | 4096 | The build's memory limit, in MiB |
| `build.disk_mib` | integer ≥ 1 | 4096 | The build's disk limit, in MiB |
| `cells` | object | required | Every cell the kit can measure, with its parameters and, when it needs one, its own time limit. See [Cells](#cells) |
| `run.copy` | list of kit paths | `[]` | Kit files and folders copied, read-only, into every run. A run reaches them as `{kit:<path>}` |
| `run.command` | list of text, at least one | required | One run of one build on one cell |
| `run.driver` | list of text, at least one | none | The kit's driver, where a run needs one beside the candidate: see [A kit's driver](#a-kits-driver). Without it, `run.command` runs alone |
| `run.timeout_s` | integer from 1 to 86400 | 300 | A run's time limit, in seconds, for each cell that sets none of its own |
| `run.rss_mib` | integer ≥ 1 | 1024 | A run's memory limit, in MiB; with a driver, the driver's and the candidate's each |
| `run.disk_mib` | integer ≥ 1 | 256 | A run's disk limit, in MiB; with a driver, the driver's and the candidate's each |
| `metrics` | object | required | What the judge measures. See [Metrics](#metrics) |
| `check.command` | list of text, at least one | required | The check's command and arguments. See [Check output](#check-output) |
| `check.timeout_s` | integer from 1 to 86400 | 120 | The check's time limit, in seconds |
| `verifiers` | object | `{}` | Named verifiers for goal campaigns. See [Verifiers](#verifiers) |
| `mcp_servers` | list | none | The MCP servers the campaign's agents use, and which agents get each. See [MCP servers](#mcp-servers) |

### Rules across fields

| Rule | Message |
| --- | --- |
| A kit path (in `build.copy` or `run.copy`) is relative and normalized, stays inside the kit, has no `..`, does not start or end with `/`, and is not `.` | `a kit path is relative, normalized and inside the kit` |
| Each name in a verifier's `requires` is another verifier of the kit | `<name> is not another verifier of this kit` |
| Verifiers' `requires` do not form a loop | `verifier gates form a cycle` |
| Every `{kit}` or `{kit:<path>}` in `run.command` or `run.driver` is in `run.copy` | `{kit:<path>} is not in run.copy (a run cannot read the kit)` |
| `run.driver` has no `{build}` | `{build} is not for the driver: the candidate's build runs as run.command alone` |
| With `run.driver`, `run.command` has no `{out}` | `with run.driver, the driver writes {out}: the candidate's command gets none` |
| Every time limit (`build.timeout_s`, `run.timeout_s`, `check.timeout_s` and a cell's `timeout_s`) is at most 86400 seconds, a day: the judge runs nothing for longer | `a time limit is at most 86400 s (24 hours)` |

### Cells

A **cell** is one measured input, a test case: a name and its parameters. The dashboard calls cells **cases**. `cells` maps each cell's name to its parameters, in one of two forms:

- **Its parameters alone:** an object whose values are numbers, text or `true`/`false`, such as `"small": {"n": 128, "work": 1006632960}`. Its runs have the time limit `run.timeout_s`.
- **Its parameters and its own time limit:** `{"params": {…}, "timeout_s": <seconds>}`. `timeout_s` is an integer from 1 to 86400. It replaces `run.timeout_s` for this cell's runs only, so one slow cell does not set the limit for every cell. Leave `timeout_s` out to keep `run.timeout_s`. No other field is taken in this form.

```json title="kit.json (part)"
{
  "cells": {
    "small": { "n": 128, "work": 1006632960 },
    "diagnostic": { "params": { "n": 4096, "mode": "full", "work": 137438953472 }, "timeout_s": 1800 }
  },
  "run": { "command": ["{build:out/bench}", "{params}", "{out}"], "timeout_s": 60 }
}
```

Here `small` is stopped after 60 seconds and `diagnostic` after 1,800. A parameter's value is never an object, so the second form is never read as parameters. A parameter that is called `timeout_s` in the first form is only a parameter: it sets no limit. A kit written before cells could set a limit works as before.

A run receives the parameters through `{params}` and `{params_json}`, in both forms; the time limit is not among them.

The contract chooses which cells count: `cells` for every block, `held_out_cells` for confirmation only, and each goal's cells. A rate metric reads one parameter, named by its `work`, from each cell; time and check metrics need none.

### Metrics

`metrics` maps each metric's name to one of three kinds. The judge works out every value itself: a run never reports its own score.

| Kind | Form | Value |
| --- | --- | --- |
| Rate | `{"unit": "<unit>", "work": "<parameter>"}` | The cell's parameter named by `work`, divided by the run's time in seconds on the judge's clock. `unit` is required |
| Time | `{"unit": "s", "from": "time"}` | The run's time in seconds, on the judge's clock. `unit` defaults to `s`. A contract improves it with `"direction": "min"` |
| From the check | `{"unit": "", "from": "check", "field": "<field>"}` | A number the kit's check prints under `<field>` in its result line, for example an accuracy. `unit` defaults to empty |

Every value must be above zero, because the judge compares runs by their ratio. A run whose check prints no number above zero for a check metric is invalid: `the check reported no <field> above zero (got <value>)`. Every run works out every metric of the kit, so each case the contract runs needs each rate's `work` parameter, a number above zero: the [check against the contract](#the-kit-against-the-contract) refuses a case without it. A rate whose `work` parameter is still missing, zero or not a number at a run is an infrastructure error: `kit metric <name>: bad work <value> or time <seconds>`. On a held-out case, the agents get only `a held-out check could not finish (an infrastructure failure)`, and the rig's log keeps the error.

The device's driver also refuses values it cannot believe. The `cpu` driver refuses values that are not finite; the `cuda-gpu` driver refuses values that are not finite or not above zero.

### Verifiers

`verifiers` maps each verifier's name to how a goal contract's `{"type": "code", "verifier": "<name>"}` goal is checked. A verifier passes when one run on each of its cells ends normally and passes the kit's check.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cells` | list of cell names, at least one | required | The cells whose runs must all pass the check |
| `priority` | integer | 100 | The order verifiers run in: lower first. Goals are checked in this order and reported in the contract's order |
| `requires` | list of verifier names | `[]` | Gates: other verifiers that must pass first. If one does not, this verifier runs none of its cells, and its goal is unmet with `not run: it requires <names>, which did not pass`. A gate with no cells in this pass (all held out, or none held out) does not block |

### MCP servers

`mcp_servers` lists the [MCP servers](../how-to/campaigns/give-agents-mcp-tools.md) whose tools this kit's campaigns give their agents, by their names in control's **Settings › Providers**. The judge never uses them. At most 20 servers, each named once.

```json title="kit.json (part)"
{
  "mcp_servers": [
    { "name": "gbrain", "agents": ["workers", "planner", "advisors"] },
    { "name": "github", "agents": ["workers", "advisors"], "tools": { "advisors": ["search_code"] } }
  ]
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text matching `^[a-z0-9][a-z0-9-]{0,63}$` | required | The server's name in **Settings**. Not `thermite`, the name of Thermite's own server, which gives every agent the [knowledge base's tools](knowledge-base.md#the-agents-tools), refused with "thermite is the name of Thermite's own tools: give the server another name" |
| `agents` | list of `workers`, `planner` and `advisors`, at least one, each once | required | The kinds of agent that get the server: the workers (every lane), the planner, and the advisors (the teachers, the auditor and the review panel) |
| `tools` | object | none | Only when narrowed: for a kind of agent in `agents`, the tools it may call, as a list of 1 to 500 tool names, each once. A kind left out gets every tool the server lists. A kind not in `agents` is refused: `the <kind> do not get this server: add <kind> to agents, or take out its tools` |

The harness calls the servers for the workers and the planner, and the supervisor for the advisors; each caller gets only the tools given to its kind, and a call to another is refused as a tool error. When a run is assigned:

- **Control** refuses to sign the assignment when **Settings** has no server of a name the kit names: `The kit names the MCP server <name>, and Settings has no server of that name. Add an MCP server named <name> in Settings › Providers, or take it out of the kit. Then start the campaign again.` With more than one missing: `The kit names the MCP servers <names>, and Settings has none of these names. Add them in Settings › Providers, or take them out of the kit. Then start the campaign again.` It sends the kit's list in the assignment ([`assign_campaign`](signed-commands.md#assign_campaign), field `mcp_servers`).
- **The harness** refuses the run when the assignment's list is not the one `kit.json` names: `the kit names the MCP servers <list>, and the assignment names <list>: start the run from control, which reads the kit's servers, or give the kit's mcp_servers in the assignment`. Then it records the list in the run's history as the event `mcp_servers`.

A research campaign has no kit: its contract's `mcp_servers` takes the same list ([Contract](contract.md)).

## Placeholders

Placeholders go inside the arguments of `run.command`, `run.driver` and `check.command`. `{name:sub/path}` is the placeholder's path joined with `sub/path`. Any other lowercase name in braces is an infrastructure error when the command runs: `unknown placeholder {<name>}`.

| Placeholder | In a run | In the check |
| --- | --- | --- |
| `{build}` | The arm's stored build (read-only) | The same build |
| `{params}` | The run's copy of the cell's parameters, as `key=value` lines; the driver gets a copy of its own | The judge's own copy, in the check's folder |
| `{params_json}` | The run's copy of the cell's parameters, as a JSON object; the driver gets a copy of its own | The judge's own copy, in the check's folder |
| `{out}` | The run's output folder, which it may write; with a driver, the driver's alone | The same outputs, moved to the check's folder, to read |
| `{kit}` | The run's read-only copy of the `run.copy` paths | The kit itself |
| `{models}` | The imported [model files](glossary.md) (data files such as a model's weights), one read-only file per SHA-256: `{models:<sha256>}` is one | The same |

## Processes

The judge runs each stage as its own Unix user, so a candidate cannot change the kit, the stored builds or the judge's records. [Isolation inside a rig](../explanation/isolation.md) says how the users are kept apart.

| Stage | User | Working folder | Environment |
| --- | --- | --- | --- |
| Build | `builder` | The source tree: a fresh export of the candidate's commit, without `.git` | `PATH`, `LANG=C.UTF-8`, `USER`, and `HOME` and `TMPDIR` set to the working folder |
| Run | `run`, whose group owns the device. On a rig with several judge cards, card *i* is timed by `run-<i>`, with that card's own group | The run's own folder, holding `params.txt`, `params.json` and `out/` | As for the build. With dedicated judge cards, `CUDA_VISIBLE_DEVICES` names the run's card. On a GPU rig, timed runs are pinned by default to the CPUs near their card (`THERMITE_RUN_CPUS`) |
| Driver, with `run.driver` | `driver`, a user of its own, apart from the candidate's; card *i*'s is `driver-<i>`. No group of a device | Its own folder, holding `params.txt`, `params.json` and `out/` | As for the build. It gets no GPU |
| Check | `checker`, a user of its own; card *i*'s is `checker-<i>`. It holds the `checkers` group, through which it reads the kit and the baselines | A folder of its own, holding the judge's `params.txt` and `params.json` and the run's outputs in `out/` | As for the build, and in a hill climb `THERMITE_BASELINE_DIR` ([The check's baseline folder](#the-checks-baseline-folder)). `/tmp` is closed to it: it writes temporary files to its own folder (`TMPDIR`) |

What each of these users may reach:

| User | Reads | Writes | Can't reach |
| --- | --- | --- | --- |
| `run` | The stored build, the run's copy of `run.copy`, the models, its own folder | Its own folder | The kit, the judge's state, the check's and the driver's folders and processes |
| `driver` | The run's copy of `run.copy`, the models, its own folder | Its own folder, and `{out}` in it | The kit, the judge's state, the candidate's folder and processes |
| `checker` | The kit and the baselines' kept files (by their paths, through the `checkers` group), the stored build, the models, its own folder | Its own folder, and the baseline's folder during a baseline job | The judge's state otherwise (the ledger, the git mirrors, the stored builds' list), the run's and the driver's folders, the lanes' work |

A run cannot read the kit. The kit files a run needs go in `run.copy`. Before each run, the judge copies them into a folder outside the run's working folder. The copies are plain files owned by the judge: folders `0555`, files `0444`, or `0555` when executable. Neither the build nor the run can change them. A link among them, or a path missing from the kit, is an infrastructure error: `kit run.copy: not a regular file or directory: <path>` or `kit run.copy: <path> is not in the kit`.

## A kit's driver

Some measurements need a program of the kit's beside the candidate: to send it requests and time its answers, say, or to feed it input as it runs. Name that program in `run.driver`. The judge then starts `run.command`, the candidate, and the driver at the same time, each as its own user:

- The driver's standard output is the candidate's standard input, and the candidate's standard output is the driver's standard input. The two talk through these pipes alone; neither can signal or trace the other's processes, or read the other's folder.
- The driver writes the run's outputs to `{out}`, and the check reads them. The candidate gets no `{out}`, and the driver gets no `{build}`: it never runs the candidate's code.
- The run is over when the driver's command ends; then every process of the candidate's user is ended. The judge's time is from the start of both to the driver's end. A driver that exits with an error, or the candidate or the driver stopped for a limit, ends the run as a crash; the reason has the driver's standard error, and the candidate's after `candidate:`.

```json title="kit.json (part)"
"run": {
  "copy": ["run"],
  "command": ["{build:out/server}", "--stdio"],
  "driver": ["python3", "{kit:run/drive.py}", "{params_json}", "{out}"]
}
```

## Limits

| Limit | Build | Run | Check |
| --- | --- | --- | --- |
| Time | `build.timeout_s` | The cell's own `timeout_s`, else `run.timeout_s` | `check.timeout_s` |
| Memory: the summed resident memory of the user's processes, sampled every 100 ms | `build.rss_mib` | `run.rss_mib` | none |
| Disk: the working folder, sampled every 500 ms | `build.disk_mib` | `run.disk_mib` | none |
| Files: 50,000 or more files and folders, or folders nested 128 deep, count as over the disk limit | yes | yes | none |
| Processes and threads (`RLIMIT_NPROC`) | 512 | 256 | 256 |
| Output kept: the last part of standard output and standard error | 64 KiB | 64 KiB | 64 KiB |

When a build or run goes over a limit, every process of its user is ended. Processes still alive when the main process exits are ended too, and the files the user left in `/tmp`, `/var/tmp` and `/dev/shm` are removed. After a timeout, the judge waits up to 15 seconds more for the output to close. These limits end one build, run or check; they never end a campaign. With a driver, the driver and the candidate each have the run's limits; the run is over when the driver ends, and every process of the candidate's user is ended then.

## Outputs

| Rule | Build outputs | Run outputs (`{out}`) |
| --- | --- | --- |
| Allowed | Plain files, each with one link, and folders | Plain files, each with one link, and folders |
| Refused | Symbolic links, hard links, devices, sockets, named pipes | Symbolic links, hard links, devices, sockets, named pipes |
| Most entries | 20,000 | 10,000 |
| Deepest nesting | 32 levels | 32 levels |
| Afterwards | Hashed, made read-only and stored. The hashes are checked again before every run; a mismatch is the infrastructure error `build store tampered: <key> <files>` | Read by the check, then removed with the run's folder |

## Check output

The check prints one JSON object as the **last line** of its standard output. The judge does not use its exit code.

A kit described on the **New campaign** page is different: control wraps its check command in a script that turns the exit code into this line. Exit 0 passes, and any other exit fails with `the check exited <code>: <its last output>`. When a check that exits 0 prints a JSON object with `pass` as its last line, that line is passed on as it is, so it can report a score.

| Field | Type | Meaning |
| --- | --- | --- |
| `pass` | boolean | The run is valid only when this is exactly `true` |
| `reasons` | list of text | Why the run failed. They are joined with `; ` into the verdict's reason; with none, the reason is `check failed` |
| any other field | any | Details. A `from: "check"` metric reads its number from here |

When the last line is not JSON, the run fails with `check produced no result (exit <code>): <standard error>`, shortened as [the reasons below](#outcomes) are.

## The check's baseline folder

In a hill climb, the judge's first job measures the starting point alone: the run's [baseline](contract.md#the-baseline). During it, the check gets the environment variable `THERMITE_BASELINE_DIR`: an empty folder it may write to, such as reference outputs of the starting point to compare candidates' outputs with. In every later job of the run (screening, confirmation, the A/A calibration), the check gets the same folder again, read-only.

```js title="check.mjs (part)"
const dir = process.env.THERMITE_BASELINE_DIR;
const ref = join(dir, `ref-${params.n}.bin`);
if (!existsSync(ref)) writeFileSync(ref, output); // the baseline: keep the starting point's output
const drift = compare(output, readFileSync(ref)); // every later job: compare with it
```

| Rule | Value |
| --- | --- |
| Where | During the baseline job, a folder of the job's own that the checker's user writes. Then the judge keeps its files at `<state>/baselines/<run>/job-<id>`: the judge's own, in the `checkers` group, so later checks read them. The build, the run and the driver never get it, and their users cannot reach it |
| Writable | During the baseline job only. Then each file is kept `0440` and each folder `0550`, and no user can change them |
| Contents | Plain files and folders. A link, a hard link or a special file fails the baseline |
| Limits | 64 MiB and 1,000 files in all, at most 32 folders deep. More fails the baseline: `the kit's check wrote to the baseline's folder: it holds more than 64 MiB, the most it may keep` |
| Record | Each file's `path`, `bytes` and `sha256`, in the `baseline` event's `files`, sorted by path, and the total in `bytes` |
| A new starting point | A setup change that becomes the starting point gets a new, empty folder, from its own baseline job |
| Without a baseline | A goal campaign's check, and a check in a run whose baseline has not run, gets no `THERMITE_BASELINE_DIR` |

## Outcomes

The judge measures **arms**: the candidate and, in a hill climb, the champion (the run's current best) beside it. A failure counts against the candidate only when it is the candidate's. When the champion's build or run fails, something is wrong with the rig or the kit, so it is an **infrastructure error**: the verdict is `crash_infra`, it never counts against the candidate, and the judge tries the job once more. [Verdicts and states](verdicts.md) describes every verdict.

| What happened | Candidate | Champion |
| --- | --- | --- |
| The build exits with an error, or an output is missing | `invalid`, and the failed build is remembered | Infrastructure error |
| The build's outputs are refused | `invalid`, and the failed build is remembered | Infrastructure error |
| The build is ended for time, memory or disk | `crash_candidate`, not remembered: the next try builds again | Infrastructure error |
| A run is ended for a limit, or exits with an error | `crash_candidate` | Infrastructure error |
| A run's outputs are refused | `invalid` | Infrastructure error |
| The check fails | `invalid` | Infrastructure error |
| The driver refuses a metric's value | `invalid` | Infrastructure error |

A hill climb's [baseline](contract.md#the-baseline) judges the starting point as the table judges a candidate: whatever gives a candidate `invalid` or `crash_candidate` means the starting point can't be measured yet, and the run is in setup. Each of its reasons begins with the cell it failed on, `cell <cell>: `.

The reasons have these forms:

| Failure | Reason |
| --- | --- |
| Build | `build: ` and one of `build failed (exit <code>)`, `build outputs missing: <paths>`, `build killed (<timeout, memory or disk>)`, `build outputs refused: <problems>`, then the last 1,500 characters of the build's log |
| Run ended for a limit | `killed: <timeout, memory or disk>` |
| Run exited with an error | `exit <code>: <standard error>` |
| Run outputs refused | `outputs refused: <problems>` |
| Driver refused a value | `implausible: <problems>` |
| Check failed | The check's `reasons`, joined with `; ` |

In a goal campaign, a failed run on a verifier's cell makes that goal unmet, with the run's failure as its reason, whichever arm it was. A held-out cell's failure is recorded with the cell's name and its kind for you; the agents learn its kind alone: see [Held-out failures](verdicts.md#held-out-failures).

Each run's reason keeps at most 2,000 characters. A longer one keeps its first quarter and its last three quarters, with ` … ` where it was cut: the start says what failed, and the end of the standard error is where the error usually is. Reasons are shortened the same way where they are passed on:

| Where | Characters kept |
| --- | --- |
| One failed cell in a goal report, for a verifier or a metric threshold | 2,000 |
| A verdict's reasons, in the ledger and as control gets them; a goal's reasons in a goal check | 4,000 |
| A verdict's reasons in a worker's brief, for each of the lane's last attempts | 1,200 |
| Why the judge could not measure a hill climb's starting point, in a setup trial's brief | 3,000 |
| Each goal's reasons in the goal report a worker's brief and the planner get | 600 |
| A build's log in the verdict | the last 1,500 |

## Build cache

Each build has a key: the hash of the candidate's commit, the kit's commit, the kit's `build` section and the toolchain. The toolchain is a hash of the image's installed packages (`dpkg-query -W`), the `cc` and `nvcc` versions, and `THERMITE_TOOLCHAIN_ID` when it is set and not empty. A build is made once for each key and reused after: an update to new images whose packages and compilers are the same, such as a new Thermite release on the same base, keeps the run's builds, and one that changes a package builds afresh. While one judge executor makes a build, another that needs the same key waits for it. A failed build is remembered as failed, unless it was ended for a limit.

## How a kit reaches a rig

A kit arrives as a `kit_bundle` import in the `assign_campaign` [signed command](signed-commands.md):

| Field | Value |
| --- | --- |
| `kind` | `kit_bundle` |
| `path` | The git bundle's path, relative to the rig's inbox |
| `repo` | The kit's repository name: an id, matching the contract's `project.kit.repo` |
| `commit` | The kit's full commit id, matching `project.kit.commit` |
| `sha256` | Optional. The bundle file's SHA-256, checked when given |
| `source` | Optional. Where the rig's supervisor fetches the commit before it passes the command on: `{"git": "<url>"}` with an optional `"access"` naming Git access that control keeps for a private repository, or `{"control": "kits/<name>"}` for a kit that control keeps itself |

The harness keeps the kit as the repository `kit-<repo>` and exports each commit it needs into its private state. `thermite assign --kit <url>` adds this import for you; see the [command line reference](command-line.md).

## The kit against the contract

When a run is assigned, the harness checks the kit against the contract before it creates the run. Each problem found is listed after `the kit does not fit the contract: `, joined with `; `:

| Problem | Message |
| --- | --- |
| The kit's `target` is not the rig's | `the kit measures on <kit target>, and this rig's target is <rig target>` |
| A cell named in `cells` (hill climb) or `held_out_cells` (hill climb and goal) | `cells names cell <cell>, which the kit does not have`, or `held_out_cells names cell …` |
| A metric named by the objective, a secondary objective, a guard or a `min`/`max` hard constraint (hill climb) | `the objective names metric <metric>, which the kit does not have`, or `a secondary objective …`, `a guard …`, `a hard constraint …` |
| A goal's verifier | `goal <id> names verifier <verifier>, which the kit does not have` |
| A goal threshold's metric or cell | `goal <id> names metric <metric>, which the kit does not have`, or `goal <id> names cell <cell>, which the kit does not have` |
| A case the contract runs (in `cells`, `held_out_cells`, a threshold goal's cells, or all the kit's cases when it names none, or a goal's verifier and the verifiers it requires) without a rate metric's `work` parameter as a number above zero | `cell <cell> has no parameter <work> above zero, which rate metric <metric> divides by the run's time` |

Before each job, the judge checks the target again. A mismatch then is an infrastructure error: `kit <name> measures <target>, this rig has <type>`.

Contract fields that refer to the kit:

| Contract field | Refers to | Checked when a run is assigned |
| --- | --- | --- |
| `project.kit` | The kit's `repo` and `commit` | Yes: the commit must be on the rig, and its `kit.json` valid |
| `cells` (hill climb), `held_out_cells` (hill climb and goal) | Cell names | Yes |
| `objective.primary.metric`, `objective.secondary[].metric`, `guards[].metric`, `hard_constraints[].metric` | Metric names | Yes |
| `monitor_only` | Metric names | No; the field is not used |
| `goals[].verify` `{"type": "code", "verifier": …}` | A verifier name | Yes |
| `goals[].verify` `{"type": "metric_threshold", "metric": …, "cells": …}` | A metric name in `metrics`, and cell names. A number the check prints counts only when `metrics` declares it as a `from: "check"` metric | Yes |
| `models` | Imported model files, reached as `{models:<sha256>}` | The files must be imported; the kit does not list them |
