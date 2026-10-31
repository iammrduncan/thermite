---
title: "Write a kit for your project"
description: "Give your project a pinned, tested kit: how to build it, run it, time it and check it."
type: how-to
sidebar:
  order: 4
---

A [kit](../../reference/glossary.md) is the judge's recipe for your project: how to build a change, run it on test cases, time it and check its output. This guide gives your project a kit in its own repository, pinned by commit. Agents never see it. A hill climb and a goal campaign need a kit; a research campaign has none ([Choose a campaign mode](choose-a-mode.md)).

[Kits](../../explanation/kits.md) explains why the kit lives outside the project, and the [kit manifest reference](../../reference/kit-manifest.md) has every field. For a first campaign, the **New campaign** page can write a simple kit for you: see [Start a campaign from the dashboard](start-from-dashboard.md).

## Before you start

- The project in a git repository, and a way to build and run it with no one at the keyboard.
- A way to tell a right answer from a wrong one, such as reference outputs or a slower reference implementation.
- The target of the rigs that will measure it: `cpu` or `cuda-gpu`.

`kits/smoke-cpu` in Thermite's repository is a complete small kit: `kit.json`, a `bench/` folder with its build script and sources, and `check.mjs`, the check. Its manifest:

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
  "metrics": { "flops_per_s": { "unit": "FLOP/s", "work": "work" } },
  "check": {
    "command": ["node", "{kit:check.mjs}", "{params_json}", "{out}"],
    "timeout_s": 60
  }
}
```

## 1. Make the kit repository

Make a new git repository for the kit, apart from the project. Put a `kit.json` at its top with `schema_version` `1`, a `name` (lowercase letters, digits, dots, dashes and underscores) and the `target`. A rig refuses a kit with another target.

Keep the kit's repository private if it holds reference outputs or held-out inputs. See [Use a private repository](private-repository.md).

## 2. Write the build

The judge builds each change in a fresh copy of its commit, with no `.git` folder, as a user of its own.

- `build.copy` lists kit paths to copy into the source tree under `.kit/`: `bench/build.sh` in the kit runs as `sh .kit/bench/build.sh`.
- `build.command` is the program and its arguments, as a list. Placeholders don't work here.
- `build.outputs` lists every result, relative to the source tree. The judge keeps exactly these, read-only, and throws the rest away.
- Every output must be a plain file or folder: links are refused, at most 20,000 entries, 32 levels deep. Versioned shared libraries are the usual trap, because `libfoo.so` is a link: with CMake, set `-DCMAKE_PLATFORM_NO_VERSIONED_SONAME=ON`, or replace each link with a copy at the end of the build.
- The judge moves the build, so binaries that load its own libraries need an `$ORIGIN` run path, for example CMake's `-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON`.
- Size the limits for a cold build: `timeout_s` (600 seconds unless set), `rss_mib` (4096) and `disk_mib` (4096). The disk limit covers the source tree too, and more than 50,000 files there also counts as over it.

A build that fails, or lacks an output, makes the change `invalid`. A build stopped at a limit makes it `crash_candidate`.

## 3. Define the cells

A cell is one test case: a named set of parameters, such as a size, a seed or an input file's name. The dashboard calls a cell a **case**. Values are numbers, strings or `true`/`false`.

- Add the cells you will hold out, with parameters far enough from the others that tuning for the visible cells doesn't carry over. The contract says which cells count and which are held out.
- For a rate metric, each cell needs a work value: the amount of work one run does, such as items sorted or floating-point operations. The cell parameter that holds it is the one the metric's `work` names.

## 4. Choose the metrics

The judge works out each metric itself, never from what the program prints:

| Metric | Write | The score |
| --- | --- | --- |
| A rate | `{"unit": "FLOP/s", "work": "work"}` | The cell's work value divided by the run's time on the judge's clock. The key `work` makes the metric a rate; its value names the cell parameter that holds the work, here a parameter that is also called `work` |
| A time | `{"unit": "s", "from": "time"}` | The run's time on the judge's clock, in seconds |
| A number the check works out | `{"unit": "%", "from": "check", "field": "accuracy"}` | The `accuracy` field of the check's JSON line |

Every value must be above zero. A goal's `metric_threshold` must name one of these metrics: to use a number the check prints, declare it as a `from: "check"` metric.

## 5. Write the run command

The run command runs one stored build on one cell, as another user. It is timed as a whole, so start-up counts.

| Placeholder | In the run |
| --- | --- |
| `{build}`, `{build:out/bench}` | The stored build, read-only, or one path in it |
| `{params}` | A file with the cell's parameters as `key=value` lines |
| `{params_json}` | The same, as JSON |
| `{out}` | A folder for the run's results |
| `{kit:run/driver.py}` | A kit file listed in `run.copy` |
| `{models:<sha256>}` | A [model file](../../reference/glossary.md) the contract lists under `models`: a data file the project loads, such as weights |

These are a `kit.json`'s placeholders. The **New campaign** page has a shorter set of its own (`{args}`, `{input}`, `{build}`, `{out}`, `{kit}`) for the kits it writes for you.

- The run can't read the kit. List the driver scripts and inputs it needs in `run.copy` and reach them as `{kit:<path>}`: a `{kit:…}` path not under `run.copy` is refused. They are copied fresh and read-only into every run. Never list reference outputs or held-out inputs there. For a large input, such as a dataset or a model's weights, use a model file instead: the contract lists it with its SHA-256, the rig imports it once, and every run reads the same read-only file as `{models:<sha256>}`.
- Write results only to `{out}`, as plain files: at most 10,000 entries.
- Repeat the work until it takes much longer than starting up, as the smoke kit's `reps` does.
- Pin what varies: pass thread counts sized to the rig's CPU share, turn off automatic tuning, and set seeds.
- Size the limits: `timeout_s` (300 seconds), `rss_mib` (1024) and `disk_mib` (256), with the same 50,000-file rule as the build.
- Size `timeout_s` for the ordinary cells. A cell that needs far longer, such as a slow diagnostic, takes its own limit: write it as `{"params": {…}, "timeout_s": 1800}` in `cells`. The [kit manifest reference](../../reference/kit-manifest.md#cells) shows both forms.

A run stopped at a limit, or that exits with an error, makes the change `crash_candidate`.

When the measurement needs a program of the kit's beside the candidate, such as one that sends it requests and times each answer, put that program in `run.driver`. The judge starts it with `run.command`, as a user of its own that the candidate's code can't reach, and joins the two by their standard input and output: the driver writes to the candidate and reads its answers. The driver writes `{out}`; it gets no `{build}`, and the candidate's command gets no `{out}`. The run ends when the driver does ([A kit's driver](../../reference/kit-manifest.md#a-kits-driver)).

## 6. Write the check

The check runs after every run that ended well, as a checker user of its own, in a folder of its own. There `{kit}` is the whole kit, which it reads, `{params}` and `{params_json}` are the judge's own copies of the cell's parameters, and `{out}` holds the run's results. It can't write to the kit or to `/tmp`: reach the kit's files through `{kit}` or `{kit:<path>}`, not by a path relative to the working folder, and write temporary files to the check's own folder, its `TMPDIR`. Its last line of output is one JSON object:

```json
{"pass": false, "reasons": ["max abs error 0.31 above 0.002"], "max_err": 0.31}
```

A small check, which compares the run's `result.txt` with an answer kept in the kit's `expected/` folder for the cell's `input` parameter, with `"command": ["node", "{kit:check.mjs}", "{params_json}", "{out}"]`:

```js title="check.mjs"
import { existsSync, readFileSync } from "node:fs";

const [paramsFile, out] = process.argv.slice(2);
const p = JSON.parse(readFileSync(paramsFile, "utf8"));
const reasons = [];
const result = `${out}/result.txt`;
if (!existsSync(result)) reasons.push("no result.txt");
else if (readFileSync(result, "utf8") !== readFileSync(`expected/${p.input}.txt`, "utf8"))
  reasons.push(`wrong result for ${p.input}`);
console.log(JSON.stringify({ pass: reasons.length === 0, reasons }));
```

`kits/smoke-cpu/check.mjs` is a fuller one: it works the right answer out from the parameters and proves that the fast path ran.

- The change passes only when `pass` is exactly `true`. The check's exit code doesn't count, only this line. A last line that isn't JSON fails with `check produced no result (exit <code>): …`. (A check written on the **New campaign** page is different: there the page turns its exit code into this line.)
- Work out the right answer from the parameters, or compare with a reference kept in the kit. Trust nothing in `{out}`.
- If the project keeps a slow reference implementation, prove the fast path ran. The smoke kits count calls to the reference and fail the run if it was called.
- Put the cause first in each reason, and keep it short: agents see up to 600 characters of a verdict's reasons, and a goal check keeps 300 for each failed cell.
- Report extra numbers as fields, such as `max_err` above. A `from: "check"` metric reads one.
- In a hill climb, the check can compare a change's outputs with the starting point's instead of a reference kept in the kit. The judge's first job measures the starting point alone (the run's [baseline](../../reference/contract.md#the-baseline)), and during it the check gets `THERMITE_BASELINE_DIR`, a folder to write to: keep the starting point's outputs there. Every later check of the run gets the same folder read-only. Check `process.env.THERMITE_BASELINE_DIR` before you use it: a goal campaign's check never gets it. [The check's baseline folder](../../reference/kit-manifest.md#the-checks-baseline-folder) has its rules and its 64 MiB limit.

The check's time limit is `check.timeout_s` (120 seconds).

## 7. Add verifiers for goal campaigns

A goal campaign checks a goal with a verifier: the cells whose runs must all pass the check.

```json title="kit.json (part)"
"verifiers": {
  "load": { "cells": ["load"], "priority": 10 },
  "perplexity": { "cells": ["ppl", "ppl-held"], "priority": 20, "requires": ["load"] }
}
```

- Lower `priority` runs first (100 unless set), so put cheap checks first.
- A verifier that `requires` another runs only when that one passed. Otherwise its goal is unmet with `not run: it requires load, which did not pass`. Leave independent goals ungated, so they still run and catch regressions.
- To hold a goal out, give its verifier at least one visible cell and one held-out cell. A verifier whose cells are all held out never counts as met.
- **How it is checked** under each goal in the run's **Goals** block, and **How each goal is checked** on the campaign's page, show the verifier or threshold as your kit runs it: each case's parameters and time limit, and the held-out cases by name. Compare it with the contract's goal text.

### Optional: name the MCP servers its agents use

To give the campaign's agents tools from outside Thermite, name MCP servers that are in control's **Settings**, by name, with the agents that get each. `tools` narrows a server to some of its tools for one kind of agent ([Give agents MCP tools](give-agents-mcp-tools.md)).

```json title="kit.json (part)"
"mcp_servers": [
  { "name": "gbrain", "agents": ["workers", "planner"] },
  { "name": "docs-search", "agents": ["workers"], "tools": { "workers": ["get-library-docs"] } }
]
```

The judge never uses them, and no secret goes in the kit. A campaign whose kit names a server that **Settings** lacks can't start.

## 8. Commit it and pin it

Commit the kit, and write its full commit in the contract's `project.kit`:

```json title="contract.json (part)"
"project": {
  "repo": "project",
  "kit": { "repo": "project-kit", "commit": "89abcdef0123456789abcdef0123456789abcdef" }
}
```

A later change to the kit is a new commit, so a new contract version, and every build is made again.

There is no command that checks a `kit.json` on its own yet ([goal 040](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/040-kit-tools.goal)). Two places check one:

- **Upload a kit** on the **New campaign** page checks it as soon as you choose the file, and shows its cases and metrics, or a short message such as `kit.json: metrics.seconds: Invalid input`. Pack the committed kit with `git archive --format=tar.gz -o kit.tar.gz HEAD` in its repository, and choose `kit.tar.gz` there to check it early; you need not start the campaign. (A `tar` of the kit's folder made on a Mac adds hidden `._` files, and the page then says `the archive has no kit.json at its top`.)
- A run's start checks the kit against its contract. It refuses with `kit <repo> at <commit> has no valid kit.json: …` and the problems as a list in JSON, or `the kit does not fit the contract: …` with each problem, such as `cells names cell large, which the kit does not have` or `the kit measures on cpu, and this rig's target is cuda-gpu`. Fix the kit or the contract, commit the kit again if you changed it, put its new commit in `project.kit`, and start the run again. [If it is refused](start-from-command-line.md#if-it-is-refused) has each case.

## 9. Test it, then use it

Check that the kit gives known changes the verdicts you expect: see [Test a kit with known candidates](test-a-kit.md). In a hill climb, the run's first job tells you whether the kit can measure your starting point at all: its page shows each case's values under **Where the run started**, or, when the judge could not measure it, its reasons, and the run is in setup until a change makes the project build and run. Then start the campaign with **A kit in a repository** or **Upload a kit** on the [New campaign page](start-from-dashboard.md), or with [`thermite assign --kit`](start-from-command-line.md). When the rigs can't reach the kit's repository, give control the repository first, as the next section says.

## Give control a kit you wrote elsewhere

Control can keep the kit's repository itself, with its history: you give it the repository as a git bundle, and each rig fetches the kit from control, by commit, with the rig's own token. Use this when the rigs can't reach the kit's repository, or should not. Every commit keeps its id, so the commit your contract names, and the commits a kit check names, stay the same. Nothing goes into a rig's inbox by hand.

1. Make a bundle of the branch that holds the commit your contract's `project.kit.commit` names:

   ```sh
   git -C ~/src/project-kit bundle create ~/project-kit.bundle main
   ```

   The bundle holds the branch's whole history, so an earlier commit of it fetches too. A bundle made with `--all` holds every branch and tag, and control then takes the bundle's `HEAD` as the kit's head.

2. Give the bundle to control, with the owner's token, under the name the contract's `project.kit.repo` has:

   ```sh
   npx thermite kit add project-kit ~/project-kit.bundle \
     --control https://control.example.com --token-file ~/thermite-owner-token
   ```

   Control checks the bundle and the head's `kit.json`, as the harness would, and prints `Control keeps the kit project-kit at 5f0c1d2e3a4b (12 commits). Rigs fetch it with the source {"control": "kits/project-kit"}.` To make another branch, a tag or a commit the head, add `--ref`. A refusal says why, such as `the bundle's head <commit> has no kit.json at its top`: [Kits control keeps](../../reference/rest-api.md#kits-control-keeps) lists each one.

3. Start the run with the kit from control:

   ```sh
   npx thermite assign --contract contract.json --run sort-speed-1 \
     --seed https://git.example.com/you/project.git \
     --kit control:project-kit \
     --control https://control.example.com --token-file ~/thermite-owner-token --rig rig-1
   ```

   The kit's import names `{"control": "kits/project-kit"}` as its source ([Imports](../../reference/signed-commands.md#imports)). Later runs, from the campaign's page or with `thermite run start`, use the same import.

Over the REST API, send the bundle's bytes to `POST /v1/kits/<name>`, with `?ref=` and `?force=true` as needed. An agent with the owner's or the operator's token uses MCP's [`kit_add`](../../reference/mcp-tools.md#kit_add), with the bundle in base64: at most 3,000,000 bytes of bundle, as an MCP request is at most 4 MiB. The command line and REST take up to 64 MiB. `thermite kit list`, `GET /v1/kits` and MCP's `kits` show each kit control keeps, with its head.

For a later version of the kit, make a new bundle and add it again: the kit's head moves forward. Control refuses a head that does not descend from the head it keeps, unless you add `--force`. Even then, control keeps the old head's commits, so a contract that names one still runs.
